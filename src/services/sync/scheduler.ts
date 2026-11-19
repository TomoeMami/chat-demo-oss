import { readSyncConfig } from './config.js'
import { syncNow } from './engine.js'
import { setLocalChangeListener } from './events.js'

/** 本地写入后延迟推送，避免流式回复期间每条消息都发一次请求 */
const DEBOUNCE_MS = 3000
/** 跨标签页通知：任一标签推送后，其他标签稍后拉取一次 */
const CHANNEL_NAME = 'chat-demo:sync'

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let channel: BroadcastChannel | null = null

const run = () => {
  void syncNow().catch(() => {})
}

const schedule = () => {
  if (!readSyncConfig().enabled) {
    return
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    run()
    channel?.postMessage('changed')
  }, DEBOUNCE_MS)
}

/**
 * 启动同步：第一次拉取 + 注册写入防抖、窗口聚焦、恢复联网与跨标签通知。
 * 返回清理函数，供 React effect 卸载时调用。
 */
export const startSync = (): (() => void) => {
  // 始终注册监听：用户可能在设置里刚打开同步，此时不能要求刷新页面才生效。
  // 是否真的发起请求由 schedule / syncNow 内部按当前配置判断。
  setLocalChangeListener(schedule)
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = () => {
      schedule()
    }
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      run()
    }
  }
  const onOnline = () => run()
  window.addEventListener('focus', run)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisible)
  // 首次进入先拉取远端变更（未启用时 syncNow 直接返回），失败只影响状态提示，不阻塞界面
  if (readSyncConfig().enabled) {
    run()
  }
  return () => {
    setLocalChangeListener(null)
    window.removeEventListener('focus', run)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisible)
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    channel?.close()
    channel = null
  }
}
