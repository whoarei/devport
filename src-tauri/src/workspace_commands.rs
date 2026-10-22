use crate::{
    commands::AppState,
    workspace_ref::WorkspaceRef,
    workspace_run::{self as model, *},
};

async fn store(state: &AppState, workspace: &WorkspaceRef) -> Result<Store> {
    let source = source_device(workspace, &state.device_store)?;
    Store::open(workspace, source.as_ref(), &state.config_dir).await
}
#[tauri::command]
pub async fn read_runner_config(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
) -> Result<ConfigState> {
    store(&state, &workspace).await?.config().await
}
#[tauri::command]
pub async fn save_runner_config(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    config: Config,
    expected_revision: String,
) -> Result<ConfigState> {
    store(&state, &workspace)
        .await?
        .save_config(config, &expected_revision)
        .await
}
#[tauri::command]
pub async fn list_workspace_commands(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
) -> Result<Commands> {
    store(&state, &workspace).await?.commands().await
}
#[tauri::command]
pub async fn delete_workspace_command(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    id: String,
    expected_revision: String,
) -> Result<Commands> {
    store(&state, &workspace)
        .await?
        .delete(&id, &expected_revision)
        .await
}
#[tauri::command]
pub async fn edit_workspace_command_entry(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    id: String,
    entry: Entry,
    expected_revision: String,
) -> Result<Commands> {
    store(&state, &workspace)
        .await?
        .edit_entry(&id, entry, &expected_revision)
        .await
}
#[tauri::command]
pub async fn inspect_workspace_python(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    project: bool,
) -> Result<ProjectInfo> {
    store(&state, &workspace).await?.project_info(project).await
}
#[tauri::command]
pub async fn runner_lock_info(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
) -> Result<Option<serde_json::Value>> {
    store(&state, &workspace).await?.lock_info().await
}
#[tauri::command]
pub async fn recover_runner_lock(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    expected_revision: String,
) -> Result<()> {
    store(&state, &workspace)
        .await?
        .recover_lock(&expected_revision)
        .await
}
#[tauri::command]
pub fn run_workspace(
    state: tauri::State<'_, AppState>,
    updates: tauri::State<'_, crate::update::UpdateState>,
    mut request: Request,
    expected_source_revision: Option<String>,
) -> Result<String> {
    let _update = updates
        .allow_run()
        .map_err(|e| error("busy", e.to_string()))?;
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    request.command.validate()?;
    if let Some(source) = request.source.as_mut() {
        source.validate()?;
    }
    request.settings.cwd = relative(&request.settings.cwd, true)?;
    let device = state
        .device_store
        .get(&request.device_id)
        .map_err(|e| error("device", e.to_string()))?;
    if device_revision(&device) != request.device_revision {
        return Err(error(
            "conflict",
            "Device configuration changed; refresh before running",
        ));
    }
    let source = source_device(&request.workspace, &state.device_store)?;
    if expected_source_revision
        .as_ref()
        .is_some_and(|r| source.as_ref().map(device_revision).as_ref() != Some(r))
    {
        return Err(error(
            "conflict",
            "Workspace source configuration changed; refresh before running",
        ));
    }
    let managed = request.command.entry.python() && matches!(request.python, Python::Project);
    if request.operation != Operation::Run && !managed {
        return Err(error(
            "invalid",
            "Environment preparation requires project Python",
        ));
    }
    let mut legacy:crate::runner::RunRequest=serde_json::from_value(serde_json::json!({
        "device_id":request.device_id,"workspace":request.workspace,
        "kind":if request.command.entry.python() {"python"} else {"shell"},
        "entry":request.command.entry.value(),"args":request.command.args,
        "module":request.command.entry.module(),"env":request.settings.env,
        "managed_python":managed,"console_mode":request.settings.console_mode,
        "cols":request.settings.cols,"rows":request.settings.rows,
        "timeout_secs":request.settings.timeout_secs,"cwd":request.settings.cwd,"bash":request.settings.bash,
    })).map_err(|e|error("invalid",e.to_string()))?;
    legacy.workspace_context = Some(Context {
        request,
        source_device: source.clone(),
        config_dir: state.config_dir.clone(),
    });
    state
        .run_manager
        .start(legacy, device, state.config_dir.clone(), source)
        .map_err(|e| error("run", e.to_string()))
}
#[tauri::command]
pub fn get_workspace_run(
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Option<serde_json::Value> {
    state.run_manager.workspace_session(&run_id)
}
#[tauri::command]
pub async fn retry_workspace_history(
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Result<()> {
    state
        .run_manager
        .retry_command_history(&run_id)
        .await
        .map_err(|e| error("run", e.to_string()))
}
#[tauri::command]
pub async fn probe_python_environment(
    state: tauri::State<'_, AppState>,
    device_id: String,
) -> crate::error::Result<crate::workspace_probe::Probe> {
    let device = state.device_store.get(&device_id)?;
    if device.transport == crate::device::TransportKind::Serial {
        return crate::workspace_probe::serial_python(&device).await;
    }
    let mut probe = crate::workspace_probe::python(
        &device,
        &state.config_dir,
        None,
        None,
        &Default::default(),
        None,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await?;
    // Full profile variables are only needed by the backend launch path.
    probe.env.clear();
    Ok(probe)
}
#[tauri::command]
pub async fn rename_workspace_commands(
    state: tauri::State<'_, AppState>,
    workspace: WorkspaceRef,
    old_path: String,
    new_path: String,
) -> Result<Commands> {
    store(&state, &workspace)
        .await?
        .rename_commands(&old_path, &new_path)
        .await
}

#[derive(serde::Serialize)]
pub struct DeviceSnapshot {
    #[serde(flatten)]
    pub device: crate::device::DeviceProfile,
    pub revision: String,
}
pub fn device_snapshot(device: crate::device::DeviceProfile) -> DeviceSnapshot {
    let revision = model::device_revision(&device);
    DeviceSnapshot { device, revision }
}
