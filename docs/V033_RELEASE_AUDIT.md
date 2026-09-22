# v0.3.3 发布审计（V033_RELEASE_AUDIT）

> **状态：历史快照（2026-09-17，v0.3.3 发布前审计）。** 文中"待核实/处理中"等标记反映当时的审计进度，
> 不代表当前状态：其中 P1-04、P1-11、P2 项与基线一致性缺陷已在 v0.3.3—v0.3.6 中陆续修复并发布
> （见 CHANGELOG 各版本小节）。本文保留作为审计方法与问题分类的记录，不再更新。

审计分支 `audit/v0.3.3-polish`，基于 main `094d18ce`。状态标记：`待核实/已确认/处理中/已修复待验证/已验证/受阻/不适用`。

## 1. 基线记录（阶段 0—1）

### 工作目录身份（2026-09-18 盘点）

| 目录 | remote | branch | HEAD | dirty | 用途 |
|---|---|---|---|---|---|
| `../Pulse-upstream` | qunqin24/Pulse | (detached v1.2.1) | 68fa829f | 0 | 上游参考，不开发 |
| `../pulse-windows` | (无) | master | 7162622a | 1（CHANGELOG） | 历史开发副本，保留 |
| `../pulse-windows-clean` | CNDDVP/pulse-windows | main | d8c40656 | 0 | 旧对照副本，保留 |
| `../pulse-windows-release` | CNDDVP/pulse-windows | main | 094d18ce | 1（CHANGELOG） | 发布工作副本 |
| `../pulse-windows-main`（本轮新建） | CNDDVP/pulse-windows | audit/v0.3.3-polish | 29c018c→ | 审计中 | 本轮工作目录 |

两份 CHANGELOG 未提交差异已存档于 `.audit-snapshots/`（dev 37 行 / release 37 行），未吸收前不覆盖。

### 发布与版本

- GitHub main：`094d18ce`；tag `v0.3.2` → 同一 commit；Release 为正式版（非 Draft/Pre-release），5 件附件。
- 产物核验：下载后 SHA256 与 SHA256SUMS.txt 全部一致；BUILD_INFO commit = `094d18ce` = main HEAD，**资产与源码对应关系成立**。
- 版本一致性：package.json / tauri.conf.json / Cargo.toml / Cargo.lock = 0.3.2；**package-lock.json = 0.3.1（缺陷 F-01，已修复）**。

### 工具链与环境

- Node v24.18.0、cargo 1.98.0、Windows 11、WebView2 系统安装版。
- 门禁（新目录独立运行）：npm ci ✅ / lint ✅（0 错误）/ typecheck ✅（修复前假覆盖，见 F-02）/ vitest 9/9 ✅ / vite build ✅ / cargo test --locked 60/60 ✅。

## 2. 问题分类

### 已确认并已修复（本分支，待回归验证标 `已修复待验证`）

| 编号 | 等级 | 问题 | 状态 |
|---|---|---|---|
| F-01 | P1 | package-lock 顶层版本停留在 0.3.1（版本一致性缺陷） | 已修复待验证 |
| F-02 | P1 | `typecheck` 为 `tsc --noEmit` + references 根工程，实际不检查任何子工程 | 已修复待验证（改为 `tsc -b`） |
| R-01 | P1 | release.yml 固定 `prerelease: true` | 已修复待验证（SemVer 解析，正式/预发布自动分流） |
| R-02 | P2 | Release 说明 Full Changelog 重复追加 | 已修复待验证（CHANGELOG 段落整份替换） |
| R-03 | P1 | build-dist 默认版本 0.3.1、无一致性校验 | 已修复待验证（从 package.json 读取 + 三处比对） |
| R-04 | P1 | 安装包找不到时模糊回退到其他 setup.exe | 已修复待验证（只接受含精确版本段的文件名） |
| R-05 | P2 | 打包默认按进程名强杀 Pulse | 已修复待验证（默认报错，`-StopRunningInstance` 显式允许） |
| R-06 | P1 | OutputDir 可配置且直接递归删除 | 已修复待验证（限定构建根内，禁止覆盖 src） |
| R-08 | P3 | 依赖清单含本机路径 | 已修复待验证（结构化生成名称+版本） |
| N-01 | P2 | PowerShell 脚本 UTF-8 无 BOM 在 PS5 下中文乱码 | 已修复待验证（BOM+CRLF） |

### 此前 P1 清单核定（在正式 main `094d18ce` 复核）

| 编号 | 状态 | 说明 |
|---|---|---|
| P1-01 内环关闭残留 | 已验证 | null=完全关闭（68b70b4） |
| P1-02 拖动乱飘 | 已验证 | GetCursorPos + 原子定位 + 显示器缓存（222815a） |
| P1-03 刷新未合并 | 已验证 | inflight 真合并（094d18c） |
| P1-05 退避 / P1-06 超时写回 / P1-08 drag_end 覆盖 / P1-09 拖后误刷新 / P1-10 菜单命令名 / P1-12 定时覆盖活动 | 已验证 | 094d18c |
| **P1-04** 手动与定时在途管理 | 已确认（结构性） | 共享并发槽+generation 守卫已兜底覆盖问题；按账号去重协调器待做 |
| **P1-07** 通知输入过滤 | 已验证 | 仅评估通过 generation 检查的读数（094d18c） |
| **P1-11** 活动按 Provider 聚合 | 已确认（结构性） | 多会话互相覆盖场景存在；按会话维护为结构性改动，列下一批次 |
| 悬浮栏右键菜单 | 受阻 | WebView2 控制器层吞掉右键事件（contextmenu 与 pointerdown(button=2) 均不到达页面）；托盘菜单覆盖；需 Rust 层 WM_RBUTTONUP 子类化 |

### P2/P3（登记，处理中或后续）

- P2-03 内环不遵守 Remaining 显示模式；P2-04 模型组缺稳定 group_id（现按展示名前缀）；P2-06 拆分详情无组上下文；P2-07 机器人 fetching 优先于 working（与上游 working 优先规则不一致）；P2-08 视线无轮廓约束；P2-09 减少动画下 SVG transform 未复位；P2-10 折叠仅 CSS 隐藏；P2-11 活动扫描无读取预算并持设置锁；P2-12 小米 code 非整数默认成功、可选路由错误被丢；P2-13 Token Spend flatten 忽略行错误；P2-14 主包 526KB。
- P3：两处 CHANGELOG 差异待吸收合并（快照在 .audit-snapshots/）；组件级测试缺失（保存/拖拽/IPC 时序）。

### 不适用 / 有意保留

- Codex helper CPU 空转（上游 macOS helper 管道路线，Windows 不适用）；Sparkle/自动安装更新（保持关闭）；macOS 菜单栏坐标语义（Windows 用工作区）。

## 3. 发布验证缺口

- 24 小时驻留：**进行中**（2026-09-18 19:35 启动，采样至 09-19 20:35；监控独立于 agent 会话）。按计划先回收 8 小时中间检查，PASS 后才承认 24 小时结果。
- 升级/迁移矩阵（v0.3.1→v0.3.2→候选、便携迁移、凭据隔离）、100%—200% DPI 矩阵、热插拔：**待执行**。
- Windows 实机录屏验收（拖拽/内环/菜单）：**待执行**。
