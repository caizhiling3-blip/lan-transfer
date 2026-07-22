# 发布指南

## Windows 测试包

阶段 12 使用 electron-builder 生成 Windows x64 应用目录和 NSIS `.exe` 安装包。第一版包未签名，只用于受控测试；macOS `.dmg` 将在阶段 13 单独配置。

打包配置：

- 应用名：邻渡
- App ID：`com.lindu.transfer`
- 可执行文件：`Lindu.exe`
- 目标架构：Windows x64
- 安装方式：NSIS 安装向导，可选择仅当前用户或所有用户，并允许更改安装目录
- 快捷方式：创建桌面快捷方式和开始菜单快捷方式
- 卸载策略：移除程序文件和快捷方式，默认保留 Electron `userData` 中的设置与历史
- 图标：`build/icon.ico`（256×256、32 位 RGBA），源文件为 `build/icon.svg`

## 构建命令

应优先在干净的 Windows 10/11 x64 构建机执行：

```bash
pnpm install --frozen-lockfile
pnpm package:win:dir
pnpm package:win
```

输出位置：

- `release/win-unpacked/Lindu.exe`：免安装冒烟测试入口
- `release/Lindu-Setup-0.1.0-x64.exe`：NSIS 安装包

当前无原生 Node 扩展的配置已在 macOS 开发机成功生成 Windows NSIS 包。若后续加入原生扩展或构建机提示缺少兼容工具链，应改在 Windows x64 环境构建。跨平台产物即使生成成功，也不能替代 Windows 上的安装、快捷方式、卸载、文件锁和防火墙测试。

## Windows 安装验收

在全新 Windows 10 和 Windows 11 x64 测试账户中分别执行：

1. 检查安装包文件名、邻渡图标、产品名和版本号；记录未签名包触发的 SmartScreen 提示。
2. 运行安装向导，分别验证默认目录和自选目录；无管理员权限时验证当前用户安装。
3. 检查桌面快捷方式、开始菜单快捷方式和“已安装的应用”条目。
4. 从快捷方式启动，确认首页、Logo、深浅色、设置与传输页面资源完整。
5. 执行双机连接和文件传输，确认应用安装目录不会被当作接收目录。
6. 卸载后检查程序目录和快捷方式已移除；再次安装后确认默认保留的设置与历史仍可读取。

如测试要求彻底清理数据，应先退出应用，再删除 Electron 实际 `app.getPath('userData')` 返回的目录；不要在卸载脚本中默认删除用户历史。

## Windows Defender Firewall

邻渡不自动创建或修改防火墙规则。第一次监听局域网端口时，Windows 可能显示 Defender Firewall 提示：

- 仅在受信任环境允许“专用网络”；不要为公共网络开放。
- 默认服务端口为 TCP `53317`，设置修改端口后需要重新检查规则。
- 若没有弹窗，在“Windows 安全中心 > 防火墙和网络保护 > 允许应用通过防火墙”中检查邻渡。
- 分别验证允许、拒绝和删除规则后的表现；拒绝时应用应保持可用并显示连接失败，不能崩溃。
- 不建议通过安装器静默添加全局入站规则，避免扩大局域网暴露面。

## 未签名包与正式发布

未签名测试包可能被 SmartScreen 拦截，不应分发给不知情的终端用户。正式 Windows 发布前需另行配置受信任代码签名证书、签名密钥保护、时间戳服务和签名校验流程。

macOS 的 Bundle ID、DMG、Developer ID、Hardened Runtime、Gatekeeper 与 notarization 不属于本阶段，将在阶段 13 规划和实现。
