import { awsUriEncode, signRequest } from '../sigv4.js'
import { SyncError, type RemoteAdapter, type RemoteObject, type SyncConfig } from '../types.js'

/**
 * S3 兼容对象存储适配器：Cloudflare R2 / Backblaze B2 / AWS S3 / MinIO / 阿里云 OSS，
 * 以及腾讯云 COS（S3 兼容 API，鉴权同为 AWS SigV4，service = s3）。
 *
 * 两种寻址风格，由 config.backend 决定：
 * - path-style（backend = 's3'）：`${endpoint}/${bucket}/${key}`，endpoint 必填；
 * - virtual-hosted（backend = 'cos'）：`https://<bucket>.cos.<region>.myqcloud.com/<key>`，
 *   endpoint 可留空（按 region 推导）；若 endpoint 的 host 已以 `<bucket>.` 开头就直接用，
 *   避免重复拼桶名；endpoint 若带 base path（反向代理场景），把该前缀拼在 key 前面。
 *
 * 其余实现两种后端共用：
 * - key 逐段 encodeURIComponent 后再拼，签名与实际请求共用同一套编码；
 * - 鉴权用 WebCrypto 手写的 SigV4（见 sigv4.ts），不依赖 aws-sdk，也不要求 node；
 * - 对外暴露的 key **相对 config.prefix**（如 `v1/devices/<deviceId>/log/3.json.gz`），
 *   list() 返回的 key 已剥掉 config.prefix，可与 get/put/delete 直接互传。
 */

/** ListObjectsV2 单页最多请求的对象数 */
const PAGE_MAX_KEYS = 1000
/** 一次 list 最多累计的对象数，防止异常分页把内存拉满 */
const MAX_LIST_OBJECTS = 5000
/** test() 探针只需要 1 条：能同时校验连通性、桶名与鉴权 */
const PROBE_MAX_KEYS = 1
/** COS 桶名必须带 APPID 后缀（形如 chat-1250000000），否则无法按桶名访问 */
const COS_APPID_SUFFIX = /-\d+$/

/** 寻址风格：s3 用 path-style，cos 用 virtual-hosted */
type Addressing = 'path' | 'virtual-hosted'

/** 校验并规范化后的连接参数 */
type Target = {
  addressing: Addressing
  /** 桶根 URL，不带尾部斜杠；virtual-hosted 时已含桶名与 endpoint 的 base path */
  baseUrl: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** 去掉首尾斜杠的远端根前缀；空串表示桶根 */
  root: string
}

const trimSlashes = (value: string): string => value.replace(/^\/+/, '').replace(/\/+$/, '')

/** file:// 与内网 http 不是安全上下文，crypto.subtle 会是 undefined */
const hasWebCrypto = (): boolean => typeof globalThis.crypto?.subtle?.digest === 'function'

/** 解析 endpoint 并要求 https；任何失败都归为配置错误 */
const parseEndpoint = (raw: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new SyncError('config', 'endpoint is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new SyncError('config', 'endpoint must start with https://')
  }
  return parsed
}

/** s3 的 path-style 桶根：`${endpoint}/${bucket}`，endpoint 的 base path 原样保留 */
const pathStyleBaseUrl = (endpoint: string, bucket: string): string => {
  if (!endpoint) {
    throw new SyncError('config', 'endpoint is required for S3-compatible storage')
  }
  const parsed = parseEndpoint(endpoint)
  return `${parsed.protocol}//${parsed.host}${trimSlashes(parsed.pathname)}/${awsUriEncode(bucket)}`
}

/**
 * cos 的 virtual-hosted 桶根：桶名放进 host，endpoint 的 base path（反代前缀）保留。
 * endpoint 已经是 `<bucket>.xxx` 时直接用它的 host，避免拼成 `<bucket>.<bucket>.xxx`。
 */
const virtualHostedBaseUrl = (endpoint: URL, bucket: string): string => {
  const basePath = trimSlashes(endpoint.pathname)
  const host = endpoint.host.startsWith(`${bucket}.`) ? endpoint.host : `${bucket}.${endpoint.host}`
  return `https://${host}${basePath ? `/${basePath}` : ''}`
}

/** cos 的 region 必填且要进入 SigV4 credential scope；S3/R2 的占位值 auto 不能用于 COS */
const resolveCosRegion = (raw: string): string => {
  const region = raw.trim()
  if (region === '' || region.toLowerCase() === 'auto') {
    throw new SyncError('config', 'COS region is required; set a real region such as ap-guangzhou')
  }
  return region
}

