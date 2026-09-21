# Pulse Windows 更新系统设计与实现

本轮维护基线：v0.6.3 / 2590f59。实现留在本地工作区；未改版本、未提交、未推送、未发布、未覆盖正在运行的正式 EXE。

## 产品行为

- 设置 → 关于 → 更新与开源：显示检查状态、部署方式、最近检查、发布说明、下载进度、上次升级结果。
- 默认自动检查与新版通知开启；启动后约 5 秒后台检查，此后每 2 小时检查。每个新版本最多通知一次。关闭自动检查仍允许手动检查。
- 自动检查不等于自动安装。先点击下载，SHA256/包体检查完成后，再点击“退出并更新”。账号/凭据有未保存草稿时阻止退出，先保存或放弃草稿。
- 下载可取消、失败可重试；已验证的下载可跨启动复用。可取消本次升级，保留备份。
- 只接受固定仓库 CNDDVP/pulse-windows 的完整稳定版 Release，严格 SemVer、精确资产名称、HTTPS 与允许的 GitHub CDN 重定向。旧版、同版、预发行版、不完整发布均不执行。
- Portable 只取 ZIP；Installed 只取 Setup EXE。缺少可靠部署证据或设置 PULSE_DATA_DIR 时视为 Advanced，提供手动发布页面，禁止猜测目标。

## 部署判定和目标

Portable：当前文件为 Pulse.exe，旁边有 portable.flag，数据必须为同目录 data/。
Installed：当前为 pulse-windows.exe，HKCU/HKLM 卸载登记的 Pulse / InstallLocation（兼容带引号）与当前 EXE 目录实际匹配。不能仅凭配置位于 AppData 判安装版。
目标路径由后端当前进程推导，不接受前端传入 URL、EXE 路径或安装参数。

更新缓存：LocalAppData/Pulse/updates/<程序路径摘要>/<事务 UUID>。缓存与程序/data 不得重叠；拒绝父目录跳转、符号链接及 Windows 重解析点。

## 状态和并发

统一 Rust UpdateService：idle / checking / up_to_date / available / downloading / verifying / staging / ready / waiting_for_exit / failed / succeeded / rate_limited。
检查、下载、安装入口共享 gate；重复操作不启动第二条更新链。主进程通过 update-status 事件广播，设置页订阅后再读取快照，避免旧快照覆盖新事件。
更新网络使用现有代理设置，但单独限制重定向、连接/检查/下载读取超时。API 403/429 退避；不影响额度网络客户端，不读取 GitHub Token。

## 便携升级事务

1. 预检目录写权限与可用磁盘空间。完整下载到 .part，核对 Release 大小和 SHA256。
2. 独立 staging 解压。仅允许发行白名单：Pulse.exe、portable.flag、README-portable.zh-CN.md、LICENSE、NOTICE、BUILD_INFO.json、BUILD_INFO.txt。拒绝额外文件、重复条目、路径穿越、链接、解压超限。
3. 校验 BUILD_INFO 产品、目标版本、x64 架构及 EXE 哈希。data/ 不在白名单。
4. 点击升级后禁止新配置/凭据变更和新刷新，取消统计扫描，等待设置、SQLite、刷新提交与网络槽位。超时保持应用运行。
5. 将当前 EXE 复制至缓存，作为独立 helper（专用启动参数，在 Tauri/配置/GUI 初始化之前处理）。helper 校验自身/旧 EXE/清单，持有目标更新锁，核实父进程路径并持有 Windows 进程句柄。
6. 握手成功后主程序正常退出。helper 最多等待 60 秒，不按名称杀进程，也不 force kill。
7. 先写 pending，再备份白名单文件、核对备份 Hash、落盘 journal。逐文件临时复制、落盘、原子替换，有限次数重试。替换错误按已验证备份回滚；恢复失败保留 journal 和 backup，不伪报成功。
8. 启动新程序。新版本、Profile、配置、SQLite quick_check、包体哈希和前端 IPC 就绪共同确认。便携 journal 中断、首次启动未完成或确认失败会尝试 helper 恢复旧程序；不倒退用户数据。
9. 成功清除 pending，保留最近一次程序备份。缓存清理仅处理 7 天前、UUID 命名、内容符合约束的非活跃事务，保留 ready/pending/最近备份，每轮最多 20 个。

边界：恢复程序文件不等于恢复数据库迁移。未来修改不可逆数据结构前，需要另行设计兼容迁移和数据备份。本轮不新增数据结构迁移。

## 安装版升级

下载并核对 Setup EXE 的 SHA256；退出握手与等待父进程逻辑共用。执行正常可见的 NSIS 向导，/D=原安装目录作为最后一个原始参数。使用 NSIS 执行升级，不手工覆盖安装目录、不先自行卸载、不伪造静默成功。取消/非零退出记录失败；若旧 EXE 哈希仍匹配，可重新启动旧版。

安装版的完整事务及回滚由安装器行为决定，不能保证与便携版相同的逐文件回滚。若安装器部分失败或用户在向导中更改路径，需显示失败并手动修复，不能宣称升级成功。UAC、向导路径与取消必须在干净 Windows 环境验收。

## 发布门禁

scripts/verify-release.ps1 校验必需资产的 SHA256、ZIP 白名单和内部 EXE 身份。
workflow 拒绝修改已公开的同版 Release；创建 draft、上传、下载回验，再取消 draft。失败保持草稿，不将半成品给更新客户端。
SHA256 来自同一 GitHub Release，只提供完整性验证，不提供独立发布者身份验证。目前无 Authenticode / 独立更新签名，不声称解决 SmartScreen。未来签名密钥和签名流水线作为独立工作项。

## 尚需验收与暂不启用的行为

- 未发布含更新器的新版本，旧的 v0.6.3 EXE 不会凭空获得此功能，首个含更新器的版本仍需手动安装一次。
- 首次启动前直接无人值守安装未启用；只在启动后检查和提示，已下载包也需确认。
- NSIS 静默参数与强制隐藏安装界面未启用。
- 本地端到端双版本安装/断电/锁文件、真实签名、24 小时运行及混合 DPI 仍按回归表验收；单元测试不替代这些检查。

## 文件入口

后端 src-tauri/src/updater/{mod,core,helper}.rs；界面 src/pages/settings/UpdateCenter.tsx；启动与退出协调 src-tauri/src/lib.rs；发布检查 scripts/verify-release.ps1；审查结论 docs/V063_UPDATE_AUDIT.md。
