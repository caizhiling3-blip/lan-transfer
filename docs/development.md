# 开发指南

## 初始化

```bash
pnpm install
```

## 启动开发环境

```bash
pnpm dev
```

Vite 启动渲染进程开发服务器，Electron 主进程和 Preload 由 `vite-plugin-electron` 构建并启动。

## 检查

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

项目使用 TypeScript strict 模式，并额外开启 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。代码风格由 ESLint 与 Prettier 管理。

协议输入使用 Zod 做运行时校验，静态类型优先由 schema 推导。纯 shared 单元测试使用 Vitest：

```bash
pnpm test
pnpm test:watch
```

## IPC 开发约束

- 新 handler 必须使用 `registerIpcHandler`，不得直接分散调用 `ipcMain.handle`。
- channel、请求类型及 Zod schema 必须先加入 `src/shared/ipc`。
- Preload 只能增加具名方法，禁止暴露通用 IPC 方法。
- renderer 不得导入 Electron、Node.js 或主进程模块。

## 阶段

项目严格按需求与架构、初始化、共享协议、安全基础、本地服务、设备连接、文字、文件、多文件、存储、安全完善、双平台打包和验收的顺序推进。
