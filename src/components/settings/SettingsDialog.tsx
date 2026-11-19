import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { readSyncConfig, writeSyncConfig } from '../../services/sync/config.js'
import { syncNow, testSyncConfig } from '../../services/sync/engine.js'
import { useSyncStatus } from '../../services/sync/state.js'
import {
  SyncError,
  type SyncBackend,
  type SyncConfig,
  type SyncErrorKind,
  type SyncPhase,
} from '../../services/sync/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import {
  exportSettingsFile,
  exportSettingsFileEncrypted,
  importSettingsFile,
  inspectSettingsFile,
  SettingsTransferError,
} from '../../services/settingsTransfer.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）、「数据管理」（API Key、导入、导出、
 * 删除）与「同步」（S3 兼容对象存储）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'sync', label: 'settingsSync', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  // 分组内容必须显式分支：新增分组不能落进数据管理分支
  const sectionContent = (() => {
    switch (section) {
      case 'general':
        return (
          <>
            <ThemeSetting />
            <LocaleSetting />
            <TtsVoiceSetting />
            <LocationSetting />
          </>
        )
      case 'data':
        return (
          <>
            <ApiKeyField editor={apiKeyEditor} />
            <ImportHistory historyImport={historyImport} disabled={historyBusy} />
            <ExportHistory disabled={historyBusy} />
            <ExportSettings disabled={historyBusy} />
            <ImportSettings disabled={historyBusy} />
            <SettingCell
              label={t('deleteAllSessions')}
              status={null}
              action={
                <Button
                  variant="dangerOutlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={historyBusy}
                  onClick={historyDelete.open}
                >
                  {t('delete')}
                </Button>
              }
            />
            {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
          </>
        )
      case 'sync':
        return <SyncSetting />
    }
  })()
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {sectionContent}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 同步错误分类 → 提示文案；未知错误（如占位引擎的裸 Error）用通用失败文案。 */
const syncErrorKeys: Record<SyncErrorKind, TranslationKey> = {
  config: 'syncErrorConfig',
  auth: 'syncErrorAuth',
  cors: 'syncErrorCors',
  network: 'syncErrorNetwork',
  server: 'syncErrorServer',
  protocol: 'syncErrorProtocol',
  storage: 'syncErrorStorage',
}

/**
 * 同步失败时给用户看的文案。
 * SyncError 按类型映射；其他异常（例如浏览器抛出的 DOMException）带上原始信息，
 * 避免只显示「测试连接失败」这种无法排查的兜底文案。
 */
const syncErrorMessage = (error: unknown): TranslationMessage =>
  error instanceof SyncError
    ? { key: syncErrorKeys[error.kind] }
    : {
        key: 'syncErrorUnknown',
        params: { message: error instanceof Error ? error.message : String(error) },
      }

/** 状态区只展示进行中与空闲的文案；出错时改由下方错误提示说明。 */
const syncPhaseKeys: Record<SyncPhase, TranslationKey | null> = {
  disabled: null,
  idle: 'syncIdle',
  pulling: 'syncPulling',
  pushing: 'syncPushing',
  error: null,
}

const formatSyncTime = (at: number, locale: string): string =>
  new Date(at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

/**
 * 同步分组：S3 兼容对象存储与腾讯云 COS 的配置、状态与操作。
 * 输入变更立即写回 localStorage（与 API Key 一样只在本浏览器生效），不设「保存」按钮。
 */
const SyncSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const status = useSyncStatus()
  const [config, setConfig] = useState(readSyncConfig)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const update = (patch: Partial<SyncConfig>) => {
    const next = { ...config, ...patch }
    setConfig(next)
    writeSyncConfig(next)
  }

  const backendOptions: { value: SyncBackend; label: string }[] = [
    { value: 's3', label: t('syncBackendS3') },
    { value: 'cos', label: t('syncBackendCos') },
  ]

  const test = async () => {
    if (testing) {
      return
    }
    setTesting(true)
    try {
      await testSyncConfig(readSyncConfig())
      showToast({ key: 'syncTestOk' })
    } catch (error) {
      showToast({ ...syncErrorMessage(error), type: 'error' })
    } finally {
      setTesting(false)
    }
  }

  const runSync = async () => {
    if (syncing) {
      return
    }
    setSyncing(true)
    try {
      await syncNow()
    } catch (error) {
      showToast({ ...syncErrorMessage(error), type: 'error' })
    } finally {
      setSyncing(false)
    }
  }

  const cos = config.backend === 'cos'
  const endpoint = config.endpoint.trim()
  const endpointInvalid = endpoint !== '' && !endpoint.startsWith('https://')
  const phaseKey = syncPhaseKeys[status.phase]
  const syncLabel = syncing
    ? status.phase === 'pulling'
      ? t('syncPulling')
      : t('syncPushing')
    : t('syncNow')

  return (
    <>
      <div className={styles.cell}>
        <div className={styles.description}>{t('syncIntro')}</div>
        <label className={styles.syncEnableRow}>
          <input
            type="checkbox"
            className={styles.syncCheckbox}
            checked={config.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          {t('syncEnable')}
        </label>
      </div>
      <div className={styles.cell}>
        <div className={styles.syncFields}>
          <div className={styles.syncBackendRow}>
            <span className={styles.label}>{t('syncBackend')}</span>
            <Select
              ariaLabel={t('syncBackend')}
              className={styles.syncBackendSelect}
              value={config.backend}
              options={backendOptions}
              onChange={(value) => {
                // 腾讯云 COS 必须用真实地域：沿用 S3/R2 的 auto 会让签名被拒，切换时给一个可用默认值
                const region =
                  value === 'cos' &&
                  (config.region.trim() === '' || config.region.trim() === 'auto')
                    ? 'ap-guangzhou'
                    : undefined
                update(region === undefined ? { backend: value } : { backend: value, region })
              }}
            />
          </div>
          <label className={styles.syncField}>
            <span className={styles.label}>
              {t('syncEndpoint')}
              {cos ? t('syncCosEndpointOptional') : null}
            </span>
            <input
              type="text"
              className={styles.syncInput}
              value={config.endpoint}
              placeholder={
                cos ? 'https://cos.ap-guangzhou.myqcloud.com' : t('syncEndpointPlaceholder')
              }
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ endpoint: event.target.value })}
            />
            {cos ? <span className={styles.syncHint}>{t('syncCosEndpointHint')}</span> : null}
          </label>
          {endpointInvalid ? (
            <div className={styles.syncHintError}>{t('syncHttpsRequired')}</div>
          ) : null}
          <div className={styles.syncFieldRow}>
            <label className={styles.syncField}>
              <span className={styles.label}>{t('syncBucket')}</span>
              <input
                type="text"
                className={styles.syncInput}
                value={config.bucket}
                placeholder={t('syncBucketPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update({ bucket: event.target.value })}
              />
              {cos ? <span className={styles.syncHint}>{t('syncCosBucketHint')}</span> : null}
            </label>
            <label className={styles.syncField}>
              <span className={styles.label}>{t('syncRegion')}</span>
              <input
                type="text"
                className={styles.syncInput}
                value={config.region}
                placeholder={cos ? 'ap-guangzhou' : t('syncRegionPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update({ region: event.target.value })}
              />
              {cos ? <span className={styles.syncHint}>{t('syncCosRegionHint')}</span> : null}
            </label>
          </div>
          <label className={styles.syncField}>
            <span className={styles.label}>{t('syncAccessKey')}</span>
            <input
              type="text"
              className={styles.syncInput}
              value={config.accessKeyId}
              placeholder={t('syncAccessKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ accessKeyId: event.target.value })}
            />
          </label>
          <label className={styles.syncField}>
            <span className={styles.label}>{t('syncSecretKey')}</span>
            <input
              type="password"
              className={styles.syncInput}
              value={config.secretAccessKey}
              placeholder={t('syncSecretKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ secretAccessKey: event.target.value })}
            />
          </label>
          {cos ? <span className={styles.syncHint}>{t('syncCosCredentialHint')}</span> : null}
          <label className={styles.syncField}>
            <span className={styles.label}>{t('syncPrefix')}</span>
            <input
              type="text"
              className={styles.syncInput}
              value={config.prefix}
              placeholder={t('syncPrefixPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ prefix: event.target.value })}
            />
          </label>
          <label className={styles.syncEnableRow}>
            <input
              type="checkbox"
              className={styles.syncCheckbox}
              checked={config.syncAttachments}
              onChange={(event) => update({ syncAttachments: event.target.checked })}
            />
            <span className={styles.syncEnableText}>
              {t('syncAttachments')}
              <span className={styles.syncHint}>{t('syncAttachmentsHint')}</span>
            </span>
          </label>
        </div>
      </div>
      <div className={styles.cell}>
        <div className={styles.syncActions}>
          <Button
            variant="outlined"
            size="m"
            disabled={testing || syncing}
            onClick={() => void test()}
          >
            {testing ? t('syncTesting') : t('syncTest')}
          </Button>
          <Button
            size="m"
            disabled={!config.enabled || testing || syncing}
            onClick={() => void runSync()}
          >
            {syncLabel}
          </Button>
        </div>
        <div className={styles.syncStatus}>
          <div className={styles.syncStats}>
            {phaseKey ? <span>{t(phaseKey)}</span> : null}
            <span>
              {status.lastSyncedAt === null
                ? t('syncNeverSynced')
                : t('syncLastSynced', { time: formatSyncTime(status.lastSyncedAt, locale) })}
            </span>
            <span>{t('syncPendingCount', { count: status.pending })}</span>
          </div>
          {status.lastError ? (
            <div className={styles.error} title={status.lastError.message}>
              {t(syncErrorKeys[status.lastError.kind])}
              {status.lastError.kind === 'cors' ? (
                <div className={styles.syncErrorDetail}>{t('syncCorsHint')}</div>
              ) : null}
              {status.lastError.kind === 'storage' ? (
                <div className={styles.syncErrorDetail}>{status.lastError.message}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 错误文案兜底：非 SettingsTransferError 时带上原始信息，便于排查 */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 导出配置（API Key、对象存储等）为 JSON；可在弹窗里设置口令加密 */
const ExportSettings = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const [opened, setOpened] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  const download = async (encrypted: boolean) => {
    setBusy(true)
    try {
      const { name, blob } = encrypted
        ? await exportSettingsFileEncrypted(passphrase)
        : exportSettingsFile()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showToast({ key: encrypted ? 'settingsExportDoneEncrypted' : 'settingsExportDone' })
      setOpened(false)
      setPassphrase('')
    } catch (error) {
      if (error instanceof SettingsTransferError) {
        showToast({ ...error.localMessage, type: 'error' })
      } else {
        showToast({
          key: 'settingsExportFailed',
          params: { message: messageOf(error) },
          type: 'error',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingCell
        label={t('settingsExportLabel')}
        description={t('settingsExportDescription')}
        status={null}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={disabled || busy}
            onClick={() => {
              setPassphrase('')
              setOpened(true)
            }}
          >
            <IconDownloadOutline16 />
            {t('exportAllDownload')}
          </Button>
        }
      />
      {opened ? (
        <Modal
          title={t('settingsExportLabel')}
          className={styles.importConfirm}
          onClose={() => {
            if (!busy) {
              setOpened(false)
            }
          }}
          footer={
            <div className={styles.deleteActions} aria-busy={busy}>
              <Button variant="outlined" disabled={busy} onClick={() => setOpened(false)}>
                {t('cancel')}
              </Button>
              <Button variant="outlined" disabled={busy} onClick={() => void download(false)}>
                {t('settingsExportPlain')}
              </Button>
              <Button
                disabled={busy || passphrase.trim() === ''}
                onClick={() => void download(true)}
              >
                {t('settingsExportEncrypted')}
              </Button>
            </div>
          }
        >
          <div className={styles.importConfirmText}>{t('settingsExportHint')}</div>
          <label className={styles.syncField}>
            <span className={styles.label}>{t('settingsExportPassword')}</span>
            <input
              type="password"
              className={styles.syncInput}
              value={passphrase}
              placeholder={t('settingsExportPasswordPlaceholder')}
              autoComplete="new-password"
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
        </Modal>
      ) : null}
    </>
  )
}

/** 导入配置：明文直接应用，加密文件先索要口令再解密 */
const ImportSettings = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = async (file: File, secret = '') => {
    setBusy(true)
    try {
      await importSettingsFile(file, secret)
      showToast({ key: 'settingsImportDone' })
      setPending(null)
      setPassphrase('')
    } catch (error) {
      // 口令错误时保留弹窗，方便用户重试
      if (error instanceof SettingsTransferError) {
        showToast({ ...error.localMessage, type: 'error' })
      } else {
        showToast({
          key: 'settingsImportFailed',
          params: { message: messageOf(error) },
          type: 'error',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const onSelect = async (file: File) => {
    const kind = await inspectSettingsFile(file)
    if (kind === 'invalid') {
      showToast({ key: 'settingsImportInvalid', type: 'error' })
      return
    }
    if (kind === 'encrypted') {
      setPassphrase('')
      setPending(file)
      return
    }
    await apply(file)
  }

  return (
    <>
      <SettingCell
        label={t('settingsImportLabel')}
        description={t('settingsImportDescription')}
        status={null}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  void onSelect(file)
                }
              }}
            />
          </>
        }
      />
      {pending ? (
        <Modal
          title={t('settingsImportPasswordTitle')}
          className={styles.importConfirm}
          onClose={() => {
            if (!busy) {
              setPending(null)
            }
          }}
          footer={
            <div className={styles.deleteActions} aria-busy={busy}>
              <Button variant="outlined" disabled={busy} onClick={() => setPending(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={busy || passphrase === ''}
                onClick={() => void apply(pending, passphrase)}
              >
                {t('confirm')}
              </Button>
            </div>
          }
        >
          <label className={styles.syncField}>
            <span className={styles.label}>{t('settingsExportPassword')}</span>
            <input
              type="password"
              className={styles.syncInput}
              value={passphrase}
              placeholder={t('settingsImportPasswordPlaceholder')}
              autoComplete="off"
              autoFocus
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
        </Modal>
      ) : null}
    </>
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
