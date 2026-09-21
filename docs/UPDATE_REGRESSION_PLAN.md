# 更新系统回归与发布前验收

## 本轮已实际执行

|项目|结果|证据/范围|
|---|---|---|
|基线前端|90 项通过|既有 12 个套件|
|基线 Rust|101 项通过|离线单元测试|
|更新单元/隔离文件事务|11 项新增通过|SemVer、缺资产/重复资产/异常 URL、校验清单、错误 Hash、ZIP 穿越、白名单、回滚、保留用户数据、精确父进程路径与等待、缓存保护|
|更新界面|3 项新增通过|不自动执行安装、草稿阻止退出、Advanced 只提供手动入口|
|当前全量前端|93 项通过|13 套件|
|当前全量 Rust|112 项通过|main/doc tests 0 项|
|typecheck/build/check|通过|具体最终构建结果见审查记录|
|lint|0 错误，15 项既有警告|不把 warnings 当成功修复|
|npm ci|失败|本机正在使用的原生 .node 文件导致 EPERM；通过 npm install --ignore-scripts 恢复依赖后验证；仍需 CI 干净安装|
|GitHub v0.6.3 真实资产|通过|下载 Setup、Portable、BUILD_INFO.txt、DEPENDENCIES.txt、SHA256SUMS.txt，执行 verify-release.ps1；未执行该安装器|
|GitHub API|首次成功、复查限流|现网 403；未绕过限流或创建测试 Release|

离线夹具使用虚构字节、临时目录，不包含真实账户和凭据。真实资产保存在被忽略的 .audit/release-0.6.3，不提交包体。

## 发布阻塞的实机验收

以下均 NOT TESTED，不能因自动测试通过而打勾：

1. 两个含更新器版本的便携 ZIP 在中文/空格/普通用户目录完整升级，前后校验 data 全部文件及 Credential Manager 身份，确认其他目录 Pulse 不受影响。
2. Installed currentUser NSIS：已安装目录识别、路径保持、取消、安装失败、升级后版本及数据、旧快捷方式与自启。额外验证用户更改安装路径和 UAC。安装器部分失败不能冒充可回滚。
3. helper 等待超时、第二次启动、重复点击、取消下载、HTTP 断流、429、错误 SHA、错误清单/架构、发布草稿/资产延迟、代理不可用。
4. 只读目录、磁盘满、杀毒锁 EXE、移动硬盘拔出、NTFS junction/符号链接、备份受损；失败必须保留可恢复证据。
5. 写 journal 前后、替换中、替换后首次启动前模拟进程中断；首次启动崩溃、界面迟迟未 ready、配置/SQLite 损坏。确认恢复只替换程序文件、不重置数据且不无限重试。
6. 多显示器 100/125/150/175/200% 混合 DPI，首次悬停、快速切账号、工作区钳制和睡眠恢复。
7. 正式 Release 构建、全新 CI npm ci、NSIS 安装及 portable ZIP 打包验证、Windows Defender 检查、24 小时驻留；本轮不覆盖运行中的 release EXE。

## 执行命令

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
# 退出目标构建 EXE 后运行；不得按进程名称强杀所有实例。
./scripts/build-dist.ps1 -Version <待发布版本>
./scripts/verify-release.ps1 -Directory release-artifacts -Version <待发布版本>
```

没有用户确认前，不修改正式版本号、不创建 tag、不 push、不触发发布。本地现有 master 无 remote，应先由维护者确认目标仓库与分支，不能凭猜测补 remote 并上传。
