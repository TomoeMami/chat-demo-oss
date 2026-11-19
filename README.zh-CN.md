# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。
- 可选：把历史同步到自己的 S3 兼容对象存储 / 腾讯云 COS，多个浏览器与设备间保持一致。
- 配置导入导出：把 API Key、对象存储与界面设置导出为 JSON，在新设备上一次性恢复。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

### 配置导入导出

设置 → 数据管理 → 导出配置会生成 `chat-demo-config-日期.json`，包含 API Key、对象存储（同步）配置以及语言、主题、思考/搜索开关等本机设置；在新设备的「导入配置」里选择该文件即可一次性恢复，导入后会覆盖本机当前配置。

导出时可以在弹窗里设置**口令**：

- **设置口令**：文件用 PBKDF2(SHA-256, 31 万次) 派生密钥、AES-GCM-256 加密，命名为 `chat-demo-config-日期.enc.json`，内容只有盐、IV 与密文，不含明文密钥；导入时必须输入同一口令。
- **留空**：导出明文文件（含 API Key 与对象存储密钥），便于迁移但要注意保管。

口令不会保存在本地，也不会随文件或同步上传。当前环境不支持 WebCrypto（非安全上下文）时，加密选项会直接报错提示，改用明文导出。

### 可选：跨设备同步

设置 → 同步 可以把会话复制到用户自己的 S3 兼容对象存储（Cloudflare R2、Backblaze B2、AWS S3、MinIO 等）或腾讯云 COS。需要填写 endpoint、bucket、region、Access Key、Secret Key 与可选的路径前缀，页面需通过 HTTPS 访问该桶。

腾讯云 COS：存储类型选「腾讯云 COS」，桶名必须带 APPID（如 `chat-1250000000`），地域填真实地域（如 `ap-guangzhou`），endpoint 可留空（自动使用 `https://cos.<region>.myqcloud.com`）。2024-01-01 之后创建的 COS 桶只支持 virtual-hosted-style 寻址，本适配器按此实现；访问密钥填控制台的 SecretId / SecretKey。需要在 COS 控制台「安全管理 → 跨域访问」配置 CORS：Methods 选 `GET/PUT/DELETE/HEAD`，Allow-Headers 建议填 `*`。

- 远端结构：`<prefix>/v1/devices/<device-id>/log/<seq>.json.gz`（每个标签页一条只追加的日志），附件原件在 `<prefix>/v1/blobs/<file-id>`。内容为 gzip 压缩的 JSON，**不加密**；桶的访问控制与生命周期策略由使用者负责。
- 需要给桶配置 CORS：允许本站来源的 `GET`、`PUT`、`DELETE`、`HEAD` 以及 `authorization`、`x-amz-date`、`x-amz-content-sha256` 头（`AllowedHeaders: ["*"]` 最省事）。所有请求都用 SigV4 签名，因此必然有预检；若还要用 `file://` 打开产物，`AllowedOrigins` 需为 `["*"]`。
- 每个标签页只写自己的日志前缀；其他设备拉取未见过的日志后合并，删除通过 tombstone 传播。消息按 id 取并集，两台设备各自新增的回复都会保留。
- 附件原件默认不同步；开启「同步附件」后同时上传本地原件（单文件上限 20MB，超出只同步元数据）。
- API Key 与其他设置不参与同步，仍只保存在当前浏览器。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
