import * as db from '../chat/db.js'
import { applySyncResults, isSessionBusy } from '../chat/store.js'
import { toSessionSummary, type Session, type SessionSummary } from '../chat/types.js'
import { createAdapter } from './adapters/index.js'
import { canonicalSession, decodeLogEntry, encodeLogEntry, sessionDigest } from './codec.js'
import { getDeviceId, isSyncConfigured, readSyncConfig } from './config.js'
import { mergeSession } from './merge.js'
import { setSyncStatus } from './state.js'
import {
  BLOB_MAX_BYTES,
  PULL_BATCH,
  PUSH_BATCH,
  SYNC_BLOBS_DIR,
  SYNC_DEVICES_DIR,
  SYNC_PROTOCOL_VERSION,
  SyncError,
  type RemoteAdapter,
  type SyncConfig,
  type SyncLocalState,
  type SyncLogEntry,
  type SyncSessionChange,
} from './types.js'

/** 远端 key 一律相对配置里的 prefix：prefix 由适配器持有并拼接 */
const logPrefix = () => `${SYNC_DEVICES_DIR}/`
const logKey = (deviceId: string, seq: number) =>
  `${SYNC_DEVICES_DIR}/${deviceId}/log/${seq}.json.gz`
const blobPrefix = () => `${SYNC_BLOBS_DIR}/`
const blobKey = (fileId: string) => `${SYNC_BLOBS_DIR}/${fileId}`

const LOG_KEY_PATTERN = /([^/]+)\/log\/(\d+)\.json\.gz$/

/** 从记录里移除某个 key（保留不可变更新风格，避免动态 delete） */
const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key))

/** IndexedDB 连接被关闭 / 存储异常时浏览器抛出的错误名 */
const STORAGE_ERROR_NAMES = new Set([
  'InvalidStateError',
  'DatabaseClosedError',
  'UnknownError',
  'QuotaExceededError',
  'DataError',
  'VersionError',
  'NotFoundError',
  'AbortError',
  'TransactionInactiveError',
])

/** 连接已被浏览器关闭：重连后重试通常就能成功（标签页休眠、往返缓存恢复等） */
const isClosedConnectionError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === 'InvalidStateError' || error.name === 'DatabaseClosedError')

const toSyncError = (error: unknown): SyncError => {
  if (error instanceof SyncError) {
    return error
  }
  const name = error instanceof Error ? error.name : ''
  if (name !== '' && STORAGE_ERROR_NAMES.has(name)) {
    return new SyncError('storage', `${name}: ${error instanceof Error ? error.message : ''}`)
  }
  return new SyncError('network', error instanceof Error ? error.message : String(error))
}

/** 读取同步状态；连接被浏览器关闭时重连并重试一次 */
const loadState = async (): Promise<SyncLocalState> => {
  try {
    return await db.loadSyncState()
  } catch (error) {
    if (!isClosedConnectionError(error)) {
      throw error
    }
    db.resetConnection()
    return db.loadSyncState()
  }
}

/** 保存同步状态；同样对「连接已关闭」做一次重连重试 */
const saveState = async (state: SyncLocalState): Promise<void> => {
  try {
    await db.saveSyncState(state)
  } catch (error) {
    if (!isClosedConnectionError(error)) {
      throw error
    }
    db.resetConnection()
    await db.saveSyncState(state)
  }
}

const safeCount = (): Promise<number> => db.countOutbox().catch(() => 0)

/**
 * 单次同步内最多跑多少轮「一批推送 / 一批拉取」。
 * 单条日志最多 PUSH_BATCH 个会话（控制单条日志大小与失败半径），
 * 但导入上千条历史时一次同步应把它们推完，而不是每次点击只推一批。
 */
const ROUND_LIMIT = 500

let running: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** 延后的会话（生成中/待保存）稍后重试一次，避免用户必须手动点同步 */
const scheduleRetry = () => {
  if (retryTimer !== null) {
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    void syncNow().catch(() => {})
  }, 5000)
}

