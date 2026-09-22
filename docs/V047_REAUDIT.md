# Pulse for Windows v0.4.7 复查与修复交接

日期：2026-09-20。范围：本地当前代码的窗口交互、便携导入、Token 消耗取消生命周期及相关回归。不是全部 Provider 真实账号验收，也不是 GitHub ZIP 与安装包的二进制一致性认证。初次审计未修改生产代码；后续已按用户要求修复，以下新增修复记录。用户实际配置和凭据未用于测试。

## 基线及验证

- HEAD：`8ba64ab2383afee53968ff2c7588c299f172a2be`；检查前工作区干净。
- package.json 与正在运行路径的 EXE 文件版本均为 0.4.7。
- 运行进程 PID 50992，路径为本仓库 `src-tauri/target/release/pulse-windows.exe`；本轮没有重启它。
- 该磁盘 EXE SHA256：`25D9EDEABD1DC9919DF1AB1FDDA9190C4A784277F370F223E4FA6563619877D0`。版本资源与路径不能单独证明二进制精确对应 HEAD。
- `npm test`：4 个文件、13 项通过。
- `npm run typecheck`：通过。
- `npm run lint`：成功退出，10 条警告；包含折叠 effect 的依赖遗漏。
- `cargo test --locked --lib`：81 项通过，无失败、无忽略。
- 以下均为当前代码调用链证据，未通过操作用户正在运行的窗口复现；既有测试通过不代表下列交互已覆盖。

## 初次审计问题及证据（下述根因描述对应修复前）

### R01 / P1：便携导入将账号 ID 写成服务商类型

- 位置：`src-tauri/src/config.rs:457-483`，尤其 482；`types.rs:163`；`src/pages/SettingsWindow.tsx:232`。
- 新建账号的键是 UUID，而 `provider_id` 应为 codex、antigravity 等固定服务商 ID。导入却执行 `cfg.provider_id = target_id.clone()`。追加遇到同名键时还会产生 `codex_xxxxxx` 一类值。
- 结果：最后 save_settings 的校验返回“账号配置无效”，导入不能完成。即使绕过校验，这些值也不能正常分发到 Provider。
- 修复：保持来源 cfg.provider_id，仅更换账户字典键和凭据引用；先校验整个合并结果，再产生写入副作用。
- 验收：UUID 多账号、默认账号追加、同名冲突、覆盖导入均保持服务商类型正确，导入后可达原有数据路线。

### R02 / P1：导入凭据回滚不完整，可能破坏目标原凭据

- 位置：`src-tauri/src/config.rs:448-496`。
- 覆盖模式先清空内存账号表，再按源键直接写目标 Credential Manager；旧目标凭据未备份。后续合并失败时 rollback 对所有 written_keys 直接 delete，不能恢复被覆盖的旧值。
- 最后的 save_settings 在 merge_result 回滚范围之外。校验失败（R01）或写盘失败时，已写入凭据仍保留，原配置文件和凭据可能来自不同状态。settings.json 的备份不包含 Credential Manager 原值。
- 修复：导入事务保存每个目标凭据原值及是否存在，失败精确恢复；把设置验证、原子提交失败也纳入回滚；禁止将“删除已写键”当作覆盖写入的回滚。
- 验收：模拟第二项写失败、读回失败、最终设置写失败，原设置和原凭据逐项不变；测试采用内存 SecretStore，不能以真实凭据作为样本。

### R03 / P1：追加导入遇到目标配置损坏会退回默认值并可能覆盖原文件

- 位置：`src-tauri/src/config.rs:447-449,496`。
- load_settings().unwrap_or_default() 丢弃损坏/读取错误；只有 Overwrite 分支调用 backup_settings。Append 模式在后续可以成功提交的条件下会把默认值与源账号写回，违背保留损坏文件的原则。
- 修复：显式传播现有文件读取和解析错误；只有确实不存在时允许初始化默认值。损坏恢复作为独立流程，并保留原始文件。
- 验收：目标 JSON 损坏、结构无效和读取失败时，追加导入失败且原始字节不变。

