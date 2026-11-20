---
name: release
description: "DevPort 版本发布流程。按规则定版、同步版本并推送标签，跟踪 GitHub Actions 构建、校验和正式发布，提供安装包与便携版下载链接。"
---

# DevPort 发布流程

发布一个稳定版本，标签格式为 `vX.Y.Z`，各字段须为不带前导零且不大于 65535 的整数。正式发布包括提交、打标签和推送。先核对本次更新与拟发布范围。未提交改动按用户已经授权的范围处理，只有确实影响候选提交且归属不清时才澄清。

## 步骤

1. **检查工作区、展示更新内容**
   - `git status --short`：检查已暂存、未暂存及未跟踪内容，按文件或功能列出可能纳入发布的改动，以及用途尚不明确的内容。此时先检查和展示，不自动暂存或提交。
   - 核对版本号最高的已公开稳定版，比较其标签到候选提交的完整差异和拟纳入的本地提交。缺少可核实的发布基线时说明具体情况。
   - 展示实际更新摘要、比较基线和兼容性影响。拟发布的未提交改动单独注明。
   - 摘要使用面向用户的具体行为，不能只输出原始 git log；纯文档或流程调整如实列出，不包装为功能新增。

2. **确定发布范围和版本号**
   - 只纳入本次明确授权的既有改动。范围有实质歧义时澄清具体文件或功能，并继续独立检查。
   - 用户已指定版本时沿用并校验。未指定时以最高已公开稳定版为基线直接定版，说明本次选定版本与理由，并按已授权范围继续。
   - **补丁 `PATCH`**。问题修复、性能与稳定性改进、布局或文案调整、例行维护，补丁号加一。
   - **次版本 `MINOR`**。新增向后兼容的功能或扩展工作流，次版本号加一，补丁号归零。`0.x` 的不兼容变更也升次版本，并在发布说明中写明影响。
   - **主版本 `MAJOR`**。从 `1.0.0` 起，遇到不兼容变更时主版本号加一，次版本和补丁号归零。首次进入 `1.0.0` 采用用户明确指定的版本。
   - 同次发布包含多类改动时取最高级别。目标标签已存在时先核对提交、CI 和 Release。确需新标签且自动选定的版本被其他提交占用时，在该主次版本下递增补丁号。用户已指定的版本发生冲突时，报告冲突并保留其选择。
   - 获准纳入的功能或修复独立提交。发布提交只含版本同步和发布说明。提交前检查暂存区，保留范围外的用户改动。

3. **同步版本号**（仓库根目录）：
   ```powershell
   node scripts/release.mjs sync vX.Y.Z
   ```
   该脚本更新 5 个文件：`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。不要手工改版本号。

4. **写发布说明** `docs/releases/vX.Y.Z.md`，按 [开发、验证与发布](../../../docs/00008-development-and-release.md) 第 6 节模板编写（目录不存在时新建）：
   - `# DevPort vX.Y.Z` 标题
   - `## 新功能` 和/或 `## 修复`：面向用户的要点
   - `## 验证范围`：跑了哪些测试、哪些行为需手动验证（如桌面/硬件相关）
   - `## 升级说明`：便携版文件名写 `DevPort_X.Y.Z_x64-portable.exe`；固定提醒两套更新清单与 `.exe.sig` 用于更新校验

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
   工作流产出 NSIS 安装包、`.exe.sig` 签名、`latest.json` / `devport-latest.json` 更新清单、`DevPort_X.Y.Z_x64-portable.exe` 便携版，并自动校验清单与产物一致性（`scripts/release.mjs verify`）。上传期间保持草稿状态，校验通过后自动公开并设为 Latest；任何前置步骤失败均不会执行公开步骤。

9. **确认发布并汇报**：确认本次标签和提交对应的 CI 成功，Release 已公开且为 Latest。通过 Release 资产元数据取得 NSIS 安装包与 `DevPort_X.Y.Z_x64-portable.exe` 的实际下载链接。文件校验由 CI 完成。发布成功后只汇报版本和这两个下载链接。仍在等待或失败时说明当前阶段和具体原因。

## 注意事项

- DevPort 兼容旧版更新依赖 `whoarei/remote-runner` 的 GitHub 重定向；禁止占用旧仓库名。CI 必须在草稿阶段执行 `release.mjs bridge`、校验并重传 `latest.json` 和 `devport-latest.json`、通过隔离安装器测试后才能公开，详见 [改名兼容](../../../docs/00008-development-and-release.md#devport-改名兼容)。保持 1.0 的 DevPort 身份、签名公钥和旧版迁移入口；不得让旧数据覆盖新配置。

- 签名私钥在仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY`），本地无法构建带签名的发布产物；发布必须走 CI。
- 工作流内也会执行一次 `release.mjs sync`，但仓库里的版本提交仍要提前做（安装包「关于」页等读取的是仓库版本）。
- 也可用 `workflow_dispatch` 对已有 tag 重新触发发布（workflow 的 `tag` 输入）。
- 若构建、上传或校验失败，保留草稿并排查原因；无需改代码时可用 `workflow_dispatch` 重试原标签，代码修复则提交后用新版本标签发布。不要移动已有标签，或覆盖已公开版本的产物。
