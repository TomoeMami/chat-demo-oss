# 跨设备历史同步 · 实现说明（v3）

> 目标：用户只填 **API Key** 和 **一个同步方式**（自己的 S3 兼容对象存储），在手机、电脑等所有打开前端页面的浏览器中看到同一份历史。
>
> 已拍板范围：只支持技术用户 + S3 兼容对象存储；**不做端到端加密**（靠 HTTPS 传输，桶的访问控制由用户负责）；不官方托管同步服务；附件可选同步；不同步设置与 API Key。

---

## 1. 为什么必须是「对象存储 + 每设备追加日志」

静态站点没有后端，同步必须有浏览器之外的写入点。用户自备对象存储是唯一不引入官方服务的选择（GitHub Pages 只托管静态文件）。

关键约束：S3/WebDAV/网盘都**没有原子 CAS**，两台设备写同一个 key 必然互相覆盖。因此远端按「写者」划分前缀，永不共享可写对象：

```text
<prefix>/v1/devices/<deviceId>/log/<seq>.json.gz   # 每标签页一条只追加日志
<prefix>/v1/blobs/<fileId>                         # 附件原件（可选）
```

读取方列出所有设备目录，按各自水位增量拉取，合并结果再作为**本设备**的新日志写出。这样任何只支持列出/读/写/删的对象存储都能当后端。

## 2. 数据流

```text
用户操作 ──► store.ts ──► db.saveSession / rename / delete / commitStaging
                                  │  同一 IndexedDB 事务
                                  ├──► sessions / files
                                  └──► syncOutbox（脏标记）/ syncTombstones（删除标记）
                                          │
                          scheduler（防抖 3s / focus / online / 跨标签）
                                          │
                                     engine.runSync
                          ┌───────────────┴───────────────┐
                    pull：list → 增量下载 → 合并 → 写回本地并刷新界面
                    push：outbox → gzip 日志 → PUT 到自己的前缀
```

## 3. 关键设计

### 3.1 变更捕获在 DB 事务内（不漏写）

`syncOutbox` 只记录「哪个会话变脏」，不记录内容：推送时再读最新会话，流式期间的连续保存自然合并为一条。写入与标记在同一事务，事务原子性保证「本地保存成功 ⇒ 一定有待同步项」。

覆盖的写入口（`src/services/chat/db.ts`）：

| 入口 | 同步记账 |
| --- | --- |
| `saveSession` | outbox.put |
| `renameSession` | outbox.put |
| `deleteSession` | outbox.delete + tombstone.put |
| `commitStaging`（导入 / 删除全部） | 清空前枚举旧 key，消失的写 tombstone，出现的写 outbox |

`saveSyncedSession` / `deleteSyncedSession` 供引擎应用远端结果使用，**不**产生 outbox/tombstone，避免删除标记来回传播。

### 3.2 同步单元 = 单会话，消息按 id 并集

不使用整包 ZIP：现有导入是整体替换语义，无法合并两端各自的新增。

- 消息按 `id` 取并集（编辑/重生成都会产生新 id，旧消息基本不可变）；
- 同 id 冲突（仅流式并发）：`blocks` 更长者胜，其次状态优先级 `done > stopped > streaming > pending > error`；
- 双谱系判定：两侧消息 id **完全不相交**且都非空（同一会话被整包导出后再导入过）→ 保留消息更多的一侧，而不是并集出重复消息；
- 元数据：`rootMessageId` 与分支引用取 `updatedAt` 较新的一方；**标题单独用 `titleUpdatedAt` 决胜**（重命名不改变 `updatedAt`，否则对端的改名永远同步不过来）；
- 分支引用（消息上的 `parentId` / `selectedChildId`）取较新会话里那一份，因此一端切换分支后另一端能看到同样的当前位置。

> 说明：`updatedAt` 只在用户操作（发送/编辑/重生成/续写/导入）时更新，流式追加正文不更新它。这恰好符合需要——流式内容靠「blocks 更长者胜」合并，元数据靠 `updatedAt` / `titleUpdatedAt` 决胜。

### 3.3 删除通过 tombstone 传播

- 本地删除 → 写 tombstone → 推送 `del` 变更；
- 应用日志时若有会话正在生成/导入（被延后），**不推进该设备的水位**，稍后整条日志重放（put/del 重放幂等），否则这条日志里的其他变更会被永久跳过；
- 远端删除到达时，若本地 `updatedAt > deletedAt`（本地刚有新回复）则保留本地并回推，覆盖远端删除；
- 「删除所有对话」走 `commitStaging` 空提交，事务内枚举旧会话逐条写 tombstone，避免其他设备把它们当「远端有而本地没有」复活。

### 3.4 传输：gzip + 明文，强制 HTTPS

