# 收纳条颜色与预警：实现及验证记录

日期：2026-09-20。基于最新 v0.4.8 / `2da87f3`，开始时工作区干净。此为本地功能候选，未提交、未上传 GitHub，未升级版本号，也未替换用户正在运行的 EXE。

## 已实现范围

入口：通用设置 → 收纳条颜色与预警。

| 设计要求 | 实现与证据 |
|---|---|
| 自动、固定、彩虹三模式 | 保留原有模式、预设色、颜色选择器与十六进制输入；自动模式隐藏时仍保留预警配置 |
| 全部已启用 / 自选一个或多个账号 | 新启用账号自动进入全部模式；自选按独立账号 ID，不按服务商合并 |
| 主圆环 / 全部周期 / 指定周期 | 指定周期缺失显示未知，不回退到其他额度；删除或停用的显式选择仍保留并提示 |
| 默认 / 手动百分比阈值 | 默认黄色 75、红色 90；验证 0 < 黄 < 红 ≤ 100；与圆环及通知阈值独立 |
| 已用与剩余口径 | 判断始终使用已使用比例，超过100%仍按真实使用值评级 |
| 金钱余额 | 按账号、三位币种代码独立设置；0 ≤ 红 < 黄；零和负余额支持；不同币种不求和、不换算 |
| 不支持的计量 | 未配置金额阈值不参与余额评级，提示排除；不将金额当百分比；非三位货币代码不作为币种设置 |
| 混合风险 | 每个来源先评级，再取最高风险，不平均；各触发来源分别列出 |
| 缓存、缺失、断线 | stale与超过10分钟的读数不参与实时风险；有效黄/红与异常共存时保留有效风险并提示；仅绿色与异常共存变灰；全部未知或空选择变灰 |
| 余额未配置 | 已识别为纯余额且没有余额规则的账号明确排除，不能把它当0%或绿色 |
| 原因与预览 | 目标颜色、触发账号/周期/金额、阈值、更新时间、排除原因、参与/异常账号数；实际收纳条状态单独显示；悬停收纳条可读原因 |
| 刷新 | 提供独立按钮，沿用原刷新机制；刷新中标记；修改外观/预警不会顺带请求缺少缓存的账号 |
| 防抖 | 升级立即；降级连续10秒；配置改变、明确的周期结束时间推进、数据失效立即重算；自动主额度在不同周期间切换不会伪装成重置 |
| 实时编辑与保存 | 数值合法时预览，离开输入框自动保存；非法空值或阈值不提交；沿用后端原子设置保存、错误toast和前端回滚；实际收纳条只采用保存成功的设置 |
| 默认恢复 | 仅重置收纳条规则与颜色，不清账号、凭据、主圆环、通知配置 |
| 减少动态 | 继续使用系统/app统一CSS；彩虹关闭动画后有静态底色，设置预览遵循减少动态 |
| 旧配置迁移 | 原配置没有 rail_warnings 时，按原 warning_threshold 迁移实际黄/红界限，保留固定色和彩虹；新的默认值为75/90 |
| 多窗口 | 共用纯判断函数；主窗口负责10秒状态记忆，通过专用IPC向设置窗口发布实际结果；修复设置窗口事件监听权限缺失 |

## 代码位置

- `src/railWarnings.ts`：统一风险判断、有效性、来源说明与纯防抖状态转换。
- `src/useRailWarnings.ts`：主窗口时钟、刷新标记及实际状态同步。
- `src/pages/settings/RailWarningSettings.tsx`：独立配置面板及实时预览。
- `src/components/FloatingRail.tsx`：自动颜色和悬停说明。
- `src-tauri/src/types.rs`：结构化 RailWarnings / RailAccountRule / RailBalanceRule 与验证。
- `src-tauri/src/config.rs`：旧设置阈值迁移及测试。
- `src-tauri/src/commands.rs`：主窗口专用状态转发；阻止外观保存触发无关缺失读数请求。
- `src-tauri/capabilities/default.json`：为settings补齐listen/unlisten，没有开放通用emit权限。

配置结构：`rail_warnings` 保存 scope、account_ids、custom_thresholds、yellow、red、accounts；账号规则保存 mode、window_id、balances。原 collapsed_bar_color_mode / collapsed_bar_color 继续负责模式和固定颜色，避免丢失旧外观选择。

## 测试与证据

- `npm test`：8个文件，44项通过。
- `npm run build`：TypeScript与Vite生产构建通过。
- `cargo test --locked --lib`：90项通过。
- `npm run lint`：无错误；仍有React effect/ref等警告，不宣称零警告。
- `git diff --check`：通过。
- Release构建成功：`cargo rustc --release --locked --bin pulse-windows -- -o D:/ai-programs/pulse-windows/release-artifacts/pulse-v048-rail-warnings.exe`。

新增覆盖：百分比边界、超过100%、指定周期失效、选择范围、删除/停用、不同币种、零/负余额、不同计量风险比较、未配置余额排除、缓存过期、升降级时间边界、设置/重置/数据失效绕过降级等待、数值空输入、模式切换、局部恢复、不自动刷新、旧配置迁移、非法配置拒绝写盘。

原生联调脚本：`scripts/native-rail-warnings-regression.py`。用新建临时目录与独立进程，关闭额度采集授权与Token扫描；通过测试WebView已注册的回调注入脱敏读数，真实执行Rust设置保存、事件同步和窗口渲染。没有使用真实API Key或服务商额度作为测试数据。每次结束只清理本次创建的进程树。

最终Release实例已验证：

1. 97%样本驱动真实收纳条变红。
2. 将阈值改成98/99后，真实收纳条和设置预览均变绿。
3. 设置窗口收到主窗口发布的实际颜色结果。
4. 非法阈值保存被Rust拒绝，原阈值98保持不变。
5. 自选空账号列表使收纳条变灰。
6. 目标配置实际写入隔离settings.json；序列化读回由Rust测试覆盖。

原生截图：`release-artifacts/rail-warning-settings.png`；数据为Regression fixture，不是用户真实账号。

## 产物与边界

本地便携候选：`release-artifacts/Pulse-0.4.8-rail-warnings-portable.zip`。

- EXE SHA256：`D9829AED281B88200E72264304B58EF1E7278F31AEA1A5EE1F9C248FA1A4C56D`
- ZIP SHA256：`82575543A42E5111F7C711AC17F4CE6FDE89AE2A4171A2473BDB6C56ECD1ABC3`
- 包内仅有Pulse.exe、portable.flag、README.txt、构建manifest与SHA256SUMS；已核对ZIP内EXE哈希。
- manifest包含基线SHA及当前自有源码文件哈希，明确区分未提交候选与v0.4.8已发布产物。

本轮没有生成或发布新NSIS安装包，也没有执行覆盖安装/卸载。新规则没有按安装/便携模式分支，同一设置使用同一算法；正式发布前仍需用最终安装包和ZIP执行发行形态验收。全Provider真实服务、混合DPI热插拔和24小时驻留也不在此次已通过结论中。

使用方式：先完整解压候选包，再运行Pulse.exe；不要只将候选EXE复制到原配置旁试验。本轮未复制私人数据。版本资源仍为0.4.8，正式发布时应统一升版。
