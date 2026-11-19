import type { RemoteAdapter, SyncConfig } from '../types.js'
import { createS3Adapter } from './s3.js'

/**
 * 按后端类型创建适配器。
 * s3 与 cos 都走 S3 兼容 API + AWS SigV4，差异只在寻址风格与默认端点，
 * 由 s3.ts 按 config.backend 处理，这里统一转交即可。
 */
export const createAdapter = (config: SyncConfig): RemoteAdapter => createS3Adapter(config)
