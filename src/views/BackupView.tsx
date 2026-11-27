import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Cloud, History, Link2, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { ToggleSwitch } from "../components/ToggleSwitch";

interface BackupStatus {
  is_repo: boolean;
  remote: string | null;
  branch: string;
  last_backup: string | null;
  push_status: string | null;
  last_commit: string | null;
  last_error: string | null;
  size_bytes: number;
  version_count: number;
}

interface VersionRecord {
  sha: string;
  message: string;
  author: string;
  time: string;
}

const fmtBytes = (n: number) => {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const fmtTime = (iso: string | null) => {
  if (!iso) return "—";
  // git %ci 形如 2026-11-27 16:48:33 +0800 → 取到分钟
  const m = iso.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  return m ? m[1] : iso;
};

export function BackupView() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [versions, setVersions] = useState<VersionRecord[]>([]);
  const [remoteInput, setRemoteInput] = useState("");
  const [projectCount, setProjectCount] = useState(0);
  const [autoBackupOn, setAutoBackupOn] = useState(true);
  const [vaultPath, setVaultPath] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<BackupStatus>("docs_get_backup_status");
      setStatus(s);
      setRemoteInput(s.remote ?? "");
      setVersions(await invoke<VersionRecord[]>("docs_list_versions"));
      const settings = await invoke<{ auto_backup: boolean; vault_path: string }>("docs_get_settings");
      setAutoBackupOn(settings.auto_backup);
      setVaultPath(settings.vault_path);
      setProjectCount((await invoke<{ id: number }[]>("docs_list_projects")).length);
    } catch (e) {
      toast.error(`加载备份状态失败：${e}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = listen("docs-sync-done", () => refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const connected = !!status?.remote;

  const connectRemote = async () => {
    const v = remoteInput.trim();
    if (!v) {
      toast.error("请先填写远端地址");
      return;
    }
    setBusy(true);
    try {
      await invoke("docs_set_settings", { remote: v });
      toast.success("远端已保存，下一轮同步完成后自动备份");
      await refresh();
    } catch (e) {
      toast.error(`保存失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnectRemote = async () => {
    if (!confirm("断开远端后不再自动备份到 git，本地备份仓与历史保留。确认断开？")) return;
    setBusy(true);
    try {
      await invoke("docs_set_settings", { remote: "" });
      toast.success("已断开远端");
      await refresh();
    } catch (e) {
      toast.error(`操作失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await invoke<{ committed: boolean; pushed: boolean; sha: string | null }>(
        "docs_backup_now"
      );
      toast.success(
        r.committed
          ? `备份完成：commit ${r.sha ?? ""}${r.pushed ? "，已推送远端" : ""}`
          : r.pushed
            ? "备份仓无新变更，已补推远端"
            : "备份仓无变更"
      );
      await refresh();
    } catch (e) {
      toast.error(`备份失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (sha: string) => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: `选择导出目录（版本 ${sha} 将作为副本恢复到此处）`,
    });
    if (typeof picked !== "string" || !picked) return;
    try {
      await invoke("docs_restore_version", { sha, targetDir: picked });
      toast.success(`版本 ${sha} 已导出到 ${picked}`);
    } catch (e) {
      toast.error(`恢复失败：${e}`);
    }
  };

  const pushBadge = () => {
    if (!connected) return <span className="app-badge">未配置远端</span>;
    if (status?.push_status === "pushed")
      return <span className="app-badge border-[var(--color-accent-border)] text-[var(--color-accent)]">✔ 已推送</span>;
    if (status?.push_status === "failed")
      return <span className="app-badge border-red-500/30 text-red-500">✕ 推送失败</span>;
    return <span className="app-badge">仅本地 commit</span>;
  };

  return (
    <div className="app-page">
      <div className="app-page-header flex items-center justify-between gap-3">
        <div>
          <h1 className="app-page-title">备份</h1>
          <p className="app-page-subtitle">
            备份 = 备份目录 → 远端 git 仓库（整个备份仓每轮合并为 1 个 commit，全项目同一备份时间）。同步操作在
            <button className="text-[var(--color-accent)] hover:underline" onClick={() => navigate("/center")}>
              备份中心
            </button>
            。
          </p>
        </div>
        <button
          onClick={refresh}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] font-medium text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)]"
        >
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* 主列 */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* 备份状态 */}
          <section className="app-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Cloud size={16} className="text-[var(--color-text-muted)]" />
                  <h2 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">备份状态</h2>
                  {pushBadge()}
                </div>
                <div className="mt-3 grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  <span className="text-[var(--color-text-muted)]">备份目录</span>
                  <span className="truncate font-mono text-[12px] text-[var(--color-text-secondary)]" title={vaultPath}>
                    {vaultPath || "—"}
                  </span>
                  <span className="text-[var(--color-text-muted)]">模式</span>
                  <span className="text-[var(--color-text-secondary)]">
                    {connected ? "git 仓库 + 远端" : "本地文件夹（只同步，不推远端）"}
                  </span>
                  <span className="text-[var(--color-text-muted)]">分支</span>
                  <span className="text-[var(--color-text-secondary)]">{connected ? status?.branch : "—"}</span>
                  <span className="text-[var(--color-text-muted)]">上次备份</span>
                  <span className="text-[var(--color-text-secondary)]">{fmtTime(status?.last_backup ?? null)}</span>
                  <span className="text-[var(--color-text-muted)]">推送结果</span>
                  <span className="text-[var(--color-text-secondary)]">
                    {status?.last_error
                      ? status.last_error
                      : status?.push_status === "pushed"
                        ? "已推送"
                        : status?.push_status === "local"
                          ? "未配置远端，仅本地 commit"
                          : "—"}
                  </span>
                </div>
                {!connected && (
                  <p className="mt-3 text-[12px] leading-[18px] text-[var(--color-text-muted)]">
                    当前备份目录是普通文件夹。在下方填入 git 远端后，每轮同步完成会自动把整个备份仓 commit + push
                    到远端；也可以点"立即备份"手动触发。
                  </p>
                )}
              </div>
              <button
                onClick={backupNow}
                disabled={busy}
                className="app-button-primary h-10 shrink-0 self-start px-4 py-0"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Cloud size={15} />}
                立即备份
              </button>
            </div>
          </section>

          {/* 连接远端 */}
          <section className="app-panel p-4">
            <div className="flex items-center gap-2">
              <Link2 size={16} className="text-[var(--color-text-muted)]" />
              <h2 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">连接远端仓库</h2>
            </div>
            <p className="mb-3 mt-2 text-[13px] leading-5 text-[var(--color-text-muted)]">
              填入 git 远端地址（如 GitHub 私有仓库），保存后自动启用云端备份。认证复用系统 git
              凭证（已配置的 SSH / 凭证管理器），无需在应用内填写账号密码。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                placeholder="git@github.com:Is-Ming/docs-vault.git"
                className="app-input h-8 min-w-0 flex-1 font-mono text-[13px]"
                spellCheck={false}
              />
              <button
                onClick={connectRemote}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2.5 text-[13px] font-medium text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-active)] disabled:opacity-50"
              >
                保存
              </button>
              {connected && (
                <button
                  onClick={disconnectRemote}
                  disabled={busy}
                  className="inline-flex h-8 items-center rounded-lg border border-[var(--color-danger)] px-2.5 text-[13px] font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] disabled:opacity-50"
                >
                  断开远端
                </button>
              )}
            </div>
          </section>

          {/* 备份历史 */}
          <section className="app-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <History size={16} className="text-[var(--color-text-muted)]" />
                <h2 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">备份历史</h2>
              </div>
              <button
                onClick={refresh}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
              >
                <RefreshCw size={12} /> 刷新
              </button>
            </div>
            {versions.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                {connected
                  ? "还没有备份版本。点\"立即备份\"或等下一轮同步完成后自动生成。"
                  : "未连接远端，暂无备份历史。连接远端后，这里按时间列出每次备份（整个备份仓一个 commit）。"}
              </div>
            ) : (
              <div className="max-h-[360px] space-y-1.5 overflow-auto pr-1">
                {versions.map((v) => (
                  <div
                    key={v.sha}
                    className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-[var(--color-text-secondary)]">
                        {fmtTime(v.time)}
                      </div>
                      <div className="truncate text-[12px] text-[var(--color-text-muted)]">{v.message}</div>
                      <div className="truncate text-[11px] text-[var(--color-text-faint)]">
                        {v.author ? `${v.author} · ` : ""}
                        {v.sha} · {v.time}
                      </div>
                    </div>
                    <button
                      onClick={() => restoreVersion(v.sha)}
                      className="shrink-0 rounded-lg border border-[var(--color-border-subtle)] px-2 py-1 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                    >
                      恢复此版本
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 侧栏 */}
        <div className="flex flex-col gap-4">
          <section className="app-panel p-4">
            <div className="flex items-center gap-2">
              <Settings2 size={16} className="text-[var(--color-text-muted)]" />
              <h2 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">自动备份</h2>
            </div>
            <p className="mb-3 mt-2 text-[12px] leading-5 text-[var(--color-text-muted)]">
              每轮同步完成后自动把备份仓 commit + push 到远端。与"自动同步"相互独立，可单独关闭（只同步不备份）。
            </p>
            <div className="flex items-center justify-between">
              <span className="text-[13px]">同步后自动备份</span>
              <ToggleSwitch
                checked={!!status && autoBackupOn}
                onChange={async () => {
                  try {
                    await invoke("docs_set_settings", { autoBackup: !autoBackupOn });
                    toast.success(!autoBackupOn ? "已开启自动备份" : "已关闭自动备份");
                    await refresh();
                  } catch (err) {
                    toast.error(`操作失败：${err}`);
                  }
                }}
                title="同步后自动备份"
              />
            </div>
          </section>

          <section className="app-panel p-4">
            <h2 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">摘要</h2>
            <div className="mt-3 grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <span className="text-[var(--color-text-muted)]">项目</span>
              <span className="text-[var(--color-text-secondary)]">{projectCount} 个</span>
              <span className="text-[var(--color-text-muted)]">备份版本</span>
              <span className="text-[var(--color-text-secondary)]">
                {status && status.version_count > 0 ? `${status.version_count} 个 commit` : "—"}
              </span>
              <span className="text-[var(--color-text-muted)]">备份仓大小</span>
              <span className="text-[var(--color-text-secondary)]">
                {status ? fmtBytes(status.size_bytes) : "—"}
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
