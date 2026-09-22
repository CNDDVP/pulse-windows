# Pulse v0.3.8 运行与体验审计

日期：2026-09-19。范围：本仓库本地工作区及用户正在运行的程序。

## 结论与边界

审计进行中，尚未完成全部实机验收。本报告是缺陷审计，不代表已修复。没有修改生产源码、账号、凭据或启动配置。用户按 Escape 停止 Computer Use 后没有继续操作界面。源码检查发现的问题与实机已复现严格区分；P1/P2 是修复优先级，不等于已发生数据丢失。

## 基线

- HEAD：2eff0a5a72507bff8d0d87fbf45e69e64a245202；package/Cargo/Tauri 声明 0.3.8。
- 本轮开始存在非本审计产生的 activity.rs 未提交改动，扩展 ZCode/Antigravity 活动检测；已保留。
- 本轮 activity.rs SHA256：8C95D07B7015A63E75271E59E0C421CCE11CFB83C73617EFF9B8D5F536543938。
- 运行实例 PID 66840，启动时间 2026-09-19 15:52:36 +08:00，路径 src-tauri/target/release/pulse-windows.exe，文件版本 0.3.7。
- EXE SHA256：383421E8DD08C2E13330BC86759D1EE8CCD7DAAF72CB5E8C4D49D83111EE6DEA。
- 本地未配置 Git remote；未声称本目录就是 GitHub 最新 main。

## 已执行验证

上一审计轮：npm run lint（0 error、5 warnings）、npm run typecheck、npm test（9/9）、npm run build 成功；cargo test --offline --lib --manifest-path src-tauri/Cargo.toml（62/62、4 warnings）。这些测试运行早于本轮发现的 activity.rs 未提交修改，不冒充其完整回归结果。

本轮再次用当前真实 activity.rs 模块、隔离临时目录和合成 Codex 日志运行活动探针。只有系统路径发现被替换为空实现，Watcher 使用真实代码；消费者按 poll_activity 的增量覆盖语义模拟，不是完整 GUI 测试。结果：

```text
working_scan={"codex": true}; ui_active=true
stopped_scan={}; ui_active=true
expired_scan={}; ui_active=true
```

打包路径探针仅求值现有保护条件，不调用脚本、不执行删除；src/components、docs、.git、../pulse-windows-other 均被放行。

实机已观察悬浮栏及右键菜单，账号存在读数更新；不能由此推断额度精度或所有 Provider 可用。用户输入中断了后续 UI 验证。

上一轮约 30 秒采样覆盖主进程和 8 个 WebView2 后代进程。主进程私有内存 41.59→41.64 MiB、句柄 783→783；样本太短，不能证明无泄漏。机器同时有其他应用运行，不是空闲性能基准。旧报告所称 24 小时监控尚未找到本轮可核实的运行句柄及结果，不能记为通过。

## 缺陷清单

### A01 [P1] 活动停止后仍显示工作中

- 位置：src-tauri/src/activity.rs:148; src-tauri/src/lib.rs:301。
- 证据：合成日志复现。
- 根因与影响：Watcher 仅返回 true 来源；poll_activity 仅遍历返回项，停止和 180 秒衰减不会清除上层 true。当前未提交改动后再次复现。
- 验收：所有已配置来源每轮返回明确状态；任务结束和衰减后两个轮询内 UI 复位。
- 状态：未修复。

### A02 [P1] 手动与定时刷新非对称去重

- 位置：src-tauri/src/lib.rs:50; src-tauri/src/lib.rs:200。
- 证据：静态调用链。
- 根因与影响：定时轮检查手动 inflight，却不登记自己的在途请求；同账号可出现两请求，generation 相同时都能写回。
- 验收：所有入口使用同一按账号协调器；可控延迟测试证明单请求及旧结果不覆盖新结果。
- 状态：未修复。

### A03 [P1] 设置事务存在丢更新风险

- 位置：src-tauri/src/commands.rs:31; src/pages/SettingsWindow.tsx:91。
- 证据：静态调用链。
- 根因与影响：读取旧设置后释放锁，异步落盘后重新覆盖；滑块和普通设置可连续提交。代际冲突合并只保护四个位置字段。
- 验收：串行事务或原子比较版本加字段补丁；并发保存、拖动、凭据变更不丢字段。
- 状态：未修复。

### A04 [P1] 清理凭据可能假成功

