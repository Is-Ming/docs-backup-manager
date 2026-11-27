//! docs-backup-manager 独立数据层：项目注册表、同步状态、全局设置。
//!
//! 与 skills-manager 的 SkillStore 完全隔离，数据库存放在
//! `~/.docs-backup-manager/db.sqlite`，避免污染基座的中央库。

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result};
use dirs::home_dir;
use rusqlite::{params, Connection};

/// 应用自身数据目录：~/.docs-backup-manager
pub fn data_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".docs-backup-manager")
}

/// 默认备份目标：~/.docs-vault（可配置，参照 skills-manager 家目录方式）
pub fn default_vault_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".docs-vault")
}

pub fn db_path() -> PathBuf {
    data_dir().join("db.sqlite")
}

/// 默认同步清单：AI 工作文件
pub const DEFAULT_INCLUDE_JSON: &str =
    r#"["docs/","openspec/","AGENTS.md",".codebuddy/",".workbuddy/memory/"]"#;
pub const DEFAULT_EXCLUDE_JSON: &str = r#"["node_modules/","dist/","__pycache__/","*.log",".git"]"#;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectRecord {
    pub id: i64,
    pub name: String,
    pub repo_path: String,
    pub enabled: bool,
    pub include_json: String,
    pub exclude_json: String,
    pub manage_git_exclude: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncStateRecord {
    pub project_id: i64,
    pub last_sync: Option<String>,
    pub added: i64,
    pub deleted: i64,
    pub last_commit: Option<String>,
    /// ok / failed / skipped / synced
    pub push_status: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupSettings {
    pub vault_path: String,
    pub remote: Option<String>,
    pub branch: String,
    /// 自动同步（项目目录 → 备份目录）
    pub auto_mode: bool,
    /// 自动备份（备份目录 → 远端 git），与自动同步相互独立
    pub auto_backup: bool,
    pub interval_minutes: i64,
}

/// 备份仓级状态：整个备份仓 → 远端 git 的批次操作结果（全项目共享）。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct BackupState {
    pub last_backup: Option<String>,
    /// pushed / local（未配置远端，仅 commit）/ failed
    pub push_status: Option<String>,
    pub last_commit: Option<String>,
    pub last_error: Option<String>,
}

/// 近期动态事件（首页时间线用，本地保留最近 50 条）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct EventRecord {
    pub ts: String,
    /// sync_ok / sync_failed / backup_ok / backup_failed / project_added / project_enabled / project_disabled
    pub kind: String,
    pub message: String,
}

pub struct DocsStore {
    conn: Mutex<Connection>,
}

impl DocsStore {
    pub fn new(db_path: &PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create data dir {}", parent.display()))?;
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("Failed to open database at {}", db_path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                repo_path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                include_json TEXT NOT NULL,
                exclude_json TEXT NOT NULL DEFAULT '[]',
                manage_git_exclude INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                last_sync TEXT,
                added INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0,
                last_commit TEXT,
                push_status TEXT,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                kind TEXT NOT NULL,
                message TEXT NOT NULL
            );
            "#,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // ---------- settings ----------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_backup_settings(&self) -> Result<BackupSettings> {
        let vault = self
            .get_setting("vault_path")?
            .unwrap_or_else(|| default_vault_dir().to_string_lossy().into_owned());
        let remote = self.get_setting("remote")?.filter(|s| !s.is_empty());
        let branch = self
            .get_setting("branch")?
            .unwrap_or_else(|| "main".to_string());
        let auto_mode = self
            .get_setting("auto_mode")?
            .map(|v| v == "on" || v == "true")
            .unwrap_or(true);
        let auto_backup = self
            .get_setting("auto_backup")?
            .map(|v| v == "on" || v == "true")
            .unwrap_or(true);
        let interval_minutes: i64 = self
            .get_setting("interval_minutes")?
            .and_then(|v| v.parse().ok())
            .filter(|&m| m >= 1)
            .unwrap_or(60);
        Ok(BackupSettings {
            vault_path: vault,
            remote,
            branch,
            auto_mode,
            auto_backup,
            interval_minutes,
        })
    }

    pub fn set_backup_settings(
        &self,
        vault_path: Option<&str>,
        remote: Option<&str>,
        branch: Option<&str>,
        auto_mode: Option<bool>,
        auto_backup: Option<bool>,
        interval_minutes: Option<i64>,
    ) -> Result<()> {
        if let Some(v) = vault_path {
            self.set_setting("vault_path", v)?;
        }
        if let Some(r) = remote {
            self.set_setting("remote", r)?;
        }
        if let Some(b) = branch {
            if !b.is_empty() {
                self.set_setting("branch", b)?;
            }
        }
        if let Some(a) = auto_mode {
            self.set_setting("auto_mode", if a { "on" } else { "off" })?;
        }
        if let Some(a) = auto_backup {
            self.set_setting("auto_backup", if a { "on" } else { "off" })?;
        }
        if let Some(m) = interval_minutes {
            if m >= 1 {
                self.set_setting("interval_minutes", &m.to_string())?;
            }
        }
        Ok(())
    }

    // ---------- 备份仓级状态（settings 键值存取） ----------

    pub fn get_backup_state(&self) -> Result<BackupState> {
        Ok(BackupState {
            last_backup: self.get_setting("bk_last_backup")?,
            push_status: self.get_setting("bk_push_status")?,
            last_commit: self.get_setting("bk_last_commit")?,
            last_error: self.get_setting("bk_last_error")?,
        })
    }

