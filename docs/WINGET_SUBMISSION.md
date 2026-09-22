# winget 上架提交指南（CNDDVP.PulseForWindows）

日期：2026-09-23。对应 `docs/ROUND5C_PLAN.md`【项目二】与对齐审计 #22。
生成器：`scripts/gen-winget-manifest.ps1`；产物：`release-artifacts/winget/<版本>/` 下三件 manifest。

## 产物一览（以 v0.6.6 为例）

| 文件 | ManifestType | 作用 |
| --- | --- | --- |
| `CNDDVP.PulseForWindows.yaml` | `version` | 声明包 ID、版本、默认 locale（en-US） |
| `CNDDVP.PulseForWindows.installer.yaml` | `installer` | x64 NSIS 安装包：GitHub Releases URL、SHA256、`InstallerType: nullsoft`、`Scope: user`、`/S` 静默、WebView2 运行时依赖 |
| `CNDDVP.PulseForWindows.locale.en-US.yaml` | `defaultLocale` | 发布者、包名、许可证（Apache-2.0）、描述、标签、ReleaseNotesUrl |

命名与术语的勘误（相对计划文档的简称，落盘以 winget 规范为准）：

1. 计划写的 `.locale.yaml` 实际落盘为 `CNDDVP.PulseForWindows.locale.en-US.yaml`——winget-pkgs
   要求 locale 文件名带 locale 后缀（`.locale.en-US`），三件 manifest 缺一不可。
2. 计划写的 "InstallerType nsis" 落盘值为 `InstallerType: nullsoft`——winget manifest schema
   对 NSIS 安装器的枚举值是 `nullsoft`，不存在 `nsis` 值（已对照官方
   `https://aka.ms/winget-manifest.installer.<版本>.schema.json` 核对）。写 `nsis` 会被官方
   校验直接拒绝。安装器技术本身仍是 NSIS（Tauri bundle target）。
3. 计划写的 "升级检测基于 GitHub" 与实际机制不符：`winget upgrade` 的版本对比完全依赖
   winget-pkgs 仓库里 manifest 的演进（每次发版需人工 PR 更新），manifest 本身不含
   "自动发现 GitHub 新 Release"的机制——详见下文「升级检测说明（诚实口径）」。
4. ManifestVersion 基线为 **1.12.0**（不再用 1.6.0）：winget-pkgs PR 模板勾选项要求
   "Manifest conforms to the [1.12 schema](https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema/1.12.0)"，
   `.github/copilot-instructions.md` 写明 "Recommended schema version: 1.12.0 (1.10.0 also
   accepted)"；1.6.0 仅是历史目录，不在当前接受集内（2026-09-23 抓取核对）。生成器
   `$script:ManifestVersionValue` 与三件 manifest 的 schema URL 随之联动，提交前仍以
   winget-pkgs 当时贡献指南为准。

## 为什么不自动提 PR

向 `microsoft/winget-pkgs` 提交 manifest 需要以**用户本人的 GitHub 账号** fork 微软仓库、
推送分支并在微软仓库发起公开 PR——这是代表用户身份的外向动作（涉及用户账号、CLA、
公开署名与后续社区沟通），超出本会话可代做范围，故留给用户按本文档一键执行。
本仓库 CI 与脚本只做本地生成与校验，不做任何网络发布动作。

## 前置条件（提交前逐项确认）

1. 目标版本已在 `CNDDVP/pulse-windows` 正式发布 GitHub Release（**非 draft**、非 prerelease），
   tag 形如 `v0.6.6`，资产名精确为 `Pulse-0.6.6-windows-x64-setup.exe`（生成器按此名拼 URL）。
2. `release-artifacts/SHA256SUMS.txt` 与 Release 资产一致（发布流水线已回验）。
3. 当前构建为 **未签名**（BUILD_INFO `signing: unsigned`）：winget-pkgs 接受未签名安装包，
   但用户安装时会遇 SmartScreen/未验证发布者提示。PR 描述中如实说明即可，不声称已签名。
