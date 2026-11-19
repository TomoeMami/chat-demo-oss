import { formatDate } from '../utils/format.js'
import type { TranslationMessage } from '../i18n/index.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import {
  setApiKey,
  setLocale,
  setLocation,
  setSearch,
  setSiderCollapsed,
  setThemePreference,
  setThinking,
  setTtsVoice,
  useSettings,
  type Locale,
  type ThemePreference,
} from './settings.js'
import { isSyncConfigured, readSyncConfig, writeSyncConfig } from './sync/config.js'
import { syncNow } from './sync/engine.js'
import type { SyncConfig } from './sync/types.js'

/**
 * 配置导入导出：把 API Key、对象存储（同步）配置与其他本机设置写成一个 JSON，
 * 方便用户在新设备上一次性恢复。文件含密钥，导出时会提示妥善保管。
 */

/** 文件格式标识与版本；字段不兼容变更时递增 version */
const SETTINGS_FORMAT = 'chat-demo-settings'
const SETTINGS_VERSION = 1

type SettingsSnapshot = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

type SettingsFile = {
  format: string
  version: number
  exportedAt: string
  settings: SettingsSnapshot
  sync: SyncConfig
}

/** 导入失败时带回可直接展示的文案 */
export class SettingsTransferError extends Error {
  readonly localMessage: TranslationMessage

  constructor(localMessage: TranslationMessage) {
    super(localMessage.key)
    this.name = 'SettingsTransferError'
    this.localMessage = localMessage
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

const isLocale = (value: unknown): value is Locale => value === 'zh-CN' || value === 'en-US'
const isTheme = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system'
const isTtsVoice = (value: unknown): value is TtsVoice => value === 'stella' || value === 'tide'

/** 当前配置快照，作为导出文件内容 */
const snapshot = (): SettingsSnapshot => {
  const state = useSettings.getState()
  return {
    apiKey: state.apiKey,
    locale: state.locale,
    themePreference: state.themePreference,
    location: state.location,
    ttsVoice: state.ttsVoice,
    thinking: state.thinking,
    search: state.search,
    siderCollapsed: state.siderCollapsed,
  }
}

/** 导出为 JSON 文件内容；文件名带日期，便于区分多次导出 */
export const exportSettingsFile = (): { name: string; blob: Blob } => {
  const file: SettingsFile = {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    settings: snapshot(),
    sync: readSyncConfig(),
  }
  const date = formatDate(new Date()) ?? 'export'
  return {
    name: `chat-demo-config-${date}.json`,
    blob: new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
  }
}

/** 只应用文件里出现的、类型正确的字段，避免半损坏的文件把配置清空 */
const applySettings = (value: Record<string, unknown>) => {
  if ('apiKey' in value) {
    if (value.apiKey === null) {
      setApiKey(null)
    } else {
      const apiKey = asString(value.apiKey)?.trim() ?? ''
      setApiKey(apiKey === '' ? null : apiKey)
    }
  }
  if (isLocale(value.locale)) {
    setLocale(value.locale)
  }
  if (isTheme(value.themePreference)) {
    setThemePreference(value.themePreference)
  }
  if ('location' in value) {
    setLocation(normalizeLocation(value.location))
  }
  if (isTtsVoice(value.ttsVoice)) {
    setTtsVoice(value.ttsVoice)
  }
  const thinking = asBoolean(value.thinking)
  if (thinking !== null) {
    setThinking(thinking)
  }
  const search = asBoolean(value.search)
  if (search !== null) {
    setSearch(search)
  }
  const siderCollapsed = asBoolean(value.siderCollapsed)
  if (siderCollapsed !== null) {
    setSiderCollapsed(siderCollapsed)
  }
}

/** 合并对象存储配置：文件里缺失或不合法的字段保留本机原值 */
const applySync = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false
  }
  const next: SyncConfig = { ...readSyncConfig() }
  if (value.backend === 'cos' || value.backend === 's3') {
    next.backend = value.backend
  }
  const enabled = asBoolean(value.enabled)
  if (enabled !== null) {
    next.enabled = enabled
  }
  for (const key of [
    'endpoint',
    'bucket',
    'region',
    'accessKeyId',
    'secretAccessKey',
    'prefix',
  ] as const) {
    const field = asString(value[key])
    if (field !== null) {
      next[key] = field
    }
  }
  const syncAttachments = asBoolean(value.syncAttachments)
  if (syncAttachments !== null) {
    next.syncAttachments = syncAttachments
  }
  writeSyncConfig(next)
  return true
}

/**
 * 导入配置文件：覆盖本机 API Key、对象存储配置与其他设置。
 * 若导入后同步处于可用状态，立刻拉取一次历史，省去用户再点一次。
 */
export const importSettingsFile = async (file: File): Promise<void> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new SettingsTransferError({ key: 'settingsImportInvalid' })
  }
  if (!isRecord(parsed) || parsed.format !== SETTINGS_FORMAT) {
    throw new SettingsTransferError({ key: 'settingsImportInvalid' })
  }
  if (parsed.version !== SETTINGS_VERSION) {
    throw new SettingsTransferError({ key: 'settingsImportInvalid' })
  }
  if (isRecord(parsed.settings)) {
    applySettings(parsed.settings)
  }
  applySync(parsed.sync)
  const config = readSyncConfig()
  if (config.enabled && isSyncConfigured(config)) {
    void syncNow().catch(() => {})
  }
}
