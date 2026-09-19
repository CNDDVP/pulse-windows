# Pulse 发布版与本地版功能一致性基线 (Feature Consistency Baseline)

本文档确立 Pulse for Windows 在 **安装版 (NSIS Setup)** 与 **便携版 (Portable Edition)** 之间的功能一致性基线、架构设计原则以及防退化检查规范。

---

## 1. 产物与二进制绝对一致性

Pulse 遵循单一编译、双重打包的发布原则：
- **编译产物唯一**：通过 `scripts/build-dist.ps1` 进行 release 构建时，生成单一的 `pulse-windows.exe`。
- **打包验证**：该二进制文件直接被 NSIS 安装包打包，同时原样复制为便携版 ZIP 内的 `Pulse.exe`。
- **校验对齐**：构建脚本在组装后自动计算并断言便携版 `Pulse.exe` 的 SHA256 与构建出的 release 二进制完全一致，并在 `BUILD_INFO.txt` 中固化 `exe_sha256`。

---

## 2. 数据目录与单实例隔离 (Data Directory Scoped Single-Instance)

### 2.1 隔离设计
- **安装版**：数据存储于 `%APPDATA%\pulse-windows\`。
- **便携版**：根目录下存在 `portable.flag` 时，数据存储于可执行文件同级目录的 `data\` 中。
- **自定义环境变量**：可通过 `PULSE_DATA_DIR` 指向任意自定义绝对路径。

### 2.2 单实例互斥机制
- 早期版本使用全局硬编码的 Bundle Identifier 作为单实例锁，导致安装版与便携版同时运行时相互冲突（后启动者误激活先启动者的窗口并自动退出）。
- **当前设计**：单实例锁以**规范化后的数据目录绝对路径（Canonical Data Directory）**的 SHA256 散列为作用域（`Pulse_Instance_Mutex_<hash>` 与 `Pulse_Instance_Window_<hash>`）。
- **运行表现**：
  - 相同数据目录的重复运行：自动通过 `WM_COPYDATA` 唤醒并置顶已有实例的设置页面，当前进程安全退出。
  - 不同数据目录的运行（例如已安装版与便携版、放在不同 U 盘/目录的多个便携版）：互不干扰、独立并发运行。

---

## 3. 便携版开机自启与路径自愈 (Self-Healing Autostart)

### 3.1 注册表键值区分
- **安装版**：使用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `Pulse` 键。
- **便携版**：使用 `Pulse_Portable_<profile_id>` 键，保证便携版与安装版的启动项独立存在，不互相覆盖。

### 3.2 移动文件夹自动修复 (`repair_startup_if_moved`)
- 便携版每次启动时，检查注册表中 `Pulse_Portable_<profile_id>` 项。
- 若注册表已配置自启，但记录的 EXE 路径与当前运行的绝对路径不一致（例如用户将便携版文件夹重命名或移动到了其他磁盘），Pulse 自动将注册表路径更新为当前 EXE 路径，彻底消除因移动文件夹导致的无效死链。

---

## 4. 首次使用配置与凭据迁移 (Installed -> Portable Migration)

### 4.1 自动检测与横幅提示
- 当便携版首次运行且自身无任何配置账号时，自动检测本机是否存在已安装版的配置 (`%APPDATA%\pulse-windows\settings.json`)。
- 检测到后，设置页面顶部弹出引导横幅，提示用户可一键导入已安装版的账号与凭据。

### 4.2 安全迁移协议
- **后端内存迁移**：通过 `import_installed_config` 命令由 Rust 后端完成。
- **凭据克隆**：后端通过已安装版的 Profile ID 在 Windows 凭据管理器中安全读取凭据，并以当前便携版的新 Profile ID 重新写入 Windows 凭据管理器。
- **零泄露**：密钥全程不经过前端、不写入任何日志或普通 JSON 文件。
- **持久入口**：除首次运行横幅外，“关于 Pulse”页面亦提供“从本机安装版导入配置与凭据”持久按钮。

---

## 5. 设置界面与圆环一致性保障

### 5.1 窗口关闭事件可靠性
- 在原生窗口过程（`lib.rs` 的 `CloseRequested`）中拦截设置窗口关闭，同时向 `window.app_handle()`（全局广播）与 `window`（定向窗口）发送 `settings-close-requested`。
- 前端通过 `getCurrentWebviewWindow().listen` 与稳定回调 Ref 监听，确保右上角原生 `✕` 按钮、界面内“关闭”按钮与 `Esc` 快捷键在任何生命周期下都能 100% 响应并唤起未保存修改的确认流程。

### 5.2 读数未到位时的占位保留
- **主圆环 / 内环 / 时间环** 下拉框在账号尚未获取读数（或连接测试中）时**始终可见**，绝不被条件隐藏。
- 若账号已配置了 `primary_window` / `secondary_window` / `elapsed_window`，但后端当前尚未返回对应的额度项，下拉框自动以 `[已配置 · 等待读数]` 占位项显示并锁定该值，防止用户修改其他设置时将原有配置意外清空。

---

## 6. 运行时诊断与脱敏标准 (Diagnostics & Sanitization)

- “关于 Pulse”页面提供实时运行时信息：
  - 应用版本与 Commit
  - 构建时间
  - 运行模式（安装版 / 便携版 / 自定义目录）
  - 配置身份 Profile ID
  - 当前运行 EXE 的 SHA256 完整/截断指纹
  - 数据目录路径与可执行文件路径
- **一键复制脱敏诊断**：
  - 提供“复制脱敏诊断”按钮，聚合系统环境信息与后端连接诊断报告。
  - 所有用户私人路径（如 `C:\Users\<username>\...` 或 `/Users/<username>/...`）均经过自动化脱敏转换为 `[PATH]`，确保提交反馈时保护个人隐私。