### R04 / P2：旧明文配置的凭据被识别存在，但不会随导入迁移

- 位置：`src-tauri/src/config.rs:192-228,443-477`。
- parse_settings_readonly 从反序列化对象去掉 api_key，仅将其存在性计入 credential_configured；导入阶段却只读 old_store。若凭据仅在旧 JSON 中，导入阶段拿不到它并重置为未配置。
- 修复：只读解析返回独立的待迁移 Secret 集合；优先级明确，写安全存储并校验后提交目标配置，源文件仍保持不变。报告和日志禁止打印 Secret。
- 验收：只有旧 api_key、只有安全存储、两者并存、空值四类脱敏样本；迁移后调用链可用且目标 JSON 不含明文。

### R05 / P2：Token 消耗扫描中切换页面后，按钮可能永久停在“正在读取”

- 位置：`src/pages/TokenSpend.tsx:12-17,25-39`；`SettingsWindow.tsx:600`。
- 页面通过 hidden 保留挂载。active=false 时递增 request 并取消后台任务，但不清 busy。原请求 finally 因 seq 不匹配也不清 busy；切回页面后按钮和时间选择器仍禁用。
- 修复：取消/失活明确重置 busy；用扫描 ID 管理 pending/完成/取消，旧任务不得修改新任务状态。同步更新“切换页签不会丢失结果”的提示与真实行为。
- 验收：延迟扫描时切页再回来，可重新扫描；取消响应晚到不得覆盖新结果。

### R06 / P2：详情首次显示仍可绕过布局就绪，错位有复发路径

- 位置：`src-tauri/src/commands.rs:643-658`；`src/App.tsx:58-68`。
- 后端 260ms 后无条件进入 show（仍检查请求 ID/隐藏状态，但不检查 viewport）；前端 attempts>=20 也把尚未匹配的布局当作 ready。
- 这不是已经在 v0.4.7 实机复现的声明。代码证明：慢启动或 DPI 尚未稳定时，显示不再以布局正确为前提，因此不能宣称之前的首次错位已彻底解决。
- 修复：超时走有限重试/重新测量/定位或明确失败状态，不能把超时等同成功；当前请求内容与 viewport 均就绪才显示。保留请求 ID 防止过期回调打开旧卡。
- 验收：冷启动人为延迟布局 >260ms、混合 DPI、快速换账号和移出；第一帧无窄窗、裁剪、旧内容，超时后可再次打开。

### R07 / P2：250ms 折叠请求反复重置 280ms 动画完成计时

- 位置：`src-tauri/src/lib.rs:670-695`；`src/components/FloatingRail.tsx:48-62,114-120`。
- 后台在超时且仍为 rail 时逐 tick 发 request-collapse；前端每次 clearTimeout 再设 280ms。若事件间隔接近 250ms，完成回调不断延期，最终依赖后台额外 1 秒强制折叠。
- 修复：折叠过渡幂等，同一过渡仅调度一次；一个状态机负责计时，后台兜底只处理明确超时并使用代际号。不要简单靠加长某个固定延时互相躲避。
- 验收：模拟每 250ms 重复事件，仍只完成一次 280ms 过渡；途中移入立即取消且旧回调不能重新折叠。

### R08 / P2：鼠标停在详情卡阅读时，前端仍可能关闭详情并折叠

- 位置：`src/components/FloatingRail.tsx:149-163,227-236,330-338`；后台 `lib.rs:650-660`。
- 退出悬浮栏后 inside=false，detailPointer=true 只阻止短暂离开计时器关闭卡片。长自动折叠计时器仍执行 hide_detail；startCollapse 也不检查 detailPointer。后台考虑了 over_detail，但不能阻止前端独立提交。
- 修复：悬浮栏和详情窗共用“交互区域内”状态；进入详情取消待折叠，真正离开两者后重新开始计时。
- 验收：开启 1 秒折叠，移入详情停留 10 秒保持可读；离开两窗口后才折叠。

### R09 / P2：快捷唤出保持展开 5 秒的状态仅前端知道，后端可提前强制折叠

