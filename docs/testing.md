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

网络和文件功能实现后补充双机手动测试矩阵。