/** cos 的桶根：endpoint 留空时按 region 推导，填了就用 virtual-hosted 规则拼 */
const resolveCosBaseUrl = (config: SyncConfig, bucket: string, region: string): string => {
  const endpoint = config.endpoint.trim()
  if (!endpoint) {
    return `https://${bucket}.cos.${region}.myqcloud.com`
  }
  return virtualHostedBaseUrl(parseEndpoint(endpoint), bucket)
}

/**
 * 校验配置并规范化。所有操作前都调用一次，配置错误统一抛 SyncError('config')，
 * 这样 createS3Adapter 本身不会抛错，engine 可以安全地提前构造适配器。
 */
const resolveConfig = (config: SyncConfig): Target => {
  if (!hasWebCrypto()) {
    throw new SyncError('config', 'WebCrypto is unavailable; sync requires https (secure context)')
  }
  const bucket = config.bucket.trim()
  if (!bucket) {
    throw new SyncError('config', 'bucket is required')
  }
  const accessKeyId = config.accessKeyId.trim()
  const secretAccessKey = config.secretAccessKey.trim()
  if (!accessKeyId || !secretAccessKey) {
    throw new SyncError('config', 'access key id and secret access key are required')
  }
  const shared = {
    accessKeyId,
    secretAccessKey,
    root: trimSlashes(config.prefix.trim()),
  }
  if (config.backend === 'cos') {
    if (!COS_APPID_SUFFIX.test(bucket)) {
      throw new SyncError(
        'config',
        `COS bucket must end with an APPID, e.g. chat-1250000000 (got ${bucket})`
      )
    }
    const region = resolveCosRegion(config.region)
    return {
      ...shared,
      addressing: 'virtual-hosted',
      baseUrl: resolveCosBaseUrl(config, bucket, region),
      region,
    }
  }
  return {
    ...shared,
    addressing: 'path',
    baseUrl: pathStyleBaseUrl(config.endpoint.trim(), bucket),
    region: config.region.trim() || 'auto',
  }
}

/** key 逐段编码后拼回 '/'：对象名里的空格、?、# 等不会破坏 URL */
const encodeKey = (key: string): string =>
  key
    .split('/')
    .map((segment) => awsUriEncode(segment))
    .join('/')

/** 把相对 key 拼到远端根前缀后面 */
const appendRoot = (root: string, key: string): string => {
  const relative = key.replace(/^\/+/, '')
  if (!root) {
    return relative
  }
  return relative ? `${root}/${relative}` : root
}

/** list 的 S3 前缀：只给 root 时补 '/'，避免把 chat-demo-other/ 也列进来 */
const listPrefixOf = (root: string, prefix: string): string => {
  const relative = prefix.replace(/^\/+/, '')
  if (!root) {
    return relative
  }
  return relative ? `${root}/${relative}` : `${root}/`
}

/** 把 S3 返回的完整 key 还原成相对 config.prefix 的 key */
const stripRoot = (root: string, key: string): string => {
  if (!root) {
    return key
  }
  const head = `${root}/`
  return key.startsWith(head) ? key.slice(head.length) : key
}

const objectUrl = (target: Target, key: string): string => {
  const fullKey = appendRoot(target.root, key)
  if (!fullKey) {
    throw new SyncError('protocol', 'object key must not be empty')
  }
  return `${target.baseUrl}/${encodeKey(fullKey)}`
}

/**
 * list 的 URL 与对象共用同一个 host；virtual-hosted 的桶根显式写出 '/'，
 * path-style 保持 `https://endpoint/bucket?list-type=2` 的原样。
 */
const listUrl = (target: Target, params: string[]): string => {
  const rootSlash = target.addressing === 'virtual-hosted' ? '/' : ''
  return `${target.baseUrl}${rootSlash}?${params.join('&')}`
}

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false

const normalizeFetchError = (error: unknown): SyncError => {
  if (error instanceof SyncError) {
    return error
  }
  if (error instanceof TypeError) {
    // 浏览器在「跨域被拦」与「断网」时都只抛 TypeError；离线时可确定是网络问题
    if (isOffline()) {
      return new SyncError('network', 'network is offline')
    }
    return new SyncError('cors', error.message || 'request was blocked by the browser')
  }
  return new SyncError('network', error instanceof Error ? error.message : String(error))
}

