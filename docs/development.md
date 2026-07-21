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
pnpm build
```

项目使用 TypeScript strict 模式，并额外开启 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。代码风格由 ESLint 与 Prettier 管理。

## 阶段

项目严格按需求与架构、初始化、共享协议、安全基础、本地服务、设备连接、文字、文件、多文件、存储、安全完善、双平台打包和验收的顺序推进。
