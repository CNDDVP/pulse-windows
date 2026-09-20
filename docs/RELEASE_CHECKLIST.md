# 发布检查表（Release Checklist）

每次发布前逐项勾选。证据留存于 Release 附件与 CI 运行记录。

## 源码与隐私
- [ ] `cargo test` 与 `npm test` 全绿（CI 强制）
- [ ] 隐私扫描通过（CI privacy-check；本地可复核 docs/PRIVACY_AUDIT.md 的模式清单）
- [ ] `package-lock.json` 与 `Cargo.lock` 只指向公共源（npmjs.org / crates.io）
- [ ] 版本号三处一致：package.json = tauri.conf.json = Cargo.toml，且与 tag 一致
- [ ] 无私人路径、真实账号数据、截图元数据进入提交

## 构建
- [ ] 从干净 checkout 执行 `scripts/build-dist.ps1 -Version <v>` 成功
- [ ] 产物：setup.exe、portable.zip、DEPENDENCIES.txt、BUILD_INFO.txt、SHA256SUMS.txt
- [ ] 便携 ZIP 内容白名单（exe + portable.flag + LICENSE + NOTICE + README-portable），无用户数据
- [ ] 便携首启在"中文 + 空格"路径下创建 data/profile.json；移动目录后 profile_id 不变

## 安装包
- [ ] 全新安装 → 悬浮栏出现，设置可保存，凭据入 Windows 凭据管理器
- [ ] 升级安装 → 配置与凭据保留；卸载 → 默认保留用户数据并说明位置

## 发布
- [ ] tag 指向的 commit 已通过全部 CI
- [ ] Release 标注 Pre-release（稳定版需完成 24h 驻留验收后转正）
- [ ] 重新下载产物并与 SHA256SUMS.txt 比对
- [ ] 远端 README 徽章、下载链接指向本 Release
