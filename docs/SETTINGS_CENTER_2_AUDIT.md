# Pulse Windows Settings Center 2.0 审计报告

日期：2026-09-18 · 版本：v0.3.0（schema 3）· 上游基准：qunqin24/Pulse `main`（Docs/ui/settings.md、Docs/notifications.md）

## 1. 差异矩阵（上游设置功能 → Windows 现状）

图例：✅ 已完整实现 · 🟡 已实现需优化 · 🔴 Windows 缺失 · 🪟 Windows 采用不同实现 · 🍎 macOS 专属不移植

| 上游功能 | 本轮前 | 本轮后 | 说明 |
|---|---|---|---|
| 侧栏分组 + 每账号独立页 | 🔴 单页堆叠 | ✅ | Pulse / 账号（每账号一项）/ 应用 三组，账号点击进详情页 |
| 侧栏搜索（页面 + 账号名/服务商） | 🔴 | ✅ | 大小写不敏感；匹配页面标题+关键词、账号备注+服务商名/ID |
| 顺序：拖拽 / 箭头 / Reset order | 🟡 数字输入 | ✅ 🪟 | 指针事件拖拽（WebView2 不启动 HTML5 drag）+ ▲▼ + 恢复默认（名称序，默认时禁用）；单位=账号 |
| Panel: show / ring shows / ring colour | 🔴 | ✅ | 显示悬浮栏开关；主圆环指标（已有）；每账号圆环颜色（自定义仅作用于正常区间） |
| Turn red at（60–90） | 🔴 | ✅ | `warning_threshold` 60–95，只移动琥珀→红；耗尽始终红 |
| 通知：approaching / spent / reset / unreadable / low balance | 🔴 | ✅ 🪟 | `alerts.rs` 纯决策函数对齐上游去重规则；Windows Toast（tauri-plugin-notification）；记忆 alerts.json |
| 通知权限状态 + 测试 | 🔴 | ✅ 🪟 | 读注册表 `PushNotifications\ToastEnabled` + 插件权限；"发送测试通知" |
| Refresh 间隔 picker + 立即刷新 + 上次成功时间 | 🟡 数字输入 | ✅ | 30s–30min 选择器；显示最近成功读数时间 |
| Application: 开机启动 | 🔴 | ✅ 🪟 | HKCU Run 键读写（SMAppService 对应物），状态直读系统，路径不匹配视为关闭 |
| 启动行为 | 🔴 | ✅ | 显示悬浮栏 / 打开设置 / 仅托盘 |
| 全屏隐藏 / 跟随活动显示器 / 显示器选择 / 贴靠 / 自动折叠 | ✅ | ✅ | 折叠选项补 1 秒；跟随时禁用固定显示器 |
| Shortcuts（2 个全局键，即改即生效，Esc/⌫） | 🔴 | ✅ 🪟 | tauri-plugin-global-shortcut；冲突=注册失败→UI 回滚+提示；不触发刷新 |
| 每账号连接诊断（最近检查/成功/来源/缓存/耗时/错误/凭据/下一步） | 🟡 只有总报告 | ✅ | `duration_ms` 入 DTO；账号页"诊断"区 + 诊断页账号列表 |
| Sign in again（OAuth） | 🔴 | 🔴 | Windows 端所有路线为 Token/本地登录读取，无 OAuth 流程可"重新登录"；替换凭据即等价 |
| 每账号 low balance 金额线（按币种） | 🔴 | ✅ | `low_balance` + `low_balance_currency`，只比较所选币种 |
| Animated mark（人格/形状/颜色） | 🔴 | 🔴 P2 | 需移植上游几何动画，成本高，按计划放 P2 |
| Language | 🔴 | 🔴 P2 | 全量字符串抽取约 300 条；半翻译=假实现，宁缺 |
| About：版本/更新状态/来源 | 🔴 | 🟡 | 版本 + Git commit + 构建时间 + 上游链接；自动更新未接入（需签名密钥与分发端点） |
| Developer integrations（--json） | ✅ | ✅ | 已有 `--json`，关于页展示命令 |
| Token Spend 图表/模型维度/来源状态 | 🟡 | 🟡 P2 | 本轮未动（见第四轮修复的扫描性能） |
| Keychain / Sparkle / SMAppService / NSPanel / UNUserNotification | — | 🍎 | 分别以 Credential Manager / 手动分发 / Run 键 / Tauri 窗口 / Toast 替代 |

