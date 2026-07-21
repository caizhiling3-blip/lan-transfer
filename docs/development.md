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

## 本地服务检查

开发模式启动后，首页会展示当前非 internal IPv4、实际服务端口和服务状态。可在本机验证健康检查：

```bash
curl http://127.0.0.1:53317/health
```

预期返回 HTTP 200 和协议版本。若端口被其他程序占用，首页应展示 `PORT_IN_USE` 对应的中文错误；本阶段不会自动选择随机端口。

## 双设备连接检查

在两台同局域网设备运行应用，在主动方输入另一台首页显示的 IPv4 和端口 53317。接收方必须出现审批弹窗；允许后双方显示对方设备信息，拒绝后双方回到未连接。继续检查主动断开、应用退出和错误端口。

macOS 或 Windows 防火墙提示应只允许受信任的专用网络。阶段 6 不发送文字或文件。

## 阶段

项目严格按需求与架构、初始化、共享协议、安全基础、本地服务、设备连接、文字、文件、多文件、存储、安全完善、双平台打包和验收的顺序推进。
