use crate::device::{DeviceProfile, DeviceStore};
use crate::error::Result;
use crate::runner::{RunManager, RunStatus};
use std::path::PathBuf;

pub struct AppState {
    pub terminal_manager: crate::terminal::TerminalManager,
    pub run_manager: RunManager,
    pub device_store: DeviceStore,
    pub config_dir: PathBuf,
    pub event_rx: parking_lot::Mutex<tokio::sync::broadcast::Receiver<crate::runner::RunEvent>>,
    /// 活跃 Run 持有的 Environment lease（00027 §16）；删除/GC 不得触碰
    pub leases: std::sync::Arc<crate::runtime::manager::LeaseSet>,
}

#[tauri::command]
pub fn drain_run_events(state: tauri::State<'_, AppState>) -> Vec<crate::runner::RunEvent> {
    crate::events::drain(&mut state.event_rx.lock(), &state.run_manager)
}

// ---------- 设备管理 ----------

#[tauri::command]
pub fn list_devices(state: tauri::State<'_, AppState>) -> Result<Vec<DeviceProfile>> {
    state.device_store.list()
}

#[tauri::command]
pub fn save_device(
    state: tauri::State<'_, AppState>,
    device: DeviceProfile,
) -> Result<DeviceProfile> {
    state.device_store.save(device)
}

#[tauri::command]
pub fn delete_device(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    state.device_store.delete(&id)
}

/// Test the selected transport without starting a user workload.
#[tauri::command]
pub async fn test_device(
    state: tauri::State<'_, AppState>,
    device: DeviceProfile,
) -> Result<String> {
    device.validate()?;
    if device.transport == crate::device::TransportKind::Local {
        return crate::local::test_device(device.local.as_ref().unwrap()).await;
    }
    if device.transport == crate::device::TransportKind::Wsl {
        return crate::wsl::test_device(device.wsl.as_ref().unwrap()).await;
    }
    if device.transport == crate::device::TransportKind::Serial {
        return crate::serial::test_device(&device).await;
    }
    let conn = crate::ssh::client::SshConnection::connect(&device, &state.config_dir).await?;
    let channel = conn.handle.channel_open_session().await?;
    channel
        .exec(true, "uname -a && python3 --version 2>&1; echo EXIT:$?")
        .await?;
    let mut out = String::new();
    let mut ch = channel;
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => {
                out.push_str(&String::from_utf8_lossy(&data));
            }
            russh::ChannelMsg::ExtendedData { data, .. } => {
                out.push_str(&String::from_utf8_lossy(&data));
            }
            russh::ChannelMsg::Eof => {
                let _ = ch.close().await;
            }
            russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(out)
}

// ---------- 工作区 ----------

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>> {
    crate::serial::transport::available_ports()
}

#[tauri::command]
pub async fn list_wsl_distributions() -> Result<Vec<String>> {
    crate::wsl::list_distributions().await
}

#[tauri::command]
pub fn list_local_shells() -> Vec<crate::local::shells::ShellInfo> {
    crate::local::shells::detect()
}

type WorkspaceResult<T> = std::result::Result<T, crate::workspace::FileError>;

/// RunStatus does not expose workspace identity. Conservatively block every
/// workspace change during preparation/sync of ANY desktop run, including a run
/// being stopped, so the transport never scans a directory that is changing.
fn blocked_by_run(state: &AppState) -> Option<crate::workspace::FileError> {
    state
        .run_manager
        .list_running()
        .iter()
        .any(|run| run.state.blocks_workspace_change())
        .then(|| {
            crate::workspace::FileError::new("busy", "任务正在准备、同步或停止，请稍后修改工作区")
        })
}

#[tauri::command]
pub fn list_workspace_dir(
    dir: String,
    subdir: String,
) -> WorkspaceResult<Vec<crate::workspace::Entry>> {
    // Read-only listing takes no lock: the tree stays usable during a run.
    crate::workspace::list_dir(&dir, &subdir)
}

#[tauri::command]
pub fn read_workspace_file(
    dir: String,
    name: String,
) -> WorkspaceResult<crate::workspace::Document> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    crate::workspace::read(&dir, &name)
}

#[tauri::command]
pub fn write_workspace_file(
    state: tauri::State<'_, AppState>,
    request: crate::workspace::SaveRequest,
) -> WorkspaceResult<crate::workspace::Saved> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    crate::workspace::write(request)
}

#[tauri::command]
pub fn create_workspace_entry(
    state: tauri::State<'_, AppState>,
    dir: String,
    name: String,
    kind: crate::workspace::EntryKind,
) -> WorkspaceResult<()> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    crate::workspace::create(&dir, &name, kind)
}

#[tauri::command]
pub fn rename_workspace_entry(
    state: tauri::State<'_, AppState>,
    dir: String,
    old_name: String,
    new_name: String,
) -> WorkspaceResult<()> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    crate::workspace::rename(&dir, &old_name, &new_name)
}

