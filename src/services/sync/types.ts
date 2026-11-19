import type { Session } from '../chat/types.js'

/** 同步协议版本；远端日志条目结构不兼容变更时递增 */
export const SYNC_PROTOCOL_VERSION = 1

/** 远端根目录（相对配置里的 prefix） */
export const SYNC_DIR = 'v1'
/** 每设备独占前缀，规避对象存储没有原子 CAS 的问题 */
export const SYNC_DEVICES_DIR = `${SYNC_DIR}/devices`
/** 附件原件，按本地 fileId 命名 */
export const SYNC_BLOBS_DIR = `${SYNC_DIR}/blobs`

/** 单次推送的会话数上限，避免单条日志过大 */
export const PUSH_BATCH = 20
/** 单个附件同步上限（字节），超出只保留元数据 */
export const BLOB_MAX_BYTES = 20 * 1024 * 1024
/** 一次拉取最多应用的日志条数，防止初次同步过久 */
export const PULL_BATCH = 200

/**
 * 同步后端类型。两者都走 S3 兼容 API + AWS SigV4，只是寻址与默认端点不同：
 * - s3：通用 S3 兼容服务（R2 / B2 / AWS / MinIO / OSS），path-style，endpoint 必填；
 * - cos：腾讯云对象存储，virtual-hosted，endpoint 可留空由 region 推导。
 */
export type SyncBackend = 's3' | 'cos'

/** S3 兼容对象存储的连接配置 */
export type SyncConfig = {
  backend: SyncBackend
  enabled: boolean
  /**
   * 服务端点。s3 必填（如 https://<account>.r2.cloudflarestorage.com）；
   * cos 可留空，留空时按 region 推导 https://cos.<region>.myqcloud.com。
   * 只要填写就必须以 https:// 开头。
   */
  endpoint: string
  bucket: string
  /** AWS 区域；R2 用 auto，其他兼容服务按服务商要求 */
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** 远端根前缀，默认 chat-demo，用于隔离同一桶内的其他数据 */
  prefix: string
  /** 是否同步附件原件；关闭时只同步会话文本与附件元数据 */
  syncAttachments: boolean
}

/** 一条会话变更：put 携带完整会话，del 只带删除时间 */
export type SyncSessionChange =
  | { op: 'put'; id: string; digest: string; data: Session }
  | { op: 'del'; id: string; at: number }

/** 一次推送写出的日志条目，gzip 后作为一个对象存放 */
export type SyncLogEntry = {
  v: number
  deviceId: string
  seq: number
  /** 写入时间，用于排查与日志清理 */
  at: number
  sessions: SyncSessionChange[]
}

/** 同步错误分类；界面按类别给出不同提示（跨域、鉴权、网络等） */
export type SyncErrorKind =
  | 'config'
  | 'auth'
  | 'cors'
  | 'network'
  | 'server'
  | 'protocol'
  /** 本地数据库读写失败（连接被浏览器关闭、存储被清理或损坏） */
  | 'storage'

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

export type RemoteObject = {
  key: string
  size: number
  lastModified?: number
}

/** 最小远端能力：列出、读、写、删；对象存储与自建服务都能实现 */
export type RemoteAdapter = {
  readonly id: SyncBackend
  /** 校验配置与连通性，失败时抛出 SyncError */
  test(): Promise<void>
  list(prefix: string): Promise<RemoteObject[]>
  /** 不存在时返回 null，而不是抛错 */
  get(key: string): Promise<Uint8Array | null>
  put(key: string, bytes: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
}

export type SyncPhase = 'disabled' | 'idle' | 'pulling' | 'pushing' | 'error'

export type SyncStatus = {
  phase: SyncPhase
  lastSyncedAt: number | null
  lastError: { kind: SyncErrorKind; message: string; status?: number } | null
  /** 待推送的会话数（outbox 大小） */
  pending: number
  lastResult: { pushed: number; pulled: number; blobs: number } | null
}

/**
 * 本地同步状态，整体存在 IndexedDB 的 syncMeta 里。
 * seqs / watermarks 按 deviceId 记：每个标签页/设备各写自己的日志前缀。
 */
export type SyncLocalState = {
  /** deviceId -> 已写入的最大 seq */
  seqs: Record<string, number>
  /** deviceId -> 已应用的最大 seq */
  watermarks: Record<string, number>
  /** sessionId -> 最近一次成功推送的会话摘要，内容没变就不重复推 */
  pushedDigests: Record<string, string>
  /** sessionId -> 最近一次成功推送的删除时间 */
  pushedTombstones: Record<string, number>
  /** fileId -> 已上传的附件信息 */
  blobs: Record<string, { size: number }>
}

export const EMPTY_SYNC_STATE: SyncLocalState = {
  seqs: {},
  watermarks: {},
  pushedDigests: {},
  pushedTombstones: {},
  blobs: {},
}
