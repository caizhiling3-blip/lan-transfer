# 1.2 文件夹传输设计

## 目标与边界

1.2 支持选择或拖拽一个文件夹，保留相对目录结构、普通文件和空目录，通过现有局域网连接逐文件串行传输。接收方对整个文件夹确认一次；传输完成后历史中写入一条文件夹任务摘要。

本版本不支持符号链接、快捷方式跟随、文件夹同步、权限与扩展属性复制、断点续传、暂停恢复、并行上传或压缩打包。扫描到符号链接时整个选择失败，不静默跳过，避免用户误以为内容已完整发送。

## 固定限制

| 限制                    | 默认与硬上限 |
| ----------------------- | ------------ |
| 单文件大小              | 2 GiB        |
| 单文件夹普通文件数量    | 1,000        |
| 单文件夹总大小          | 10 GiB       |
| 目录深度                | 20 层        |
| 单个相对路径 UTF-8 长度 | 512 字节     |
| 单路径段 UTF-8 长度     | 255 字节     |
| 空目录数量              | 1,000        |
| manifest 编码后大小     | 2 MiB        |
| manifest 分片数量       | 32           |
| 单次顶层待发送项目数量  | 10           |
| 文件夹扫描时间          | 30 秒        |
| 文件夹任务总时限        | 4 小时       |
| 单个 HTTP 流空闲时间    | 30 秒        |

这些值后续统一定义于 `src/shared/constants`。设置页暂不开放修改文件数量、目录深度、manifest 大小和任务总时限，避免对端之间出现不一致策略。

## Manifest

文件夹使用 transferId 作为任务和顶层文件夹标识，不额外增加 folderId。文件仍使用独立 fileId。

```ts
interface FolderManifest {
  transferId: TransferId
  displayName: string
  totalSize: number
  files: readonly FolderFileEntry[]
  emptyDirectories: readonly string[]
}

interface FolderFileEntry {
  fileId: FileId
  relativePath: string
  size: number
  mimeType: string
}
```

manifest 文件按规范化 relativePath 升序排列，空目录同样排序。文件 relativePath 与 emptyDirectories 不得重复，且不得出现文件与其父路径同名、同一路径同时为文件和目录、或经过跨平台规范化后冲突的条目。

## 相对路径规则

网络协议中的路径统一使用 `/`，不使用当前操作系统分隔符。接收端只在完成协议校验后按路径段调用 `path.join` 和 `path.resolve`。

每个 relativePath 必须满足：

- 必须是非空相对路径，不得以 `/` 或 `\\` 开头；
- 不得包含 Windows 盘符、UNC 前缀、NUL、控制字符或反斜杠；
- 不得包含空路径段、`.` 或 `..`；
- 每个路径段都通过现有跨平台安全文件名规则；
- Unicode 统一规范化为 NFC；
- 深度不超过 20，完整 UTF-8 长度不超过 512 字节；
- 使用 NFC、小写和 Windows 尾随规则生成可移植 collision key；collision key 重复时拒绝整个 manifest；
- 接收端解析后必须验证 `path.resolve(stagingRoot, ...segments)` 仍位于 stagingRoot 内。

发送端扫描和接收端 manifest 校验都执行上述规则。远端永远不能提供绝对源路径、接收目录或最终系统路径。

## 扫描与选择授权

系统文件夹选择器或 Preload 包装的拖拽入口只把选中对象交给主进程。主进程递归扫描时：

1. 对根目录和每个条目使用 lstat；
2. 遇到符号链接、非普通文件或非目录条目立即失败；
3. 持续累计文件数、空目录数、总大小、深度和编码大小，达到限制立即终止；
4. 为每个普通文件记录设备号、inode、大小和修改时间；
5. 生成短期 selectionToken，真实根路径和文件路径只保存在主进程；
6. renderer 只得到文件夹名称、文件数、总大小和 selectionToken。

上传每个文件前重新打开并核对文件身份、大小和修改时间。文件夹扫描后新增、删除或替换内容不会被静默纳入原任务；不一致时任务失败并提示重新选择。

阶段 2 已实现扫描器、系统文件夹选择、文件/文件夹混合拖拽、一次性 folder selectionToken 和 renderer 摘要预览。阶段 3 已实现 offer、manifest 分片、完整性与路径冲突校验、接收确认和 token 消费。阶段 4 已实现任务级 uploadKey、逐文件 HMAC 授权、串行 HTTP 流、空目录、进度/速度、取消、超时和 staging 清理。

## 协议版本与 Manifest 分片

文件夹能力使用协议版本 2。原因是 hello/welcome 和消息 schema 当前为 strict，版本 1 客户端无法安全协商新能力。v1 与 v2 连接必须返回 `PROTOCOL_INVALID` 并在 UI 显示双方版本不一致；本版本不维护双协议栈。

单条 WebSocket 消息继续限制为 128 KiB。最大 2 MiB manifest 不作为一个消息发送，而是：

1. `folder:offer` 发送摘要、manifestId、分片数量和 manifest SHA-256；
2. `folder:manifest` 按顺序发送最多 32 个分片，每片解码后仍必须小于 WebSocket 限制；
3. 接收端在有界内存中组装，持续校验 transferId、manifestId、索引、重复分片和总编码大小；
4. 分片齐全后验证 SHA-256、文件数量、空目录数量和总大小；
5. 只有完整 manifest 通过校验后才向 renderer 投影接收确认。

