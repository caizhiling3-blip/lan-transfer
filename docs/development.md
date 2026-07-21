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

应用使用固定左侧菜单和独立滚动的右侧内容区。首页连接状态以中文徽标展示：未连接、正在连接、等待对方确认、已连接、正在断开或连接异常。

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

## 双设备文字检查

完成上述连接后进入“传输”页面：

1. Windows 向 macOS 发送普通文字，确认对端立即显示并可一键复制；
2. macOS 向 Windows 反向发送普通文字；
3. 双向发送完整 HTTP/HTTPS 链接，确认显示“链接”标记；
4. 点击“打开链接”，确认只有用户操作后才交给默认浏览器；
5. 使用“读取剪贴板”填入编辑框，再发送；
6. 断开连接，确认发送按钮禁用；输入超过 64 KiB 时同样不能发送；
7. 在同一次应用运行期间切换页面，确认最近文字仍可显示。

阶段 7 的历史只保存在内存，重启应用会清空。持久化和独立历史页面在阶段 10 实现。

## 阶段

项目严格按需求与架构、初始化、共享协议、安全基础、本地服务、设备连接、文字、文件、多文件、存储、安全完善、双平台打包和验收的顺序推进。
