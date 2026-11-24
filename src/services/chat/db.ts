import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { notifyLocalChange } from '../sync/events.js'
import type { SyncLocalState } from '../sync/types.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。12 增加同步用的 outbox / tombstone / 状态存储。 */
const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

/** 待同步的会话：只记录「哪个会话变脏」，推送时再读取最新内容，流式期间的连续保存自然合并。 */
export type OutboxEntry = { id: string; at: number }

/** 已删除会话的标记；用于告诉其他设备删除，而不是被当成「远端有而本地没有」而复活。 */
export type Tombstone = { id: string; at: number }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 待推送的会话，写入正式数据时在同一事务内追加 */
  syncOutbox: { key: string; value: OutboxEntry }
  /** 已删除会话的标记，推送到远端后清理 */
  syncTombstones: { key: string; value: Tombstone }
  /** 同步的本地状态（设备 seq、各设备水位、已推送摘要）；整条记录以 'state' 为键 */
  syncMeta: { key: string; value: SyncLocalState }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'sessionsStaging',
        'filesStaging',
        'syncOutbox',
        'syncTombstones',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      // syncMeta 是 key-value 存储（整条同步状态存在 'state' 键下），不能带 keyPath
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta')
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  })
    .then((db) => {
      // 其他标签页升级版本时关闭本连接，避免升级被老连接长期阻塞
      db.addEventListener('versionchange', () => {
        db.close()
        dbPromise = null
      })
      // 浏览器也可能自己关闭连接（标签页休眠、从往返缓存恢复、存储被清理）。
      // 这里只清掉缓存，让下一次操作重新打开；正在进行的操作由调用方重试。
      db.addEventListener('close', () => {
        dbPromise = null
      })
      return db
    })
    .catch((error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      dbPromise = null
      throw error
    }))