- 位置：src-tauri/src/secrets.rs:68; src-tauri/src/commands.rs:405。
- 证据：静态调用链。
- 根因与影响：逐项删除错误被忽略并返回 Ok；内存 credential_configured、读数及在途 generation 均未同步。
- 验收：错误逐项反馈；清理成功后各窗口同步；过期请求不能重新写入。
- 状态：未修复。

### A05 [P1] 打包目录保护仍可删除源码或相邻目录

- 位置：scripts/build-dist.ps1:32。
- 证据：非破坏性条件复现。
- 根因与影响：StartsWith 缺少目录分隔符边界；保护只检查目标是否为源码祖先，未禁止源码后代。.git、docs、src/components、../pulse-windows-other 均被当前条件放行。未执行删除。
- 验收：限定专用输出目录并校验真实路径及重解析点；危险参数全部在任何删除前拒绝。
- 状态：未修复。

### A06 [P2] 凭据修改后悬浮栏残留旧读数

- 位置：src-tauri/src/commands.rs:117; src-tauri/src/commands.rs:133。
- 证据：静态调用链。
- 根因与影响：清除后端缓存后只发 settings-updated，不发 usages-updated；前端仍持旧数组。
- 验收：凭据更换或删除立即清空相关读数并呈现等待/未配置状态。
- 状态：未修复。

### A07 [P2] 立即刷新全部可能无请求却报成功

- 位置：src-tauri/src/lib.rs:214; src/pages/settings/GeneralPage.tsx:94。
- 证据：静态调用链。
- 根因与影响：手动全量入口复用 due 调度，正常冷却期内全部被跳过；界面仍提示已刷新全部。
- 验收：区分手动刷新与周期调度，保留服务限流；返回实际刷新、跳过和失败数量。
- 状态：未修复。

### A08 [P2] 长拖动后的点击抑制提前过期

- 位置：src/components/FloatingRail.tsx:143。
- 证据：静态代码。
- 根因与影响：抑制到期时间在拖动开始设置，pointerup 未续期。超过 400ms 的拖动松手点击可进入刷新。
- 验收：抑制拖动产生的 click；覆盖长拖动、短拖动和正常点击。
- 状态：未修复。

### A09 [P2] 跨屏拖动保存遗漏显示器和代际

- 位置：src-tauri/src/commands.rs:501。
- 证据：静态代码。
- 根因与影响：monitor_name 赋值不标 changed；相同比例换屏可不落盘；drag_end 保存不递增 generation。
- 验收：跨屏即使比例一致也保存，且与其他设置修改遵循同一事务。
- 状态：未修复。

### A10 [P2] 手动刷新遗漏通知及持久缓存

- 位置：src-tauri/src/lib.rs:274。
- 证据：静态调用链。
- 根因与影响：apply_single_reading 不执行 alerts::evaluate 和 usage-cache 写入，定时入口才执行。
- 验收：统一结果提交步骤；两入口同样触发适用通知与 --json 更新。
- 状态：未修复。

### A11 [P2] 旧请求定时器关闭新刷新动画

- 位置：src/components/FloatingRail.tsx:80。
- 证据：静态代码。
- 根因与影响：finished 处理时检查 request_id，但延时回调删除状态时不再次检查。
- 验收：延时回调核对请求编号；A 完成后 B 开始仍保留 B 动画。
- 状态：未修复。

### A12 [P2] 剩余模式详情条形图语义不一致

- 位置：src/components/UsageDetailCard.tsx:28。
- 证据：静态代码。
- 根因与影响：数字转为剩余，条宽仍用 used_percent。
- 验收：统一剩余/已用表达，或对固定显示已用的条形图明确标注。
- 状态：未修复。

### A13 [P2] 缺失工具目录被误判统计缺口

- 位置：src-tauri/src/ledger.rs:62。
- 证据：静态代码。
- 根因与影响：任何 read_dir 失败均 truncated=true，包括未安装工具的根目录；还导致历史清理被长期跳过。
- 验收：缺失来源单独标未发现，权限失败和扫描截断才标缺口；维护删除文件策略。
- 状态：未修复。

### A14 [P2] 费用覆盖不透明且模型匹配过宽

- 位置：src-tauri/src/ledger.rs:180; src-tauri/src/ledger.rs:226。
- 证据：静态代码。
- 根因与影响：存在一个已知价格即返回部分费用总数；未知模型未反映计价覆盖率；任意含 pro/flash 名称可被套价。未核验外部最新价格。
- 验收：精确模型映射、价格版本及来源；同时呈现已计价与未计价 token 数。
- 状态：未修复。

