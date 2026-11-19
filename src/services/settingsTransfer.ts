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
 * 方便用户在新设备上一次性恢复。
 *
 * 可选口令加密：PBKDF2(SHA-256) 派生 AES-GCM-256 密钥，导出文件里只有盐、IV 与密文；
 * 口令不上传、不存储在本地，导入时必须输入同一口令。不加密导出仍然支持（含明文密钥，界面会提示）。
 */

/** 明文文件格式标识 */
const SETTINGS_FORMAT = 'chat-demo-settings'
/** 加密文件格式标识；与明文不同，导入时据此判断要不要口令 */
const ENCRYPTED_FORMAT = 'chat-demo-settings-encrypted'
/** 文件格式版本；字段不兼容变更时递增 */
const SETTINGS_VERSION = 1
/** PBKDF2 迭代次数：兼顾手机端耗时与离线暴力破解成本 */
const PBKDF2_ITERATIONS = 310_000
const SALT_BYTES = 16
const IV_BYTES = 12
/** 读取加密文件时接受的迭代次数上限，避免被恶意文件拖死 */
const MAX_ITERATIONS = 10_000_000

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

type EncryptedSettingsFile = {
  format: string
  version: number
  exportedAt: string
  kdf: { name: string; hash: string; iterations: number; salt: string }
  cipher: { name: string; iv: string }
  ciphertext: string
}

/** 文件属于哪一类；导入前先判断，加密文件才需要口令 */
export type SettingsFileKind = 'plain' | 'encrypted' | 'invalid'

/** 导入失败时带回可直接展示的文案 */
export class SettingsTransferError extends Error {
  readonly localMessage: TranslationMessage

  constructor(localMessage: TranslationMessage) {
    super(localMessage.key)
    this.name = 'SettingsTransferError'
    this.localMessage = localMessage
  }
}

const invalidFile = () => new SettingsTransferError({ key: 'settingsImportInvalid' })

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

const buildPayload = (): SettingsFile => ({
  format: SETTINGS_FORMAT,
  version: SETTINGS_VERSION,
  exportedAt: new Date().toISOString(),
  settings: snapshot(),
  sync: readSyncConfig(),
})

const fileName = (suffix = '') => {
  const date = formatDate(new Date()) ?? 'export'
  return `chat-demo-config-${date}${suffix}.json`
}

/** 导出为明文 JSON；文件包含 API Key 与对象存储密钥 */
export const exportSettingsFile = (): { name: string; blob: Blob } => ({
  name: fileName(),
  blob: new Blob([JSON.stringify(buildPayload(), null, 2)], { type: 'application/json' }),
})

/* ------------------------------------------------------------------ 加密 */

const hasWebCrypto = (): boolean =>
  typeof crypto !== 'undefined' && typeof crypto.subtle?.encrypt === 'function'

/** WebCrypto 的 BufferSource 只接受基于 ArrayBuffer 的视图，这里复制一份消除类型歧义 */
const toBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

const BASE64_CHUNK = 0x8000

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK))
  }
  return btoa(binary)
}

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    'raw',
    toBuffer(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** 导出口令加密的 JSON；文件里没有明文密钥，只有盐、IV 与密文 */
export const exportSettingsFileEncrypted = async (
  passphrase: string
): Promise<{ name: string; blob: Blob }> => {
  if (!hasWebCrypto()) {
    throw new SettingsTransferError({ key: 'settingsCryptoUnavailable' })
  }
  if (passphrase.trim() === '') {
    throw new SettingsTransferError({ key: 'settingsPassphraseRequired' })
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(passphrase, salt)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv) },
      key,
      toBuffer(new TextEncoder().encode(JSON.stringify(buildPayload())))
    )
  )
  const file: EncryptedSettingsFile = {
    format: ENCRYPTED_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
    },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
  }
  return {
    name: fileName('.enc'),
    blob: new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
  }
}