- 位置：`src/components/FloatingRail.tsx:76-90`；`src-tauri/src/commands.rs:168-173`；`lib.rs:678`。
- reveal-rail 设置 pinned 至少 5 秒。后端只重置 last_cursor_over，不知道 pinned；折叠设 1/2/3 秒、鼠标在外时，后端可在约 delay+1 秒强制收起，即使前端拒绝 request-collapse。
- 修复：后端共享 pin_until 或统一状态机，明确用户唤出优先级；定时器用同一时间基准。
- 验收：鼠标远离悬浮栏时快捷唤出，在约定保持期内不可提前收起。

### R10 / P3：“减少动态”切换未同步到已注册折叠闭包

- 位置：`src/components/FloatingRail.tsx:48-62,112-120,141-163`。
- startCollapse 读取 settings.reduce_motion，但两个 effect 依赖列表都未包含它或稳定的 startCollapse；仅切换减少动态时可能继续使用旧分支及旧延时。
- 修复：使用依赖完整的稳定回调或最新状态引用；切换减少动态时处理正在进行的动画。
- 验收：悬浮栏运行中双向切换减少动态，首次自动折叠即遵循新值，无需重启。

## 已有改进和本轮边界

- 关闭桥接已有订阅就绪、IPC 找回丢失请求与去重；相关测试通过。不能据此替代便携 EXE 原生 X、页面关闭和 Esc 实机验收。
- 详情窗已有请求编号和 viewport 检查，但 R06 的兜底仍削弱该保证。
- Token 扫描已有后台取消机制，但前端取消后的状态收尾不完整。
- 源配置只读解析、目标凭据读回验证已有实现，但 R01-R04 说明导入事务还未闭环。
- 尚未验证：GitHub Release 下载包、全新便携目录、安装升级卸载、全部真实 Provider、多屏热插拔、长时间驻留和性能；不能将这些写为通过或已发现故障。

## 建议执行顺序

1. R01-R04：先补内存凭据仓库和临时文件失败注入测试，再修便携导入事务，确保不破坏账号数据。
2. R05：修取消收尾，增加保留挂载页面的交互回归。
3. R07-R10：统一窗口折叠/唤出/详情悬停状态与动画完成确认，使用虚拟时钟验证重复事件。
4. R06：修详情显示就绪条件，进行冷启动和混合 DPI 实机验收。
5. 从同一 SHA 构建安装包与便携 ZIP，记录 EXE 哈希和构建清单；分别实测关闭三入口、首开详情、取消扫描和无损导入。未通过不得写成发布验收完成。

交接时保留用户配置与凭据；不得把删除配置、清空 Credential Manager 或复制开发机私人配置当作修复方法。R01-R10 均已完成代码修复和针对性自动回归；实机与发布验收边界见下方记录。


## 本轮修复与自测记录

保留用户追加的余额显示修改。未变更版本号、未提交或发布 GitHub、未覆盖运行中的 EXE。

| 编号 | 修复结果 | 针对性证据 |
|---|---|---|
| R01 | 导入使用独立 UUID，保持 provider_id；写入前验证全部设置 | import_uuid_accounts_and_legacy_secrets_without_touching_source |
| R02 | 新账号使用新凭据键；写前记录原值；凭据写入/读回/最终提交失败均回滚；回滚失败明确报错 | import_save_failure_preserves_credentials_and_target_bytes；import_partial_write_failure_removes_only_new_credentials；import_readback_failure_rolls_back_and_source_store_wins_over_plaintext |
| R03 | 只读解析目标，损坏/读取失败直接终止；两种模式提交前备份 | import_damaged_target_never_saves_or_writes_secrets |
| R04 | 单独提取旧明文 Secret，安全存储优先，目标 JSON 不含 Secret，源文件不变 | UUID/旧凭据导入测试以及安全存储优先测试 |
| R05 | 失活清除 busy 并使旧请求失效；新扫描先等待取消完成；修正文案 | TokenSpend.test.tsx：真实组件切页、重新扫描、旧响应晚到 |
| R06 | 删除 260ms 强制显示与前端超时即 ready；每个请求先隐藏再定位；两次稳定测量才请求显示，后端返回实际结果；5秒失败保持隐藏，可重新悬停重试 | windowRegression.test.tsx：慢布局、超时、旧请求取消、暂时拒绝后重试 |
| R07 | 重复折叠请求不重置动画；取消时清理句柄；移除前端独立空闲计时 | 重复250ms请求仍在首个280ms完成的组件测试 |
| R08 | 后端统一检测两个窗口；前端详情悬停取消过渡；延迟折叠提交再次验证交互状态 | 详情停留10秒不折叠/不隐藏的组件测试；rail_state 后端交互保护测试 |
| R09 | 所有唤出入口先设置后端5秒保护；后台兜底及迟到的前端请求共用 may_collapse 保护 | reveal组件测试；reveal_pin_wins_over_short_auto_collapse_and_late_ack |
| R10 | 折叠回调依赖完整；减少动态变化取消旧过渡 | reduced motion 运行中切换组件测试 |

