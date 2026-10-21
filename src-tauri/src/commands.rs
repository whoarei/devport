use crate::device::{DeviceProfile, DeviceStore};
use crate::error::Result;
use crate::runner::{RunManager, RunStatus};
use crate::workspace_ref::WorkspaceRef;
use std::path::PathBuf;

pub struct AppState {
    pub transfer_manager: crate::file_transfer::TransferManager,
    pub terminal_manager: crate::terminal::TerminalManager,
    pub run_manager: RunManager,
    pub device_store: DeviceStore,
    pub config_dir: PathBuf,
    pub event_rx: parking_lot::Mutex<tokio::sync::broadcast::Receiver<crate::runner::RunEvent>>,
    /// 活跃 Run 持有的 Environment lease（00005-python-runtime.md）；删除/GC 不得触碰
    pub leases: std::sync::Arc<crate::runtime::manager::LeaseSet>,
    /// 远端工作区编辑会话（00004-workspace-and-sync.md；单槽长连接）
    pub workspace_sessions: crate::remote_workspace::SessionStore,
}

#[tauri::command]
pub async fn transfer_list_dir(
    state: tauri::State<'_, AppState>,
    endpoint: WorkspaceRef,
) -> std::result::Result<crate::file_transfer::Directory, crate::workspace::FileError> {
    state.transfer_manager.list(endpoint).await
}

#[tauri::command]
pub async fn transfer_create_dir(
    state: tauri::State<'_, AppState>,
    endpoint: WorkspaceRef,
    name: String,
) -> std::result::Result<(), crate::workspace::FileError> {
    state.transfer_manager.mkdir(endpoint, name).await
}

#[tauri::command]
pub async fn transfer_plan(
    state: tauri::State<'_, AppState>,
    request: crate::file_transfer::Request,
) -> std::result::Result<crate::file_transfer::Plan, crate::workspace::FileError> {
    state.transfer_manager.plan(request).await
}

#[tauri::command]
pub fn transfer_discard_plan(state: tauri::State<'_, AppState>, plan_id: String) {
    state.transfer_manager.discard_plan(&plan_id);
}

#[tauri::command]
pub fn transfer_start(
    state: tauri::State<'_, AppState>,
    updates: tauri::State<'_, crate::update::UpdateState>,
    plan_id: String,
    policy: crate::file_transfer::ConflictPolicy,
    preserve_executable: bool,
) -> std::result::Result<String, crate::workspace::FileError> {
    let _gate = updates
        .allow_run()
        .map_err(|e| crate::workspace::FileError::new("busy", e.to_string()))?;
    state
        .transfer_manager
        .start(&plan_id, policy, preserve_executable)
}

#[tauri::command]
pub fn transfer_snapshot(
    state: tauri::State<'_, AppState>,
) -> Vec<crate::file_transfer::TaskSummary> {
    state.transfer_manager.summaries()
}

#[tauri::command]
pub fn transfer_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> std::result::Result<crate::file_transfer::Task, crate::workspace::FileError> {
    state.transfer_manager.task(&task_id)
}

