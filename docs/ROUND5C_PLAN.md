# Round 5c 开发清单：英文界面（i18n）+ winget 分发准备

日期：2026-09-23。前置：Round 2~5b 已落地（最新 722cf48）。对应对齐审计 #23（多语言）与 #22（winget）。
浅色模式与 Discord RPC 排 Round 5d。

## 项目一：英文界面（i18n 框架 + 全量抽取）

**设计**：
1. 框架（极简，不引第三方库）：`src/lib/i18n.ts`——`{ zh: Dict, en: Dict }` 两份扁平
   key-value 词典、`t(key, vars?)` 函数、`Lang = 'zh'|'en'`、React Context
   （I18nProvider）+ `useLang()`；语言设置进既有设置通道（通用页下拉：简体中文/English，
   默认 zh）。DOM 侧 `<html lang>` 同步。
2. 词典组织：按域分前缀（`settings.`、`spend.`、`rail.`、`detail.`、`trend.`、`bot.`、
   `tray.`、`updater.`…）；英译必须准确传达口径标注（诚实文案逐句对应，不得弱化，
   如「按固定汇率估算」「未经真实数据验证」「跨来源不去重」）。
3. 抽取范围：src/ 下全部用户可见字符串（页面/组件/托盘菜单/通知文案/错误消息）。
   Rust 侧 emit 的错误文案本轮保持中文并标注 TODO(EN-backend)，前端对 Rust 来的
   消息原样展示（不做翻译映射，避免语义漂移）——README 诚实注明"后端消息暂为中文"。
4. 冲突控制：框架先建 + 一个示范页迁移；随后按文件域并行抽取，每个工程师独占
   自己的文件集合（禁止越界改他人文件）；最后统一门禁。
5. 测试：t() 纯函数单测（缺 key 回退 zh、vars 插值）；每域抽查组件测试断言英文渲染；
   现有测试因文案断言需同步更新（中文断言改经 t() 或保持 zh locale 断言）。

**验收**：切换语言后全部界面可见文案变化；zh 为默认；tsc/vitest/oxlint 全过。

## 项目二：winget 分发准备（manifest 生成器）

**设计**：
1. `scripts/gen-winget-manifest.ps1`：从 release-artifacts/（SHA256SUMS.txt + 版本号）
   生成 microsoft/winget-pkgs 规范的三件 manifest YAML
   （`CNDDVP.PulseForWindows.yaml` / `.installer.yaml` / `.locale.yaml`，安装包 URL 指
   GitHub Releases、SHA256 取自 SHA256SUMS、InstallerType nsis、升级检测基于 GitHub）。
2. 产物落 `release-artifacts/winget/<版本>/`；`docs/WINGET_SUBMISSION.md` 写清人工步骤
   （fork microsoft/winget-pkgs → 按版本路径放入 manifest → PR；为什么会话不自动提：
   需要 GitHub 账号在微软仓开 PR，属外向动作，留给用户一键执行）。
3. 校验：脚本对 manifest 做本地 YAML 结构断言（PowerShell 解析回读比对关键字段）+ 单元
   式自测（用固定假 SHA 跑一遍生成并断言输出）。

**验收**：脚本在本机对现有 release-artifacts 跑通生成；文档完整。

## 门禁与复核

cargo/npm 门禁全过；复核三名（i18n 完整性专查——grep 残留硬编码中文、英译口径忠实度；
winget 规范；前端风格）+ 逐发现确认。预计 ≈ 3 天。