本轮验证命令与结果：

- `npm test`：6 个测试文件，21 项通过。
- `npm run build`：TypeScript 和 Vite 生产构建通过。
- `cargo test --locked --lib`：87 项通过。
- `git diff --check`：通过。
- `npm run lint`：无错误，12 条警告；折叠回调缺失依赖的原警告已解决。其余包括 React 对 effect 更新状态、ref 使用及既有组件的提示，不能将成功退出写为零警告。

测试使用模拟 IPC、虚拟时钟、内存凭据仓库和临时目录；不读取真实账号 Secret、不请求 Provider 服务、不迁移用户配置。当前 150% DPI 的隔离原生实例验证见下方；混合 DPI 热插拔、逐帧录制、真实 Credential Manager 故障及 GitHub 下载包仍未验收，不能以自动测试代替。


### Release 与隔离 Windows 实例验证

- `cargo rustc --release --locked --bin pulse-windows -- -o release-artifacts/pulse-v047-audit-fixes.exe`（仓库内相对路径）成功。另设输出路径，未替换运行中的目标 EXE。
- Release EXE 在临时 PULSE_DATA_DIR 下执行 `--json` 返回 `[]`、退出码 0，目录无新增文件。
- 使用独立临时配置、未授权任何 Provider、关闭 Token 扫描的原生 WebView2 实例测试；只检查本次创建的 PID，测试后终止该实例及其子进程。
- 150% DPI：冷启动第一次打开详情卡，实际 CSS 340×360、DPR 1.5，与请求物理 510×540 一致，原生窗口已可见。
- 隐藏详情后，旧 request_id 的 ready 被拒绝，原生窗口仍隐藏。
- 1 秒自动折叠：重新展开后 1.75 秒时窗口已收窄至 24 CSS 像素，早于原有约 2 秒强制兜底。
- 唤出保护使用后端 may_collapse 时间边界测试及前端真实组件事件测试验证；未操作用户真实快捷键或鼠标进行接管。
- 原生测试脚本：`scripts/native-window-regression.py`（依赖 Python websocket-client；仅连接本次隔离实例的本地调试端口）。

本地测试包：`release-artifacts/Pulse-0.4.7-audit-fixes-portable.zip`，仅含 Pulse.exe、portable.flag、README.txt、SHA256SUMS.txt。不含用户 data、配置或凭据。请解压完整目录运行；保持旧版备份。没有上传 GitHub，版本资源仍为 0.4.7，目录名称用于区分本地修复候选。

- EXE SHA256：`89E1656BB131F33CA059535F9476BCA436AD614D2D3BAD18CE87AC7EBE0A8053`
- ZIP SHA256：`DFF5F55DFCF573289A5B87795F02844F7F946CCBFFBDA3826E0B392C8F512ED9`
- ZIP 内 EXE 哈希与构建产物核对一致。

结果：10项所列代码问题已修复，并通过对应自动回归及上述有限原生实例检查；这不等于所有 Provider、显示器组合和正式发布渠道已完成验收。
