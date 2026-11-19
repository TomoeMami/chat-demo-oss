import type { SyncConfig } from './types.js'

/** 同步配置存在 localStorage；与 API Key 一样只在本浏览器生效 */
const CONFIG_KEY = 'chat-demo:sync-config'
/** 每个标签页各自一个 deviceId：避免多标签并写同一 seq 前缀导致日志互相覆盖 */
const DEVICE_KEY = 'chat-demo:sync-device'

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  backend: 's3',
  enabled: false,
  endpoint: '',
  bucket: '',
  region: 'auto',
  accessKeyId: '',
  secretAccessKey: '',
  prefix: 'chat-demo',
  syncAttachments: false,
}

const readRaw = (key: string, storage: 'local' | 'session'): string | null => {
  try {
    return (storage === 'local' ? localStorage : sessionStorage).getItem(key)
  } catch {
    return null
  }
}

const writeRaw = (key: string, value: string, storage: 'local' | 'session') => {
  try {
    const target = storage === 'local' ? localStorage : sessionStorage
    target.setItem(key, value)
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const asString = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value : fallback

/** 读配置；字段缺失或类型不符时退回默认值，避免半损坏的记录让整页不可用 */
export const readSyncConfig = (): SyncConfig => {
  const raw = readRaw(CONFIG_KEY, 'local')
  if (!raw) {
    return { ...DEFAULT_SYNC_CONFIG }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_SYNC_CONFIG }
    }
    const value = parsed as Record<string, unknown>
    return {
      backend: value.backend === 'cos' ? 'cos' : 's3',
      enabled: value.enabled === true,
      endpoint: asString(value.endpoint, DEFAULT_SYNC_CONFIG.endpoint),
      bucket: asString(value.bucket, DEFAULT_SYNC_CONFIG.bucket),
      region: asString(value.region, DEFAULT_SYNC_CONFIG.region) || DEFAULT_SYNC_CONFIG.region,
      accessKeyId: asString(value.accessKeyId, DEFAULT_SYNC_CONFIG.accessKeyId),
      secretAccessKey: asString(value.secretAccessKey, DEFAULT_SYNC_CONFIG.secretAccessKey),
      prefix: asString(value.prefix, DEFAULT_SYNC_CONFIG.prefix),
      syncAttachments: value.syncAttachments === true,
    }
  } catch {
    return { ...DEFAULT_SYNC_CONFIG }
  }
}

export const writeSyncConfig = (config: SyncConfig): void => {
  writeRaw(CONFIG_KEY, JSON.stringify(config), 'local')
}

/**
 * 只做本地字段检查（不发请求）。
 * s3 必须有 https endpoint；cos 允许留空（按 region 推导），但填了就必须是 https，避免明文传输历史。
 */
export const isSyncConfigured = (config: SyncConfig): boolean => {
  if (!config.enabled) {
    return false
  }
  if (
    config.bucket.trim() === '' ||
    config.accessKeyId.trim() === '' ||
    config.secretAccessKey.trim() === ''
  ) {
    return false
  }
  if (config.backend === 'cos') {
    const endpoint = config.endpoint.trim()
    return config.region.trim() !== '' && (endpoint === '' || endpoint.startsWith('https://'))
  }
  return config.endpoint.trim().startsWith('https://')
}

const randomId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 当前标签页的写入者标识；sessionStorage 不可用时退化为本页内存值 */
let deviceIdMemory: string | null = null

export const getDeviceId = (): string => {
  const saved = readRaw(DEVICE_KEY, 'session')
  if (saved) {
    return saved
  }
  if (!deviceIdMemory) {
    deviceIdMemory = randomId()
    writeRaw(DEVICE_KEY, deviceIdMemory, 'session')
  }
  return deviceIdMemory
}
