import { create } from 'zustand'
import type { SyncStatus } from './types.js'

/** 同步状态；界面订阅它显示进度与错误，不参与持久化 */
export const useSyncStatus = create<SyncStatus>(() => ({
  phase: 'disabled',
  lastSyncedAt: null,
  lastError: null,
  pending: 0,
  lastResult: null,
}))

export const setSyncStatus = (patch: Partial<SyncStatus>) => useSyncStatus.setState(patch)

export const resetSyncStatus = () =>
  useSyncStatus.setState({
    phase: 'disabled',
    lastSyncedAt: null,
    lastError: null,
    pending: 0,
    lastResult: null,
  })