- `JSON → fflate.gzipSync`，不加密；
- `testSyncConfig` 与 `isSyncConfigured` 都要求 `endpoint` 以 `https://` 开头，避免历史明文走 HTTP；
- 远端内容对桶的所有者可读，README 已明示，桶权限、生命周期与访问控制由用户负责。

### 3.5 多标签页

- 每个标签页一个独立 `deviceId`（`sessionStorage`），各写自己的日志前缀，**不会发生 seq 冲突**，因此不需要主标签选举；
- 共享的 `syncState` 记录在写入时与已存值**合并**（seq/水位取大、表项取并集），避免标签页互相覆盖进度；
- 推送成功后通过 `BroadcastChannel('chat-demo:sync')` 通知其他标签页拉取。

### 3.6 并发与覆盖防护

- 正在生成（`streaming`）、待保存（`unsavedSessions`）、删除中的会话：拉到远端变更时**跳过**并 5 秒后重试，避免用远端快照覆盖内存里正在写的内容；
- 应用远端结果只更新列表摘要并**淘汰详情缓存**，下一次读取从 IndexedDB 拿到合并后的内容；不整对象替换 `sessionCache`（否则流式收尾的 `persist` 会用旧缓存覆盖）；
- 推送清除 outbox 时比对 `at`，推送期间新产生的修改不会被误清；
- 合并结果若比远端多（本地有新增），标记 outbox 回推一次，让其他设备收敛。

### 3.7 附件（可选）

默认只同步文本与附件元数据。开启后：

- 上传：被推送会话引用、本地有原件、≤20MB 的文件 → `v1/blobs/<fileId>`，`syncState.blobs` 记录已传，避免重复；
- 下载：拉取会话时若本地缺原件且远端有 → 写入 IndexedDB `files`；
- 跨设备不复用 `FileAttachment.serverId`（Files API 的 `file_id` 仅账号内有效），codec 规范化时统一置 `null`，首次请求时按现有逻辑补传。

## 4. 协议

```jsonc
{
  "v": 1,
  "deviceId": "9f2c…",
  "seq": 42,
  "at": 1763550000000,
  "sessions": [
    { "op": "put", "id": "…", "digest": "sha256:…", "data": { /* 规范化 Session */ } },
    { "op": "del", "id": "…", "at": 1763549990000 }
  ]
}
```

- `digest` 是规范化会话的 sha256：两端一致就完全跳过，是收敛与去重的核心；
- 单条日志最多 `PUSH_BATCH = 20` 个会话（控制单条对象体积与失败半径），但**一次同步会循环分批直到 outbox 推空**：导入 1200 条历史时点一次「立即同步」即可（60 条日志），不需要反复点击。拉取侧同理，单轮最多应用 `PULL_BATCH = 200` 条日志，循环到水位追平。
- 水位 `watermarks[deviceId] = seq` 存在 `syncState`，每条日志应用后落盘，中断可续；
- 加载时若发现对象与 key 的 `deviceId/seq` 不一致，按协议错误处理（防止日志错位）。

规范化（`codec.canonicalSession`）会剥离本地运行态：`serverId`、`error.localMessage`、`usage`、`thinking.signature`，并把 in-flight 的 `pending/streaming` 视为 `stopped`。

## 5. 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/services/sync/types.ts` | 协议常量、配置、日志条目、错误类型、适配器接口 |
| `src/services/sync/config.ts` | 配置读写（localStorage）、deviceId（sessionStorage）、字段校验 |
| `src/services/sync/codec.ts` | 规范化、sha256 摘要、日志 gzip 编解码与结构校验 |
| `src/services/sync/merge.ts` | 纯函数：消息并集、双谱系判定、元数据决胜、悬空引用修复 |
| `src/services/sync/adapters/` + `sigv4.ts` | 对象存储适配器：SigV4（WebCrypto）、ListObjectsV2 分页、PUT/GET/DELETE；`s3.ts` 同时支持通用 S3（path-style）与腾讯云 COS（virtual-hosted），`index.ts` 按 `backend` 分发 |
| `src/services/sync/engine.ts` | 一次同步的 pull→merge→apply→push，错误归一化与状态上报 |
| `src/services/sync/scheduler.ts` | 启动、防抖、focus/online/visibility、BroadcastChannel |
| `src/services/sync/state.ts` | 同步状态（zustand），供设置页展示 |
| `src/services/sync/events.ts` | 本地写事件总线（避免 db / store / engine 之间循环依赖） |
| `src/services/chat/db.ts` | DB_VERSION 12：outbox / tombstone / syncMeta 存储与事务挂钩 |
| `src/services/chat/store.ts` | `applySyncResults`（刷新界面）、`isSessionBusy`（并发保护） |
| `src/components/settings/*` | 设置 → 同步：字段、测试连接、立即同步、状态与错误提示 |
| `src/app/App.tsx` | 启动同步（`useEffect(startSync, [])`） |

