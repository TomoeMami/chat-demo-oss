/**
 * AWS Signature Version 4（AWS4-HMAC-SHA256）的纯 WebCrypto 实现。
 *
 * 只依赖 crypto.subtle，不引入 SDK：Cloudflare R2 / Backblaze B2 / AWS S3 / MinIO 等
 * S3 兼容服务都能直接用。算法参考 AWS 文档「Authenticating Requests: Using the
 * Authorization Header (AWS Signature Version 4)」。
 *
 * 调用方负责构造 URL：path 与 query 都要用 awsUriEncode 编码，保证「实际发出的请求」
 * 与「参与签名的 canonical request」使用同一套百分号编码（UTF-8、大写十六进制）。
 */

/** 出现在 Authorization 头部的算法标识 */
const ALGORITHM = 'AWS4-HMAC-SHA256'
/** SigV4 中不做百分号编码的字符集（RFC 3986 unreserved） */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

const encoder = new TextEncoder()

/** 签名参数；除 method / url / 凭据外都可省略 */
export type SigV4Options = {
  /** HTTP 方法，签名时统一转大写 */
  method: string
  /** 完整请求 URL（含 query）；path 与 query 需已按 awsUriEncode 编码 */
  url: string
  /** 参与签名的请求头（如 Range / Content-Type）；Authorization 由本函数生成，不要传入 */
  headers?: Record<string, string>
  /** 请求体，用于计算 payload 哈希；GET / DELETE 不需要 */
  body?: Uint8Array | null
  /** 区域；R2 用 auto，AWS / MinIO 用实际区域 */
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** 服务名，默认 s3 */
  service?: string
  /** 签名时间；缺省为当前时间，自测已知向量时传入固定值 */
  date?: Date
}

/**
 * 按 SigV4 规则做 URI 编码：unreserved 之外全部 %XX。
 * 与 encodeURIComponent 的差别：' ! ( ) * 也会被编码（规范要求）。
 */
export const awsUriEncode = (value: string): string => {
  let encoded = ''
  for (const byte of encoder.encode(value)) {
    const char = String.fromCharCode(byte)
    encoded += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}

/** x-amz-date 用的紧凑 UTC 时间：20130524T000000Z */
const amzDate = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')

/** 逐段解码：URL 里的 path 可能已被编码，也可能含有原文；非法编码按原文处理 */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** CanonicalURI：逐段解码后按 SigV4 规则重编码，保证与 CanonicalURI 的编码一致 */
const canonicalUri = (pathname: string): string =>
  pathname
    .split('/')
    .map((segment) => awsUriEncode(decodeSegment(segment)))
    .join('/')

/** CanonicalQueryString：按编码后的 name、value 排序，空值写成 name= */
const canonicalQuery = (searchParams: URLSearchParams): string => {
  const pairs: { name: string; value: string }[] = []
  searchParams.forEach((value, name) => {
    pairs.push({ name: awsUriEncode(name), value: awsUriEncode(value) })
  })
  pairs.sort((left, right) => {
    if (left.name !== right.name) {
      return left.name < right.name ? -1 : 1
    }
    if (left.value === right.value) {
      return 0
    }
    return left.value < right.value ? -1 : 1
  })
  return pairs.map((pair) => `${pair.name}=${pair.value}`).join('&')
}

/** 请求头值规范化：去掉首尾空白，连续空格/制表符压成一个空格 */
const canonicalHeaderValue = (value: string): string => value.trim().replace(/[ \t]+/g, ' ')

/** 生成 CanonicalHeaders 与 SignedHeaders（名字小写、按字典序） */
const canonicalizeHeaders = (
  headers: Record<string, string>
): { canonical: string; signed: string } => {
  const merged = new Map<string, string>()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    const normalized = canonicalHeaderValue(value)
    const previous = merged.get(key)
    // 同名头按 AWS 规则用逗号连接；本项目的适配器不会传重复头
    merged.set(key, previous === undefined ? normalized : `${previous},${normalized}`)
  }
  const names = [...merged.keys()].sort()
  const lines = names.map((name) => `${name}:${merged.get(name) ?? ''}\n`)
  return { canonical: lines.join(''), signed: names.join(';') }
}

const toHex = (bytes: Uint8Array): string => {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * WebCrypto 的 BufferSource 只接受基于 ArrayBuffer 的视图（SharedArrayBuffer 视图不行），
 * 而调用方传进来的 Uint8Array 泛型参数是 ArrayBufferLike，这里复制一份消除类型歧义。
 */
const toBufferSource = (data: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(data)

/** SHA-256 → 小写十六进制 */
const sha256Hex = async (data: Uint8Array): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(data))))

/** HMAC-SHA256 → 原始字节 */
const hmac = async (key: Uint8Array, message: string): Promise<Uint8Array> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    toBufferSource(encoder.encode(message))
  )
  return new Uint8Array(signature)
}

/** 派生签名密钥：kDate → kRegion → kService → kSigning */
const signingKey = async (
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<Uint8Array> => {
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, service)
  return hmac(serviceKey, 'aws4_request')
}

/**
 * 对一次请求签名。
 *
 * 返回可直接传给 fetch 的 headers：调用方传入并参与签名的头 + host + x-amz-date +
 * x-amz-content-sha256 + Authorization。浏览器会自己生成 Host（同名头会被忽略），
 * 这里仍然返回 host 只是为了签名信息完整，传不传都不影响。
 */
export const signRequest = async (options: SigV4Options): Promise<Record<string, string>> => {
  const url = new URL(options.url)
  const service = options.service ?? 's3'
  const date = options.date ?? new Date()
  const timestamp = amzDate(date)
  const dateStamp = timestamp.slice(0, 8)
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array())

  const headers: Record<string, string> = {
    ...options.headers,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  }
  const { canonical, signed } = canonicalizeHeaders(headers)
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonical,
    signed,
    payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${options.region}/${service}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    timestamp,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join('\n')
  const key = await signingKey(options.secretAccessKey, dateStamp, options.region, service)
  const signature = toHex(await hmac(key, stringToSign))
  // 与 AWS 文档示例保持完全一致（逗号后不加空格），避免个别兼容实现的解析差异
  const authorization =
    `${ALGORITHM} Credential=${options.accessKeyId}/${scope},` +
    `SignedHeaders=${signed},Signature=${signature}`

  return { ...headers, Authorization: authorization }
}
