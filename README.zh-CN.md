# ChatDemoOSS

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天页面：不需要自建后端，浏览器直接请求 DeepSeek 接口，对话保存在本机；可选地把历史同步到**你自己的对象存储**，让手机、电脑等所有设备看到同一份记录。

## 快速上手

1. 打开部署好的页面（例如 `https://<你的用户名>.github.io/chat-demo-oss/`；也可以本地构建后直接打开 `dist/index.html`）。
2. 点左下角「设置」→「数据管理」，填入 API Key，点「确定」（会先校验一次）。
3. 关掉设置，开始聊天。

API Key 与设置只保存在当前浏览器的 localStorage，不会上传到 DeepSeek 以外的服务。

## 可选：多设备同步（对象存储）

对话默认只存在当前浏览器。要让所有设备共享同一份历史，把它同步到你自己的对象存储。支持 S3 兼容服务与腾讯云 COS。

### 1. 准备对象存储

- **S3 兼容**（Cloudflare R2 / Backblaze B2 / AWS S3 / MinIO 等）：建一个私有桶，记下 endpoint、bucket、region、Access Key、Secret Key。
  - R2：endpoint 形如 `https://<accountId>.r2.cloudflarestorage.com`，region 填 `auto`
  - B2：endpoint 形如 `https://s3.<region>.backblazeb2.com`，region 与 endpoint 里的地域一致，Access Key 用 applicationKeyId
  - AWS S3：endpoint 形如 `https://s3.<region>.amazonaws.com`，region 填桶的真实地域
- **腾讯云 COS**：建桶，桶名必须带 APPID（如 `chat-1250000000`）；region 填真实地域（如 `ap-guangzhou`）；endpoint 可留空，会自动使用 `https://cos.<region>.myqcloud.com`；密钥填控制台的 SecretId / SecretKey。

### 2. 让对象存储放行 CORS（必做）

页面是浏览器直接访问对象存储，桶必须允许跨域，否则「测试连接」会报「跨域被拦截」。

| 配置项 | 值 |
| --- | --- |
| 允许来源 AllowedOrigins | 你部署的站点域名；若用 `file://` 打开 `dist/index.html`，填 `*` |
| 允许方法 AllowedMethods | `GET`、`PUT`、`DELETE`、`HEAD` |
| 允许头 AllowedHeaders | `authorization`、`x-amz-date`、`x-amz-content-sha256`（省事可直接填 `*`） |
| 暴露头 ExposeHeaders | `ETag`（可选，便于排查） |

各家入口：

- Cloudflare R2：控制台 → R2 → 目标桶 → Settings → CORS Policy
- Backblaze B2：桶的 CORS Rules（CLI 可用 `b2 update-bucket --cors-rules ...`）
- AWS S3：桶 → 权限 → 跨源资源共享（CORS）
- 腾讯云 COS：控制台 → 桶 → 安全管理 → 跨域访问 CORS 设置（Methods 勾选 GET/PUT/DELETE/HEAD，Allow-Headers 填 `*`）

### 3. 在网页里填写

设置 →「同步」：

1. 打开「启用同步」。
2. 选择存储类型，填写 endpoint / bucket / region / Access Key / Secret Key / 路径前缀（默认 `chat-demo`，同一个桶里多份数据靠它隔离）。
3. 按需打开「同步附件原件」：默认只同步文字与附件信息；开启后额外上传本地图片等原件（单文件上限 20MB）。
4. 点「测试连接」；成功后点「立即同步」，或等自动同步（打开页面、切回窗口、恢复联网、本地写入后都会自动同步）。

其他设备填**同一份配置**即可看到同一份历史。首次同步大量历史时会自动分批传完（设置页的「待同步」会递减到 0），不需要反复点击。

### 数据放在哪里

`<前缀>/v1/devices/<设备>/log/<序号>.json.gz`，附件在 `<前缀>/v1/blobs/<文件ID>`。内容是 **gzip 明文，不加密**：请使用私有桶，并自行管理访问权限与生命周期规则。在一台设备上删除对话，会同步删除其他设备上的同一对话。

## 导入导出

设置 →「数据管理」：

- **历史对话（ZIP）**：「导出所有历史对话」生成 ZIP，包含所有会话与本地可用的图片原件，不含 API Key；「导入历史对话」会用 ZIP **覆盖**本机全部会话与附件。
- **配置（JSON）**：「导出配置」把 API Key、对象存储配置与界面设置导出为一个 JSON；换设备时在新设备「导入配置」即可一次填好（会覆盖本机配置，并在同步可用时自动拉取一次历史）。导出时可设置**口令**：加密后文件只含盐、IV 与密文（AES-GCM），导入时需要同一口令；不设口令则导出明文，请自行保管。

## 常见问题

- **「测试连接」报跨域被拦截**：桶的 CORS 没配好，按上面的规则加一条。
- **报鉴权失败**：Access Key / Secret Key 不对，或该密钥没有这个桶的读写权限。
- **报 bucket 不存在或 endpoint 配错**：检查 bucket 名与 endpoint 是否属于同一地域；COS 的桶名必须带 APPID。
- **COS 要求真实 region**：COS 不能用 R2 的 `auto`，要填 `ap-guangzhou` 这样的地域。
- **两台设备都改过同一个对话**：消息按条合并，两边新增的内容都会保留；标题与当前分支取较新的一次操作。
- **同步内容加密吗**：不加密。同步到对象存储的是 gzip 明文，靠桶的访问控制保护；只有「导出配置」的 JSON 支持口令加密。
- **点「立即同步」报本地数据库读写失败**：浏览器关掉了页面的本地数据库连接（常见于标签页休眠后唤醒、从往返缓存恢复）。关掉本站点的其他标签页后刷新页面重试即可；仍失败时可在浏览器设置里清理本站点数据，历史可以再从对象存储拉回来。
- **页面一直停在「加载中」**：可能有该站点的其他标签页还开着旧版本、占着本地数据库。关掉它们再刷新。

## 开发

```sh
pnpm install
pnpm dev    # http://localhost:8090
pnpm build  # 输出到 dist/，可直接静态托管
pnpm type
pnpm lint
```

构建默认连接 `https://api.deepseek.com`，可在 [rspack.config.ts](rspack.config.ts) 里通过 `createConfig({ apiOrigin })` 修改。同步协议与实现说明见 [docs/sync-design.zh-CN.md](docs/sync-design.zh-CN.md)。

## 许可证

[MIT](LICENSE)