4. 首次上架前搜索 [winget-pkgs](https://github.com/microsoft/winget-pkgs) 中 `CNDDVP`
   无既有包，`CNDDVP.PulseForWindows` 标识符未被占用。

## 生成与本地校验

```powershell
# 生成（内置自测：固定假 SHA 生成 + 逐字段断言 + 负向用例；随后真实生成并复核本地哈希）
powershell -ExecutionPolicy Bypass -File scripts\gen-winget-manifest.ps1

# 只跑自测不生成
powershell -ExecutionPolicy Bypass -File scripts\gen-winget-manifest.ps1 -SelfTest
```

生成器已集成本机官方校验（有 winget CLI 时自动执行）。注意：**必须传目录**——

```powershell
winget validate release-artifacts\winget\0.6.6        # ✔ 目录模式，加载同目录三件 manifest
winget validate release-artifacts\winget\0.6.6\CNDDVP.PulseForWindows.yaml   # ✘ 单文件模式只加载一个文件，误报 incomplete
```

（单文件误报行为来自 winget-cli `YamlParser` 的 `CreateFromPath`：仅目录输入时枚举同目录文件。）

2026-09-23 本机实测：winget 1.29.380 对 `release-artifacts/winget/0.6.6` 校验**成功**（依赖项
Microsoft.EdgeWebView2Runtime 的"未验证"提示属正常——包尚未上架，winget 无法在源中查到它）。

落盘口径：ManifestVersion 基线 1.12.0（见上方勘误 4）；行尾 CRLF（UTF-8 无 BOM），符合
winget-pkgs `.editorconfig` 的 `[*] end_of_line = crlf` 工作区要求——仓库 `.gitattributes`
的 `*.yaml text=auto` 会在提交时把 blob 规范化为 LF，两者不冲突。

## 人工提交步骤（首次上架）

1. **Fork**：登录 GitHub，fork `https://github.com/microsoft/winget-pkgs` 到自己账号。
2. **Clone fork 并建分支**：
   ```bash
   git clone https://github.com/<你的用户名>/winget-pkgs.git
   cd winget-pkgs
   git checkout -b add-cnddvp-pulseforwindows-0.6.6
   ```
3. **放入 manifest**（路径规范：`manifests/<厂商首字母小写>/<厂商>/<包名>/<版本>/`）：
   ```bash
   mkdir -p manifests/c/CNDDVP/PulseForWindows/0.6.6
   cp <repo>/release-artifacts/winget/0.6.6/*.yaml manifests/c/CNDDVP/PulseForWindows/0.6.6/
   git add manifests/c/CNDDVP/PulseForWindows
   ```
4. **本地安装冒烟**（winget-pkgs PR 模板必需勾选项 "Tested manifest locally with
   `winget install --manifest <path>`"，未勾会被审核问询）：
   ```powershell
   winget install --manifest manifests\c\CNDDVP\PulseForWindows\0.6.6
   winget uninstall CNDDVP.PulseForWindows   # 验完卸载（可选）
   ```
5. **提交并推送**：
   ```bash
   git commit -m "New package: CNDDVP.PulseForWindows version 0.6.6"
   git push -u origin add-cnddvp-pulseforwindows-0.6.6
   ```
6. **开 PR**：向 `microsoft/winget-pkgs` 的 `master` 发起。PR 标题必须用模板声明的两种格式之一
   （`PR Title Format: "New package: Publisher.Name version X.Y.Z" or "Update: Publisher.Name to X.Y.Z"`）；
   首次上架属 new package，标题用 **`New package: CNDDVP.PulseForWindows version 0.6.6`**
   （后续版本更新用 `Update: CNDDVP.PulseForWindows to <新版本>`；勿写 "Add version:"/"v" 前缀）。
   描述中附：
   - 项目主页 `https://github.com/CNDDVP/pulse-windows` 与 Release 页；
   - 安装包直链与 SHA256（与 manifest 中 `InstallerSha256` 一致）；
   - 如实说明：未签名（SmartScreen 会提示）；安装包为 Tauri NSIS、按用户级（per-user）安装；
     缺 WebView2 时由安装器引导安装。
   - **签署 CLA**（PR 模板必需勾选项）：用提交 PR 的同一 GitHub 账号在
     [cla.opensource.microsoft.com](https://cla.opensource.microsoft.com) 签署微软 CLA，
     否则 CLA bot 会把 PR 挡在审核之前。
7. **应对流水线**：PR 会触发 winget-pkgs 自动校验（manifest 规范、SHA 与 URL 可达性、
   包标识唯一性等）。被 bot 或审核员提出修改时在原分支追加 commit 即可。
8. **合入即上架**：合入后 `winget search`/`winget install CNDDVP.PulseForWindows` 可用。

## 后续版本更新

每个新版本重复一次：发 GitHub Release → 本机跑生成器 → 在 winget-pkgs fork 拉新分支 →
新增 `manifests/c/CNDDVP/PulseForWindows/<新版本>/` 目录 → PR。旧版本 manifest 保留，
由 winget-pkgs 维护者按保留策略清理。

## 升级检测说明（诚实口径）

- **winget 侧**：`winget upgrade` 的版本对比完全依赖 winget-pkgs 仓库里的 manifest 演进——
  即每次发版都需要一次人工 PR 更新 manifest，winget 才能看到新版本；manifest 本身不含
  "自动发现 GitHub 新 Release"的机制。
- **应用侧**：Pulse 自带更新器独立工作，只接受 `CNDDVP/pulse-windows` 完整稳定版 Release
  （SHA256 校验、白名单、回滚，详见 `docs/UPDATE_SYSTEM_DESIGN.md`）。两条通道互补：
  winget 管安装/全局升级入口，应用内更新器管已装实例的自更新。
- manifest 中 `UpgradeBehavior: install` 表示升级时直接运行新版 NSIS 安装器覆盖安装
  （Tauri NSIS 支持原地升级，不先卸载）。

## 已知限制（勿在 PR 中夸大）

- 未内嵌 `ReleaseNotes`：CHANGELOG 为简体中文，en-US locale manifest 不做机翻
  （避免口径失真），仅提供 `ReleaseNotesUrl` 指向 Release 页。如需可由人工补英文摘要。
- 未设置 `Moniker`：`pulse` 这样的短名可能与其他包冲突，须提交前用 `winget search` 核实；
  需要时在 locale manifest 加一行 `Moniker: <别名>` 再提 PR。
- `MinimumOSVersion: 10.0.17763.0` 取 Tauri 2 + WebView2 常用基线；README 仅声明
  "Windows 10/11 x64"，未给出更精确的构建号。
- `AppsAndFeaturesEntries.DisplayName: Pulse` 取自 `tauri.conf.json` 的 productName，
  用于 ARP（卸载登记）关联；未在本机逐字段核对 NSIS 卸载注册表键值。
- 本文档与 manifest 均未经过真实 PR 流程验证（提交动作留给用户）；ManifestVersion 基线已按
  winget-pkgs 现行指南提至 1.12.0（2026-09-23 核对），提交时若指南再调整，以当时的贡献指南
  为准并回改生成器。