### A15 [P2] 自由窗口缺少持续显示器恢复

- 位置：src-tauri/src/lib.rs:399。
- 证据：静态代码，实机待验证。
- 根因与影响：每秒定位分支排除 free，且没有发现显示器变化的专门恢复入口。跟随活动屏开关在自由模式缺少持续执行。
- 验收：实机断屏与主屏切换后窗口可见；明确自由模式跟随策略。
- 状态：未修复。

### A16 [P2] 隐藏主栏未统一隐藏详情

- 位置：src-tauri/src/lib.rs:393; src-tauri/src/tray.rs。
- 证据：静态代码，实机待验证。
- 根因与影响：托盘、全屏避让和 show_rail 隐藏路径只处理 main，detail 独立置顶。
- 验收：统一可见性状态，隐藏主栏时 detail 同步关闭。
- 状态：未修复。

### A17 [P2] 原生关闭设置绕过清理流程

- 位置：src-tauri/src/lib.rs:445; src/pages/SettingsWindow.tsx:190。
- 证据：静态调用链。
- 根因与影响：原生 X/Alt+F4 被 Rust 改为 hide，绕过 React 未保存确认和 secrets 清空；窗口不卸载。
- 验收：所有关闭入口统一处理未保存编辑并清理暂存 secret。
- 状态：未修复。

### A18 [P2] 配置身份文件损坏时静默换身份

- 位置：src-tauri/src/config.rs:78。
- 证据：静态代码。
- 根因与影响：profile.json 解析失败就生成新 ID；写入错误被忽略。旧凭据可能变得不可达，写入失败后重启继续换身份。
- 验收：损坏文件保留并显式报错，持久化成功后才启用新身份。
- 状态：未修复。

### A19 [P2] 缓存过期缺少独立时钟驱动

- 位置：src-tauri/src/cache.rs:32; src-tauri/src/lib.rs:200; src/App.tsx。
- 证据：静态调用链。
- 根因与影响：expire 只在请求结果/get_usages 等路径执行；无新结果时 UI 可超过 600 秒仍显示 live，刷新间隔允许 1800 秒以上。
- 验收：独立过期状态推进；跨重置、退避和长周期状态及时变化。
- 状态：未修复。

### A20 [P2] Token 日期分组顺序不稳定

- 位置：src/pages/TokenSpend.tsx:10; src-tauri/src/ledger.rs:175。
- 证据：静态代码。
- 根因与影响：后端按 source/model/day/hour 排序，前端 Map 按首次遇见顺序展示，跨来源合并后日期不一定顺序排列。
- 验收：日期/小时显式排序；模型顺序有明确规则。
- 状态：未修复。

### A21 [P2] 统计错误信息不能跨扫描保留

- 位置：src-tauri/src/ledger.rs:142; src-tauri/src/ledger.rs:173。
- 证据：静态代码。
- 根因与影响：坏行只增加当轮 skipped；下轮未变文件被跳过，不再保留坏行标记；query_map 的错误经 flatten 丢弃。
- 验收：文件级不完整标记持久化；SQL 行错误明确报告；连续扫描不把残缺数据标完整。
- 状态：未修复。

### A22 [P2] Provider 可选请求吞错与总超时冲突

- 位置：src-tauri/src/providers/xiaomi.rs:45; src-tauri/src/providers/command_code.rs; src-tauri/src/providers/volcengine.rs。
- 证据：静态调用链。
- 根因与影响：多串行请求各有 12 秒超时，外层总限 25 秒；可选请求可导致有效主额度也被总超时丢弃。可选错误被 ok() 或分支吞掉。
- 验收：主额度不被可选信息超时拖垮；部分数据状态可见，统一总预算。
- 状态：未修复。

### A23 [P2] Windsurf 记录新鲜度判定过宽

- 位置：src-tauri/src/providers/devin.rs:53。
- 证据：静态代码。
- 根因与影响：按整个数据库 mtime 判定 7 天，缺元数据也视为非旧；非额度数据写入可让旧额度被标实时。
- 验收：以额度记录自身时间/可信重置证据判断，不可证实的新鲜度标未验证。
- 状态：未修复。

### A24 [P2] 活动扫描长行卡住及文件表不清理

- 位置：src-tauri/src/activity.rs:72; src-tauri/src/activity.rs:116。
- 证据：静态代码。
- 根因与影响：一行超过单次预算且预算中没有换行时 offset 永远不前进；files 映射不移除消失路径。
- 验收：超长记录可跳过并恢复后续解析；消失会话按规则回收。
- 状态：未修复。