/** 校验配置与连通性（设置页「测试连接」），失败抛 SyncError */
export const testSyncConfig = async (config: SyncConfig): Promise<void> => {
  const endpoint = config.endpoint.trim()
  if (config.backend === 'cos') {
    if (config.region.trim() === '') {
      throw new SyncError('config', 'COS region is required')
    }
    if (endpoint !== '' && !endpoint.startsWith('https://')) {
      throw new SyncError('config', 'Endpoint must use https://')
    }
  } else if (!endpoint.startsWith('https://')) {
    throw new SyncError('config', 'Endpoint must use https://')
  }
  if (
    config.bucket.trim() === '' ||
    config.accessKeyId.trim() === '' ||
    config.secretAccessKey.trim() === ''
  ) {
    throw new SyncError('config', 'Bucket or credentials are missing')
  }
  await createAdapter(config).test()
}

/** 立即同步一次；未启用或未配置时更新状态后返回。同一时刻只跑一轮。 */
export const syncNow = (): Promise<void> => {
  if (running) {
    return running
  }
  running = runSync().finally(() => {
    running = null
  })
  return running
}

const runSync = async (): Promise<void> => {
  try {
    const config = readSyncConfig()
    if (!config.enabled) {
      setSyncStatus({ phase: 'disabled', pending: await safeCount() })
      return
    }
    if (!isSyncConfigured(config)) {
      throw new SyncError('config', 'Sync is not configured')
    }
    const adapter = createAdapter(config)
    const deviceId = getDeviceId()
    // 先读本地同步状态：浏览器可能已经关掉 IndexedDB 连接，loadState 内部会重连重试
    const state = await loadState()
    setSyncStatus({ phase: 'pulling', lastError: null, pending: await safeCount() })
    const pulled = await pull(adapter, config, deviceId, state)
    setSyncStatus({ phase: 'pushing', pending: await safeCount() })
    const { pushed, blobs } = await push(adapter, config, deviceId, state)
    await saveState(state)
    setSyncStatus({
      phase: 'idle',
      lastSyncedAt: Date.now(),
      lastError: null,
      pending: await safeCount(),
      lastResult: { pushed, pulled, blobs },
    })
  } catch (error) {
    // 任何异常都归一化为 SyncError，避免界面只能显示「测试连接失败」这种兜底文案
    const syncError = toSyncError(error)
    setSyncStatus({
      phase: 'error',
      lastError: { kind: syncError.kind, message: syncError.message, status: syncError.status },
      pending: await safeCount(),
    })
    throw syncError
  }
}

/** 列出远端已有的附件 key；关闭附件同步时返回 null */
const blobIndex = async (adapter: RemoteAdapter, config: SyncConfig): Promise<Set<string> | null> =>
  config.syncAttachments
    ? new Set((await adapter.list(blobPrefix())).map((object) => object.key))
    : null

/** 拉取并应用其他设备的日志 */
const pull = async (
  adapter: RemoteAdapter,
  config: SyncConfig,
  deviceId: string,
  state: SyncLocalState
): Promise<number> => {
  const objects = await adapter.list(logPrefix())
  const byDevice = new Map<string, number[]>()
  for (const object of objects) {
    const match = LOG_KEY_PATTERN.exec(object.key)
    if (!match) {
      continue
    }
    const remoteDevice = match[1]
    const seq = Number(match[2])
    if (remoteDevice === deviceId || !Number.isSafeInteger(seq) || seq <= 0) {
      continue
    }
    const seqs = byDevice.get(remoteDevice)
    if (seqs) {
      seqs.push(seq)
    } else {
      byDevice.set(remoteDevice, [seq])
    }
  }
  const availableBlobs = await blobIndex(adapter, config)
  let applied = 0
  for (const [remoteDevice, seqs] of byDevice) {
    const ordered = [...seqs].sort((a, b) => a - b)
    let watermark = state.watermarks[remoteDevice] ?? 0
    // 每轮最多应用 PULL_BATCH 条日志，循环到追平，避免首次同步只拉一部分
    for (let round = 0; round < ROUND_LIMIT; round += 1) {
      const pendingSeqs = ordered.filter((seq) => seq > watermark).slice(0, PULL_BATCH)
      if (pendingSeqs.length === 0) {
        break
      }
      let deferred = false
      for (const seq of pendingSeqs) {
        const bytes = await adapter.get(logKey(remoteDevice, seq))
        if (!bytes) {
          // 日志已被远端清理：跳过并把水位推过去，避免每次重复请求
          state.watermarks[remoteDevice] = seq
          watermark = seq
          continue
        }
        const entry = decodeLogEntry(bytes)
        if (entry.deviceId !== remoteDevice || entry.seq !== seq) {
          throw new SyncError('protocol', 'Log entry does not match its object key')
        }
        const result = await applyEntry(adapter, entry, state, availableBlobs)
        applied += result.applied
        if (result.deferred) {
          // 有会话正在生成/导入：不推进水位，等状态空闲后整条日志重放（put/del 重放是幂等的）
          scheduleRetry()
          deferred = true
          break
        }
        state.watermarks[remoteDevice] = seq
        watermark = seq
        // 每条日志后落一次状态：中途失败不必从头重放
        await saveState(state)
      }
      if (deferred) {
        break
      }
    }
  }
  return applied
}