    pub fn set_backup_state(&self, state: &BackupState) -> Result<()> {
        if let Some(v) = &state.last_backup {
            self.set_setting("bk_last_backup", v)?;
        }
        if let Some(v) = &state.push_status {
            self.set_setting("bk_push_status", v)?;
        }
        match &state.last_commit {
            Some(v) => self.set_setting("bk_last_commit", v)?,
            None => self.set_setting("bk_last_commit", "")?,
        }
        match &state.last_error {
            Some(v) => self.set_setting("bk_last_error", v)?,
            None => self.set_setting("bk_last_error", "")?,
        }
        Ok(())
    }

    // ---------- 近期动态 ----------

    pub fn record_event(&self, kind: &str, message: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO events (kind, message) VALUES (?1, ?2)",
            params![kind, message],
        )?;
        // 只保留最近 50 条
        conn.execute(
            "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 50)",
            [],
        )?;
        Ok(())
    }

    pub fn recent_events(&self, limit: i64) -> Result<Vec<EventRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT ts, kind, message FROM events ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(EventRecord {
                ts: row.get(0)?,
                kind: row.get(1)?,
                message: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ---------- projects ----------

    pub fn list_projects(&self) -> Result<Vec<ProjectRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, repo_path, enabled, include_json, exclude_json, manage_git_exclude
             FROM projects ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                repo_path: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                include_json: row.get(4)?,
                exclude_json: row.get(5)?,
                manage_git_exclude: row.get::<_, i64>(6)? != 0,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// 校验并注册项目。返回错误字符串（供 Tauri command 直接展示）。
    pub fn add_project(
        &self,
        name: &str,
        repo_path: &str,
        include_json: Option<&str>,
        exclude_json: Option<&str>,
        manage_git_exclude: bool,
    ) -> std::result::Result<i64, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("项目名不能为空".into());
        }
        if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
            || name == "."
            || name == ".."
        {
            return Err("项目名不能包含路径分隔符或特殊字符".into());
        }
        let repo = PathBuf::from(repo_path.trim());
        if !repo.is_dir() {
            return Err(format!("项目路径不存在：{}", repo.display()));
        }
        let include = include_json.unwrap_or(DEFAULT_INCLUDE_JSON);
        let exclude = exclude_json.unwrap_or(DEFAULT_EXCLUDE_JSON);
        validate_include_entries(&repo, include).map_err(|e| e.to_string())?;

        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE name = ?1 OR repo_path = ?2",
                params![name, repo.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists > 0 {
            return Err("同名项目或同路径项目已注册".into());
        }
        conn.execute(
            "INSERT INTO projects (name, repo_path, enabled, include_json, exclude_json, manage_git_exclude)
             VALUES (?1, ?2, 1, ?3, ?4, ?5)",
            params![
                name,
                repo.to_string_lossy(),
                include,
                exclude,
                manage_git_exclude as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn remove_project(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sync_state WHERE project_id = ?1", params![id])?;
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_project_enabled(&self, id: i64, enabled: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET enabled = ?2, updated_at = datetime('now','localtime') WHERE id = ?1",
            params![id, enabled as i64],
        )?;
        Ok(())
    }

    /// 更新项目的同步清单（校验后写入）。
    pub fn set_project_include(&self, id: i64, include_json: &str) -> Result<()> {
        let repo_path: String = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT repo_path FROM projects WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )?
        };
        validate_include_entries(&PathBuf::from(&repo_path), include_json).map_err(anyhow::Error::msg)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET include_json = ?2, updated_at = datetime('now','localtime') WHERE id = ?1",
            params![id, include_json],
        )?;
        Ok(())
    }

    // ---------- sync state ----------

    pub fn get_state(&self, project_id: i64) -> Result<SyncStateRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT project_id, last_sync, added, deleted, last_commit, push_status, last_error
             FROM sync_state WHERE project_id = ?1",
        )?;
        let mut rows = stmt.query_map(params![project_id], |row| {
            Ok(SyncStateRecord {
                project_id: row.get(0)?,
                last_sync: row.get(1)?,
                added: row.get(2)?,
                deleted: row.get(3)?,
                last_commit: row.get(4)?,
                push_status: row.get(5)?,
                last_error: row.get(6)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(row?),
            None => Ok(SyncStateRecord {
                project_id,
                ..Default::default()
            }),
        }
    }

    pub fn upsert_state(&self, state: &SyncStateRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_state (project_id, last_sync, added, deleted, last_commit, push_status, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_id) DO UPDATE SET
               last_sync = excluded.last_sync,
               added = excluded.added,
               deleted = excluded.deleted,
               last_commit = excluded.last_commit,
               push_status = excluded.push_status,
               last_error = excluded.last_error",
            params![
                state.project_id,
                state.last_sync,
                state.added,
                state.deleted,
                state.last_commit,
                state.push_status,
                state.last_error
            ],
        )?;
        Ok(())
    }
}

/// SafetyGate：include 条目必须是 repo 之下的相对路径，拒绝绝对路径与 `..` 逃逸。
/// 不要求条目当前存在——项目里暂缺的条目在同步时自动跳过（中央仓留存历史快照）。
fn validate_include_entries(repo: &PathBuf, include_json: &str) -> Result<(), String> {
    let _ = repo;
    let entries: Vec<String> = serde_json::from_str(include_json)
        .map_err(|e| format!("include 清单不是合法 JSON 数组：{e}"))?;
    for entry in &entries {
        if entry.trim().is_empty() {
            return Err("include 条目不能为空".into());
        }
        let p = std::path::Path::new(entry);
        if p.is_absolute() {
            return Err(format!("include 条目不允许绝对路径：{entry}"));
        }
        for comp in p.components() {
            if matches!(comp, std::path::Component::ParentDir) {
                return Err(format!("include 条目不允许 .. 逃逸：{entry}"));
            }
        }
    }
    Ok(())
}
