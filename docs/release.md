# 发布指南

## Windows 测试包

阶段 12 使用 electron-builder 生成 Windows x64 应用目录和 NSIS `.exe` 安装包。第一版包未签名，只用于受控测试。

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
- `release/Lindu-Setup-0.3.0-x64.exe`：v0.3.0 NSIS 安装包

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

## macOS 测试包

阶段 13 使用 electron-builder 分别生成 Apple Silicon 和 Intel DMG：

- Bundle ID：`com.lindu.transfer`
- 应用包：`邻渡.app`
- 可执行文件：`邻渡`
- 应用分类：Utilities
- 最低系统版本：macOS 12
- Apple Silicon：`Lindu-0.3.0-arm64.dmg`
- Intel：`Lindu-0.3.0-x64.dmg`
- 图标：`build/icon.icns`，包含 16–1024 像素资源
- 安装界面：把邻渡拖入 Applications

构建命令：

```bash
pnpm install --frozen-lockfile
pnpm package:mac:dir
pnpm package:mac:arm64
pnpm package:mac:x64
pnpm package:mac
```

应优先在对应架构硬件或 CI matrix 上生成正式产物：Apple Silicon 构建 arm64，Intel 构建 x64。当前项目没有原生 Node 扩展，因此可以在 Apple Silicon 开发机生成并结构检查 x64 包，但本机不能证明 Intel 运行行为正确。

## macOS 安装与 Gatekeeper 验收

第一版 DMG 明确未签名、未 notarize，仅用于受控测试。测试步骤：

1. 挂载与本机架构匹配的 DMG，把“邻渡”拖到 Applications；
2. 从 Applications 首次启动，记录 Gatekeeper 提示；需要放行时使用 Finder 右键“打开”，或在“系统设置 > 隐私与安全性”中确认本次启动；
3. 不使用全局关闭 Gatekeeper 的命令，也不要移除其他应用的 quarantine 属性；
4. 检查 Dock、访达、应用切换器和诊断页中的图标、名称、`0.3.0` 版本及 Bundle ID；
5. 验证深浅色页面、系统文件/目录选择器、通知和外部链接；
6. 退出应用并把它移到废纸篓，再确认用户设置和历史仍保留在 Electron `userData`；
7. 如需彻底清理测试数据，先备份并确认 `app.getPath('userData')` 的实际目录，再由测试人员手动删除。

不要把手动 Gatekeeper 放行作为正式发布流程。正式分发需要 Developer ID Application 签名、Hardened Runtime、正确 entitlements、`notarytool` notarization 和 stapling。

## macOS 本地网络与防火墙

Info.plist 包含 `NSLocalNetworkUsageDescription`，说明邻渡通过局域网直连设备。1.1 使用原生 UDP4 组播自动发现，不使用 Bonjour，因此不声明 Bonjour service type。

打包钩子会关闭 ATS 任意网络加载、删除模板中的 localhost 例外域，并移除应用未使用的相机、麦克风、音频采集和蓝牙用途描述。局域网 HTTP/WebSocket 由受控的 Electron 主进程处理，渲染进程仍受 CSP 和安全窗口配置限制。

实机验收：

- 首次发生局域网访问时检查本地网络权限提示，选择允许后完成双向连接；
- 在“系统设置 > 隐私与安全性 > 本地网络”关闭邻渡权限，确认连接失败但应用不崩溃；
- 重新允许权限并重启服务，确认连接恢复；
- 开启 macOS 防火墙后检查传入连接提示与应用规则，分别验证允许和阻止；
- 只在受信任网络测试，端口变更后重新检查监听和连接；
- 检查 UDP 53318 组播发现；防火墙阻止组播时应保留手动 IP 连接回退，Windows 只应为专用网络放行；
- 下载、文稿和桌面目录只在用户通过系统选择器授权后访问。

未签名应用的本地网络权限身份在不同构建之间可能不稳定；正式包应使用稳定 Developer ID 签名。

## 正式签名发布待办

- 准备 Apple Developer Program 团队和 Developer ID Application 证书；
- 启用 Hardened Runtime，并为 Electron/V8 配置最小 entitlements；
- 在 CI 密钥库中提供证书和 notarization 凭据，不写入仓库；
- 对 arm64、x64 或最终选定的 Universal 架构执行签名；
- 使用 `notarytool` 提交，等待成功后 stapling；
- 通过 `codesign --verify --deep --strict`、`spctl --assess` 和离线 Gatekeeper 测试；
- 再决定是否公开分发、加入自动更新或发布渠道。

## v0.3.0 发布状态

v0.3.0 包含历史摘要精细清理、可选保留天数、最近设备备注/删除/在线合并、脱敏诊断报告、日志生命周期和失败恢复建议。协议保持 v2，不改变现有局域网互通格式。

当前提交可作为未签名候选包构建来源，但在以下门禁完成前不得标记为正式双平台发布：

- 使用同一提交在 Windows x64 和 macOS arm64（以及计划支持的 Intel Mac）生成候选包并记录 SHA-256；
- 从 v0.2.0 的真实 `settings.json`、`recent-devices.json` 和 `history.json` 升级，确认迁移后数据完整；
- 完成本文与 `docs/testing.md` 中 v0.3.0 实机矩阵，包括日志目录、诊断导出、权限、文件锁和防火墙；
- 确认历史与日志清理从不删除接收目录中的真实文件；
- 记录未签名包 Gatekeeper/SmartScreen 行为，正式公开分发前完成独立签名与 notarization 计划。

阶段 6 在 Apple Silicon 构建机完成 `pnpm package:mac:dir` 与 `pnpm package:win:dir`：macOS 主程序为 arm64 Mach-O，Windows 主程序为 x86-64 PE32+ GUI；两个目录包均包含 ASAR。macOS Info.plist 的版本为 `0.3.0`、Bundle ID 为 `com.lindu.transfer`、最低系统版本为 macOS 12，ATS 任意加载关闭且本地网络说明存在。构建目录位于被 Git 忽略的 `release/`，这些结构检查不等于候选安装包或实机验收通过。

## 1.2 文件夹传输发布门禁

1.2 安装包除原有文字和文件矩阵外，还必须使用同一提交构建的 Windows x64 与 macOS arm64/x64 包执行文件夹验收。至少准备：

- 含中文、空格、括号、0 字节文件和多层空目录的混合文件夹；
- 1,000 个小文件边界样本和一个超过限制的 1,001 文件拒绝样本；
- 同名目标目录、大小写冲突、NFC/NFD 冲突和 Windows 保留名样本；
- 可在传输中断开网络、退出应用、锁定目标文件及耗尽测试卷空间的隔离环境。

发布记录必须关联 Git 提交、包 SHA-256、操作系统/架构、文件系统、网络环境和 [阶段 8 签字矩阵](testing.md#12-阶段-8-安全与双平台签字矩阵)。当前自动化和跨平台目录构建只能标记为“实现及结构检查通过”；在真实 Windows/macOS 双向测试完成前，不得写成“双平台验收通过”。
