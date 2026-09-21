# v0.6.3 更新施工前审查

基线：2590f59，本地 master，初始工作区干净，无 Git remote。未执行无依据的 checkout/pull 或新建分支。GitHub API 实查 Latest 为 v0.6.3（非 draft/prerelease），有 Setup、Portable、SHA256SUMS、BUILD_INFO.txt；无独立 BUILD_INFO.json 资产。

基线验证：cargo check --locked、cargo test --locked（101 项）、npm lint（0 错误，有警告）、typecheck、npm test（90 项）、build 均执行通过。npm ci 因正在使用的原生 node 模块 EPERM 失败，npm install --ignore-scripts 恢复依赖后运行检查；不能把 npm ci 记为通过。

|ID|级别|置信度|位置/根因|处理|
|---|---|---|---|---|
|U01|P2|高，静态|commands.rs resize_detail 不绑定 request_id；旧账号异步测量可修改新账号高度记忆|增加请求身份与有限高度校验|
|U02|P1|高，静态|build-dist.ps1 按进程名强杀所有 pulse-windows；可能中止别的目录实例和写入|去掉强杀，检查目标构建 EXE 的运行状态并要求正常退出|
|U03|P2|高，静态|ConfigMode::Installed 实际仅意味着默认 AppData；About 将开发二进制称安装版|Updater 单独检测程序注册位置，无法证明则 Advanced，不执行安装替换|
|U04|P2|高，静态|release workflow 创建发布并上传文件之间存在可见的不完整状态；门禁仅查存在|先 draft 上传、验证哈希与 ZIP 元数据、最后发布|
|U05|P2|高，静态|Provider HTTP 禁止重定向、12 秒超时，不适合作为 GitHub 大文件下载策略|抽取共用代理配置，Updater 单独受限 HTTPS 重定向及下载超时|

未确认 P0。已核查详情测量链路、窗口定位、配置/profile、凭据、SQLite 事务及发布脚本。不能将静态阅读视为 DPI 实机或长期资源验证：100/125/150/200%、混合 DPI、睡眠恢复及长期驻留均待专门设备验收。本次不声称 v0.6.3 全项目无 Bug。

设计增补：更新必须显式点击；只检查不自动执行；helper 等待精确父进程、不强杀；便携版白名单替换、data 不参与事务；备份保留至新版确认；未知部署模式不猜安装版；SHA256 仅完整性保证，不冒充数字签名。签名/attestation 作为单独供应链增强项。


## 施工结果与交接

U01—U05 均已有本地代码变更：P1 1 项、P2 4 项。另补上详情前端使用后端实际钳制高度，避免以未经钳制的预计高度等待窗口 ready。这里的“已改”不等于原生窗口或发布流水线实机验收通过。

新增更新器：统一状态服务、部署识别、稳定版本检查、可取消下载、SHA/ZIP/BUILD_INFO 检查、独立 helper、精确进程等待、白名单备份替换与回滚、启动确认、缓存保护、设置页与草稿保护。源码版本保持 0.6.3。

本轮验证：前端 93 项、Rust 112 项测试；typecheck、前端 build、cargo check 通过；Tauri debug --no-bundle 构建成功。新增测试均离线。真实 GitHub v0.6.3 的安装器和便携包已下载校验，通过 scripts/verify-release.ps1；未执行安装器。

剩余风险按发布门禁处理：
- P1 待验证：真实 portable 双版本更新/启动确认/断电恢复；NSIS 原目录覆盖升级、取消与失败处理。没有实测，不标修复完成。
- P2：没有独立发布签名；SHA 同源清单无法抵抗发布账号被攻陷。未来启用更新签名与应用签名。
- P2 待验证：混合 DPI 和详情卡首次悬停实际效果。
- P3：15 项既有 lint 警告；依赖干净 npm ci 受本机文件占用影响，CI 必须重新通过。

没有完整遍历所有 Provider 的真实账号调用、所有 UI 行为和长期驻留，不能将本次聚焦审查写成“全项目无 Bug”。

可交给下一位 AI：先阅读 UPDATE_REVIEW_HANDOFF.md，再检查 git diff 和新增文件；禁止仅依赖本报告勾选验收。

停止点补充：用户要求转交其他 AI 审查，已停止施工。Tauri debug 构建发生在最终 UI 启动确认接入之前，不代表最终工作区；须由下一位 AI 重新生成并核验最终产物。详见 UPDATE_REVIEW_HANDOFF.md。
