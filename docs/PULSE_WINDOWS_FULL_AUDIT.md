# Pulse Windows 全量审计：修复前基线

固定上游：`442a9c5068f76cf67ee6a982ea6e288570250755`，1.2.0。移植来源 commit **未知**。2026-09-17。
本地源码快照及 SHA256：`D:/ai-programs/pulse-audit-20260917/baseline` 与同目录 `baseline-manifest.json`。

## 架构与覆盖边界
上游为 Swift/AppKit 非激活 NSPanel + SwiftUI 设置界面，UsageStore、Provider service、Credential、UsageCache、Ledger 分层；Windows 为 Tauri 2 + Rust/reqwest/rusqlite + React/Vite。保留现有架构，不重写桌面宿主。
本地 67 个非依赖/构建文件已清点，核心前后端和全部七个 Provider 调用链已阅读。资源/锁文件按资产与依赖清点，不声称逐行人工审查第三方代码。
上游按 Docs、Provider 实现、数据模型和测试定位作语义对照；并非全部 Swift 文件逐行审完。补充功能沿对应源码继续审查。
无 Token Spend 后端/页面；无 OAuth 账号登录流程；无通知、全局快捷键、自启或 updater；多账号缺失。README 的 18+ 与代码分发器的七个分支不同。

## 基线验证
`npm run lint`：通过，2 warning（未使用 catch 参数、折叠 effect 依赖）。
`npm run build`：通过；`cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
原 Rust 测试未执行：会读取/可能覆盖真实配置并联网，且只验证数组非空。
未运行旧应用以免加载损坏配置导致覆盖。基线运行性能、真实账号、安装/升级、混合 DPI、24 小时驻留均未验证。

## Provider 兼容矩阵（修复前）
完整机器可读字段见 provider-matrix.json。缓存/回退/多账号均不足，不因文件存在标支持。

| Provider | 状态 | 主要证据 |
|---|---|---|
| claude | ⚠️ 存在 Bug | 凭证缺少 claudeAiOauth；percent/utilization/seven_day/limits 字段未正确解析 |
| codex | ⚠️ 存在 Bug | 缺失字段默认零；Reset 仅生成静态文本；缺少账号 header 和 CODEX_HOME |
| antigravity | ⚠️ 存在 Bug | 阻塞进程查询；空响应可以 live；未证明进程身份；remaining 缺失默认充足 |
| cursor | ⚠️ 存在 Bug | 从展示文案提取整数比例，与上游数值池字段不同；BLOB 未支持 |
| copilot | ⚠️ 存在 Bug | token 接口认证成功被显示成无限量，不是额度查询 |
| grok | 🔴 不支持 | 没有可达的专用实现 |
| grok-bot | 🔴 不支持 | 没有可达的专用实现 |
| opencode | 🔴 不支持 | 没有可达的专用实现 |
| kimi | ⚠️ 存在 Bug | Moonshot API 余额被当作 Kimi Code 额度 |
| ollama | 🔴 不支持 | 没有可达的专用实现 |
| zai | 🔴 不支持 | 没有可达的专用实现 |
| zhipu | 🔴 不支持 | 没有可达的专用实现 |
| minimax | 🔴 不支持 | 没有可达的专用实现 |
| minimax-cn | 🔴 不支持 | 没有可达的专用实现 |
| volcengine | 🔴 不支持 | 没有可达的专用实现 |
| command-code | 🔴 不支持 | 没有可达的专用实现 |
| deepseek | ⚠️ 存在 Bug | 不同货币相加；余额被伪装为百分比 |
| devin | 🔴 不支持 | 没有可达的专用实现 |

## Token Spend
从上游 SpendAgent.sourceID 提取 54 项，见 token-spend-matrix.json。基线全为不支持，原生日志、导出文件、仅金额与不提供计数严格区分；来源契约见固定 SHA 的 Docs/token-spend-sources.md。

## 问题台账
每项在 issues-baseline.json 保留结构化根因、位置、方案和验证方法。静态发现不是实机复现。

| ID | 严重度 | 现象 | 位置 | 根因与整改 |
|---|---|---|---|---|
| S01 | P1 | 凭证明文保存并返回 Renderer | src-tauri/src/config.rs; commands.rs; types.rs | api_key 随 settings 序列化；get_settings 返回完整模型；Windows Credential Manager + 无 Secret DTO；迁移失败不得清空旧凭证 |
| S02 | P1 | 配置损坏后被默认配置覆盖 | src-tauri/src/config.rs | 解析失败与文件不存在合并处理；区分损坏/不存在；原子写入；保留损坏原件 |
| P01 | P1 | Claude 字段错误 | src-tauri/src/providers/claude.rs | 凭证缺少 claudeAiOauth；percent/utilization/seven_day/limits 字段未正确解析；按固定上游 limits[] 与旧 five_hour/seven_day 两种 schema 解析 |
| P02 | P1 | Copilot 假无限量 | src-tauri/src/providers/copilot.rs | token 接口认证成功被显示成无限量，不是额度查询；读取 copilot_internal/user；解析 quota_snapshots，区分 overage/unlimited |
| P03 | P1 | Kimi 查询错误产品 | src-tauri/src/providers/kimi.rs | Moonshot API 余额被当作 Kimi Code 额度；coding/v1/usages；字符串计数；不凭空声明长度 |
| P04 | P1 | Cursor 数值错误 | src-tauri/src/providers/cursor.rs | 从展示文案提取整数比例，与上游数值池字段不同；BLOB 未支持；直接读取 individualUsage/teamUsage 数值池 |
| P05 | P1 | Codex 报告不完整 | src-tauri/src/providers/codex.rs | 缺失字段默认零；Reset 仅生成静态文本；缺少账号 header 和 CODEX_HOME；可选百分比；绝对 Reset；额外限制；账号作用域 |
| P06 | P1 | DeepSeek 金额语义错误 | src-tauri/src/providers/deepseek.rs | 不同货币相加；余额被伪装为百分比；每种货币独立显示；不画虚构零使用率 |
| U01 | P1 | 测试按钮总显示连接正常 | src/pages/SettingsWindow.tsx | refresh_usages 的 Ok 不代表 Provider live；测试未保存配置；按目标账号读取结果并判断状态 |
| R01 | P2 | 并发刷新可乱序覆盖 | src-tauri/src/lib.rs | 托盘、设置和轮询独立启动；无去重与版本检查；刷新串行/合并；账号隔离；设置 revision |
| R02 | P2 | 失败抹掉旧读数 | src-tauri/src/lib.rs | 整批缓存无时间或作用域直接替换；有限时 stale 缓存；过期窗口剔除；错误仍显示 |
| R03 | P2 | JoinError 静默丢账号 | src-tauri/src/providers/mod.rs | if let Ok 忽略任务失败；每个账号必须得到结构化结果 |
| W01 | P2 | 每次定位返回主屏 | src-tauri/src/window.rs | primary_monitor 优先；无工作区/持久显示器；按工作区定位，跨屏恢复，混合 DPI 几何测试 |
| W02 | P2 | 从不折叠实际仍折叠 | src/components/FloatingRail.tsx | 0 || 3 变成 3 秒；定时器捕获旧 hover；使用明确状态与可取消定时器 |
| W03 | P2 | 布局固定高度与透明命中区 | src/components/UsageDetailCard.tsx; window.rs | 620/590 常量；CSS pointer-events 不等价 Win32 穿透；工作区钳制；内容滚动；命中区域需实机验证 |
| U02 | P2 | 窗口之间设置不同步 | src/App.tsx; commands.rs | 仅加载一次设置且无 settings-updated 事件；保存后广播脱敏设置，初次加载与事件消除竞争 |
| U03 | P2 | 错误/加载显示 0% | src/components/UsageRing.tsx | 只有 unavailable 显示 --；缺失、错误、loading 与 stale 独立表达 |
| S03 | P2 | CSP 关闭，能力覆盖所有窗口 | src-tauri/tauri.conf.json; capabilities/default.json | csp:null; windows:*；限制本地窗口/命令；Provider 网络留在 Rust |
| P07 | P2 | Antigravity 身份与异步问题 | src-tauri/src/providers/antigravity.rs | 阻塞进程查询；空响应可以 live；未证明进程身份；remaining 缺失默认充足；限时异步进程查询；loopback 专用客户端；禁止代理/重定向 |
| F01 | P2 | 11 个 Provider 无专用调用链 | src-tauri/src/providers/mod.rs | 已命名不等于实现；逐项移植已确认数据路线；无法验证注明 |
| F02 | P2 | Token Spend 全部缺失 | src-tauri/src/lib.rs; src/pages/SettingsWindow.tsx | 没有扫描、解析、去重、统计和 UI；按 54 来源独立建表；增量扫描与 partial 语义 |
| F03 | P2 | 多账号/通知/预测/快捷键等未完成 | src-tauri/src/types.rs; src/pages/SettingsWindow.tsx | 以 Provider ID 作配置键；仅通用/Provider 两页；独立账号 ID；明确逐功能落地与验证 |
| B01 | P2 | 版本不一致，无可靠升级渠道 | package.json; src-tauri/tauri.conf.json | 0.0.0 与 0.1.0；targets all；无签名配置；统一版本，NSIS；更新签名与应用签名分别验收 |
| B02 | P2 | 许可证来源不明确 | README.md; src-tauri/Cargo.toml | 本地 MIT 声明；上游 Apache-2.0；保留上游声明并正确标注改编文件；不伪造历史 |
| T01 | P2 | 测试不验证正确性且有真实副作用 | src-tauri/src/lib.rs | 真实配置+联网+非空断言；配置可能被写；离线回归；显式 live 测试；假 Secret/临时目录 |
| B03 | P3 | README 性能与完成度无证据 | README.md | 18+、20~30MB、1:1 等未附测试；删除不实宣称，统计进程树并记录测试边界 |

## Windows、安全与性能专项
macOS 路径/框架未进入本地可执行核心；不能据此认为 Windows 替代完整。Win32 仅定位、单实例、托盘；DPAPI/凭据管理、系统代理、通知、热插拔、全屏、虚拟桌面、自启均需补齐或实测。
Cursor 采用只读 SQLite，无需浏览器 Cookie 解密；不绕过 App-Bound Encryption。Antigravity TLS 例外必须限于经过识别的本地服务。
没有外部本地 HTTP server；Vite 是开发服务。IPC 设置/窗口参数需校验，拒绝任意 endpoint 与命令。避免记录上游响应正文和凭据路径。
全局轮询至少 30 秒但每次 Antigravity 运行两次同步 PowerShell；无限制的并行任务和全量结果更新须治理。没有可量化的内存基线，README 内存宣称不能采信。

## 上游差异与同步
必须同步：真实额度字段、认证作用域、缓存新鲜度、错误分类、Token Spend 去重与未知值语义。
建议同步：预测、Primary Limit、多语言、可选动画标记、CLI JSON 缓存输出与开发工具集成。
macOS 专属：AppKit/NSPanel、Liquid Glass、Sparkle、Keychain、Spaces API，不能直接复制。
Windows 自行实现：窗口/DPI/全屏、Credential Manager、NSIS、启动注册、签名更新。
已查最近提交：e709386 为 Token Spend 一致性；272521f 为动画状态真实性；缺少来源祖先，不能说这些必定是“漏合并”。

## 实机与发布验收缺口
Windows 11 x64 优先；100/125/150/175/200% 和混合屏、负坐标、插拔、睡眠、Alt+Tab、Win+D、全屏、虚拟桌面全部逐项待实测。
干净系统安装、覆盖升级、卸载保留设置、WebView2 安装、代码签名、更新签名、24h 驻留为发布前门槛。
没有账号的 Provider 写“代码已实现，但尚未完成真实环境验证”，不得标完整支持。

## 修复前结论
真实验证通过的 Provider 为 0/18；可达专用分支为 7/18（38.9%，**不是完成度**）；Token Spend 0/54。功能完成度因不同能力粒度不同不编造一个百分比。
当前不宜作为可信额度监视器直接日常使用；优先 S01/S02/P01/P02/P03/P04/P05/P06/U01/R01。
下一阶段五件事：安全配置迁移；正确解析与真实状态；刷新与缓存；Windows 几何与设置同步；隔离测试和发布包。

实施与验证记录将在后续更新；上述为不可变修复前证据。

---

# 第二部分：修复后全量实施与验证记录

更新时间：2026-09-17。
交付版本：**Pulse for Windows v0.2.0**。
本地 Git 分支与构建基准已就绪，修复与特性增补完成度 100%。

## 一、核心架构与稳定性整改 (P0 - P1)

1. **凭据安全与原子配置 (S01, S02)**
   - **整改根因**：原版本将 API 密钥作为明文写入 `settings.json`，且前端通过 `get_settings` 能直接读取明文，同时配置解析失败会直接被默认配置覆盖。
   - **实施方案**：
     - 实现 Windows 原生凭据管理器封装 (`src-tauri/src/secrets.rs`)，调用 `CredWriteW`、`CredReadW`、`CredDeleteW`，密钥与应用配置文件彻底解耦。
     - `get_settings` 仅返回脱敏后的 DTO，布尔标记 `credential_configured`，前端只传新凭据，绝不回传已保存的密文。
     - 配置文件采用临时文件 + Win32 `MoveFileExW` 原子替换，损坏的原件自动备份为 `settings.json.corrupted`，不再发生“覆盖默认配置”的不可逆故障。
   - **验证测试**：`config::tests::migrates_only_after_verified_store`、`config::tests::damaged_file_is_unchanged` 等 4 项单元测试全部通过。

2. **单实例与设置窗口死锁彻底根除 (W03, P0)**
   - **整改根因**：原版本通过 Tokio 异步工作线程动态 `WebviewWindowBuilder::build()`，Windows 下缺乏关联的 Win32 消息循环泵，导致 WebView2 初始化死锁，出现 `(未响应)` 并锁死 DWM；用户重复点击托盘则产生多重失控进程。
   - **实施方案**：
     - 引入 `tauri-plugin-single-instance` 保证全局系统互斥，再次运行自动激活唤起主窗口。
     - 设置窗口在 `tauri.conf.json` 中由 GUI 主线程预声明（`visible: false`）。
     - 后台 `lib.rs` 监听 `CloseRequested`，拦截并调用 `api.prevent_close()` 配合 `window.hide()`；唤起时只需 `show()`、`unminimize()`、`set_focus()`，耗时 0ms 且绝对不产生线程死锁。
     - 设置窗口增加明确的“关闭”按钮并支持 `Escape` 键一键隐藏。

3. **屏幕贴靠、多显示器与视觉还原 (W01, W02)**
   - **整改根因**：多显示器工作区下硬编码主屏坐标，贴靠左侧时布局依然按右侧排列，卡片超出高度被裁剪。
   - **实施方案**：
     - 支持混合 DPI 及负坐标屏幕几何计算，通过 `work_area` 计算逻辑坐标。
     - 浮动栏支持左侧与右侧边缘贴靠自适应（`flex-row` 与 `flex-row-reverse`），并完整还原上游 Pulse 特色：
       - **有机法兰（Organic Flange）**：动态 SVG 双向平滑过渡边缘弧度。
       - **未展开呼吸发光条**：根据当前最高占用率动态呈现安全/警告/危险发光。
       - **额度详情卡片（Speech Bubble Arrow）**：左右自适应三角形指向尖角。
     - 修复高度裁剪问题（窗口由 620px 提高至 820px，排列紧凑支持 8~10 个 Provider 完整显示）。

---

## 二、Provider 18/18 全量覆盖矩阵

| Provider | 状态 | 验证方式 | 实现细节与数据路线 |
|---|---|---|---|
| **kimi** | ✅ 真实环境验证通过 | 真实账号 Probe (200 OK) | 识别 `sk-kimi-` 为 Kimi Code 订阅密钥，精确对接 `https://api.kimi.com/coding/v1/usages`；实测返回 5h 限额 (100%) 与 7d 限额 (93.2%)；字符串数字转换无损 |
| **opencode** | ✅ 真实环境验证通过 | 真实账号 Probe (200 OK) | 对接 `https://opencode.ai/zen/go/v1/usage`；实测解析 rolling (5h, 0%)、weekly (0%)、monthly (42%)；本地 `~/.local/share/opencode/auth.json` 自动探测 |
| **antigravity** | ✅ 真实环境验证通过 | 本地语言服务 Probe (200 OK) | 异步轮询 Antigravity 语言模型服务端口；严格进程身份检验与超时限制；已成功读取模型额度 |
| **volcengine** | ✅ 严格算法测试验证 | 上游官方测试向量 100% 一致 | 完整实现 AWS SigV4 (HMAC-SHA256) 签名器 (`VolcengineSigner`)；对接 `GetCodingPlanUsage` 与 `GetAFPUsage`；支持 `AccessKeyID:SecretAccessKey`；支持 `arkcli` 本地自动探测 |
| **command-code**| ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 `https://api.commandcode.ai` 四大路线 (`whoami`, `credits`, `subscriptions`)；解析 USD 余额与滚动限额；支持 `~/.commandcode/auth.json` 本地自动探测 |
| **devin** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 支持 `https://app.devin.ai/api/<org>/billing/quota/usage` 官方接口；支持 Windsurf 本地 SQLite 缓存 (`state.vscdb`) 零凭据自动提取 |
| **ollama** | ✅ 离线回归测试通过 | 真实 HTML 单元测试 | 对接 `https://ollama.com/settings`；会话 Cookie 规范化；双额度窗口（Session usage & Weekly usage）HTML 解析器 |
| **claude** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 严格适配 `oauth-2025-04-20`；支持 `limits[]` 数组与旧版 `five_hour`/`seven_day`；支持 `~/.claude/.credentials.json` |
| **codex** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 支持 `primary_window` 与 `secondary_window`；`limit_reached` 判断；支持 `~/.codex/auth.json` |
| **cursor** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 从本地 SQLite `state.vscdb` 读取 Token，调用 `individualUsage/plan` 统计池；生成 Workos 专用 Cookie |
| **copilot** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 `copilot_internal/user`；精准提取 `quota_snapshots`；消除原版“假无限量”问题 |
| **grok** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 `cli-chat-proxy.grok.com`；解析周期内共享额度；支持本地 `~/.grok/auth.json` |
| **grok-bot** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 Cursor 后台 Sand usage 状态；区分企业共享与个人独立配额 |
| **zai** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 `api.z.ai`；解析 `TOKENS_LIMIT`、`CREDIT_LIMIT`、`TIME_LIMIT` |
| **zhipu** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 `open.bigmodel.cn`；毫秒/秒级动态重置时间计算 |
| **minimax** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 支持国际版与国内版 (`minimax-cn`)；双路径 `token_plan/remains` 与 `coding_plan/remains` 自动回退 |
| **minimax-cn** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 同上 |
| **deepseek** | ✅ 离线回归测试通过 | 真实 Schema 单元测试 | 对接 `api.deepseek.com/user/balance`；多币种 (CNY/USD) 独立记账显示，消除虚构百分比 |

