# 交给其他 AI 的审查任务

你接手的是 D:\ai-programs\pulse-windows 的更新器本地施工结果。请审查代码与设计，用户尚未要求发布。保留所有设置、账号和凭据；不要停止或覆盖用户正在运行的 release EXE。

## 当前状态

- 基线 v0.6.3、commit 2590f59、master、无 remote；施工是未提交的工作区改动，版本没有提升。
- 当前用户运行 src-tauri/target/release/pulse-windows.exe；没有替换它。
- 生成过 src-tauri/target/debug/pulse-windows.exe 验证构建。该构建之后又补充了前端启动确认等收尾代码，因此它不能代表最终工作区；接手者需重新构建。它不是正式安装包，也不是已发布版本。
- 前端 93 项、Rust 112 项自动测试已通过；真实 v0.6.3 release 资产 SHA/ZIP/BUILD_INFO 校验通过。
- npm ci 失败原因是原生 node 模块文件被占用，之后 npm install --ignore-scripts 恢复依赖；不要记录成干净安装通过。

## 必读与源码入口

1. docs/UPDATE_SYSTEM_DESIGN.md：设计、现有实现与边界。
2. docs/UPDATE_REGRESSION_PLAN.md：已测与 NOT TESTED。
3. docs/V063_UPDATE_AUDIT.md：发现的问题与施工记录。
4. src-tauri/src/updater/core.rs：Release/资产解析、Hash、ZIP、文件事务。
5. src-tauri/src/updater/helper.rs：部署、进程、替换/恢复、首次启动、缓存清理。
6. src-tauri/src/updater/mod.rs：状态机、并发、退出/启动协调与 IPC。
7. src/pages/settings/UpdateCenter.tsx 和测试；App.tsx 与 SettingsWindow/AboutPage 的接入。
8. scripts/verify-release.ps1、scripts/build-dist.ps1、.github/workflows/release.yml。
9. commands.rs / lib.rs：详情请求身份、更新中写操作保护与刷新提交串行化。

## 优先独立审查

- helper 等待父进程的握手、60 秒超时与更新锁：是否存在进程重用、提前退出或旧版重启时序问题。
- pending/journal/startup-attempt 的每个中断点：回滚不可误删 data 或任意用户文件，原子文件替换失败需可恢复。
- `confirm_startup` 必须等待 UI IPC 就绪并核验版本/Profile/配置/SQLite；二次启动不得误判首次启动失败；恢复不得无限循环。
- `update_apply` 的 settings_io、ledger_gate、refresh_gate、refresh_slots 顺序与所有写入路径：查死锁和退出前未完成写盘。
- 注册表 InstallLocation 引号、currentUser NSIS /D 参数与取消行为；安装器部分失败不是便携式事务回滚，不可声称自动完整恢复。
- URL/重定向/大小/ZIP 白名单/Hash/BUILD_INFO 验证，缓存目录边界和 junction；SHA 清单不是独立签名。
- 前端草稿保护、事件/快照乱序、后台检查与手动点击并发、取消和失败后重试。
- Release 先 draft 后上传回验再发布的流程，确保不会改写同版已发布 Release。

## 必须补充的实机证据

安装/便携两个含更新器版本之间完整升级、路径保持、数据前后 Hash、Credential Manager 身份、断电与锁文件、UAC/取消、代理断流、混合 DPI、24h 驻留。目前这些均未完成。先在隔离 Windows 环境做，不要拿用户正式实例试升级。

没有收到明确发布指令前：不 bump、不 commit/tag、不 push、不改 remote、不发布 GitHub Release。审查发现缺陷请给出文件位置、可复现步骤、严重性和修复建议，区分静态风险与已复现问题。


## 用户最新指令与停止点

用户要求“直接整理交接文档”，本轮到此停止施工。下一位 AI 以当前工作区源码为准，不能用现有 debug/release 产物推断最终源码行为。

### 收尾验证记录

- 最后一次 npm test：13 个套件、93 项通过。
- 最后一次 cargo test --locked：112 项通过，main/doc tests 各 0 项。
- 前端构建、cargo check、Tauri debug 构建在施工过程中通过；最后的 UI 启动确认接入与文案调整后，未再生成最终 Tauri 产物。接手时重新运行 typecheck/build/check 和 Tauri 构建。
- scripts/verify-release.ps1 对 GitHub 已发布 v0.6.3 的真实资产通过；这仅证明现有发布资产格式与校验脚本兼容，不证明新更新器端到端升级成功。
- 未对用户当前运行程序执行升级、重启或关闭。

### 建议接手执行顺序

1. git status --short、git diff --stat、git diff；新增文件也逐个阅读（git diff 不显示未跟踪文件内容）。不要 reset 或覆盖当前未提交成果。
2. 优先审查 helper/文件事务/退出锁顺序，再审查界面与发布脚本。任何“已修复”均重新核实。
3. 先修静态审查确定的问题，再执行离线测试和最终构建，记录源码/产物 Hash。
4. 在独立测试环境补齐 portable 与 installer 两条完整升级链路，逐项更新回归表。
5. 给用户提供审查结论和发布阻塞项；未获发布指令，不修改版本和 GitHub。

### 可直接复制给审查 AI

请审查 D:\ai-programs\pulse-windows 当前未提交的自动更新功能实现。先读取 docs/UPDATE_REVIEW_HANDOFF.md、docs/UPDATE_SYSTEM_DESIGN.md、docs/UPDATE_REGRESSION_PLAN.md 和 docs/V063_UPDATE_AUDIT.md，再检查全部变更及未跟踪新增源码。重点验证文件替换/回滚、启动确认、进程与锁、数据保留、NSIS 原目录升级、下载校验和草稿保护。不要相信施工文档等同测试通过；请独立复查并区分已复现 Bug、静态风险和未验收项。用户正式 release EXE 正在运行，不要关闭或覆盖它，不要更改真实账号或凭据，也不要 bump、commit、push、tag 或发布。先输出审查问题清单与发布门禁结论。
