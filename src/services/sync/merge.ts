import { normalizeSession } from '../chat/branches.js'
import type { Message, ReplyStatus, Session } from '../chat/types.js'

/**
 * 会话合并（纯函数，无副作用、无 IO、不依赖 store，便于单测）。
 *
 * 规则编号与 task 描述一致：
 * 1. 本地没有该会话 -> 采用远端。
 * 2. 两侧消息 id 交集为空且都非空 -> 双谱系，保留消息更多的一侧。
 * 3. 否则按 id 并集：以 local 顺序为基准，local 没有的 remote 消息按原顺序追加。
 * 4. 同 id 消息冲突：a 前缀续写取长者；b blocks JSON 更长者胜；c 状态优先级；d 取 local。
 * 5. 元数据（title / rootMessageId）整组取 updatedAt 更新的一方（相等取 local）。
 * 6. createdAt 取 min，updatedAt 取 max。
 * 7. 结果 normalizeSession，并修复悬空引用（parentId / rootMessageId / selectedChildId）。
 */

type SessionMetadata = Pick<Session, 'title' | 'rootMessageId' | 'titleUpdatedAt'>

/** 规则 2：两侧消息 id 是否有交集 */
const hasSharedMessage = (local: Session, remote: Session): boolean => {
  const remoteIds = new Set(remote.messages.map((message) => message.id))
  return local.messages.some((message) => remoteIds.has(message.id))
}

/** 规则 2：双谱系时保留消息更多的一侧；数量相同取 updatedAt 更大者，再相等取 local */
const pickLineage = (local: Session, remote: Session): Session => {
  if (local.messages.length !== remote.messages.length) {
    return local.messages.length > remote.messages.length ? local : remote
  }
  return local.updatedAt >= remote.updatedAt ? local : remote
}

/** 规则 4c：回复状态优先级 done > stopped > streaming > pending > error；提问消息不参与 */
const STATUS_RANK: Record<ReplyStatus, number> = {
  done: 4,
  stopped: 3,
  streaming: 2,
  pending: 1,
  error: 0,
}

const statusRank = (message: Message): number =>
  message.role === 'assistant' ? STATUS_RANK[message.status] : -1

/** 逐个内容块序列化：续写只会在尾部追加整块，按块比较才能识别前缀关系 */
const blockJsons = (message: Message): string[] =>
  message.role === 'assistant' ? message.blocks.map((block) => JSON.stringify(block)) : []

const blocksJsonLength = (message: Message): number =>
  JSON.stringify(message.role === 'assistant' ? message.blocks : []).length

/**
 * 规则 4a：一方 blocks 序列化后是另一方的前缀（续写）-> 取更长的一方。
 * 不是前缀关系时返回 null，交给 4b 按长度比较。
 */
const continuedMessage = (local: Message, remote: Message): Message | null => {
  const localBlocks = blockJsons(local)
  const remoteBlocks = blockJsons(remote)
  const isPrefix = (prefix: string[], full: string[]): boolean =>
    prefix.length < full.length && prefix.every((json, index) => json === full[index])
  if (isPrefix(localBlocks, remoteBlocks)) {
    return remote
  }
  if (isPrefix(remoteBlocks, localBlocks)) {
    return local
  }
  return null
}

/** 规则 4：同 id 消息冲突，4a -> 4b -> 4c -> 4d 依次决胜 */
const resolveMessageConflict = (local: Message, remote: Message): Message => {
  const continued = continuedMessage(local, remote)
  if (continued) {
    return continued
  }
  const localLength = blocksJsonLength(local)
  const remoteLength = blocksJsonLength(remote)
  if (localLength !== remoteLength) {
    return localLength > remoteLength ? local : remote
  }
  const localRank = statusRank(local)
  const remoteRank = statusRank(remote)
  if (localRank !== remoteRank) {
    return localRank > remoteRank ? local : remote
  }
  return local
}

/**
 * 规则 3：按 id 并集，local 顺序为基准；同 id 走规则 4，local 没有的按 remote 顺序追加。
 * 分支引用（parentId / selectedChildId）取较新会话里的那份：否则一端切换分支永远同步不过来。
 */
