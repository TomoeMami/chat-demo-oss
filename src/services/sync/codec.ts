import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import type {
  ServerToolBlock,
  ServerToolInput,
  StopDetails,
  TextCitation,
  WebFetchResult,
  WebFetchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from '../api/types.js'
import { normalizeSession } from '../chat/branches.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  Session,
  TextPart,
  ThinkingPart,
  UserMessage,
} from '../chat/types.js'
import {
  SYNC_PROTOCOL_VERSION,
  SyncError,
  type SyncLogEntry,
  type SyncSessionChange,
} from './types.js'

/**
 * 同步载荷编解码：规范化会话（剥离本地运行态字段）、内容摘要、日志条目的 gzip 编解码。
 *
 * 规范化必须「内容相同 → JSON 字节完全相同」：对象一律手工重建、字段顺序固定，
 * 不用展开运算符直接透传原对象，避免不同来源（本地新建 / 历史导入）产生不同顺序或多余字段。
 */

type ReplyError = NonNullable<AssistantMessage['error']>
type WebSearchItem = WebSearchToolResultBlock['content'][number]
type WebFetchContent = WebFetchToolResultBlock['content']

/** 附件：serverId 是 Files API 的 file_id，仅在签发它的账号内有效，跨设备一律置 null */
const canonicalFile = (file: FileAttachment): FileAttachment => ({
  id: file.id,
  serverId: null,
  name: file.name,
  size: file.size,
  isImage: file.isImage,
  mimeType: file.mimeType,
})

const canonicalCitation = (citation: TextCitation): TextCitation => ({
  type: citation.type,
  url: citation.url,
  title: citation.title,
  cited_text: citation.cited_text,
  encrypted_index: citation.encrypted_index,
})

/** 思考块：signature 与本次请求/API Key 绑定，服务端历史也不回传，跨设备剥离 */
const canonicalThinkingPart = (part: ThinkingPart): ThinkingPart => ({
  type: 'thinking',
  thinking: part.thinking,
  ...(part.startedAt === undefined ? {} : { startedAt: part.startedAt }),
  ...(part.endedAt === undefined ? {} : { endedAt: part.endedAt }),
  ...(part.elapsedSeconds === undefined ? {} : { elapsedSeconds: part.elapsedSeconds }),
})

const canonicalTextPart = (part: TextPart): TextPart => ({
  type: 'text',
  text: part.text,
  ...(part.citations === undefined ? {} : { citations: part.citations.map(canonicalCitation) }),
  ...(part.isTemplate === undefined ? {} : { isTemplate: part.isTemplate }),
})

const canonicalToolInput = (input: ServerToolInput): ServerToolInput => {
  switch (input.action) {
    case 'search':
      return {
        action: 'search',
        ...(input.query === undefined ? {} : { query: input.query }),
        queries: [...input.queries],
      }
    case 'open_page':
      return { action: 'open_page', url: input.url }
    case 'find_in_page':
      return { action: 'find_in_page', url: input.url, pattern: input.pattern }
    case 'read_link':
      return { action: 'read_link', url: input.url }
  }
}

const canonicalSearchResult = (result: WebSearchResult): WebSearchResult => ({
  type: 'web_search_result',
  title: result.title,
  url: result.url,
  ...(result.image_url === undefined ? {} : { image_url: result.image_url }),
  snippet: result.snippet,
  site_icon: result.site_icon,
  site_name: result.site_name,
  encrypted_content: result.encrypted_content,
  page_age: result.page_age,
})

const canonicalFetchResult = (result: WebFetchResult): WebFetchResult => ({
  type: 'web_fetch_result',
  url: result.url,
  content: {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: result.content.source.data },
    title: result.content.title,
  },
  published_at: result.published_at,
})

const canonicalSearchItem = (item: WebSearchItem): WebSearchItem =>
  item.type === 'web_search_result'
    ? canonicalSearchResult(item)
    : { type: 'web_search_tool_result_error', error_code: item.error_code }

const canonicalFetchContent = (content: WebFetchContent): WebFetchContent =>
  content.type === 'web_fetch_result'
    ? canonicalFetchResult(content)
    : { type: 'web_fetch_tool_result_error', error_code: content.error_code }

const canonicalToolBlock = (block: ServerToolBlock): ServerToolBlock => {
  switch (block.type) {
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: canonicalToolInput(block.input),
        caller: { type: 'direct' },
        kind: block.kind,
      }
    case 'web_search_tool_result':
      return {
        type: 'web_search_tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content.map(canonicalSearchItem),
        kind: block.kind,
      }
    case 'web_fetch_tool_result':
      return {
        type: 'web_fetch_tool_result',
        tool_use_id: block.tool_use_id,
        content: canonicalFetchContent(block.content),
        kind: block.kind,
        ...(block.signature === undefined ? {} : { signature: block.signature }),
      }
  }
}

const canonicalBlock = (block: ReplyBlock): ReplyBlock => {
  if (block.type === 'thinking') {
    return canonicalThinkingPart(block)
  }
  if (block.type === 'text') {
    return canonicalTextPart(block)
  }
  return canonicalToolBlock(block)
}

/** 错误：localMessage 是 TranslationKey（随界面语言变化），跨设备剥离；保留 kind/message/status/retryable */
const canonicalError = (error: ReplyError): ReplyError => ({
  kind: error.kind,
  message: error.message,
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
})

const canonicalStopDetails = (details: StopDetails): StopDetails => ({
  type: details.type,
  category: details.category,
  explanation: details.explanation,
})