## 6. 用户需要做什么（配置说明）

> 省事做法：在已配置好的设备上「设置 → 数据管理 → 导出配置」，把 `chat-demo-config-*.json` 拷到新设备再「导入配置」，API Key、对象存储与界面设置会一次填好，导入后还会自动拉取一次历史。导出时可设置口令，用 PBKDF2(SHA-256, 310k) + AES-GCM-256 加密成 `*.enc.json`，文件里没有明文密钥；不设口令则导出明文，注意保管。

通用 S3 兼容（R2 / B2 / AWS S3 / MinIO / OSS）：

1. 建桶，拿到 endpoint、region、Access Key、Secret Key；
2. 给桶配 CORS：允许本站来源的 `GET/PUT/DELETE/HEAD` 与 `authorization`、`x-amz-date`、`x-amz-content-sha256` 头，暴露 `ETag`；从 `file://` 打开时 `AllowedOrigins` 必须是 `["*"]`；
3. 设置 → 同步 → 存储类型选「S3 兼容存储」，填 endpoint（必须 `https://`）、bucket、region、AK/SK、可选 prefix，点「测试连接」；
4. 其他设备填同一份配置即可。

腾讯云 COS：

1. 控制台建桶，桶名形如 `<BucketName-APPID>`（如 `chat-1250000000`）；在「访问管理 → API 密钥管理」拿 SecretId / SecretKey；
2. COS 控制台「安全管理 → 跨域访问」加规则：Origin 填站点域名（`file://` 场景填 `*`）、Methods 选 `GET/PUT/DELETE/HEAD`、Allow-Headers 填 `*`；
3. 设置 → 同步 → 存储类型选「腾讯云 COS」，bucket 填带 APPID 的桶名，region 填真实地域（如 `ap-guangzhou`），endpoint 留空即用 `https://cos.<region>.myqcloud.com`（也可填自定义域名）；
4. 寻址固定为 virtual-hosted（`https://<bucket>.cos.<region>.myqcloud.com/<key>`）：2024-01-01 之后创建的 COS 桶不再支持 path-style，官方 S3 兼容文档也要求如此；鉴权仍是 AWS SigV4（service = `s3`，COS 同时支持 V2/V4）。

> 参考：腾讯云《在兼容 S3 的第三方应用中使用 COS 的通用配置》 https://cloud.tencent.cn/document/product/436/41284

## 7. 已知限制与后续

- **不加密**：桶即明文，按拍板要求由用户自行控制权限；需要时可在 codec 层加 AES-GCM（口令派生），不影响协议。
- **日志不压缩**：旧日志不会自动清理（每标签页一个前缀，长期使用对象数会增长）。后续可加「水位已覆盖的日志删除」或按设备汇总压缩。
- **附件用 fileId 作 key**：相同内容不同 fileId 会重复上传；后续可改为 sha256 内容寻址。
- **双谱系只保留一侧**：导出再导入产生的两份历史不会自动融合（避免重复消息），极端场景需要用户手工取舍。
- **`file://` 可用性**：加密未启用，因此不依赖 `crypto.subtle` 的加密能力；但 CORS 与 `sessionStorage` 的行为受浏览器限制，推荐用 https 部署。
- **标题是新增的可选字段**：`Session.titleUpdatedAt` 只参与同步合并、不参与列表排序；旧数据没有该字段时退回用 `updatedAt`。
- **COS 只支持 virtual-hosted 寻址**：2024-01-01 后新建的 COS 桶不支持 path-style；CDN 域名通常不支持 PUT，不建议用作 endpoint。
- 单次同步最多跑 `ROUND_LIMIT = 500` 轮（约 1 万个会话）；超出部分会在下一次触发（聚焦/联网/写入）时继续，状态栏的「待同步」会显示剩余数量。
- 未实现：WebDAV / OAuth 云盘 / 自建中转 / 服务端同步；历史 ZIP 导入导出保持不变；树完整性校验（父在前、无环）只做了悬空引用修复。

## 8. 验证要点

- 设备 A 建会话 → 设备 B 配同一桶并同步 → 列表出现该会话；
- B 回复 → A 聚焦或点同步 → 看到同一条回复（消息并集，不重复）；
- A 删除会话 → B 同步后消失（tombstone），且 A 不会复活；
- A 导入 ZIP 后 B 同步：A 端新会话出现、被替换掉的会话消失；
- 两台设备各自在同一会话追加消息 → 两端最终都含两条分支（消息并集）；
- 生成过程中触发同步：正在生成的会话被跳过，生成结束后自动补一次；
- 多标签页：两个标签同时写，日志不互相覆盖（各自前缀），界面最终收敛。