const unionMessages = (local: Session, remote: Session, newer: Session): Message[] => {
  const remoteById = new Map(remote.messages.map((message) => [message.id, message]))
  const newerById = new Map(newer.messages.map((message) => [message.id, message]))
  const merged = local.messages.map((message) => {
    const counterpart = remoteById.get(message.id)
    const winner = counterpart ? resolveMessageConflict(message, counterpart) : message
    const branchSource = newerById.get(message.id)
    if (!branchSource) {
      return winner
    }
    return {
      ...winner,
      ...(branchSource.parentId === undefined ? {} : { parentId: branchSource.parentId }),
      ...(branchSource.selectedChildId === undefined
        ? {}
        : { selectedChildId: branchSource.selectedChildId }),
    }
  })
  const localIds = new Set(local.messages.map((message) => message.id))
  for (const message of remote.messages) {
    if (!localIds.has(message.id)) {
      merged.push(message)
    }
  }
  return merged
}

/**
 * 规则 5：元数据整组取 updatedAt 更新的一方，不逐字段混合。
 * Session 没有会话级 selectedChildId（它挂在消息上，由规则 7 修复），这里只取 title 与 rootMessageId。
 */
const pickMetadata = (local: Session, remote: Session): SessionMetadata => {
  const newer = local.updatedAt >= remote.updatedAt ? local : remote
  // 标题单独用 titleUpdatedAt 决胜：重命名不会改变 updatedAt，否则对端的改名永远同步不过来
  const localTitleAt = local.titleUpdatedAt ?? local.updatedAt
  const remoteTitleAt = remote.titleUpdatedAt ?? remote.updatedAt
  const titleSource = localTitleAt >= remoteTitleAt ? local : remote
  const titleAt = Math.max(localTitleAt, remoteTitleAt)
  return {
    title: titleSource.title,
    rootMessageId: newer.rootMessageId,
    titleUpdatedAt: titleSource.titleUpdatedAt ?? titleAt,
  }
}

/** 规则 7：悬空 selectedChildId 重算；优先保留创建顺序里最早的子消息（同 normalizeSession 的线性规则） */
const firstChildId = (messages: Message[], parentId: string): string | undefined =>
  messages.find((message) => message.parentId === parentId)?.id

/** 规则 7：修复指向已不存在消息的引用，最后统一交给 normalizeSession */
const repairReferences = (session: Session): Session => {
  const ids = new Set(session.messages.map((message) => message.id))
  const messages = session.messages.map((message) => {
    const parentDangling =
      message.parentId !== undefined && message.parentId !== null && !ids.has(message.parentId)
    const selectedDangling =
      message.selectedChildId !== undefined && !ids.has(message.selectedChildId)
    if (!parentDangling && !selectedDangling) {
      return message
    }
    return {
      ...message,
      ...(parentDangling ? { parentId: null } : {}),
      ...(selectedDangling ? { selectedChildId: firstChildId(session.messages, message.id) } : {}),
    }
  })
  const rootMessageId =
    session.rootMessageId === undefined ||
    session.rootMessageId === null ||
    ids.has(session.rootMessageId)
      ? session.rootMessageId
      : (session.messages[0]?.id ?? null)
  return normalizeSession({ ...session, messages, rootMessageId })
}

export const mergeSession = (local: Session | undefined, remote: Session): Session => {
  // 规则 1：本地没有该会话，直接采用远端
  if (!local) {
    return normalizeSession(remote)
  }
  // 规则 2：双谱系判定先于并集，否则两条独立历史会被交错拼接
  if (local.messages.length > 0 && remote.messages.length > 0 && !hasSharedMessage(local, remote)) {
    return normalizeSession(pickLineage(local, remote))
  }
  // 规则 3 + 4：消息并集与同 id 冲突；较新的会话用于决胜元数据与分支引用
  const newer = local.updatedAt >= remote.updatedAt ? local : remote
  const messages = unionMessages(local, remote, newer)
  // 规则 5：元数据整组 LWW；规则 6：时间范围取并集
  const metadata = pickMetadata(local, remote)
  return repairReferences({
    id: local.id,
    ...metadata,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    messages,
  })
}
