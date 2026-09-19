# Pulse v0.3.10 复审与修复交接

日期：2026-09-19。源码 HEAD：5ce147d88abf15361509ed115630a96da774b65a；审计开始工作区干净。

## 结论

不能确认旧 28 项已全部闭环。本轮登记 21 项当前问题（4 项 P1、16 项 P2、1 项 P3），包含遗留缺口和新发现，不能把数量直接当成新增 Bug 数。除注明隔离复现外均为静态代码/调用链证据，非用户实机复现。另有运行包版本对应的验收缺口。未修改生产源码、账号、凭据，未操纵鼠标窗口、重启或重新打包正在运行的应用。

## 实际验证

- npm run lint：0 error，11 条 warning（包括重复位置的诊断）。
- npm run typecheck / npm test / npm run build：通过，前端 9 项测试。
- cargo test --offline --locked --lib --manifest-path src-tauri/Cargo.toml：65 项通过，4 条 warning。
- 在独立临时 Cargo 项目复制当前 activity.rs/ledger.rs，加探针入口。真实路径发现被禁用，统计只调用隔离 scan_paths，未读取真实会话/凭据。
- 探针原始结果：

```text
partial_write={"codex": false}
completed_line={"codex": false} EXPECT codex=true
ledger_first partial=true skipped=1; second partial=false skipped=0 EXPECT both partial
Missing protected directory probe: 不能对值为 Null 的表达式调用方法。
```

前两项为当前真实模块的行为，第三项仅求值路径表达式，未执行打包脚本或删除。

运行实例 PID 43976，创建时间 2026-09-19 16:50:26 +08:00；EXE 文件版本 0.3.9，源码版本 0.3.10。文件版本不能独立证明包含哪些提交。EXE SHA256：F9EC085C68CC988224C3F6AE3810CF089FF191EBFC41AADC35D45870E27C6EE6。没有用这个实例冒充 v0.3.10 实机验收。

## 当前问题

### B01 [P1] 设置串行锁仍不能防止旧表单覆盖新设置

- 对应：A03/A09；证据：代码确认。
- 位置：commands.rs:36; commands.rs:535; SettingsWindow.tsx:108（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：settings_io 只串行执行，new_settings 仍是锁外生成的完整旧快照。generation 冲突只保护位置字段；drag_end 不递增 generation，使旧表单仍可覆盖刚保存的位置。
- 复现/修复验收：先编辑账号不保存→拖动悬浮栏→保存账号，检查位置；快速交错提交两个不同设置。应采用字段补丁或可靠冲突处理，所有写入口共享协议。

### B02 [P1] 清理全部凭据仍未同步缓存和在途请求

- 对应：A04；证据：代码确认。
- 位置：commands.rs:413; secrets.rs:68（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：现在会报告删除失败，但命令仍不接收 AppState，不清 usages、不更新 credential_configured、不 bump generation，也未取得 settings_io。
- 复现/修复验收：模拟全部成功及部分失败；成功删除项立即清除旧读数和状态；旧请求不得回写。

### B03 [P1] Profile 持久化失败后仍启用临时新身份

- 对应：A18；证据：代码确认。
- 位置：config.rs:78; main.rs:2（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：损坏文件增加备份和 eprintln，但写盘失败仍把新身份放进 OnceLock；发布 GUI 没有默认控制台，且没有建立用户可见错误通道。重启可能再次换身份，使凭据不可达。
- 复现/修复验收：模拟 profile 损坏、只读目录、写入失败；持久化失败必须阻止启用新身份并显示可恢复错误。

### B04 [P1] 请求有效性校验与写回不是原子提交

- 对应：A02/A25；证据：代码确认。
- 位置：lib.rs:86; lib.rs:239; lib.rs:289（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：generation 检查后释放锁，再 await 清 inflight、获取缓存等；这期间凭据/Profile 可变化，旧结果仍能提交。inflight 在提交前移除，也提前放行新请求。
- 复现/修复验收：在校验通过与实际写回之间注入凭据切换；旧结果不能回写。request_id、generation、profile_id 在同一提交边界复核。