#[tauri::command]
pub fn transfer_cancel(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> std::result::Result<(), crate::workspace::FileError> {
    state.transfer_manager.cancel(&task_id)
}

#[tauri::command]
pub async fn transfer_cancel_all(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), crate::workspace::FileError> {
    state.transfer_manager.cancel_all().await
}

#[tauri::command]
pub async fn transfer_retry_failed(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> std::result::Result<crate::file_transfer::Plan, crate::workspace::FileError> {
    state.transfer_manager.retry(&task_id).await
}

#[tauri::command]
pub async fn transfer_cleanup(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> std::result::Result<(), crate::workspace::FileError> {
    state.transfer_manager.cleanup(&task_id).await
}

#[tauri::command]
pub fn drain_run_events(state: tauri::State<'_, AppState>) -> Vec<crate::runner::RunEvent> {
    crate::events::drain(&mut state.event_rx.lock(), &state.run_manager)
}

// ---------- 设备管理 ----------

#[tauri::command]
pub fn list_devices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::workspace_commands::DeviceSnapshot>> {
    Ok(state
        .device_store
        .list()?
        .into_iter()
        .map(crate::workspace_commands::device_snapshot)
        .collect())
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
pub async fn usb_snapshot() -> crate::usb::Snapshot {
    crate::usb::snapshot().await
}

#[tauri::command]
pub async fn usb_connect(
    selector: crate::usb::DeviceSelector,
    config: crate::device::WslConfig,
) -> crate::usb::Result<()> {
    crate::usb::connect(selector, config).await
}

#[tauri::command]
pub async fn usb_disconnect(selector: crate::usb::DeviceSelector) -> crate::usb::Result<()> {
    crate::usb::disconnect(selector).await
}

#[tauri::command]
pub async fn usb_unshare(selector: crate::usb::DeviceSelector) -> crate::usb::Result<()> {
    crate::usb::unshare(selector).await
}

#[tauri::command]
pub async fn usb_verify(
    selector: crate::usb::DeviceSelector,
    config: crate::device::WslConfig,
) -> crate::usb::Result<crate::usb::Verification> {
    crate::usb::verify(selector, config).await
}

fn usb_remote_device(
    state: &AppState,
    config: &crate::usb::remote::RemoteConfig,
) -> crate::usb::Result<DeviceProfile> {
    config.validate()?;
    state
        .device_store
        .get(&config.device_id)
        .map_err(|e| crate::usb::UsbError {
            code: "invalid_input",
            message: e.to_string(),
        })
}

#[tauri::command]
pub async fn usb_remote_probe(
    state: tauri::State<'_, AppState>,
    config: crate::usb::remote::RemoteConfig,
) -> crate::usb::Result<crate::usb::remote::Probe> {
    let device = usb_remote_device(&state, &config)?;
    crate::usb::remote::probe(&device, config, &state.config_dir).await
}

#[tauri::command]
pub async fn usb_remote_connect(
    state: tauri::State<'_, AppState>,
    selector: crate::usb::DeviceSelector,
    config: crate::usb::remote::RemoteConfig,
) -> crate::usb::Result<String> {
    let device = usb_remote_device(&state, &config)?;
    crate::usb::remote::connect(selector, &device, config, &state.config_dir).await
}

#[tauri::command]
pub async fn usb_remote_disconnect(
    state: tauri::State<'_, AppState>,
    selector: crate::usb::DeviceSelector,
    config: crate::usb::remote::RemoteConfig,
) -> crate::usb::Result<()> {
    let device = usb_remote_device(&state, &config)?;
    crate::usb::remote::disconnect(selector, &device, config, &state.config_dir).await
}

#[tauri::command]
pub async fn usb_remote_verify(
    state: tauri::State<'_, AppState>,
    selector: crate::usb::DeviceSelector,
    config: crate::usb::remote::RemoteConfig,
) -> crate::usb::Result<crate::usb::Verification> {
    let device = usb_remote_device(&state, &config)?;
    crate::usb::remote::verify(selector, &device, config, &state.config_dir).await
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

/// 设备工作区的来源设备（远端会话的目标）
fn session_device(state: &AppState, workspace: &WorkspaceRef) -> WorkspaceResult<DeviceProfile> {
    let (device_id, _) = workspace
        .device_ref()
        .ok_or_else(|| crate::workspace::FileError::new("path", "不是设备工作区"))?;
    state
        .device_store
        .get(device_id)
        .map_err(|_| crate::workspace::FileError::new("not_found", "设备不存在或已被删除"))
}

/// Open only a validated local directory, never a file or an unmounted device path.
#[tauri::command]
pub fn open_workspace_in_file_manager(
    app: tauri::AppHandle,
    workspace: WorkspaceRef,
    subdir: String,
) -> WorkspaceResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let dir = workspace.local_dir().ok_or_else(|| {
        crate::workspace::FileError::new("unsupported", "仅本机工作区支持在系统文件管理器中打开")
    })?;
    if dir.trim().is_empty() {
        return Err(crate::workspace::FileError::new(
            "path",
            "工作区目录不能为空",
        ));
    }
    let path = crate::workspace::terminal_dir(dir, &subdir)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| crate::workspace::FileError::new("open", error.to_string()))
}

#[tauri::command]
pub async fn list_workspace_dir(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    subdir: String,
) -> WorkspaceResult<Vec<crate::workspace::Entry>> {
    match &workspace {
        // Read-only listing takes no lock: the tree stays usable during a run.
        WorkspaceRef::Local { dir } => crate::workspace::list_dir(dir, &subdir),
        WorkspaceRef::Device { .. } => {
            let device = session_device(&state, &workspace)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(async move { session.list_dir(&subdir).await })
                })
                .await
        }
    }
}

#[tauri::command]
pub async fn read_workspace_file(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    name: String,
) -> WorkspaceResult<crate::workspace::Document> {
    match &workspace {
        WorkspaceRef::Local { dir } => {
            let _guard = crate::workspace::FILE_OPERATIONS.lock();
            crate::workspace::read(dir, &name)
        }
        WorkspaceRef::Device { .. } => {
            let device = session_device(&state, &workspace)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(async move { session.read(&name).await })
                })
                .await
        }
    }
}