/** 应用一条日志里的变更；生成中或待保存的会话延后，删除与本地更新比较后决定 */
const applyEntry = async (
  adapter: RemoteAdapter,
  entry: SyncLogEntry,
  state: SyncLocalState,
  availableBlobs: Set<string> | null
): Promise<{ applied: number; deferred: boolean }> => {
  const updated: SessionSummary[] = []
  const deleted: string[] = []
  const pushLater: string[] = []
  let applied = 0
  let deferred = false
  for (const change of entry.sessions) {
    if (change.op === 'del') {
      if (isSessionBusy(change.id)) {
        deferred = true
        continue
      }
      const local = await db.loadSession(change.id)
      state.pushedDigests = withoutKey(state.pushedDigests, change.id)
      if (!local) {
        continue
      }
      // 本地在这次删除之后还有修改（例如刚收到回复）：保留本地，等待下次推送覆盖远端
      if (local.updatedAt > change.at) {
        pushLater.push(change.id)
        continue
      }
      await db.deleteSyncedSession(change.id)
      deleted.push(change.id)
      applied += 1
      continue
    }
    if (isSessionBusy(change.id)) {
      deferred = true
      continue
    }
    const local = await db.loadSession(change.id)
    if (local) {
      const localDigest = await sessionDigest(canonicalSession(local))
      if (localDigest === change.digest) {
        // 内容一致：只记水位，并顺手清掉可能残留的 outbox
        state.pushedDigests[change.id] = change.digest
        continue
      }
    }
    const remote = canonicalSession(change.data)
    const merged = canonicalSession(mergeSession(local, remote))
    const digest = await sessionDigest(merged)
    if (!local || digest !== (await sessionDigest(canonicalSession(local)))) {
      await db.saveSyncedSession(merged)
      updated.push(toSessionSummary(merged))
      applied += 1
      if (availableBlobs) {
        await pullBlobs(adapter, merged, availableBlobs)
      }
    }
    state.pushedDigests[change.id] = change.digest
    if (digest !== change.digest) {
      // 合并结果包含本地新增内容：回推一次，让其他设备收敛
      pushLater.push(change.id)
    }
  }
  if (pushLater.length > 0) {
    await db.markOutbox(pushLater)
  }
  if (updated.length > 0 || deleted.length > 0) {
    applySyncResults(updated, deleted)
  }
  return { applied, deferred }
}

/** Uint8Array -> Blob：跨线程/类型边界安全的复制 */
const toBlob = (bytes: Uint8Array, type: string): Blob => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type })
}

/** 下载会话引用的附件原件；本地已有或远端没有时跳过 */
const pullBlobs = async (
  adapter: RemoteAdapter,
  session: Session,
  availableBlobs: Set<string>
): Promise<void> => {
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      if (await db.loadFile(file.id)) {
        continue
      }
      const key = blobKey(file.id)
      if (!availableBlobs.has(key)) {
        continue
      }
      const bytes = await adapter.get(key)
      if (!bytes) {
        continue
      }
      await db.saveFiles([
        { id: file.id, blob: toBlob(bytes, file.mimeType || 'application/octet-stream') },
      ])
    }
  }
}

/** 把 outbox 与未推送的删除标记写成一条新日志 */
/**
 * 推送一批：单条日志最多 PUSH_BATCH 个会话。
 * progress 表示这一批是否真的减少了待推送项（全是被跳过/无可推时为 false）。
 */