### B05 [P2] 保存新凭据仍保留前端旧额度

- 对应：A06；证据：代码确认。
- 位置：commands.rs:120（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：delete_credential 已补 usages-updated，set_credential 仍只有 settings-updated。
- 复现/修复验收：替换凭据后，各窗口立即删除旧读数，显示待刷新状态。

### B06 [P2] 切换 Profile 后只广播新设置而未更新内存设置

- 对应：A25；证据：代码确认。
- 位置：commands.rs:418（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：load_settings 的结果仅 emit，没有赋给 state.settings；未取得 settings_io。前端显示的凭据 flags 与 get_settings 返回值可能不同，且可与凭据保存交错。
- 复现/修复验收：切换后 get_settings、事件、磁盘状态一致；与凭据保存互斥。

### B07 [P2] 长行修复引入普通半行日志丢失

- 对应：A24 新回归；证据：隔离复现。
- 位置：activity.rs:84（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：预算内找不到换行就推进 offset，即使只有几十字节的未完成尾行也丢弃。补齐 JSON 后只能读到后半段，任务开始/结束事件均可漏读。
- 复现/修复验收：分别追加一条 JSON 的前半段和后半段，中间各轮询一次；完整行最终必须只解析一次。仅在明确超过长行上限时进入丢弃至换行的状态。

### B08 [P2] Token 坏行缺口在第二次扫描消失

- 对应：A21；证据：隔离复现。
- 位置：ledger.rs:120; ledger.rs:147; ledger.rs:178（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：未修改文件直接跳过，坏行计数只存本轮局部变量；数据库读取仍 result.flatten()。
- 复现/修复验收：同一坏行文件连续扫描，两次均 partial=true；SQL 行转换失败也需保持错误证据。

### B09 [P2] 拖动后是否抑制点击仍依赖移动窗口内的 client 坐标

- 对应：A08；证据：代码确认，实机待验。
- 位置：FloatingRail.tsx:159（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：窗口跟随光标时 clientX/clientY 可能基本不变；用松手与按下 client 距离判断 >=12，不等于真实屏幕拖动距离。
- 复现/修复验收：长距离平移时保持光标相对窗口位置不变，松手不得刷新；使用真实拖动态或稳定屏幕坐标。

### B10 [P2] 自由模式恢复只判断左上角，不保证窗口完整可见

- 对应：A15；证据：代码确认，实机待验。
- 位置：lib.rs:459; window.rs:171（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：左上角在显示器矩形内即认为正常，不检查窗口右下边界和工作区；分辨率减小可留下大部分窗口在屏外。自由模式持续跟随鼠标屏仍未实现。
- 复现/修复验收：分辨率下降、任务栏变化、负坐标和断屏后整个可交互窗口在工作区；明确跟随策略。

### B11 [P2] Command Code 的可选请求仍可耗尽总预算

- 对应：A22；证据：代码确认。
- 位置：providers/command_code.rs:18; providers/mod.rs（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：两个必需请求各 12 秒，再追加 6 秒可选请求，总计可达 30 秒，外层仍 25 秒。附加错误仍被转 None。
- 复现/修复验收：可控服务令两个必需请求各 10 秒、可选请求 6 秒；主读数应保留。使用剩余总预算或解耦附加请求。

### B12 [P2] Windsurf 新鲜度核心依据仍是数据库 mtime

- 对应：A23；证据：代码确认。
- 位置：providers/devin.rs:54（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：修复仅将元数据失败变成不可信；数据库其他写入仍可使旧额度看起来新鲜，仍按 7 天判断。
- 复现/修复验收：额度缺独立可信时间时不能宣称实时；用更新无关 DB 行的样本验证。

### B13 [P2] 删除账号后 React 脏状态基线可能不更新

