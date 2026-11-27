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
    let _ = store.record_event("project_added", &format!("导入了项目 {name}"));
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
    let name = store
        .list_projects()
        .ok()
        .and_then(|l| l.into_iter().find(|p| p.id == id))
        .map(|p| p.name)
        .unwrap_or_default();
    store.remove_project(id).map_err(|e| e.to_string())?;
    if !name.is_empty() {
        let _ = store.record_event("project_removed", &format!("移除了项目 {name}（备份快照保留）"));
    }
    Ok(())
}

#[tauri::command]
pub fn docs_set_project_enabled(
    store: State<'_, Arc<DocsStore>>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    let name = store
        .list_projects()
        .ok()
        .and_then(|l| l.into_iter().find(|p| p.id == id))
        .map(|p| p.name)
        .unwrap_or_default();
    store.set_project_enabled(id, enabled).map_err(|e| e.to_string())?;
    if !name.is_empty() {
        let _ = store.record_event(
            if enabled { "project_enabled" } else { "project_disabled" },
            &format!("{} 已{}自动同步", name, if enabled { "启用" } else { "停用" }),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn docs_get_state(
    store: State<'_, Arc<DocsStore>>,
    project_id: i64,
) -> Result<SyncStateRecord, String> {
    store.get_state(project_id).map_err(|e| e.to_string())
}

/// 更新项目同步清单（详情页编辑用）。
#[tauri::command]
pub fn docs_set_project_include(
    store: State<'_, Arc<DocsStore>>,
    id: i64,
    include_json: String,
) -> Result<(), String> {
    store
        .set_project_include(id, &include_json)
        .map_err(|e| e.to_string())
}

/// 仅同步单个项目（不动其他项目）。
#[tauri::command]
pub fn docs_sync_one(
    store: State<'_, Arc<DocsStore>>,
    app: tauri::AppHandle,
    id: i64,
) -> Result<(i64, i64), String> {
    use tauri::Emitter;
    let _guard = SYNC_LOCK.try_lock().map_err(|_| "已有同步任务在运行".to_string())?;
    let settings = store.get_backup_settings().map_err(|e| e.to_string())?;
    let vault = std::path::PathBuf::from(&settings.vault_path);
    let projects = store.list_projects().map_err(|e| e.to_string())?;
    let project = projects
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "项目不存在".to_string())?
        .clone();
    match docs_sync::run_batch_first_time(&vault, &project) {
        Ok((added, deleted)) => {
            let _ = store.upsert_state(&SyncStateRecord {
                project_id: id,
                last_sync: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                added,
                deleted,
                push_status: Some("synced".into()),
                ..Default::default()
            });
            if added + deleted > 0 {
                let _ = store.record_event(
                    "sync_ok",
                    &format!("{} 同步完成：+{}/-{}", project.name, added, deleted),
                );
            }
            let _ = app.emit("docs-sync-done", ());
            Ok((added, deleted))
        }
        Err(e) => {
            let msg = format!("{e:#}");
            let _ = store.upsert_state(&SyncStateRecord {
                project_id: id,
                last_sync: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                push_status: Some("failed".into()),
                last_error: Some(msg.clone()),
                ..Default::default()
            });
            let _ = store.record_event("sync_failed", &format!("{} 同步失败：{msg}", project.name));
            Err(msg)
        }
    }
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
    auto_backup: Option<bool>,
    interval_minutes: Option<i64>,
) -> Result<(), String> {
    // 配置远端时确保备份目录已初始化为 git 仓库并写入 origin
    if let Some(r) = &remote {
        if !r.trim().is_empty() {
            let vault = store
                .get_backup_settings()
                .map(|s| s.vault_path)
                .unwrap_or_default();
            docs_sync::ensure_git_repo(std::path::Path::new(&vault), Some(r))
                .map_err(|e| e.to_string())?;
        }
    }
    store
        .set_backup_settings(
            vault_path.as_deref(),
            remote.as_deref(),
            branch.as_deref(),
            auto_mode,
            auto_backup,
            interval_minutes,
        )
        .map_err(|e| e.to_string())
}

/// 备份页状态：备份仓 git 信息 + 最近备份结果 + 体积/版本数。
#[derive(serde::Serialize)]
pub struct BackupStatus {
    pub is_repo: bool,
    pub remote: Option<String>,
    pub branch: String,
    pub last_backup: Option<String>,
    pub push_status: Option<String>,
    pub last_commit: Option<String>,
    pub last_error: Option<String>,
    pub size_bytes: u64,
    pub version_count: i64,
}

fn dir_size(dir: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

#[tauri::command]
pub fn docs_get_backup_status(store: State<'_, Arc<DocsStore>>) -> Result<BackupStatus, String> {
    let settings = store.get_backup_settings().map_err(|e| e.to_string())?;
    let vault = std::path::PathBuf::from(&settings.vault_path);
    let is_repo = vault.join(".git").exists();
    let state = store.get_backup_state().map_err(|e| e.to_string())?;
    let mut version_count = 0i64;
    if is_repo {
        if let Ok(n) = docs_sync::run_git(&vault, &["rev-list", "--count", "HEAD"]) {
            version_count = n.trim().parse().unwrap_or(0);
        }
    }
    Ok(BackupStatus {
        is_repo,
        remote: settings.remote,
        branch: settings.branch,
        last_backup: state.last_backup,
        push_status: state.push_status,
        last_commit: state.last_commit,
        last_error: state.last_error,
        size_bytes: if vault.exists() { dir_size(&vault) } else { 0 },
        version_count,
    })
}

/// 手动"立即备份"：整个备份仓 commit + push（与同步无关）。
#[tauri::command]
pub fn docs_backup_now(
    store: State<'_, Arc<DocsStore>>,
    app: tauri::AppHandle,
) -> Result<docs_sync::BackupOutcome, String> {
    use tauri::Emitter;
    let _guard = SYNC_LOCK.try_lock().map_err(|_| "已有同步/备份任务在运行".to_string())?;
    let (committed, pushed, sha) = docs_sync::run_backup_now(&store).map_err(|e| e.to_string())?;
    let _ = app.emit("docs-sync-done", ());
    Ok(docs_sync::BackupOutcome { committed, pushed, sha })
}

/// 备份历史：最近 30 个 commit（整个备份仓，全项目共享）。
#[derive(serde::Serialize)]
pub struct VersionRecord {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub time: String,
}

#[tauri::command]
pub fn docs_list_versions(store: State<'_, Arc<DocsStore>>) -> Result<Vec<VersionRecord>, String> {
    let settings = store.get_backup_settings().map_err(|e| e.to_string())?;
    let vault = std::path::PathBuf::from(&settings.vault_path);
    if !vault.join(".git").exists() {
        return Ok(Vec::new());
    }
    let out = docs_sync::run_git(
        &vault,
        &["log", "-n", "30", "--pretty=format:%h\x1f%s\x1f%an\x1f%ci"],
    )
    .map_err(|e| e.to_string())?;
    let versions = out
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            Some(VersionRecord {
                sha: parts.next()?.to_string(),
                message: parts.next().unwrap_or("").to_string(),
                author: parts.next().unwrap_or("").to_string(),
                time: parts.next().unwrap_or("").to_string(),
            })
        })
        .collect();
    Ok(versions)
}

/// 把某个备份版本导出到目标目录（副本恢复，不改动备份仓）。
#[tauri::command]
pub fn docs_restore_version(
    store: State<'_, Arc<DocsStore>>,
    sha: String,
    target_dir: String,
) -> Result<(), String> {
    if sha.contains(|c: char| !c.is_ascii_hexdigit()) || sha.len() < 7 || sha.len() > 40 {
        return Err("无效的版本号".into());
    }
    let target = std::path::PathBuf::from(&target_dir);
    if !target.is_dir() {
        return Err("目标目录不存在".into());
    }
    let settings = store.get_backup_settings().map_err(|e| e.to_string())?;
    docs_sync::restore_version(std::path::Path::new(&settings.vault_path), &sha, &target)
        .map_err(|e| e.to_string())?;
    let _ = store.record_event(
        "restore",
        &format!("已把版本 {sha} 导出到 {}", target.display()),
    );
    Ok(())
}

/// 首页近期动态。
#[tauri::command]
pub fn docs_recent_events(store: State<'_, Arc<DocsStore>>) -> Result<Vec<crate::core::docs_store::EventRecord>, String> {
    store.recent_events(20).map_err(|e| e.to_string())
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
