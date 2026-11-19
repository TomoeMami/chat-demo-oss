# ChatDemoOSS

English | [简体中文](README.zh-CN.md)

A static chat page for the DeepSeek API: no backend of your own, the browser talks to DeepSeek directly and keeps conversations locally. Optionally sync history to **your own object storage** so phones, laptops and every other device show the same records.

## Getting started

1. Open the deployed page (for example `https://<your-user>.github.io/chat-demo-oss/`), or build locally and open `dist/index.html`.
2. Open Settings (bottom-left) → Data, enter your API Key and confirm. The key is verified once.
3. Close the dialog and start chatting.

The API Key and settings stay in this browser's localStorage and are never sent anywhere except DeepSeek.

## Optional: sync across devices (object storage)

Conversations live in the current browser by default. To share one history across all devices, sync it to your own object storage. S3-compatible services and Tencent Cloud COS are supported.

### 1. Prepare a bucket

- **S3-compatible** (Cloudflare R2 / Backblaze B2 / AWS S3 / MinIO, ...): create a private bucket and note endpoint, bucket, region, access key and secret key.
  - R2: endpoint looks like `https://<accountId>.r2.cloudflarestorage.com`, region `auto`
  - B2: endpoint looks like `https://s3.<region>.backblazeb2.com`, region must match the endpoint, key id is the applicationKeyId
  - AWS S3: endpoint looks like `https://s3.<region>.amazonaws.com`, region is the bucket's real region
- **Tencent Cloud COS**: create a bucket whose name includes the APPID (`chat-1250000000`). Use the real region (`ap-guangzhou`). The endpoint may be left empty to derive `https://cos.<region>.myqcloud.com`. Credentials are the console's SecretId / SecretKey.

### 2. Allow CORS on the bucket (required)

The page talks to the bucket straight from the browser, so the bucket must allow cross-origin requests. Otherwise "Test connection" reports that the request was blocked by the browser.

| Setting | Value |
| --- | --- |
| AllowedOrigins | origin of your deployed site; use `*` if you open `dist/index.html` from `file://` |
| AllowedMethods | `GET`, `PUT`, `DELETE`, `HEAD` |
| AllowedHeaders | `authorization`, `x-amz-date`, `x-amz-content-sha256` (or just `*`) |
| ExposeHeaders | `ETag` (optional, helps troubleshooting) |

Where to configure:

- Cloudflare R2: dashboard → R2 → bucket → Settings → CORS Policy
- Backblaze B2: bucket CORS rules (CLI: `b2 update-bucket --cors-rules ...`)
- AWS S3: bucket → Permissions → Cross-origin resource sharing (CORS)
- Tencent Cloud COS: console → bucket → Security Management → Cross-Origin Access (select GET/PUT/DELETE/HEAD, set Allow-Headers to `*`)

### 3. Configure the page

Settings → Sync:

1. Turn on "Enable sync".
2. Pick the storage type and fill in endpoint / bucket / region / access key / secret key / path prefix (default `chat-demo`; the prefix isolates multiple datasets inside one bucket).
3. Enable "Sync attachment originals" if you want images too. Off by default: only text and attachment metadata are synced. When on, local originals are uploaded as well (20 MB per file limit).
4. Click "Test connection", then "Sync now" — or simply wait: sync runs automatically when the page opens, when the window regains focus, when the network comes back, and after local writes.

Enter the **same configuration** on other devices to see the same history. The first sync of a large history is uploaded in batches (the pending counter counts down to 0); no repeated clicking is needed.

### Where the data goes

`<prefix>/v1/devices/<device>/log/<seq>.json.gz` for conversation logs, `<prefix>/v1/blobs/<file-id>` for attachments. The payload is **gzip-compressed plain text, not encrypted**: use a private bucket and manage access control and lifecycle rules yourself. Deleting a conversation on one device removes it from the others.

## Import and export

Settings → Data:

- **Chat history (ZIP)**: "Export all chats" produces a ZIP with every conversation and locally available image originals (no API key). "Import chat history" **replaces** all local conversations and attachments with the ZIP contents.
- **Configuration (JSON)**: "Export configuration" writes the API key, object storage configuration and UI settings into one JSON file. On a new device, "Import configuration" restores it in one step (it overwrites the local configuration and pulls history once when sync is usable). You can set a **passphrase**: the file is then encrypted with AES-GCM and contains only salt, IV and ciphertext, and the same passphrase is required to import. Without a passphrase the file is plain text — keep it safe.

## FAQ

- **"Test connection" says the request was blocked by the browser**: CORS is not configured on the bucket; add the rule above.
- **Authentication failed**: wrong access key / secret key, or the key lacks read/write permission on the bucket.
- **Bucket not found or endpoint mismatch**: check that bucket and endpoint belong to the same region/account. COS bucket names must include the APPID.
- **COS requires a real region**: `auto` (used by R2) is rejected; enter a region such as `ap-guangzhou`.
- **Both devices edited the same conversation**: messages are merged per message id, so additions from both sides survive; the title and active branch follow the newer edit.
- **Is the synced data encrypted?** No. Logs are gzip plain text protected by bucket access control; only the exported configuration JSON supports passphrase encryption.
- **"Sync now" reports a local database error**: the browser closed the page's IndexedDB connection (common after tab sleep or a restore from the back/forward cache). Close other tabs of this site, reload and retry; if it persists, clear this site's data in the browser settings — history can be pulled back from object storage.
- **The page stays on "Loading..."**: another tab of this site may still hold an older version of the local database. Close it and reload.

## Development

```sh
pnpm install
pnpm dev    # http://localhost:8090
pnpm build  # outputs to dist/, ready for static hosting
pnpm type
pnpm lint
```

The build targets `https://api.deepseek.com` by default; change it via `createConfig({ apiOrigin })` in [rspack.config.ts](rspack.config.ts). Protocol and implementation notes: [docs/sync-design.zh-CN.md](docs/sync-design.zh-CN.md) (Chinese).

## License

[MIT](LICENSE)