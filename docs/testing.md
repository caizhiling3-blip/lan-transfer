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