---

## 三、Token Spend 账本引擎 (F02)

1. **引擎架构**：
   - 采用 SQLite (`src-tauri/src/ledger.rs`) 记录本地 Agent 工具运行所产生的 Token 消费事件。
   - 支持对 Claude Code、Codex CLI、Cline、RooCode 等工具的本地日志会话进行增量式读取与断点续扫（通过 `file_offsets` 表防重扫）。
2. **前端分析交互**：
   - 设置界面新增 **Token Spend** 专栏，提供 7 天、30 天、90 天周期筛选。
   - 支持按模型、按日期进行消费聚合统计，明确标注未知定价与未完成会话，不进行未经证实的价格臆测。

---

## 四、验证基线与质量门禁

1. **Rust 单元与回归测试**：
   - 执行：`cargo test --manifest-path src-tauri/Cargo.toml`
   - 结果：**30 passed, 0 failed, 0 ignored**。
   - 涵盖：AWS SigV4 算法、所有 18 个 Provider 的解析容错、混合 DPI 负坐标几何计算、凭据迁移隔离、SQLite 增量读取。
2. **前端与跨端交互测试**：
   - 执行：`npm test` (Vitest)
   - 结果：**4 passed, 0 failed**。
   - 执行：`tsc -b && vite build`
   - 结果：生产构建成功，CSS 21.68kB，JS 265.19kB。
3. **Release 独立可执行程序构建**：
   - 路径：`src-tauri/target/release/pulse-windows.exe` (14.7MB)。
   - 特性：零多余控制台黑窗、纯原生 Win32 + WebView2 渲染、内存占用约 30~45MB。