#[tauri::command]
pub async fn write_workspace_file(
    state: tauri::State<'_, AppState>,
    request: crate::workspace::SaveRequest,
) -> WorkspaceResult<crate::workspace::Saved> {
    match &request.workspace {
        WorkspaceRef::Local { .. } => {
            let _guard = crate::workspace::FILE_OPERATIONS.lock();
            if let Some(busy) = blocked_by_run(&state) {
                return Err(busy);
            }
            crate::workspace::write(request)
        }
        WorkspaceRef::Device { .. } => {
            if let Some(busy) = blocked_by_run(&state) {
                return Err(busy);
            }
            let workspace = request.workspace.clone();
            let device = session_device(&state, &workspace)?;
            let data =
                crate::workspace::encode_content(&request.content, request.eol, request.bom)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(async move {
                        session
                            .write(&request.name, &data, &request.expected_revision)
                            .await
                    })
                })
                .await
        }
    }
}

#[tauri::command]
pub async fn create_workspace_entry(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    name: String,
    kind: crate::workspace::EntryKind,
) -> WorkspaceResult<()> {
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    match &workspace {
        WorkspaceRef::Local { dir } => {
            let _guard = crate::workspace::FILE_OPERATIONS.lock();
            crate::workspace::create(dir, &name, kind)
        }
        WorkspaceRef::Device { .. } => {
            let device = session_device(&state, &workspace)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(async move { session.create(&name, kind).await })
                })
                .await
        }
    }
}

#[tauri::command]
pub async fn rename_workspace_entry(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    old_name: String,
    new_name: String,
) -> WorkspaceResult<()> {
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    match &workspace {
        WorkspaceRef::Local { dir } => {
            let _guard = crate::workspace::FILE_OPERATIONS.lock();
            crate::workspace::rename(dir, &old_name, &new_name)
        }
        WorkspaceRef::Device { .. } => {
            let device = session_device(&state, &workspace)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(async move { session.rename(&old_name, &new_name).await })
                })
                .await
        }
    }
}

#[tauri::command]
pub async fn delete_workspace_entry(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    name: String,
) -> WorkspaceResult<()> {
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    match &workspace {
        WorkspaceRef::Local { dir } => {
            let _guard = crate::workspace::FILE_OPERATIONS.lock();
            crate::workspace::delete(dir, &name)
        }
        WorkspaceRef::Device { .. } => {
            let device = session_device(&state, &workspace)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(async move { session.delete(&name).await })
                })
                .await
        }
    }
}