/** 从 S3 错误响应里取 <Code>/<Message>，取不到就退化为正文片段 */
const readErrorDetail = async (response: Response): Promise<string> => {
  let text: string
  try {
    text = await response.text()
  } catch {
    return ''
  }
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    const message = doc.getElementsByTagNameNS('*', 'Message')[0]?.textContent ?? ''
    const code = doc.getElementsByTagNameNS('*', 'Code')[0]?.textContent ?? ''
    return message || code || text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}

/**
 * 非 2xx 响应归一化。
 * 401/403 → auth，404 → config（endpoint/bucket 配错），5xx → server，其余 → network。
 * COS 的 InvalidAccessKeyId / SignatureDoesNotMatch 同样是 403，会落到 auth，不会被误判成 cors。
 */
const ensureOk = async (response: Response, action: string): Promise<void> => {
  if (response.ok) {
    return
  }
  const detail = await readErrorDetail(response)
  const message = detail || `${action} failed with status ${response.status}`
  if (response.status === 401 || response.status === 403) {
    throw new SyncError('auth', message, response.status)
  }
  if (response.status === 404) {
    throw new SyncError('config', message, response.status)
  }
  if (response.status >= 500) {
    throw new SyncError('server', message, response.status)
  }
  throw new SyncError('network', message, response.status)
}

const readBodyBytes = async (response: Response): Promise<Uint8Array> => {
  try {
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new SyncError('network', error instanceof Error ? error.message : String(error))
  }
}

const readBodyText = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch (error) {
    throw new SyncError('network', error instanceof Error ? error.message : String(error))
  }
}

/** 签名并发送一次请求；只做网络层归一化，状态码交给调用方判断 */
const signedFetch = async (
  target: Target,
  method: string,
  url: string,
  body?: Uint8Array
): Promise<Response> => {
  let headers: Record<string, string>
  try {
    headers = await signRequest({
      method,
      url,
      body,
      region: target.region,
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    })
  } catch (error) {
    // 签名阶段只可能因为 WebCrypto 不可用 / URL 非法失败，归为配置错误
    throw new SyncError('config', error instanceof Error ? error.message : String(error))
  }
  // host 只参与签名（SigV4 的 CanonicalHeaders），不能真的发给 fetch：浏览器禁止设置 Host
  const requestHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host')
  )
  // 不设置 Content-Type：减少一次 CORS 预检头，S3 用默认 application/octet-stream 即可
  const init: RequestInit = { method, headers: requestHeaders }
  if (body) {
    init.body = new Uint8Array(body)
  }
  try {
    return await fetch(url, init)
  } catch (error) {
    throw normalizeFetchError(error)
  }
}

type ListPage = {
  objects: RemoteObject[]
  truncated: boolean
  nextToken: string | null
}

const parseXml = (text: string): Document => {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (
    doc.documentElement.nodeName.toLowerCase() === 'parsererror' ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    throw new SyncError('protocol', 'list response is not valid XML')
  }
  return doc
}

/** 读后代元素的文本（按 localName 匹配，忽略命名空间前缀） */
const readText = (parent: Element, name: string): string | null => {
  const element = parent.getElementsByTagNameNS('*', name)[0]
  return element ? element.textContent : null
}

const parseListPage = (target: Target, text: string): ListPage => {
  const doc = parseXml(text)
  const result = doc.documentElement
  if (result.localName !== 'ListBucketResult') {
    throw new SyncError('protocol', 'unexpected list response root element')
  }
  const truncatedText = readText(result, 'IsTruncated')
  if (truncatedText === null) {
    throw new SyncError('protocol', 'list response is missing IsTruncated')
  }
  const objects: RemoteObject[] = []
  for (const node of result.getElementsByTagNameNS('*', 'Contents')) {
    const key = readText(node, 'Key')
    if (!key) {
      throw new SyncError('protocol', 'list response contains an object without a key')
    }
    const sizeText = readText(node, 'Size')
    const size = sizeText === null ? 0 : Number(sizeText)
    if (!Number.isFinite(size) || size < 0) {
      throw new SyncError('protocol', 'list response contains an invalid object size')
    }
    const lastModifiedText = readText(node, 'LastModified')
    const lastModified = lastModifiedText === null ? Number.NaN : Date.parse(lastModifiedText)
    objects.push({
      key: stripRoot(target.root, key),
      size,
      lastModified: Number.isFinite(lastModified) ? lastModified : undefined,
    })
  }
  const nextToken = readText(result, 'NextContinuationToken')
  return {
    objects,
    truncated: truncatedText.trim().toLowerCase() === 'true',
    nextToken: nextToken || null,
  }
}

