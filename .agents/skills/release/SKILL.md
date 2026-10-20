---
name: release
description: Remote Runner 版本发布流程：同步版本号、写发布说明、提交、打 tag 推送触发 GitHub Actions 构建 draft release。当用户说"发布/发版/release 某版本"（如"发布 0.5.4"）时使用。
---

# Remote Runner 发布流程

发布一个稳定版本（tag 格式严格为 `vX.Y.Z`，禁止预发布后缀、前导零；各字段 ≤ 65535）。发布动作包含 git 提交、打 tag、推送，执行前需用户明确确认版本号。

## 步骤

1. **确认工作区干净、确定版本号**
   - `git status --short`：待发布的改动应先以 `feat:` / `fix:` 等独立提交完成，发布提交本身只含版本同步和发布说明（参见 `git show bc17cc4` 的 v0.5.1 模式）。
   - 用 `git tag -l "v*"` 确认新版本号未占用。

2. **同步版本号**（仓库根目录）：
   ```powershell
   node scripts/release.mjs sync vX.Y.Z
   ```
   该脚本更新 5 个文件：`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。不要手工改版本号。

3. **写发布说明** `docs/releases/vX.Y.Z.md`，按 [开发、验证与发布](../../../docs/00008-development-and-release.md) 第 6 节模板编写（目录不存在时新建）：
   - `# Remote Runner vX.Y.Z` 标题
   - `## 新功能` 和/或 `## 修复`：面向用户的要点
   - `## 验证范围`：跑了哪些测试、哪些行为需手动验证（如桌面/硬件相关）
   - `## 升级说明`：便携版文件名写 `Remote.Runner_X.Y.Z_x64-portable.exe`；固定提醒 `latest.json` 与 `.exe.sig` 用于更新校验

4. **验证**：
   ```powershell
   npm test
   git diff --check
   ```
   若涉及 Rust 改动，另跑 `cd src-tauri; cargo fmt --all -- --check; cargo test --offline --all-targets`（见 AGENTS.md「Change verification」）。

5. **提交发布**：
   ```powershell
   git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json docs/releases/vX.Y.Z.md
   git commit -m "chore: release vX.Y.Z"
   ```

6. **打 tag 并推送**（触发 GitHub Actions `Release` 工作流）：
   ```powershell
   git tag vX.Y.Z
   git push origin master
   git push origin vX.Y.Z
   ```

7. **跟踪构建**：
   ```powershell
   gh run list --workflow=release.yml --limit 3
   gh run watch <run-id>
   ```
   工作流约 7 分钟，产出 NSIS 安装包、`.exe.sig` 签名、`latest.json` 更新清单、`Remote.Runner_X.Y.Z_x64-portable.exe` 便携版，并自动校验清单与产物一致性（`scripts/release.mjs verify`）。

8. **告知用户**：工作流创建的是 **draft release**，构建成功后需到 GitHub 发布页手动 Publish 正式对外发布。

## 注意事项

- 签名私钥在仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY`），本地无法构建带签名的发布产物；发布必须走 CI。
- 工作流内也会执行一次 `release.mjs sync`，但仓库里的版本提交仍要提前做（安装包「关于」页等读取的是仓库版本）。
- 也可用 `workflow_dispatch` 对已有 tag 重新触发发布（workflow 的 `tag` 输入）。
- 若构建失败，修复后删除远端 tag（`git push origin :vX.Y.Z`）并删除对应 draft release，再重新打 tag 推送；不要复用同一个 tag 名指到不同提交后静默重发。