## 2. 本轮新增
- 设置中心信息架构重构：`SettingsWindow.tsx` 壳 + `settings/{shared,GeneralPage,NotificationsPage,HotkeysPage,AboutPage,DiagnosticsPage}.tsx`
- 保存逻辑统一：通用/通知/快捷键/顺序即改即存（`update()` 失败自动回滚）；账号页显式"保存 / 放弃"，关闭窗口有未保存更改时确认；凭据单独"保存凭据"；删除账号/凭据二次确认
- 控件依赖：跟随活动显示器→固定显示器禁用；阈值关闭→重置提醒禁用；自动颜色→隐藏取色器；无余额→不显示低余额区；无本地路线→不显示本地登录开关；无手动路线→不显示凭据框
- 版本注入：`__APP_VERSION__` / `__GIT_COMMIT__` / `__BUILD_TIME__`（vite define）

## 3. Settings Migration
- `schema_version` 2 → 3。新字段全部带 serde 默认值，旧文件加载后立即以 v3 重写（`config::load_from`），`validate` 接受 2..=3。
- 真实配置验证：6 个账号、顺序、主题、显示器、贴靠、折叠、全屏隐藏等全部原样保留（脚本逐字段比对）。
- 凭据不参与迁移路径（本就不在 settings.json 中）；alerts.json 只存百分比台阶与时间戳。

## 4. Credential Security（复核）
- Secret 仅存 Windows Credential Manager（`CredWriteW`，写后读回校验）；settings.json 只有 `credential_configured` 布尔。
- UI 不回显已存凭据；输入框 type=password；保存成功即清空。
- 诊断报告为 Rust 白名单构造（服务商/状态/错误码/来源/时间），不含账号名、Token、Cookie、Authorization、路径。

## 5. 修改文件
后端：`types.rs`（v3 模型）、`config.rs`（迁移）、`alerts.rs`（新）、`platform.rs`（新）、`lib.rs`（插件/快捷键/启动行为/通知触发/show_rail）、`commands.rs`（6 个新命令、快捷键先注册再保存）、`providers/mod.rs`（duration_ms）、`Cargo.toml`、`tauri.conf.json`
前端：`SettingsWindow.tsx`（重写）、`pages/settings/*`（6 个新文件）、`UsageRing.tsx`、`FloatingRail.tsx`、`types/index.ts`、`ordering.test.ts`、`vite.config.ts`、`package.json`

## 6. Build / Test
- `cargo test`：43/43（新增 alerts 4 项、迁移 1 项）；`vitest`：8/8；`tsc -b` 通过；`oxlint` 0 error（8 条 HMR 风格提示）；`tauri build --no-bundle` 成功。

## 7. 实机验证（150% 4K 主屏 + 125% 2K + 100% 1080p 三屏）
| 场景 | 结果 |
|---|---|
| v2 配置启动迁移 | schema 3，字段全保留 |
| ▲ 上移 Codex | settings.json 立即重编号；悬浮栏立即 Codex 第一 |
| 指针拖拽 Kimi 到第 1 | 保存 + 悬浮栏同步 |
| 重启 Pulse | 顺序保持 |
| 通知页 | 读到"Windows 通知已允许"；测试通知弹出 |
| 通知开关即改即存 | `on_spent` 立即落盘 |
| 开机启动 | 开→Run 键写入 exe 路径；关→删除 |
| 搜索 | 输入 "shortcut" 侧栏只剩快捷键 |
| 快捷键录入 | Ctrl+Alt+Shift+U 保存并注册；全局按下悬浮栏隐藏，再按恢复；Backspace 清除 |
| 快捷键被占用 | Ctrl+Alt+R 被 POPO 录屏占用：系统直接交给 POPO，本页收不到按键（属 OS 行为）；后端解析/注册失败时 UI 回滚并提示 |

## 8. 已知问题
1. 免安装 exe 的 Toast 显示为 "Windows PowerShell" 发送——未注册 AppUserModelID 的已知限制；NSIS 安装后可正确显示 Pulse。
2. 侧栏在 700 逻辑 px 高度下需滚动才能看到"应用"组的后两项。
3. 搜索框 Enter 打开首项在中文输入法合成态下会被 IME 吞掉（需先上屏）。
4. 自动更新、界面语言、Animated Mark、Token Spend 图表为 P2 未实现。
5. 全屏隐藏按前台窗口判断，任一屏全屏都会隐藏所有屏的悬浮栏。