/** 校验加密文件的结构，缺字段或算法不认识都按非法文件处理 */
const parseEnvelope = (value: Record<string, unknown>): EncryptedSettingsFile => {
  if (value.version !== SETTINGS_VERSION || !isRecord(value.kdf) || !isRecord(value.cipher)) {
    throw invalidFile()
  }
  const { kdf, cipher } = value
  const iterations = kdf.iterations
  if (
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    cipher.name !== 'AES-GCM' ||
    typeof kdf.salt !== 'string' ||
    typeof cipher.iv !== 'string' ||
    typeof value.ciphertext !== 'string' ||
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations <= 0 ||
    iterations > MAX_ITERATIONS
  ) {
    throw invalidFile()
  }
  return {
    format: ENCRYPTED_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: asString(value.exportedAt) ?? '',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: kdf.salt },
    cipher: { name: 'AES-GCM', iv: cipher.iv },
    ciphertext: value.ciphertext,
  }
}

/** 用口令解密；口令错误（AES-GCM 认证失败）与文件损坏都归为同一个提示 */
const decryptEnvelope = async (
  envelope: EncryptedSettingsFile,
  passphrase: string
): Promise<Record<string, unknown>> => {
  if (!hasWebCrypto()) {
    throw new SettingsTransferError({ key: 'settingsCryptoUnavailable' })
  }
  if (passphrase === '') {
    throw new SettingsTransferError({ key: 'settingsPassphraseRequired' })
  }
  let plain: ArrayBuffer
  try {
    const key = await deriveKey(passphrase, fromBase64(envelope.kdf.salt))
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(fromBase64(envelope.cipher.iv)) },
      key,
      toBuffer(fromBase64(envelope.ciphertext))
    )
  } catch {
    throw new SettingsTransferError({ key: 'settingsDecryptFailed' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw invalidFile()
  }
  if (!isRecord(parsed)) {
    throw invalidFile()
  }
  return parsed
}

/* ------------------------------------------------------------- 应用配置 */

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

/** 应用一份配置载荷（明文载荷或解密后的载荷） */
const applyPayload = (payload: Record<string, unknown>) => {
  if (payload.format !== SETTINGS_FORMAT || payload.version !== SETTINGS_VERSION) {
    throw invalidFile()
  }
  if (isRecord(payload.settings)) {
    applySettings(payload.settings)
  }
  applySync(payload.sync)
  const config = readSyncConfig()
  if (config.enabled && isSyncConfigured(config)) {
    // 导入后立刻拉取一次历史，省去用户再点一次「立即同步」
    void syncNow().catch(() => {})
  }
}

/* --------------------------------------------------------------- 导入 */

const readJson = async (file: File): Promise<unknown> => {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw invalidFile()
  }
  try {
    return JSON.parse(text)
  } catch {
    throw invalidFile()
  }
}

/** 判断文件类型：加密文件需要先输入口令 */
export const inspectSettingsFile = async (file: File): Promise<SettingsFileKind> => {
  let parsed: unknown
  try {
    parsed = await readJson(file)
  } catch {
    return 'invalid'
  }
  if (!isRecord(parsed)) {
    return 'invalid'
  }
  if (parsed.format === ENCRYPTED_FORMAT) {
    return 'encrypted'
  }
  if (parsed.format === SETTINGS_FORMAT) {
    return 'plain'
  }
  return 'invalid'
}

/**
 * 导入配置文件：覆盖本机 API Key、对象存储配置与其他设置。
 * 加密文件必须带口令；明文文件忽略 passphrase。
 */
export const importSettingsFile = async (file: File, passphrase = ''): Promise<void> => {
  const parsed = await readJson(file)
  if (!isRecord(parsed)) {
    throw invalidFile()
  }
  if (parsed.format === ENCRYPTED_FORMAT) {
    const envelope = parseEnvelope(parsed)
    applyPayload(await decryptEnvelope(envelope, passphrase))
    return
  }
  if (parsed.format !== SETTINGS_FORMAT) {
    throw invalidFile()
  }
  applyPayload(parsed)
}