const pushBatch = async (
  adapter: RemoteAdapter,
  config: SyncConfig,
  deviceId: string,
  state: SyncLocalState
): Promise<{ pushed: number; blobs: number; progress: boolean }> => {
  const outbox = await db.loadOutbox()
  const tombstones = await db.loadTombstones()
  const changes: SyncSessionChange[] = []
  const included: db.OutboxEntry[] = []
  const digests = new Map<string, string>()
  for (const entry of outbox.slice(0, PUSH_BATCH)) {
    if (isSessionBusy(entry.id)) {
      scheduleRetry()
      continue
    }
    const session = await db.loadSession(entry.id)
    if (!session) {
      // 会话已删除：删除标记由 tombstone 负责，这里只清掉 outbox
      included.push(entry)
      continue
    }
    const canonical = canonicalSession(session)
    const digest = await sessionDigest(canonical)
    if (digest === state.pushedDigests[entry.id]) {
      included.push(entry)
      continue
    }
    changes.push({ op: 'put', id: entry.id, digest, data: canonical })
    digests.set(entry.id, digest)
    included.push(entry)
  }
  const pendingTombstones = tombstones
    .filter((tombstone) => state.pushedTombstones[tombstone.id] !== tombstone.at)
    .slice(0, PUSH_BATCH)
  for (const tombstone of pendingTombstones) {
    changes.push({ op: 'del', id: tombstone.id, at: tombstone.at })
  }
  let pushed = 0
  let blobs = 0
  if (changes.length > 0) {
    const seq = (state.seqs[deviceId] ?? 0) + 1
    const entry: SyncLogEntry = {
      v: SYNC_PROTOCOL_VERSION,
      deviceId,
      seq,
      at: Date.now(),
      sessions: changes,
    }
    await adapter.put(logKey(deviceId, seq), encodeLogEntry(entry))
    state.seqs[deviceId] = seq
    for (const [id, digest] of digests) {
      state.pushedDigests[id] = digest
    }
    for (const tombstone of pendingTombstones) {
      state.pushedTombstones[tombstone.id] = tombstone.at
      state.pushedDigests = withoutKey(state.pushedDigests, tombstone.id)
    }
    pushed = digests.size
    blobs = config.syncAttachments ? await pushBlobs(adapter, changes, state) : 0
    await saveState(state)
  }
  await db.clearOutbox(included)
  await db.clearTombstones(pendingTombstones.map((tombstone) => tombstone.id))
  return { pushed, blobs, progress: included.length > 0 || pendingTombstones.length > 0 }
}

/** 一次同步把 outbox 推空：导入上千条历史时不必反复点击 */
const push = async (
  adapter: RemoteAdapter,
  config: SyncConfig,
  deviceId: string,
  state: SyncLocalState
): Promise<{ pushed: number; blobs: number }> => {
  let pushed = 0
  let blobs = 0
  for (let round = 0; round < ROUND_LIMIT; round += 1) {
    const result = await pushBatch(adapter, config, deviceId, state)
    pushed += result.pushed
    blobs += result.blobs
    // 让设置页的「待同步」计数跟着减少，用户能看到进度
    setSyncStatus({ pending: await safeCount() })
    if (!result.progress) {
      break
    }
    if ((await db.countOutbox()) === 0) {
      break
    }
  }
  return { pushed, blobs }
}

/** 上传被推送会话引用的附件原件；超过上限或本地已无原件的跳过（只同步元数据） */
const pushBlobs = async (
  adapter: RemoteAdapter,
  changes: SyncSessionChange[],
  state: SyncLocalState
): Promise<number> => {
  let count = 0
  const seen = new Set<string>()
  for (const change of changes) {
    if (change.op !== 'put') {
      continue
    }
    for (const message of change.data.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (seen.has(file.id) || state.blobs[file.id]) {
          continue
        }
        seen.add(file.id)
        const blob = await db.loadFile(file.id)
        if (!blob || blob.size > BLOB_MAX_BYTES) {
          continue
        }
        await adapter.put(blobKey(file.id), new Uint8Array(await blob.arrayBuffer()))
        state.blobs[file.id] = { size: blob.size }
        count += 1
      }
    }
  }
  return count
}
