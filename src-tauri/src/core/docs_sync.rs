//! docs-backup-manager 同步引擎与批次 git 备份。
//!
//! 流程：项目目录 → robocopy /MIR → 中央目标 backup/<项目>/ →（git 模式）
//! 批次 commit → push。同步只写 `backup/<项目>/`；中央目标根目录 README.md
//! 由本引擎（软件自身）维护，属于设计文档 §1.1 的显式例外。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use super::docs_store::{BackupSettings, DocsStore, ProjectRecord, SyncStateRecord};

/// robocopy 退出码 0–7 为成功（bit0 有复制、bit1 有 extras 删除等），≥8 为失败。
fn robocopy_ok(code: Option<i32>) -> bool {
    matches!(code, Some(c) if (0..=7).contains(&c))
}

/// 解析 robocopy 摘要行（"Files:" 与 "Dirs:" 行），列依次为
/// Total / Copied / Skipped / Mismatch / FAILED / Extras。
fn parse_summary(output: &str) -> (i64, i64) {
    let mut copied_files = 0i64;
    let mut extras_files = 0i64;
    for line in output.lines() {
        let trimmed = line.trim();
        let numbers: Vec<i64> = trimmed
            .split(|c: char| !c.is_ascii_digit() && c != '-')
            .filter(|s| !s.is_empty() && s.parse::<i64>().is_ok())
            .filter_map(|s| s.parse().ok())
            .collect();
        if numbers.len() < 6 {
            continue;
        }
        // 复制的文件数 = Files 行的 Copied 列；/MIR 下被删除的文件计入 Extras 列
        if trimmed.starts_with("Files:") || trimmed.starts_with("Files :") {
            copied_files = numbers[1];
            extras_files = numbers[5];
        }
    }
    (copied_files, extras_files)
}

/// 同步单个项目到中央目标。返回（复制数、删除数）。
fn robocopy_mirror(src: &Path, dst: &Path) -> Result<(i64, i64)> {
    let output = Command::new("robocopy")
        .arg(src)
        .arg(dst)
        .args(["/MIR", "/R:1", "/W:1", "/NFL", "/NDL", "/NP", "/UTF8"])
        .output()
        .map_err(|e| anyhow!("robocopy 启动失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !robocopy_ok(output.status.code()) {
        return Err(anyhow!(
            "robocopy 失败（exit {}）：{}",
            output.status.code().unwrap_or(-1),
            stdout.lines().rev().take(15).collect::<Vec<_>>().join("\n")
        ));
    }
    Ok(parse_summary(&stdout))
}

/// 单个 include 条目的落点：目录镜像到 `<vault>/backup/<项目>/<同名目录>`；
/// 单文件复制到 `<vault>/backup/<项目>/<文件名>`。
fn target_for_entry(project_dir: &Path, entry: &str) -> PathBuf {
    let p = Path::new(entry);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| entry.trim_end_matches(['/', '\\']).to_string());
    project_dir.join(name)
}

fn run_git(vault: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(vault)
        .output()
        .map_err(|e| anyhow!("git 启动失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        return Err(anyhow!(
            "git {} 失败：{}{}",
            args.join(" "),
            stdout,
            stderr
        ));
    }
    Ok(stdout)
}

/// 批次结果统计。
#[derive(Debug, Default, serde::Serialize)]
pub struct BatchResult {
    pub synced: usize,
    pub skipped: usize,
    pub failed: usize,
    pub added: i64,
    pub deleted: i64,
    pub committed: bool,
    pub pushed: bool,
    pub errors: Vec<String>,
}

