# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.
- Optional history sync to your own S3-compatible object storage, so conversations stay consistent across browsers and devices.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

### Optional cross-device sync

Settings → Sync can copy conversations to your own S3-compatible object storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO, ...) or Tencent Cloud COS. Fill in the endpoint, bucket, region, access key, secret key, and an optional path prefix. The page must reach the bucket over HTTPS.

For Tencent Cloud COS pick the `Tencent Cloud COS` storage type: the bucket name must include the APPID (`chat-1250000000`), the region is the real region (`ap-guangzhou`), and the endpoint may be left empty to derive `https://cos.<region>.myqcloud.com`. COS buckets created after 2024-01-01 only support virtual-hosted-style addressing, which this adapter uses; access keys are the console's SecretId / SecretKey. Configure CORS on the bucket (Security → Cross-Origin Access) with methods `GET/PUT/DELETE/HEAD` and `Allow-Headers: *`.

- Remote layout: `<prefix>/v1/devices/<device-id>/log/<seq>.json.gz` (append-only log per browser tab) plus `<prefix>/v1/blobs/<file-id>` for attachment originals. Payloads are gzip-compressed JSON and are **not encrypted**; bucket access control and lifecycle rules are your responsibility.
- Configure a CORS rule on the bucket allowing `GET`, `PUT`, `DELETE`, `HEAD` and the headers `authorization`, `x-amz-date`, `x-amz-content-sha256` from this site. `AllowedHeaders: ["*"]` is the simplest; `AllowedOrigins` must be `["*"]` if you also open the build from `file://`. Preflight is required because every request is SigV4-signed.
- Every tab writes only its own log prefix. Other devices pull the logs they have not seen and merge them; deletions propagate as tombstones. Message ids are unioned, so appending on two devices keeps both branches.
- Attachment originals are not synced by default. Enable "sync attachments" to also upload local originals (up to 20 MB per file, otherwise metadata only).
- Your API key and other settings are not synced; they stay in this browser.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