manifest SHA-256 只用于确认分片组装一致，不等同于文件内容完整性校验。文件内容 SHA-256 留到后续专项版本。

## WebSocket 状态机

新增消息：

```text
folder:offer
folder:manifest
folder:accept
folder:reject
folder:cancel
folder:progress
folder:complete
folder:error
```

发送状态：

```text
scanning -> ready -> offering -> awaitingAcceptance -> accepted
         -> transferring -> publishing -> completed
         -> rejected | cancelled | failed
```

接收状态：

```text
receivingManifest -> awaitingAcceptance -> accepted
                  -> transferring -> publishing -> completed
                  -> rejected | cancelled | failed
```

状态规则：

- manifest 不完整、摘要不一致、超限或超时不能进入 awaitingAcceptance；
- accept 只发送一个文件夹级 uploadKey 和 expiresAt，避免 1,000 个 token 超过 WS 限制；
- 每个文件的 HTTP bearer token 使用 HMAC-SHA-256 从 uploadKey、transferId 和 fileId 派生；
- 接收端只接受 manifest 顺序中的当前 fileId，每个派生 token 只消费一次；
- progress 必须单调且不能超过 manifest 总大小；
- complete 前必须完成全部普通文件、创建全部空目录并进入 publishing；
- cancel、断线、超时和应用退出会终止当前流并清理任务拥有的 staging 目录。

## HTTP 上传

文件夹文件使用：

```text
POST /v2/folder-transfers/:transferId/files/:fileId
Authorization: Bearer <derived-file-token>
Content-Type: application/octet-stream
Content-Length: <manifest-file-size>
```

服务端核对当前连接、来源 IP、transferId、当前队首 fileId、派生 token、精确长度、类型、期限和单次消费状态。URL 不包含相对路径；接收端只能从已验证 manifest 查找目标路径。

阶段 4 完成内容写入后，文件夹任务进入 `publishing`，而不是提前标记 `completed`。接收审批前 renderer 只获得文件夹摘要；接受后任务 DTO 才包含可移植相对路径和逐文件进度。任务取消为整个文件夹粒度，已写入 staging 的内容一并删除，不提供“保留已完成文件”的语义。

## 接收暂存与发布

接受任务后，在用户授权接收目录下独占创建 `.lindu-folder-<transferId>.part` staging 目录。所有目录与文件都在该目录内创建，文件仍先写随机 `.part`，长度吻合并关闭后才发布到 staging 中对应相对位置。

跨平台 Node API 没有可靠的“目录原子重命名且绝不覆盖”能力，因此不承诺整个文件夹一次原子出现。安全优先的发布流程为：

1. 在接收目录中为 `displayName`、`displayName (1)` 等候选名执行独占 mkdir；
2. 在新建最终目录写入仅含 transferId 的隐藏 ownership marker；
3. 从 staging 把已经完整的树移动到这个由当前任务独占的新目录；
4. 全部成功后删除 marker，再将任务标记 completed；
5. 发布失败时只清理 marker 仍匹配当前 transferId 的目录，绝不删除未知或用户已有目录。

最终目录可能在本地发布的短时间内可见，但任务完成前始终带有内部 marker。应用启动时只清理超过 24 小时、名称严格匹配且 ownership marker 合法的 staging/未完成目录。

## IPC 契约

新增窄接口：

```text
transfer.selectFolder()
transfer.registerDroppedItems(files)
transfer.offerFolder(selectionToken)
transfer.onOfferReceived(listener)
```

现有 `respondToOffer`、`onOfferReceived` 和 `onTaskChanged` 已扩展为文件与文件夹任务的判别联合，避免 renderer 使用任意 channel；文件夹取消和重试在对应业务阶段接入。SelectedFolderDto 只包含 selectionToken、displayName、fileCount、emptyDirectoryCount 和 totalSize，不包含路径或 manifest 明细。

拖拽继续由 Preload 使用 `webUtils.getPathForFile` 获取受控路径，再交给具名 IPC；主进程必须 lstat 并重新扫描。renderer 不能提交字符串路径到通用读写 API。

## 错误码

1.2 新增稳定错误码，中文文案仍与错误码分离：

```text
FOLDER_NOT_FOUND
FOLDER_SCAN_TIMEOUT
FOLDER_FILE_COUNT_EXCEEDED
FOLDER_TOTAL_SIZE_EXCEEDED
FOLDER_DEPTH_EXCEEDED
FOLDER_PATH_INVALID
FOLDER_PATH_CONFLICT
FOLDER_MANIFEST_TOO_LARGE
FOLDER_SYMLINK_UNSUPPORTED
FOLDER_PUBLISH_FAILED
```

网络协议只传错误码和必要 ID，不传本机路径、堆栈或扫描目录内容。

## 后续实施阶段

1. 文件夹需求与协议设计；
2. 安全文件夹扫描、选择和短期授权；
3. offer、manifest 分片、接收确认和 UI；
4. 逐文件 HTTP 流、空目录和总进度；
5. 安全发布、同名处理、失败清理和历史；
6. 多任务串行队列；
7. 后台通知和完成摘要；
8. 安全完善与 Windows/macOS 双平台验收。
