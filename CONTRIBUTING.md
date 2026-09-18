# 贡献指南 (Contributing to Pulse for Windows)

感谢关注与参与 Pulse for Windows 的开发！我们欢迎任何形式的贡献，包括提出 Issue、完善文档、报告安全漏洞或提交 Pull Request。

## 开发环境准备

- **操作系统**: Windows 10 / 11 (x64)
- **Node.js**: >= 18.0.0
- **Rust**: >= 1.75.0 (含 `x86_64-pc-windows-msvc` target)
- **WebView2 运行时**: 确保系统已安装 Microsoft Edge WebView2

## 开发流程

1. 安装依赖：
   ```bash
   npm install
   ```
2. 启动开发模式（热重载）：
   ```bash
   npm run tauri:dev
   ```
3. 运行本地门禁验证：
   ```bash
   npm test               # 运行前端测试
   npx tsc --noEmit       # TypeScript 类型检查
   npx oxlint             # 代码规范检查
   cd src-tauri && cargo test # 运行后端全量单元与回归测试
   ```
4. 构建生产产物：
   ```bash
   npm run build          # 前端静态打包
   npm run tauri:build    # 构建安装版 EXE
   ```

## 提交规范

- 严禁在提交历史中硬编码任何真实 API Key、个人账号 Token 或私钥。
- 遵循现有的代码架构分层：前端 React UI、后端 Rust Service、平台能力 Windows API。