### A25 [P2] 更换独立 Profile 未同步运行状态

- 位置：src-tauri/src/commands.rs:410; src-tauri/src/config.rs:107。
- 证据：静态调用链。
- 根因与影响：只替换身份文件和身份缓存，没有清理额度、更新凭据 flags、取消旧身份请求。
- 验收：身份切换作为事务，旧身份结果无法提交，所有窗口同步新状态。
- 状态：未修复。

### A26 [P2] 普通设置自动保存会一并保存账号草稿

- 位置：src/pages/SettingsWindow.tsx:91。
- 证据：静态调用链。
- 根因与影响：账号声明显式保存，但普通设置 persist(next) 携带全量 providers，包括账号页未保存编辑。
- 验收：普通设置只提交自己的字段；账号草稿需显式保存。
- 状态：未修复。

### A27 [P3] 减少动态未统一覆盖动画

- 位置：src/components/UsageRing.tsx; src/components/BotMark.tsx; src/index.css。
- 证据：静态代码。
- 根因与影响：减少动态只传给 BotMark；刷新旋转、活动点和详情进入动画仍运行。
- 验收：全局开关和系统偏好统一控制连续装饰动画。
- 状态：未修复。

### A28 [P2] 运行包与当前源码版本未对应

- 位置：package.json; src-tauri/target/release/pulse-windows.exe。
- 证据：实机元数据。
- 根因与影响：源码 0.3.8，运行 EXE 文件版本 0.3.7；仅版本资源不足以证明完整代码来源。
- 验收：构建信息绑定 SHA、工作区状态和 EXE 哈希，明确实机验收对象。
- 状态：未修复。

## 已有改善与旧结论纠正

- secondary_window=null 已不渲染内环，不继续把旧的自动回退逻辑列为当前缺陷；保存后的实机验收仍待完成。
- 右键菜单已在运行实例观察到，不沿用旧报告“完全不可用”的结论。
- 稳定版本/预发布分支、逐条检查原生命令退出码、精确安装包版本匹配和默认不强杀进程已有代码改善。
- 按账号去重、拖动保存及目录删除保护仍有本报告所列缺口，不能沿用旧文档的“已验证全部修复”。
- 当前兼容目录有 19 个 Provider 标识，不能拿旧文档 18/18 或样本测试比例当作真实账号覆盖率。

## 待验证风险（不作为已复现 Bug）

拖动缺少 pointer capture/失焦统一恢复，begin/move/end IPC 顺序及错误回滚需实测；拖动吸附预览后的尺寸/抓取偏移、顶部多账号滚动、模型分组后的窗口尺寸、详情初次 placement 事件时序需验证。Credential Manager 错误与未找到被混同；读取旧编码错误的资源释放、第三方响应大小、动态进程退出后的子进程回收需补异常测试。新增按日志增长判断 ZCode/Antigravity 活动属于启发式，后台日志写入误判与 WAL 覆盖式写入漏判未验收。

## 剩余工作与交接顺序

1. 冻结当前源码快照与运行二进制对应；避免覆盖用户或其他 AI 的 activity.rs 改动。
2. 为 A02/A03/A04/A06/A09/A25 加隔离并发/故障注入证据；不用真实凭据做破坏性试验。
3. 对 Token 统计进行缺目录、混合未知价格、连续坏行扫描、日志轮转、SQLite 锁及大文件测试。
4. 用户允许继续界面操作后，验收设置原生关闭、长拖动、详情残留、混合 DPI、负坐标、热插拔、睡眠和网络恢复。
5. Provider 逐项记录静态路线、脱敏样本、真实账号验证，缺账号标待验证；不把 19 个分支记成 19 个已实测。
6. 先确认既有驻留任务是否真正在运行；没有有效句柄/记录不能继续使用“进行中”文案。新的长测应绑定二进制哈希、进程创建时间、进程树及采样条件。
7. 另行验收安装、升级、便携和卸载；当前未运行 build-dist.ps1，未重启用户实例，未发布 GitHub。

建议修复顺序：设置/凭据事务与打包目录保护 → 统一刷新提交/去重 → 活动状态与窗口生命周期 → 统计完整性和 UI 一致性 → 实机及驻留回归。用户本次授权的是审计，修复状态保持未开始。

每次更新应报告新增、撤销、已验证、仍未验证及源码漂移；不凭单测通过关闭运行时问题。