- 对应：新增发现；证据：代码确认。
- 位置：SettingsWindow.tsx:173（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：删除成功只写 appliedRef.current，未调用 markApplied 更新 applied state；事件若晚于响应到达，会因 ref 相同提前返回，anyDirty 仍看到旧账号。
- 复现/修复验收：控制 IPC 响应先于 settings-updated，删除后不应一直提示未保存。统一维护基线状态。

### B14 [P2] 设置保存失败后快捷键和凭据副作用未回滚

- 对应：新增发现；证据：代码确认。
- 位置：commands.rs:49; commands.rs:120; commands.rs:138（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：先更换系统快捷键/写入或删除凭据，再保存 JSON；后者失败时只返回错误，已有系统变化未恢复，内存继续旧状态。
- 复现/修复验收：模拟写盘失败，确认真实快捷键、凭据、内存与用户提示一致；记录部分提交并可恢复，不能仅报保存失败。

### B15 [P3] 应用内减少动态未应用到独立详情窗口

- 对应：A27；证据：代码确认。
- 位置：App.tsx:81; App.tsx:DetailOverlay; index.css（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：html.reduce-motion 仅在 MainApp 设置，detail 分支直接返回 DetailOverlay，不执行该 effect；系统媒体查询有效，但应用内开关未完整传播。
- 复现/修复验收：仅开启应用内开关时，详情窗口动画也停止。

### B16 [P2] 全新源码环境打包可能在构建前报 Null 错误

- 对应：A05 新回归；证据：非破坏性表达式复现。
- 位置：scripts/build-dist.ps1:38（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：对不存在的受保护目录先 Resolve-Path，再直接调用 ProviderPath.TrimEnd；例如全新 checkout 没有 dist，空值保护发生在方法调用之后。
- 复现/修复验收：未有 dist 的全新临时项目可通过路径验证并进入构建；先处理解析失败，不执行删除测试。

### B17 [P2] 手动总超时结果缺少 scope 和采集时间

- 对应：新增发现；证据：代码确认。
- 位置：lib.rs:99; providers/mod.rs:fetch_all_stream（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：手动超时构造 problem 只补 account/label；定时超时则补 scope/checked_at。缓存回退要求同 scope，导致手动超时与自动超时表现不一致。
- 复现/修复验收：同账号同作用域有有效旧读数时，两入口超时回退行为一致且显示采集时间。

### B18 [P2] 多个结果并行落盘可能把 usage-cache 回滚

- 对应：A10 后续缺口；证据：代码确认。
- 位置：lib.rs:281; lib.rs:321（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：每个手动刷新分别截取快照再 spawn_blocking 原子写同一文件；原子替换防文件损坏但不保证版本顺序。较旧快照最后写入可使 --json 落后于 UI。
- 复现/修复验收：两账号并发完成并反转写盘顺序，最终文件必须对应最新全局 revision。

### B19 [P2] 改变本地凭据来源不使旧请求失效

- 对应：新增发现；证据：代码确认。
- 位置：commands.rs:52（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：update_settings 的账号 generation 比较只含 order/enabled/label，不含 use_local；切换来源时旧请求仍可能被当作有效结果。
- 复现/修复验收：use_local 变更纳入请求身份；旧来源响应不能重新显示为当前结果。

### B20 [P2] 点击刷新遇到退避时没有用户反馈

- 对应：新增发现；证据：代码确认。
- 位置：FloatingRail.tsx:94; lib.rs:59（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：refresh_account 在退避中直接返回 Err，前端 catch 空处理；无 started 事件，也无错误提示，用户只看到点击无反应。
- 复现/修复验收：返回并显示冷却倒计时/原因，不能提示已刷新，也不绕过服务限流。

### B21 [P2] 调整账号顺序仍会顺带保存其他账号草稿