/// 执行一轮同步：逐项目 robocopy，成功项目写入状态；全部完成后（git 模式）
/// 合并为 1 个批次 commit 并 push；更新中央目标 README.md 索引。
pub fn run_batch(store: &DocsStore) -> BatchResult {
    let mut result = BatchResult::default();

    let settings = match store.get_backup_settings() {
        Ok(s) => s,
        Err(e) => {
            result.errors.push(format!("读取设置失败：{e:#}"));
            return result;
        }
    };
    let vault = PathBuf::from(&settings.vault_path);
    if let Err(e) = std::fs::create_dir_all(vault.join("backup")) {
        result.errors.push(format!("创建备份目录失败：{e}"));
        return result;
    }

    let projects = match store.list_projects() {
        Ok(p) => p,
        Err(e) => {
            result.errors.push(format!("读取项目列表失败：{e:#}"));
            return result;
        }
    };

    let mut project_states: HashMap<String, (i64, i64)> = HashMap::new(); // name -> (added, deleted)
    for project in &projects {
        if !project.enabled {
            result.skipped += 1;
            continue;
        }
        match sync_one_project(&vault, project) {
            Ok((added, deleted)) => {
                result.synced += 1;
                result.added += added;
                result.deleted += deleted;
                project_states.insert(project.name.clone(), (added, deleted));
                let _ = store.upsert_state(&SyncStateRecord {
                    project_id: project.id,
                    last_sync: Some(now_string()),
                    added,
                    deleted,
                    push_status: Some("synced".into()),
                    ..Default::default()
                });
            }
            Err(e) => {
                result.failed += 1;
                result.errors.push(format!("{}：{e}", project.name));
                let _ = store.upsert_state(&SyncStateRecord {
                    project_id: project.id,
                    last_sync: Some(now_string()),
                    push_status: Some("failed".into()),
                    last_error: Some(format!("{e:#}")),
                    ..Default::default()
                });
            }
        }
    }

    // git 模式：中央目标存在 .git 时做批次 commit + push
    let git_mode = vault.join(".git").exists();
    if git_mode {
        match batch_git_backup(&vault, &settings, &projects, &project_states, &mut result) {
            Ok((committed, pushed, commit_sha)) => {
                result.committed = committed;
                result.pushed = pushed;
                if committed {
                    for project in &projects {
                        if project_states.contains_key(&project.name) {
                            let mut state = store
                                .get_state(project.id)
                                .unwrap_or_else(|_| SyncStateRecord {
                                    project_id: project.id,
                                    ..Default::default()
                                });
                            state.push_status = if pushed { Some("ok".into()) } else { Some("failed".into()) };
                            state.last_commit = commit_sha.clone();
                            if !pushed {
                                state.last_error = Some("push 失败，下次同步自动补推".into());
                            } else {
                                state.last_error = None;
                            }
                            let _ = store.upsert_state(&state);
                        }
                    }
                }
            }
            Err(e) => {
                result.errors.push(format!("git 备份失败：{e:#}"));
            }
        }
    }

    // 软件自身维护 README.md 索引（§1.1 显式例外）
    let _ = write_vault_readme(&vault, &settings, &projects, &project_states);

    result
}

/// 注册后的首次同步：只同步该项目本身，git 批次由下一轮统一收口。
pub fn run_batch_first_time(vault: &Path, project: &ProjectRecord) -> Result<(i64, i64)> {
    std::fs::create_dir_all(vault.join("backup"))?;
    sync_one_project(vault, project)
}

fn sync_one_project(vault: &Path, project: &ProjectRecord) -> Result<(i64, i64)> {
    let repo = PathBuf::from(&project.repo_path);
    if !repo.is_dir() {
        return Err(anyhow!("项目路径不存在：{}", repo.display()));
    }
    let entries: Vec<String> = serde_json::from_str(&project.include_json)
        .unwrap_or_else(|_| serde_json::from_str(super::docs_store::DEFAULT_INCLUDE_JSON).unwrap());
    let project_dir = vault.join("backup").join(&project.name);
    std::fs::create_dir_all(&project_dir)?;

    let mut added = 0i64;
    let mut deleted = 0i64;
    for entry in &entries {
        let src = repo.join(entry);
        if !src.exists() {
            continue; // 条目在项目中被删除：中央仓留存历史快照，不自动删除（§3.4）
        }
        let dst = target_for_entry(&project_dir, entry);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let (a, d) = robocopy_mirror(&src, &dst)
            .with_context(|| format!("同步 {} → {}", src.display(), dst.display()))?;
        added += a;
        deleted += d;
    }
    Ok((added, deleted))
}

