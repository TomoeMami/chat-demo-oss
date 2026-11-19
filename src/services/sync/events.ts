/**
 * 本地写事件：数据库写成功后通知同步触发器安排一次推送。
 * 单独成模块且不依赖任何其他模块，避免 db / store / engine 之间形成 import 环。
 */
let listener: (() => void) | null = null

export const setLocalChangeListener = (fn: (() => void) | null) => {
  listener = fn
}

export const notifyLocalChange = () => {
  if (listener) {
    listener()
  }
}