#[tauri::command]
pub fn delete_workspace_entry(
    state: tauri::State<'_, AppState>,
    dir: String,
    name: String,
) -> WorkspaceResult<()> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    crate::workspace::delete(&dir, &name)
}

/// 生成工作区配置模板（pyproject.toml 的 [tool.remote-runner] 契约）；
/// 已存在 pyproject.toml 时拒绝，不覆盖
#[tauri::command]
pub fn generate_workspace_config(
    state: tauri::State<'_, AppState>,
    dir: String,
) -> WorkspaceResult<()> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    if dir.trim().is_empty() {
        return Err(crate::workspace::FileError::new(
            "path",
            "工作区目录不能为空",
        ));
    }
    let name = crate::runtime::project::template_project_name(std::path::Path::new(&dir));
    crate::workspace::create_with_content(
        &dir,
        "pyproject.toml",
        &crate::runtime::project::config_template(&name),
    )
}

// ---------- 运行控制 ----------

#[tauri::command]
pub fn run_script(
    state: tauri::State<'_, AppState>,
    updates: tauri::State<'_, crate::update::UpdateState>,
    request: crate::runner::RunRequest,
) -> Result<String> {
    let _update_guard = updates.allow_run()?;
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    let device = state.device_store.get(&request.device_id)?;
    state
        .run_manager
        .start(request, device, state.config_dir.clone())
}

#[tauri::command]
pub fn stop_run(state: tauri::State<'_, AppState>, run_id: String) -> Result<()> {
    state.run_manager.stop(&run_id)
}

#[tauri::command]
pub fn send_run_input(
    state: tauri::State<'_, AppState>,
    run_id: String,
    data: String,
) -> Result<()> {
    state.run_manager.send_input(&run_id, data.into_bytes())
}

#[tauri::command]
pub fn resize_run_console(
    state: tauri::State<'_, AppState>,
    run_id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    state.run_manager.resize(&run_id, cols, rows)
}

