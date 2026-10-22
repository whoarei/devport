---
name: release
description: Remote Runner 版本发布流程：先展示更新内容并确定版本号，再同步版本号、写发布说明、提交、打 tag 推送触发 GitHub Actions 构建、校验并自动发布为 Latest。当用户要求本项目发布/发版/release 时使用，版本号可以尚未指定。
---

# Remote Runner 发布流程

发布一个稳定版本（tag 格式严格为 `vX.Y.Z`，禁止预发布后缀、前导零；各字段 ≤ 65535）。发布动作包含 git 提交、打 tag、推送；先在对话中展示本次更新内容，再确定版本号。版本号尚未明确时，展示后请用户确认；用户已明确指定版本号则按已有授权继续，不重复询问。

## 步骤

1. **检查工作区、展示更新内容**
   - `git status --short`：待发布的改动应先以 `feat:` / `fix:` 等独立提交完成，发布提交本身只含版本同步和发布说明（参见 `git show bc17cc4` 的 v0.5.1 模式）。
   - 确定当前分支可达的上一次稳定发布标签 `vX.Y.Z`，核对 `<上次发布标签>..HEAD` 的提交和实际差异；不只根据提交标题推断更新。缺少可靠基线时明确说明。
   - **在询问或确认版本号之前，先向用户展示更新摘要**：写明比较基线，按实际内容概括新功能、修复、文档/维护调整，并指出不兼容变化或迁移影响；没有的类别可省略。未提交的改动单独说明，不混入已提交更新。
   - 摘要使用面向用户的具体行为，不能只输出原始 git log；纯文档或流程调整如实列出，不包装为功能新增。

2. **确定版本号**
   - 结合已展示的更新和项目既有版本惯例，给出建议版本及简短理由，帮助用户判断补丁、功能或不兼容升级。
   - 用户尚未指定版本号时，在摘要之后询问确认；已明确指定时展示采用的版本号，沿用已有授权。
   - 用 `git tag -l "v*"` 确认新版本号未占用。
   - 更新摘要展示且版本号明确后，才同步版本、写发布说明及执行发布操作。

3. **同步版本号**（仓库根目录）：
   ```powershell
   node scripts/release.mjs sync vX.Y.Z
   ```
   该脚本更新 5 个文件：`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。不要手工改版本号。

4. **写发布说明** `docs/releases/vX.Y.Z.md`，按 [开发、验证与发布](../../../docs/00008-development-and-release.md) 第 6 节模板编写（目录不存在时新建）：
   - `# Remote Runner vX.Y.Z` 标题
   - `## 新功能` 和/或 `## 修复`：面向用户的要点
   - `## 验证范围`：跑了哪些测试、哪些行为需手动验证（如桌面/硬件相关）
   - `## 升级说明`：便携版文件名写 `Remote.Runner_X.Y.Z_x64-portable.exe`；固定提醒 `latest.json` 与 `.exe.sig` 用于更新校验

5. **验证**：
   ```powershell
   npm test
   git diff --check
   ```
   若涉及 Rust 改动，另跑 `cd src-tauri; cargo fmt --all -- --check; cargo test --offline --all-targets`（见 AGENTS.md「Change verification」）。

6. **提交发布**：
   ```powershell
   git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json docs/releases/vX.Y.Z.md
   git commit -m "chore: release vX.Y.Z"
   ```

7. **打 tag 并推送**（触发 GitHub Actions `Release` 工作流）：
   ```powershell
   git tag vX.Y.Z
   git push origin master
   git push origin vX.Y.Z
   ```

8. **跟踪构建和发布**：
   ```powershell
   gh run list --workflow=release.yml --limit 3
   gh run watch <run-id>
   ```
   工作流产出 NSIS 安装包、`.exe.sig` 签名、`latest.json` 更新清单、`Remote.Runner_X.Y.Z_x64-portable.exe` 便携版，并自动校验清单与产物一致性（`scripts/release.mjs verify`）。上传期间保持草稿状态，校验通过后自动公开并设为 Latest；任何前置步骤失败均不会执行公开步骤。

9. **核实并告知用户**：确认工作流成功、Release 已公开且为 Latest，核对安装包、便携版、签名和更新清单齐全，再提供发布页链接。无需用户手动 Publish；若仍为草稿或发布步骤失败，明确报告未完成发布。

## 注意事项

- 签名私钥在仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY`），本地无法构建带签名的发布产物；发布必须走 CI。
- 工作流内也会执行一次 `release.mjs sync`，但仓库里的版本提交仍要提前做（安装包「关于」页等读取的是仓库版本）。
- 也可用 `workflow_dispatch` 对已有 tag 重新触发发布（workflow 的 `tag` 输入）。
- 若构建、上传或校验失败，保留草稿并排查原因；无需改代码时可用 `workflow_dispatch` 重试原标签，代码修复则提交后用新版本标签发布。不要移动已有标签，或覆盖已公开版本的产物。