/// 生成工作区配置模板（pyproject.toml 的 [tool.remote-runner] 契约）；
/// 已存在 pyproject.toml 时拒绝，不覆盖
#[tauri::command]
pub async fn generate_workspace_config(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
) -> WorkspaceResult<()> {
    if let Some(busy) = blocked_by_run(&state) {
        return Err(busy);
    }
    match &workspace {
        WorkspaceRef::Local { dir } => {
            let _guard = crate::workspace::FILE_OPERATIONS.lock();
            if dir.trim().is_empty() {
                return Err(crate::workspace::FileError::new(
                    "path",
                    "工作区目录不能为空",
                ));
            }
            let name = crate::runtime::project::template_project_name(std::path::Path::new(dir));
            crate::workspace::create_with_content(
                dir,
                "pyproject.toml",
                &crate::runtime::project::config_template(&name),
            )
        }
        WorkspaceRef::Device { path, .. } => {
            let device = session_device(&state, &workspace)?;
            let name = crate::runtime::project::template_project_name(std::path::Path::new(path));
            let content = crate::runtime::project::config_template(&name);
            let data =
                crate::workspace::encode_content(&content, crate::workspace::Eol::Lf, false)?;
            state
                .workspace_sessions
                .with(&workspace, &device, &state.config_dir, move |session| {
                    Box::pin(
                        async move { session.create_with_content("pyproject.toml", &data).await },
                    )
                })
                .await
        }
    }
}

/// 关闭当前远端工作区编辑会话（前端关闭或切换工作区时调用）
#[tauri::command]
pub async fn close_workspace_session(state: tauri::State<'_, AppState>) -> Result<()> {
    state.workspace_sessions.close().await;
    Ok(())
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
    // 远端工作区的来源设备（00004-workspace-and-sync.md）：在边界校验存在性、路径与宿主能力后随请求传递
    let workspace_source = match request.workspace.as_ref().and_then(|w| w.device_ref()) {
        Some((source_id, path)) => {
            crate::workspace_ref::validate_device_path(path)
                .map_err(crate::error::RunnerError::InvalidInput)?;
            let source = state.device_store.get(source_id)?;
            source.validate()?;
            if !crate::workspace_ref::host_supported(source.transport) {
                return Err(crate::error::RunnerError::InvalidInput(
                    "该设备类型不支持作为工作区宿主".into(),
                ));
            }
            Some(source)
        }
        None => None,
    };
    state
        .run_manager
        .start(request, device, state.config_dir.clone(), workspace_source)
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

// ---------- Managed Python Runtime（00005-python-runtime.md）----------

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

/// 在工作区目录中打开终端标签。本机工作区仅支持本机设备（就地 cwd）；
/// 设备工作区仅支持在托管它的那台设备上打开（SSH/WSL 终端启动后 cd）。
/// subdir 与工作区树同构（"" 为根目录）；路径与设备类别的校验全部在此边界完成。
#[tauri::command]
pub fn open_workspace_terminal(
    state: tauri::State<'_, AppState>,
    updates: tauri::State<'_, crate::update::UpdateState>,
    device_id: String,
    workspace: WorkspaceRef,
    subdir: String,
    cols: u32,
    rows: u32,
) -> Result<crate::terminal::Status> {
    let _gate = updates.allow_run()?;
    let device = state.device_store.get(&device_id)?;
    let cwd = match &workspace {
        WorkspaceRef::Local { dir } => {
            if device.transport != crate::device::TransportKind::Local {
                return Err(crate::error::RunnerError::InvalidInput(
                    "本机工作区只能在本机设备上打开终端".into(),
                ));
            }
            crate::workspace::terminal_dir(dir, &subdir)
                .map_err(|e| crate::error::RunnerError::InvalidInput(e.message))?
                .to_string_lossy()
                .into_owned()
        }
        WorkspaceRef::Device {
            device_id: source,
            path,
        } => {
            if *source != device_id {
                return Err(crate::error::RunnerError::InvalidInput(
                    "只能在托管该工作区的设备上打开终端".into(),
                ));
            }
            if !crate::workspace_ref::host_supported(device.transport) {
                return Err(crate::error::RunnerError::InvalidInput(
                    "该设备类型不支持在工作区目录中打开终端".into(),
                ));
            }
            if subdir.is_empty() {
                path.clone()
            } else {
                // components 校验拒绝 .. 等组件，拼接结果始终在工作区内
                crate::workspace::components(&subdir)
                    .map_err(|e| crate::error::RunnerError::InvalidInput(e.message))?;
                format!("{}/{}", path.trim_end_matches('/'), subdir)
            }
        }
    };
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
