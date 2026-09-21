# Pulse Windows (pulse-windows) 项目全历程与交接施工文档

> **文档目的**：供后续接手的 AI 工程师快速、完整、无损地理解本项目从立项移植到当前最新状态的所有历史决策、核心架构、已解决问题、近期改动以及后续施工规范。

---

## 一、 项目背景与核心原则

### 1. 项目基本信息
- **本地路径**：`D:\ai-programs\pulse-windows`
- **开源仓库**：`https://github.com/CNDDVP/pulse-windows`
- **上游项目**：`https://github.com/qunqin24/Pulse`（macOS 原生状态栏 AI 额度追踪工具）
- **技术栈**：Tauri 2 (Rust) + React 18 + TypeScript + Tailwind CSS + Vite
- **当前开发基准版本**：`v0.6.3`（代码库处于 master 分支，当前改动待用户核准后发布）

### 2. 核心架构与设计底线（不可违背）
1. **零遥测与隐私安全**：
   - 绝不收集、上报任何遥测数据，零数据回传；
   - 账号凭据严格保存在本机安全存储中（Windows Credential Manager / DPAPI / 本地加密存储）；
   - 诊断信息（Diagnostics）复制或展示时，必须经过路径与凭据脱敏。
2. **双形态自适应部署**：
   - **安装版（Installed）**：通过 NSIS 安装器安装在 `%LOCALAPPDATA%\Programs\Pulse` 或 `Program Files`，用户数据存放于系统标准路径；
   - **便携版（Portable）**：程序同级目录下存在 `portable.flag` 或处于解压目录，所有配置、数据库、历史记录均存放在程序同级 `data/` 目录中。
   - **无论进行何种升级或操作，必须 100% 保护便携版 `data/` 目录，绝对不可覆盖、删除或重命名！**

---

## 二、 完整演进历程与施工大事件

### 阶段 1：基础移植与多平台 Provider 支持（v0.1.0 ~ v0.5.x）
- **数据源适配**：全面移植并实现了 20+ 款主流 AI / 编程助手的数据抓取与额度解析：
  - 包括：Claude, Codex, Antigravity, Cursor, Copilot, Grok, Kimi, Zhipu, Minimax, DeepSeek, Volcengine, Command Code, Devin, Ollama, Xiaomi, StepFun 等。
- **凭据桥接**：
  - Windows 原生凭据管理器集成（`WindowsSecrets`）；
  - 本地 SQLite 数据库提取（如 VSCode / Cursor 状态库、Devin 本地状态库等）；
  - 本地 RPC 探测（如 Antigravity 本地通信端口）。
- **桌面悬浮条（Floating Rail）**：
  - 开发了 Windows 桌面浮动状态栏，支持磁吸贴边、自由拖拽、自动隐藏、鼠标悬停展开额度详情卡；
  - 针对 Windows 多显示器、高 DPI 缩放进行了多次底层几何坐标修正。

### 阶段 2：UI 交互与高度自适应改造（v0.6.0 ~ v0.6.2）
- **问题**：多显示器切换、不同 DPI 分辨率下，卡片展开经常溢出屏幕或被裁切；悬停时偶现无法展开；明明能完全展示却出现多余滚动条。
- **关键修复**：
  1. **测量基准重构**：将卡片高度测量从外部 wrapper 容器改为直接测量卡片 section 本身的自然 `scrollHeight`，彻底解决多窗口卡片（如 Antigravity 4 窗口、Zhipu 3 窗口）的高度裁切问题。
  2. **消除多余滚动条**：重构 `detailLayout` 逻辑，在屏幕能够容纳卡片自然高度时严格移除滚动条，仅在极端小分辨率下启用自适应滚动。
  3. **悬停触发平滑化**：修复了在隐藏窗口测量阶段受系统节流影响导致的“悬停无反应”问题。

### 阶段 3：StepFun 阶跃星辰 Provider 额度与刷新完善
- **周期重置修正**：
  - 移除了原先未经确认、写死的“30 天周期”假设，避免时间外环百分比错误；
  - 优先获取服务商返回的真实账期；无法获取时允许用户手动指定周期或提示按自定义周期估算。
- **401 凭据刷新机制设计**：
  - 针对 StepFun 频繁 401 问题，设计了基于账号密码的自动刷新流程（RegisterDevice → SignInByPassword），支持在后台静默续期 Token。

### 阶段 4：Windows 原生自动更新系统落地（v0.6.3 重点工程）
- **更新系统架构（`src-tauri/src/updater/`）**：
  - **检查（Check）**：后台定时或手动检查 GitHub Releases 最新版本（`api.github.com`）；
  - **安装版升级流**：
    1. 下载 `Pulse-Setup-x64.exe` 及 `SHA256SUMS.txt`；
    2. 校验 SHA256 哈希；
    3. 退出 Pulse 并启动安装器执行覆盖升级。
  - **便携版升级流**：
    1. 下载 `Pulse-Portable-x64.zip`；
    2. 校验哈希并解压至临时 staging 目录；
    3. 验证必要文件（`Pulse.exe`, `portable.flag` 等）；
    4. 启动独立的 updater helper 进程，等待旧进程退出后替换二进制文件；
    5. **严格保留 `data/` 目录**，并支持发生错误时 100% 自动回滚；
    6. 重启新版 Pulse。
  - **安全保障**：
    - 路径遍历（Zip Slip）全面阻断；
    - 文件大小超限防护（最大包体 512MB）；
    - 降级拦截（禁止自动回退到旧版本）。

