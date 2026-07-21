# 测试指南

阶段 3 已加入 Vitest，在 Node 环境测试 shared 协议、错误码和 IPC 类型契约。

每个阶段至少执行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

当前单元测试覆盖所有已定义 WebSocket 消息、UUID 与数值边界、UTF-8 文字大小、文件限制、错误码文案完整性和 IPC channel 唯一性。

阶段 4 额外覆盖安全窗口选项、IPC schema 完整性、外链 scheme、连接参数、剪贴板大小、重复选择 token、设置 patch 以及主窗口/main frame 来源校验。

Electron 冒烟测试应确认应用窗口可启动且开发终端没有 preload、CSP 或未处理异常。导航、新窗口和具体 IPC 行为将在拥有对应 UI 后继续补充集成测试。

网络和文件功能实现后补充双机手动测试矩阵。

## 阶段 5

自动化集成测试使用回环地址和系统分配的随机端口，覆盖：

- 健康检查、未知路由和安全响应头；
- `/v1/ws` Upgrade、错误路径和阶段 5 的 1013 关闭；
- 拒绝携带浏览器 Origin 的跨站 WebSocket Upgrade；
- 停止服务后释放端口；
- `EADDRINUSE` 映射、重启、状态事件和运行时错误；
- 重叠 start/restart 的串行执行；
- 非 internal IPv4 收集、去重和 IPv6 排除。

手动测试应启动 Electron，确认首页显示本机 IP、53317 端口和“运行中”；再访问健康检查。真实局域网和防火墙连通性在阶段 6 双设备连接时验证。

## 阶段 6

双实例回环集成测试覆盖：

- hello、用户审批、welcome 和双方设备信息；
- 待审批 requestId 可通过连接状态快照恢复，nonce 与握手身份保持一致；
- 用户拒绝后双方回到 disconnected；
- 活动连接存在时拒绝第二个 socket；
- 主动 disconnect 在对端同步清理；
- 目标端口拒绝和非法 JSON；
- IPC 的非法 IP、端口、UUID 与未知字段继续由安全测试覆盖。

真实双机手动测试需覆盖 Windows/macOS 双向连接、允许、拒绝、错误 IP、错误端口、防火墙阻止、拔网线和退出应用。当前环境只能完成单机回环自动化与本机 Electron 冒烟测试。

## 阶段 7

自动化测试新增覆盖：

- 已审批连接上的文字/链接发送、接收 DTO 和 ACK 后完成任务；
- messageId 的 TTL/容量去重，以及当前连接态消息白名单；
- 未连接时拒绝创建文字任务；
- 完整 HTTP/HTTPS 链接识别以及其他 scheme 和混合正文拒绝分类；
- 会话历史的倒序、上限、筛选、分页和清空。

协议和 IPC 既有测试继续覆盖空文字、UTF-8 64 KiB 边界、非法类型、危险外链 scheme 和未知字段。真实双机需按开发指南验证 Windows/macOS 双向文字、链接、复制与剪贴板；自动化环境不代替系统剪贴板和默认浏览器手动检查。

文件协议测试同时覆盖 Windows 保留名、非法字符、尾随点/空格和 UTF-8 文件名长度；真正的重名落盘策略在阶段 8 增加集成测试。