- 对应：A26 后续缺口；证据：代码确认。
- 位置：SettingsWindow.tsx:128（Rust 文件位于 src-tauri/src，React 文件位于 src 或 src/pages/src/components 对应目录；以仓库搜索定位）。
- 根因与影响：普通设置已改用 providers 基线，但 commitOrder 仍把整个当前 providers 草稿持久化；账号页明确保存的语义仍有旁路。
- 复现/修复验收：有未保存账号编辑时调整顺序，只保存顺序或显式提示将保存草稿。

## 旧 28 项逐项复核

| 原编号 | 本轮结论 | 说明 |
|---|---|---|
| A01 | 代码与现有回归通过 | 停止状态显式 false；另有 B07 半行回归 |
| A02 | 部分修复 | 对称登记 inflight 已补；B04 提交竞态仍在 |
| A03 | 未完整修复 | B01 旧快照覆盖并未由锁解决 |
| A04 | 部分修复 | 报告删除失败已补；B02 状态清理缺失 |
| A05 | 部分修复 | 原危险字符串路径被挡；B16 缺目录回归，重解析点未验 |
| A06 | 部分修复 | 删除广播已补，保存缺失 B05 |
| A07 | 主要代码缺陷已处理 | 反馈 initiated/skipped；未验证真实点击与服务结果 |
| A08 | 未完整修复 | B09 相对坐标判定 |
| A09 | 部分修复 | 跨屏标 changed 已补；B01 位置版本问题仍在 |
| A10 | 主要分支已补，存在后续风险 | 通知/落盘已补；B18 写盘顺序待改 |
| A11 | 代码修复成立 | 延时回调核对 request_id |
| A12 | 代码修复成立 | 条形宽度使用 pct |
| A13 | 代码修复成立 | NotFound 与其他目录错误区分 |
| A14 | 部分修复 | 已移除裸 pro/flash 并提示未知组；非精确型号映射/价格来源未完成，本轮未查实时价格 |
| A15 | 部分修复 | B10 可见区域和自由跟随 |
| A16 | 代码修复成立，实机待验 | 周期隐藏同时隐藏详情 |
| A17 | 代码路径已补，实机待验 | 原生关闭转交前端；监听每次渲染重订阅需耐久验证 |
| A18 | 未完整修复 | B03 写失败仍启用新身份 |
| A19 | 代码路径已补，长测待验 | 约 30 秒推进过期 |
| A20 | 代码修复成立 | 显式日期字符串排序 |
| A21 | 未修复且复现 | B08 |
| A22 | 部分修复 | B11 总预算与附加错误 |
| A23 | 未完整修复 | B12 仍按数据库时间 |
| A24 | 部分修复但有回归 | 回收映射已补，B07 半行事件丢失 |
| A25 | 部分修复 | B04/B06 |
| A26 | 部分修复 | 普通设置隔离草稿已补；B21 排序旁路 |
| A27 | 部分修复 | B15 详情窗口 |
| A28 | 仍未验证通过 | 源码 0.3.10，运行文件资源 0.3.9 |

## 验证范围和剩余风险

本轮重点读取所有修复差异及相关原调用链；没有声称每个 Provider 真实服务测试通过。没有执行安装升级卸载、24 小时驻留、睡眠/断屏/混合 DPI 验收；未核验外部最新价格。依赖安全公告、发布资产与本地二进制 provenance 亦未纳入已通过范围。

后续重点：恢复一致的 revision/字段补丁协议与结果提交边界；补 B07/B08/B16 的回归测试；验证设置删除后的基线、原生关闭监听和失焦拖动；核验设置文件写失败的系统副作用。Profile/批量凭据变更纳入同一事务。对 Qt/原生 API 无关推测不列缺陷。

建议先修 B01—B04，再修 B07/B08/B16，之后处理其余 P2。每项必须记录症状、证据、修改及验收，不以注释里写了编号作为关闭依据。旧文档“28 项全部闭环”需据此修正。本次仅审计，未实施修复。