#[tauri::command]
pub fn get_run_status(
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Result<Option<RunStatus>> {
    Ok(state.run_manager.status(&run_id))
}

#[tauri::command]
pub fn list_running_runs(state: tauri::State<'_, AppState>) -> Result<Vec<RunStatus>> {
    Ok(state.run_manager.list_running())
}

#[tauri::command]
pub fn get_run_history(state: tauri::State<'_, AppState>) -> Result<Vec<RunStatus>> {
    Ok(state.run_manager.history())
}

/// 导出单条历史记录的元数据 JSON 到用户选择的路径
#[tauri::command]
pub fn export_run_record(path: String, contents: String) -> Result<()> {
    if path.trim().is_empty() {
        return Err(crate::error::RunnerError::InvalidInput(
            "export path must not be empty".into(),
        ));
    }
    if contents.len() > 32 * 1024 * 1024 {
        return Err(crate::error::RunnerError::InvalidInput(
            "export contents must not exceed 32 MiB".into(),
        ));
    }
    std::fs::write(&path, contents)?;
    Ok(())
}

/// 导出某次运行持久化的输出日志到用户选择的路径
#[tauri::command]
pub fn export_run_output(
    state: tauri::State<'_, AppState>,
    run_id: String,
    path: String,
) -> Result<()> {
    state.run_manager.export_output(&run_id, &path)
}

/// 清空全部运行历史及其输出日志
#[tauri::command]
pub fn clear_run_history(state: tauri::State<'_, AppState>) -> Result<()> {
    state.run_manager.clear_history()
}

// ---------- Managed Python Runtime（00027 §17）----------

/// 校验并返回 uv 项目契约（pyproject.toml / uv.lock / .python-version）
#[tauri::command]
pub fn inspect_python_project(
    workspace_dir: String,
) -> Result<crate::runtime::project::PythonProject> {
    if workspace_dir.trim().is_empty() {
        return Err(crate::error::RunnerError::InvalidInput(
            "workspace_dir must not be empty".into(),
        ));
    }
    crate::runtime::project::inspect(std::path::Path::new(&workspace_dir))
}

/// 目标设备的 Managed Runtime 摘要；连接失败时返回 present=false 的占位（best-effort）
#[tauri::command]
pub async fn list_managed_runtimes(
    state: tauri::State<'_, AppState>,
    device_id: String,
) -> Result<crate::runtime::ManagedRuntimeInfo> {
    let device = state.device_store.get(&device_id)?;
    device.validate()?;
    let catalog = crate::runtime::catalog::RuntimeCatalog::embedded()?;
    if device.transport == crate::device::TransportKind::Serial {
        return Err(crate::error::RunnerError::managed(
            crate::runtime::code::NOT_SUPPORTED,
            "Serial Shell V1 cannot deploy a binary managed runtime",
        ));
    }
    match crate::runtime::manage::open_host(&device, &state.config_dir).await {
        Ok(host) => crate::runtime::prepare::runtime_info(host, catalog).await,
        Err(e) => {
            tracing::warn!("list_managed_runtimes: host unavailable: {e}");
            Ok(crate::runtime::ManagedRuntimeInfo {
                uv_version: catalog.uv_version.clone(),
                platform: "unavailable".into(),
                uv_path: String::new(),
                present: false,
            })
        }
    }
}

/// 目标设备上的全部项目环境；连接失败时返回空列表（best-effort）
#[tauri::command]
pub async fn list_project_environments(
    state: tauri::State<'_, AppState>,
    device_id: String,
) -> Result<Vec<crate::runtime::ProjectEnvironmentInfo>> {
    let device = state.device_store.get(&device_id)?;
    device.validate()?;
    if device.transport == crate::device::TransportKind::Serial {
        return Err(crate::error::RunnerError::managed(
            crate::runtime::code::NOT_SUPPORTED,
            "Serial Shell V1 cannot deploy a binary managed runtime",
        ));
    }
    match crate::runtime::manage::open_host(&device, &state.config_dir).await {
        Ok(host) => crate::runtime::manager::list_environments(host, &state.leases).await,
        Err(e) => {
            tracing::warn!("list_project_environments: host unavailable: {e}");
            Ok(Vec::new())
        }
    }
}

/// 重建项目环境：删除现有环境后重新执行完整准备流水线
#[tauri::command]
pub async fn rebuild_project_environment(
    state: tauri::State<'_, AppState>,
    device_id: String,
    workspace_dir: String,
    network: Option<crate::runtime::prepare::NetworkConfig>,
) -> Result<crate::runtime::PreparedEnvironment> {
    let device = state.device_store.get(&device_id)?;
    crate::runtime::manage::rebuild_on_device(
        &device,
        &state.config_dir,
        &workspace_dir,
        &state.leases,
        &network.unwrap_or_default(),
    )
    .await
}

/// 删除指定项目环境（持 lease 的环境拒绝删除）
#[tauri::command]
pub async fn delete_project_environment(
    state: tauri::State<'_, AppState>,
    device_id: String,
    environment_id: String,
) -> Result<()> {
    let device = state.device_store.get(&device_id)?;
    device.validate()?;
    let host = crate::runtime::manage::open_host(&device, &state.config_dir).await?;
    crate::runtime::manager::delete_environment(host, &state.leases, &environment_id).await
}

/// 清理 Runtime 缓存：quarantine、未完成环境、uv 依赖缓存；返回移除的条目数
#[tauri::command]
pub async fn clean_runtime_cache(
    state: tauri::State<'_, AppState>,
    device_id: String,
) -> Result<u64> {
    let device = state.device_store.get(&device_id)?;
    device.validate()?;
    let host = crate::runtime::manage::open_host(&device, &state.config_dir).await?;
    let cancel = std::sync::atomic::AtomicBool::new(false);
    crate::runtime::manager::clean_cache(
        host,
        &state.leases,
        crate::runtime::catalog::RuntimeCatalog::embedded()?,
        &cancel,
    )
    .await
}

// ---------- 独立终端（不经过运行/工作区状态） ----------
#[tauri::command]
pub fn open_terminal(
    state: tauri::State<'_, AppState>,
    updates: tauri::State<'_, crate::update::UpdateState>,
    device_id: String,
    cols: u32,
    rows: u32,
) -> Result<crate::terminal::Status> {
    let _gate = updates.allow_run()?;
    state.terminal_manager.open(
        state.device_store.get(&device_id)?,
        state.config_dir.clone(),
        cols,
        rows,
        None,
    )
}

/// 在工作区目录中打开本机设备的终端标签。subdir 与工作区树同构（"" 为根目录）；
/// 路径与设备类别的校验全部在此边界完成。
#[tauri::command]
pub fn open_workspace_terminal(
    state: tauri::State<'_, AppState>,
    updates: tauri::State<'_, crate::update::UpdateState>,
    device_id: String,
    dir: String,
    subdir: String,
    cols: u32,
    rows: u32,
) -> Result<crate::terminal::Status> {
    let _gate = updates.allow_run()?;
    let device = state.device_store.get(&device_id)?;
    if device.transport != crate::device::TransportKind::Local {
        return Err(crate::error::RunnerError::InvalidInput(
            "仅本机设备支持在工作区目录中打开终端".into(),
        ));
    }
    let cwd = crate::workspace::terminal_dir(&dir, &subdir)
        .map_err(|e| crate::error::RunnerError::InvalidInput(e.message))?;
    state
        .terminal_manager
        .open(device, state.config_dir.clone(), cols, rows, Some(cwd))
}

#[tauri::command]
pub fn read_terminal(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<crate::terminal::Read> {
    state.terminal_manager.read(&session_id)
}

#[tauri::command]
pub fn send_terminal_input(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<()> {
    state.terminal_manager.input(&session_id, data)
}

#[tauri::command]
pub fn resize_terminal(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    state.terminal_manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub async fn close_terminal(state: tauri::State<'_, AppState>, session_id: String) -> Result<()> {
    state.terminal_manager.close(&session_id).await
}

#[tauri::command]
pub async fn close_all_terminals(state: tauri::State<'_, AppState>) -> Result<()> {
    state.terminal_manager.close_all().await
}
