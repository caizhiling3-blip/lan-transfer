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
- 停止服务后释放端口；
- `EADDRINUSE` 映射、重启、状态事件和运行时错误；
- 非 internal IPv4 收集、去重和 IPv6 排除。

手动测试应启动 Electron，确认首页显示本机 IP、53317 端口和“运行中”；再访问健康检查。真实局域网和防火墙连通性在阶段 6 双设备连接时验证。
