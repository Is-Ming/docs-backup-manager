//! docs-backup-manager Tauri 命令：项目注册、同步、状态、设置。

use std::sync::Arc;

use tauri::State;

use crate::core::docs_store::{
    BackupSettings, DocsStore, ProjectRecord, SyncStateRecord,
};
use crate::core::docs_sync;

/// 并发保护：桌面端手动同步与后台调度共用一把锁。
static SYNC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub fn docs_list_projects(store: State<'_, Arc<DocsStore>>) -> Result<Vec<ProjectRecord>, String> {
    store.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_add_project(
    store: State<'_, Arc<DocsStore>>,
    name: String,
    repo_path: String,
    include_json: Option<String>,
    exclude_json: Option<String>,
    manage_git_exclude: Option<bool>,
) -> Result<i64, String> {
    let id = store
        .add_project(
            &name,
            &repo_path,
            include_json.as_deref(),
            exclude_json.as_deref(),
            manage_git_exclude.unwrap_or(false),
        )
        .map_err(|e| e)?;
    // 注册成功后立即执行首次同步
    let settings = store.get_backup_settings().map_err(|e| e.to_string())?;
    let vault = std::path::PathBuf::from(&settings.vault_path);
    let projects = store.list_projects().map_err(|e| e.to_string())?;
    if let Some(project) = projects.iter().find(|p| p.id == id) {
        match docs_sync::run_batch_first_time(&vault, project) {
            Ok((added, deleted)) => {
                let _ = store.upsert_state(&SyncStateRecord {
                    project_id: id,
                    last_sync: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                    added,
                    deleted,
                    push_status: Some("synced".into()),
                    ..Default::default()
                });
            }
            Err(e) => {
                let _ = store.upsert_state(&SyncStateRecord {
                    project_id: id,
                    last_sync: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                    push_status: Some("failed".into()),
                    last_error: Some(format!("{e:#}")),
                    ..Default::default()
                });
            }
        }
    }
    Ok(id)
}

#[tauri::command]
pub fn docs_remove_project(store: State<'_, Arc<DocsStore>>, id: i64) -> Result<(), String> {
    store.remove_project(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_set_project_enabled(
    store: State<'_, Arc<DocsStore>>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    store.set_project_enabled(id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_get_state(
    store: State<'_, Arc<DocsStore>>,
    project_id: i64,
) -> Result<SyncStateRecord, String> {
    store.get_state(project_id).map_err(|e| e.to_string())
}

/// 立即同步一轮（手动触发）。单项目失败不影响其余项目。
#[tauri::command]
pub fn docs_sync_now(
    store: State<'_, Arc<DocsStore>>,
    app: tauri::AppHandle,
) -> Result<docs_sync::BatchResult, String> {
    use tauri::Emitter;
    let _guard = SYNC_LOCK.try_lock().map_err(|_| "已有同步任务在运行".to_string())?;
    let result = docs_sync::run_batch(&store);
    // 通知前端刷新
    let _ = app.emit("docs-sync-done", &result);
    Ok(result)
}

#[tauri::command]
pub fn docs_get_settings(store: State<'_, Arc<DocsStore>>) -> Result<BackupSettings, String> {
    store.get_backup_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_set_settings(
    store: State<'_, Arc<DocsStore>>,
    vault_path: Option<String>,
    remote: Option<String>,
    branch: Option<String>,
    auto_mode: Option<bool>,
    interval_minutes: Option<i64>,
) -> Result<(), String> {
    store
        .set_backup_settings(
            vault_path.as_deref(),
            remote.as_deref(),
            branch.as_deref(),
            auto_mode,
            interval_minutes,
        )
        .map_err(|e| e.to_string())
}

/// 注册向导预览：按传入的 include 清单列出映射与目标现存文件数（dry-run 语义）。
#[tauri::command]
pub fn docs_preview_project(
    store: State<'_, Arc<DocsStore>>,
    name: String,
    repo_path: String,
    include_json: Option<String>,
) -> Result<serde_json::Value, String> {
    // 向导预览：列出 include 条目及其落点与现存目标文件数（dry-run 语义）
    let settings = store.get_backup_settings().map_err(|e| e.to_string())?;
    let entries: Vec<String> = match include_json {
        Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string())?,
        None => serde_json::from_str(crate::core::docs_store::DEFAULT_INCLUDE_JSON).unwrap_or_default(),
    };
    let repo = std::path::PathBuf::from(&repo_path);
    let mut rows: Vec<serde_json::Value> = Vec::new();
    for entry in &entries {
        let src = repo.join(entry);
        let target = std::path::Path::new(entry)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| entry.clone());
        let dst = std::path::PathBuf::from(&settings.vault_path)
            .join("backup")
            .join(&name)
            .join(target);
        let src_exists = src.exists();
        let dst_files = if dst.is_dir() {
            std::fs::read_dir(&dst).map(|d| d.count()).unwrap_or(0)
        } else {
            0
        };
        rows.push(serde_json::json!({
            "entry": entry,
            "src": src.to_string_lossy(),
            "dst": dst.to_string_lossy(),
            "srcExists": src_exists,
            "dstExistingFiles": dst_files,
        }));
    }
    Ok(serde_json::json!({ "rows": rows }))
}