/** ListObjectsV2 取一页；continuation-token 由调用方传回 */
const requestListPage = async (
  target: Target,
  s3Prefix: string,
  maxKeys: number,
  token: string | null
): Promise<ListPage> => {
  const params = ['list-type=2', `max-keys=${maxKeys}`, `prefix=${awsUriEncode(s3Prefix)}`]
  if (token !== null) {
    params.push(`continuation-token=${awsUriEncode(token)}`)
  }
  const response = await signedFetch(target, 'GET', listUrl(target, params))
  await ensureOk(response, 'list objects')
  return parseListPage(target, await readBodyText(response))
}

/** ListObjectsV2 全量分页；最多累计 MAX_LIST_OBJECTS 条 */
const listObjects = async (config: SyncConfig, prefix: string): Promise<RemoteObject[]> => {
  const target = resolveConfig(config)
  const s3Prefix = listPrefixOf(target.root, prefix)
  const objects: RemoteObject[] = []
  const seenTokens = new Set<string>()
  let token: string | null = null
  let truncated = true
  while (truncated && objects.length < MAX_LIST_OBJECTS) {
    const page = await requestListPage(target, s3Prefix, PAGE_MAX_KEYS, token)
    for (const object of page.objects) {
      if (objects.length >= MAX_LIST_OBJECTS) {
        break
      }
      objects.push(object)
    }
    if (!page.truncated || objects.length >= MAX_LIST_OBJECTS) {
      break
    }
    if (!page.nextToken) {
      throw new SyncError('protocol', 'list response is truncated without a continuation token')
    }
    if (seenTokens.has(page.nextToken)) {
      throw new SyncError('protocol', 'list response repeats a continuation token')
    }
    seenTokens.add(page.nextToken)
    token = page.nextToken
  }
  return objects
}

/** 读对象；不存在（404）返回 null，不抛错 */
const getObject = async (config: SyncConfig, key: string): Promise<Uint8Array | null> => {
  const target = resolveConfig(config)
  const response = await signedFetch(target, 'GET', objectUrl(target, key))
  if (response.status === 404) {
    return null
  }
  await ensureOk(response, 'get object')
  return readBodyBytes(response)
}

/** 直接 PUT 字节，不额外设置 Content-Type */
const putObject = async (config: SyncConfig, key: string, bytes: Uint8Array): Promise<void> => {
  const target = resolveConfig(config)
  const response = await signedFetch(target, 'PUT', objectUrl(target, key), bytes)
  await ensureOk(response, 'put object')
}

/** 删除对象；对象本来就不存在（404）视为成功 */
const removeObject = async (config: SyncConfig, key: string): Promise<void> => {
  const target = resolveConfig(config)
  const response = await signedFetch(target, 'DELETE', objectUrl(target, key))
  if (response.status === 404) {
    return
  }
  await ensureOk(response, 'delete object')
}

/** 用 max-keys=1 的 list 探针校验连通性、桶名与鉴权 */
const probe = async (config: SyncConfig): Promise<void> => {
  const target = resolveConfig(config)
  await requestListPage(target, listPrefixOf(target.root, ''), PROBE_MAX_KEYS, null)
}

/**
 * 创建 S3 兼容适配器（backend = 's3' | 'cos'）。纯浏览器实现：手写 SigV4，无 npm 依赖，
 * 寻址风格与默认端点由 config.backend 决定（见文件头注释）。
 *
 * key 相对 config.prefix，例如 list('v1/devices/') 返回 'v1/devices/<id>/log/1.json.gz'，
 * 该 key 可直接传给 get/put/delete。
 */
export const createS3Adapter = (config: SyncConfig): RemoteAdapter => ({
  id: config.backend,
  test: () => probe(config),
  list: (prefix) => listObjects(config, prefix),
  get: (key) => getObject(config, key),
  put: (key, bytes) => putObject(config, key, bytes),
  delete: (key) => removeObject(config, key),
})
