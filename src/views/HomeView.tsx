import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { XCircle, CheckCircle2 } from "lucide-react";

interface BackupSettings {
  vault_path: string;
  remote: string | null;
  branch: string;
  auto_mode: boolean;
  auto_backup: boolean;
  interval_minutes: number;
}

interface ProjectRecord {
  id: number;
  name: string;
  enabled: boolean;
}

interface EventRecord {
  ts: string;
  kind: string;
  message: string;
}

/** 近期动态行文案的颜色/图标语义 */
function eventStyle(kind: string) {
  if (kind === "sync_failed" || kind === "backup_failed") {
    return { icon: <XCircle size={14} className="text-[var(--color-danger)]" />, danger: true };
  }
  if (kind === "backup_ok" || kind === "sync_ok") {
    return { icon: <CheckCircle2 size={14} className="text-[var(--color-accent)]" />, danger: false };
  }
  return { icon: <CheckCircle2 size={14} className="text-[var(--color-text-muted)]" />, danger: false };
}

export function HomeView() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [roundDiff, setRoundDiff] = useState<string>("—");

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<ProjectRecord[]>("docs_list_projects");
      setProjects(list);
      const evs = await invoke<EventRecord[]>("docs_recent_events");
      setEvents(evs);
      // 最近一轮同步：取任意项目最近一次成功同步的时间与变更
      let latest: string | null = null;
      let added = 0;
      let deleted = 0;
      for (const p of list) {
        const st = await invoke<{
          last_sync: string | null;
          added: number;
          deleted: number;
          push_status: string | null;
        }>("docs_get_state", { projectId: p.id });
        if (st.last_sync && (!latest || st.last_sync > latest)) {
          latest = st.last_sync;
          added = st.added;
          deleted = st.deleted;
        }
      }
      setLastSync(latest);
      setRoundDiff(latest ? `+${added} / -${deleted}` : "—");
    } catch {
      /* 静默：首页统计失败不阻塞 */
    }
  }, []);

  useEffect(() => {
    refresh();
    invoke<BackupSettings>("docs_get_settings").then(setSettings).catch(() => {});
    const unlisten = listen("docs-sync-done", () => refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const enabled = projects.filter((p) => p.enabled).length;
  const backupLabel = settings?.remote ? "已配置远端" : "未配置远端";

  return (
    <div className="app-page app-page-narrow">
      <div className="app-page-header">
        <h1 className="app-page-title">首页</h1>
        <p className="app-page-subtitle">
          {projects.length} 个项目 · {enabled} 启用
          {lastSync ? ` · 上次同步 ${lastSync}` : ""}
          {settings ? ` · 备份目标 ${settings.vault_path}` : ""}
        </p>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="app-panel flex items-center justify-between px-4 py-4 transition-colors hover:border-border">
          <div>
            <p className="app-section-title mb-1">项目</p>
            <h3 className="text-[17px] font-semibold leading-none text-[var(--color-text-primary)]">
              {projects.length}
              <span className="ml-1.5 text-[12px] font-normal text-[var(--color-text-muted)]">
                个 · {enabled} 启用
              </span>
            </h3>
          </div>
          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-accent-bg)] p-2 text-[var(--color-accent-light)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
          </div>
        </div>
        <div className="app-panel flex items-center justify-between px-4 py-4 transition-colors hover:border-border">
          <div>
            <p className="app-section-title mb-1">最近一轮同步</p>
            <h3 className="text-[17px] font-semibold leading-none text-[var(--color-text-primary)]">
              {roundDiff}
            </h3>
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{lastSync ?? "—"}</p>
          </div>
          <div className="rounded-md border border-[var(--color-border-subtle)] bg-sky-500/[0.08] p-2 text-sky-500">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
          </div>
        </div>
        <div
          className="app-panel flex cursor-pointer items-center justify-between px-4 py-4 transition-colors hover:border-border"
          onClick={() => navigate("/backup")}
        >
          <div>
            <p className="app-section-title mb-1">远端备份</p>
            <h3 className="text-[17px] font-semibold leading-none text-[var(--color-text-primary)]">
              {backupLabel}
            </h3>
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
              {settings?.remote ?? "备份 = 备份目录 → 远端 git"}
            </p>
          </div>
          <div className="rounded-md border border-[var(--color-border-subtle)] bg-amber-500/[0.08] p-2 text-amber-500">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
          </div>
        </div>
      </div>

      {/* 近期动态 */}
      <div>
        <h2 className="app-section-title mb-2.5">近期动态</h2>
        <div className="app-panel overflow-hidden">
          {events.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] py-8 text-center text-[13px] text-[var(--color-text-muted)]">
              暂无动态。同步或备份后这里会显示最近 20 条记录。
            </div>
          ) : (
            events.map((e, i) => {
              const st = eventStyle(e.kind);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--color-surface-hover)]"
                >
                  <span
                    className={`flex min-w-0 items-center gap-2 text-[13px] ${
                      st.danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-secondary)]"
                    }`}
                  >
                    {st.icon}
                    <span className="truncate">{e.message}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-[var(--color-text-faint)]">{e.ts}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