/** 丢弃缓存的连接，下次操作重新打开；用于浏览器关闭连接后的重试 */
export const resetConnection = (): void => {
  dbPromise = null
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

/** 本地保存：写入会话与原件，并在同一事务内标记待同步。 */
export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncOutbox'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
        await tx.objectStore('syncOutbox').put({ id: session.id, at: Date.now() })
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

/** 应用远端结果：只写本地数据，不标记待同步（由调用方决定是否重新推送）。 */
export const saveSyncedSession = async (session: Session): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 显式把会话标记为待同步（合并出本地新增内容时需要重新推送）。 */
export const markOutbox = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('syncOutbox', 'readwrite')
  await Promise.all([...ids.map((id) => tx.store.put({ id, at: Date.now() })), tx.done])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'syncOutbox'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          session.titleUpdatedAt = Date.now()
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
          await tx.objectStore('syncOutbox').put({ id, at: Date.now() })
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删，远端会话由 tombstone 通知其他设备。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncOutbox', 'syncTombstones'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        await tx.objectStore('syncOutbox').delete(sessionId)
        await tx.objectStore('syncTombstones').put({ id: sessionId, at: Date.now() })
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

/** 应用远端的删除：只删本地数据，不写 tombstone，避免删除标记来回传播。 */
export const deleteSyncedSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncOutbox'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        await tx.objectStore('syncOutbox').delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  if (!files.length) {
    return
  }
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSessions = async (sessions: Session[]): Promise<void> => {
  if (!sessions.length) {
    return
  }
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([...sessions.map((session) => tx.store.add(session)), tx.done])
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 回填 MIME，保留归档中的 isImage 标识。 */
export const updateStagingFileTypes = async (
  types: ReadonlyMap<string, string>,
  sessionIds: ReadonlySet<string>
): Promise<void> => {
  if (sessionIds.size === 0) {
    return
  }
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const id of sessionIds) {
          const session = await tx.store.get(id)
          if (!session) {
            continue
          }
          let changed = false
          for (const message of session.messages) {
            if (message.role !== 'user') {
              continue
            }
            for (const file of message.files) {
              const type = types.get(file.id) ?? ''
              if (file.mimeType !== type) {
                file.mimeType = type
                changed = true
              }
            }
          }
          if (changed) {
            await tx.store.put(session)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 * 同步记账：清空前先枚举原有会话，替换后消失的写 tombstone，出现的标记待推送。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    [
      'sessions',
      'sessionSummaries',
      'files',
      'sessionsStaging',
      'filesStaging',
      'syncOutbox',
      'syncTombstones',
    ],
    'readwrite'
  )
  // 必须在 clear 之前取到原有键，否则无法为被替换掉的会话写删除标记。
  const previousIds: string[] = []
  const addedIds: string[] = []
  const move = async () => {
    try {
      const sessions = tx.objectStore('sessions')
      const summariesStore = tx.objectStore('sessionSummaries')
      const files = tx.objectStore('files')
      for (const key of await sessions.getAllKeys()) {
        previousIds.push(String(key))
      }
      await sessions.clear()
      await summariesStore.clear()
      await files.clear()
      for (
        let cursor = await tx.objectStore('sessionsStaging').openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        const session = cursor.value as Session
        await sessions.put(session)
        const summary = storedSummary(session)
        await summariesStore.put(summary)
        summaries.push(toSessionSummary(summary))
        addedIds.push(session.id)
      }
      for (
        let cursor = await tx.objectStore('filesStaging').openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await files.put(cursor.value)
      }
      await tx.objectStore('sessionsStaging').clear()
      await tx.objectStore('filesStaging').clear()
      const now = Date.now()
      const added = new Set(addedIds)
      const outbox = tx.objectStore('syncOutbox')
      for (const id of previousIds) {
        if (!added.has(id)) {
          await outbox.delete(id)
          await tx.objectStore('syncTombstones').put({ id, at: now })
        }
      }
      for (const id of addedIds) {
        await outbox.put({ id, at: now })
      }
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move(), tx.done])
  notifyLocalChange()
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 待推送的会话 */
export const loadOutbox = async (): Promise<OutboxEntry[]> => (await getDB()).getAll('syncOutbox')

export const countOutbox = async (): Promise<number> => (await getDB()).count('syncOutbox')

/**
 * 清除已推送的 outbox 项：只有记录未被更新的写入（at 未变）才删除，
 * 避免把推送期间新产生的修改一并清掉。
 */
export const clearOutbox = async (entries: OutboxEntry[]): Promise<void> => {
  if (entries.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('syncOutbox', 'readwrite')
  await Promise.all([
    (async () => {
      for (const entry of entries) {
        const current = await tx.store.get(entry.id)
        if (current && current.at === entry.at) {
          await tx.store.delete(entry.id)
        }
      }
    })(),
    tx.done,
  ])
}

export const loadTombstones = async (): Promise<Tombstone[]> =>
  (await getDB()).getAll('syncTombstones')

export const clearTombstones = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('syncTombstones', 'readwrite')
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
}

/** 空状态每次返回新对象：引擎会就地修改 seqs / watermarks，共享常量会被跨轮次污染 */
const emptySyncState = (): SyncLocalState => ({
  seqs: {},
  watermarks: {},
  pushedDigests: {},
  pushedTombstones: {},
  blobs: {},
})

export const loadSyncState = async (): Promise<SyncLocalState> =>
  (await (await getDB()).get('syncMeta', 'state')) ?? emptySyncState()

/**
 * 保存同步状态。多标签页共享同一条记录，各自只增加自己 deviceId 的 seq 与水位，
 * 因此写入时与已存值合并（seq/水位取大，表项取并集），避免整体覆盖丢掉别的标签页的进度。
 */
export const saveSyncState = async (state: SyncLocalState): Promise<void> => {
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  const current = (await tx.store.get('state')) ?? emptySyncState()
  await tx.store.put(mergeSyncState(current, state), 'state')
  await tx.done
}

const maxRecord = (a: Record<string, number>, b: Record<string, number>) => {
  const merged: Record<string, number> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, value)
  }
  return merged
}

const mergeSyncState = (current: SyncLocalState, next: SyncLocalState): SyncLocalState => ({
  seqs: maxRecord(current.seqs, next.seqs),
  watermarks: maxRecord(current.watermarks, next.watermarks),
  pushedDigests: { ...current.pushedDigests, ...next.pushedDigests },
  pushedTombstones: maxRecord(current.pushedTombstones, next.pushedTombstones),
  blobs: { ...current.blobs, ...next.blobs },
})

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