/** pending / streaming 是本地进行态；跨设备一律按已停止处理（同 settleReply 的终态语义） */
const canonicalStatus = (status: ReplyStatus): ReplyStatus =>
  status === 'pending' || status === 'streaming' ? 'stopped' : status

const canonicalUserMessage = (message: UserMessage): UserMessage => ({
  id: message.id,
  role: 'user',
  content: message.content,
  files: message.files.map(canonicalFile),
  createdAt: message.createdAt,
  ...(message.parentId === undefined ? {} : { parentId: message.parentId }),
  ...(message.selectedChildId === undefined ? {} : { selectedChildId: message.selectedChildId }),
})

/** usage 只是本地统计，跨设备不传，顺带减小载荷 */
const canonicalAssistantMessage = (message: AssistantMessage): AssistantMessage => ({
  id: message.id,
  role: 'assistant',
  createdAt: message.createdAt,
  model: message.model,
  ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
  ...(message.search === undefined ? {} : { search: message.search }),
  ...(message.latestReminder === undefined ? {} : { latestReminder: message.latestReminder }),
  prefix: message.prefix,
  status: canonicalStatus(message.status),
  blocks: message.blocks.map(canonicalBlock),
  ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
  ...(message.stopDetails === undefined
    ? {}
    : { stopDetails: canonicalStopDetails(message.stopDetails) }),
  ...(message.error === undefined ? {} : { error: canonicalError(message.error) }),
  ...(message.parentId === undefined ? {} : { parentId: message.parentId }),
  ...(message.selectedChildId === undefined ? {} : { selectedChildId: message.selectedChildId }),
})

const canonicalMessage = (message: Message): Message =>
  message.role === 'user' ? canonicalUserMessage(message) : canonicalAssistantMessage(message)

/** 规范化会话：可跨设备序列化，且同一份内容总是得到相同字节 */
export const canonicalSession = (session: Session): Session => {
  const normalized = normalizeSession(session)
  return {
    id: normalized.id,
    title: normalized.title,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    ...(normalized.titleUpdatedAt === undefined
      ? {}
      : { titleUpdatedAt: normalized.titleUpdatedAt }),
    messages: normalized.messages.map(canonicalMessage),
    rootMessageId: normalized.rootMessageId ?? null,
  }
}

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** 会话内容摘要，用于判断是否需要推送/应用（sha256 小写十六进制） */
export const sessionDigest = async (session: Session): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalSession(session)))
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** 日志条目 -> gzip 字节 */
export const encodeLogEntry = (entry: SyncLogEntry): Uint8Array =>
  gzipSync(strToU8(JSON.stringify(entry)))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 只校验后续会直接使用的字段，避免远端损坏数据变成下游的运行时异常 */
const isSessionPayload = (value: unknown): value is Session => {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.messages) &&
    (value.rootMessageId === undefined ||
      value.rootMessageId === null ||
      typeof value.rootMessageId === 'string')
  )
}

const parseLogEntry = (bytes: Uint8Array): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(gunzipSync(bytes)))
  } catch {
    throw new SyncError('protocol', 'sync log entry is not valid gzip/JSON')
  }
  if (!isRecord(parsed)) {
    throw new SyncError('protocol', 'sync log entry must be a JSON object')
  }
  return parsed
}

/** put 携带完整会话，del 只携带删除时间 */
const decodeChange = (value: unknown): SyncSessionChange => {
  if (!isRecord(value)) {
    throw new SyncError('protocol', 'sync session change must be an object')
  }
  if (value.op === 'put') {
    if (typeof value.id !== 'string' || value.id === '') {
      throw new SyncError('protocol', 'put change is missing a session id')
    }
    if (typeof value.digest !== 'string') {
      throw new SyncError('protocol', `put change for ${value.id} is missing a digest`)
    }
    if (!isSessionPayload(value.data) || value.data.id !== value.id) {
      throw new SyncError('protocol', `put change for ${value.id} carries an invalid session`)
    }
    return { op: 'put', id: value.id, digest: value.digest, data: value.data }
  }
  if (value.op === 'del') {
    if (typeof value.id !== 'string' || value.id === '') {
      throw new SyncError('protocol', 'del change is missing a session id')
    }
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) {
      throw new SyncError('protocol', `del change for ${value.id} is missing a timestamp`)
    }
    return { op: 'del', id: value.id, at: value.at }
  }
  throw new SyncError('protocol', 'sync session change op must be put or del')
}

/** gzip 字节 -> 日志条目；结构不合法时抛 SyncError('protocol') */
export const decodeLogEntry = (bytes: Uint8Array): SyncLogEntry => {
  const entry = parseLogEntry(bytes)
  if (entry.v !== SYNC_PROTOCOL_VERSION) {
    throw new SyncError('protocol', `unsupported sync protocol version: ${String(entry.v)}`)
  }
  if (typeof entry.deviceId !== 'string' || entry.deviceId === '') {
    throw new SyncError('protocol', 'sync log entry is missing a device id')
  }
  if (typeof entry.seq !== 'number' || !Number.isInteger(entry.seq) || entry.seq <= 0) {
    throw new SyncError('protocol', 'sync log entry seq must be a positive integer')
  }
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) {
    throw new SyncError('protocol', 'sync log entry is missing a timestamp')
  }
  if (!Array.isArray(entry.sessions)) {
    throw new SyncError('protocol', 'sync log entry sessions must be an array')
  }
  return {
    v: SYNC_PROTOCOL_VERSION,
    deviceId: entry.deviceId,
    seq: entry.seq,
    at: entry.at,
    sessions: entry.sessions.map(decodeChange),
  }
}