/// git 批次备份：add → 判空 → commit（1 个批次）→ push（配置了 remote 才推）。
fn batch_git_backup(
    vault: &Path,
    settings: &BackupSettings,
    projects: &[ProjectRecord],
    project_states: &HashMap<String, (i64, i64)>,
    result: &mut BatchResult,
) -> Result<(bool, bool, Option<String>)> {
    run_git(vault, &["add", "-A"])?;
    // diff --cached --quiet：exit 0 = 无差异，exit 1 = 有差异
    let diff = Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(vault)
        .output()?;
    if diff.status.code() == Some(0) {
        return Ok((false, false, None));
    }
    let failed = projects
        .iter()
        .filter(|p| !project_states.contains_key(&p.name))
        .count();
    let message = format!(
        "backup: all-projects {} ({} projects, +{}/-{}, {} failed)",
        now_string_short(),
        project_states.len(),
        result.added,
        result.deleted,
        failed
    );
    run_git(vault, &["commit", "-m", &message])?;

    let has_remote = run_git(vault, &["remote"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_remote || settings.remote.is_none() {
        return Ok((true, false, None)); // 本地 git 仓：commit 即备份完成
    }
    let branch = &settings.branch;
    match run_git(vault, &["push", "origin", branch]) {
        Ok(_) => {
            let sha = run_git(vault, &["rev-parse", "--short", "HEAD"])
                .ok()
                .map(|s| s.trim().to_string());
            Ok((true, true, sha))
        }
        Err(e) => {
            result.errors.push(format!("push 失败（下次自动补推）：{e:#}"));
            let sha = run_git(vault, &["rev-parse", "--short", "HEAD"])
                .ok()
                .map(|s| s.trim().to_string());
            Ok((true, false, sha))
        }
    }
}

/// 更新中央目标根目录 README.md：项目索引 + 最后同步时间。
fn write_vault_readme(
    vault: &Path,
    settings: &BackupSettings,
    projects: &[ProjectRecord],
    project_states: &HashMap<String, (i64, i64)>,
) -> Result<()> {
    let mut content = String::from("# docs-backup-manager 备份索引\n\n");
    content.push_str("> 本文件由 docs-backup-manager 自动维护（软件自身路径，非同步落点）。\n\n");
    content.push_str(&format!(
        "- 备份目标：`{}`\n- 远端：{}\n- 生成时间：{}\n\n",
        vault.display(),
        settings.remote.as_deref().unwrap_or("（未配置，纯本地备份）"),
        now_string()
    ));
    content.push_str("| 项目 | 状态 | 变更(+/-) | 落点 |\n|---|---|---|---|\n");
    for p in projects {
        let status = if p.enabled { "启用" } else { "停用" };
        let diff = project_states
            .get(&p.name)
            .map(|(a, d)| format!("+{a}/-{d}"))
            .unwrap_or_else(|| "本轮无变更".into());
        content.push_str(&format!(
            "| {} | {} | {} | `backup/{}/` |\n",
            p.name, status, diff, p.name
        ));
    }
    std::fs::write(vault.join("README.md"), content)?;
    Ok(())
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn now_string_short() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// 后台调度：按设置间隔自动同步（auto_mode=on 时）。独立线程循环。
pub fn start_scheduler(store: std::sync::Arc<DocsStore>) {
    std::thread::spawn(move || {
        // 记录上次运行时间（分钟精度单调累计即可）
        let mut last_run_minute: u64 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let Ok(settings) = store.get_backup_settings() else {
                continue;
            };
            if !settings.auto_mode {
                continue;
            }
            let minute = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() / 60)
                .unwrap_or(0);
            let interval = (settings.interval_minutes.max(1) as u64).min(60 * 24 * 7);
            if minute.saturating_sub(last_run_minute) >= interval {
                last_run_minute = minute;
                log::info!("docs-backup: auto sync round start");
                let result = run_batch(&store);
                log::info!(
                    "docs-backup: auto sync round done (synced={}, failed={}, committed={}, pushed={})",
                    result.synced,
                    result.failed,
                    result.committed,
                    result.pushed
                );
                for err in &result.errors {
                    log::warn!("docs-backup: {err}");
                }
            }
        }
    });
}