### 阶段 5：近期关键 Bug 修复与细节打磨（当前状态）
1. **WebView2 外部链接点击失效修复**：
   - **现象**：设置 -> 关于中的“GitHub 仓库”、“上游项目”、“发布页面 / 手动下载”按钮点击无反应。
   - **根因**：Tauri 2 WebView2 默认会丢弃未处理的 `<a target="_blank">` 新建窗口事件。
   - **解决**：在后端实现 `open_external_url` 命令（严格限制 `https://` 协议，调用 Windows API `ShellExecuteW` 唤起系统默认浏览器），前端绑定 `onClick`。
2. **GitHub API 限流与 2 小时死锁优化**：
   - **现象**：检查更新提示“GitHub 请求限流，请稍后重试”，换了代理节点后点击依然无效。
   - **根因**：
     1. 用户使用代理节点时，出口 IP 共享了 GitHub 未登录请求的 60次/小时 限制；
     2. 原代码未读取 `X-RateLimit-Reset` 时间戳，未读到 `Retry-After` 时默认锁定了 7200 秒（2小时），且手动点击也被该锁拦截。
   - **解决**：
     1. 手动点击“检查更新”时强制清空 `retry_until` 限制，方便用户更换代理后立刻重试；
     2. 优先解析 `X-RateLimit-Reset` 时间戳，计算真实剩余分钟数，提供明确的恢复提示与手动下载通道。

---

## 三、 核心代码目录索引

```
pulse-windows/
├── src-tauri/                     # Rust 后端
│   ├── src/
│   │   ├── lib.rs                 # Tauri 入口、窗口生命周期、invoke_handler 注册
│   │   ├── commands.rs            # 前端 IPC 命令实现（窗口控制、凭据、外部链接等）
│   │   ├── updater/               # 自动更新核心子系统
│   │   │   ├── mod.rs             # UpdateService 状态机、下载与触发
│   │   │   ├── core.rs            # 发布包解析、SHA256 校验、Zip 解压、回滚
│   │   │   └── helper.rs          # 独立更新协助器（负责便携版替换与进程等待）
│   │   ├── providers/             # 20+ 个 AI 服务商的数据获取与凭据解析
│   │   │   ├── mod.rs             # 通用 Client、代理探测、网络重试
│   │   │   └── ...                # claude, codex, stepfun, devin 等单独适配器
│   │   ├── config.rs              # 设置读写、配置迁移、隔离 Profile
│   │   ├── alerts.rs              # 额度预警与通知
│   │   ├── cache.rs               # 额度与状态缓存机制
│   │   └── ledger.rs              # Token Spend 本地账本与用量分析
├── src/                           # 前端 React / TypeScript
│   ├── pages/
│   │   ├── settings/
│   │   │   ├── AboutPage.tsx      # 关于页面（系统信息、外部链接、导入凭据）
│   │   │   ├── UpdateCenter.tsx   # 更新中心组件（检查、下载进度条、应用升级）
│   │   │   └── ...
│   │   └── TokenSpend.tsx         # Token 消耗报表页面
│   ├── components/
│   │   ├── FloatingRail.tsx       # 桌面悬浮条组件
│   │   ├── DetailCard.tsx         # 悬停展开的额度详情卡片
│   │   └── ...
```

---

## 四、 关键测试与构建命令

在后续进行任何代码改动后，必须执行以下验证链，确保 0 回归：

1. **前端测试与类型检查**：
   ```powershell
   npm test               # 运行 Vitest 测试（目前 13 个测试套件，93 个用例全部通过）
   npm run typecheck      # TypeScript 类型检查（必须 0 错误）
   npm run build          # Vite 前端打包
   ```

2. **后端测试与编译检查**：
   ```powershell
   cargo check --locked   # 进入 src-tauri 目录，检查 Rust 编译（必须 0 错误）
   cargo test --locked    # 运行 Rust 测试（目前 112 个测试全部通过）
   ```

---

## 五、 后续施工注意事项（给接手 AI 的特别提示）

1. **版本控制规范**：
   - 当前版本为 `v0.6.3`。除非用户明确要求发布新版本，**不要擅自将版本号修改为 `v0.6.4`**，也不要私自打 git tag 或执行 git push。
2. **便携版数据绝对隔离**：
   - 修改更新逻辑或配置读写时，必须验证 `portable` 模式下 `data/` 目录不被波及。
3. **外部网络与代理兼容**：
   - 中国大陆地区用户普遍依赖代理工具（Clash、v2ray 等）。在进行网络请求时，必须通过 `updater_client` 或带有代理支持的 client，并妥善处理 403 限流、TLS 握手及超时错误。
4. **WebView2 特性兼容**：
   - 桌面 WebView2 环境不同于普通浏览器，不要依赖 `<a target="_blank">`，所有跳转外部浏览器的操作统一走 `invoke("open_external_url", { url })`。
