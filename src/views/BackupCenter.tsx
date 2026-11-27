import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  CloudUpload,
  FolderOpen,
  Plus,
  Trash2,
  Power,
  Settings2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";

interface ProjectRecord {
  id: number;
  name: string;
  repo_path: string;
  enabled: boolean;
  include_json: string;
  exclude_json: string;
  manage_git_exclude: boolean;
}

interface SyncStateRecord {
  project_id: number;
  last_sync: string | null;
  added: number;
  deleted: number;
  last_commit: string | null;
  push_status: string | null;
  last_error: string | null;
}

interface BackupSettings {
  vault_path: string;
  remote: string | null;
  branch: string;
  auto_mode: boolean;
  interval_minutes: number;
}

interface BatchResult {
  synced: number;
  skipped: number;
  failed: number;
  added: number;
  deleted: number;
  committed: boolean;
  pushed: boolean;
  errors: string[];
}

interface PreviewRow {
  entry: string;
  src: string;
  dst: string;
  srcExists: boolean;
  dstExistingFiles: number;
}

const PRESET_ENTRIES = ["docs/", "openspec/", "AGENTS.md", ".codebuddy/", ".workbuddy/memory/"];

const basenameOf = (p: string) =>
  p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

const emptySettings: BackupSettings = {
  vault_path: "",
  remote: null,
  branch: "main",
  auto_mode: true,
  interval_minutes: 60,
};

export function BackupCenter() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [states, setStates] = useState<Record<number, SyncStateRecord>>({});
  const [settings, setSettings] = useState<BackupSettings>(emptySettings);
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showRemove, setShowRemove] = useState<ProjectRecord | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  // 注册表单
  const [formName, setFormName] = useState("");
  const [formPath, setFormPath] = useState("");
  // 同步清单：常见条目勾选 + 自定义条目
  const [includeEntries, setIncludeEntries] = useState<string[]>(["docs/"]);
  const [customEntry, setCustomEntry] = useState("");

  const toggleEntry = (entry: string) => {
    setIncludeEntries((prev) =>
      prev.includes(entry) ? prev.filter((e) => e !== entry) : [...prev, entry]
    );
  };

  const addCustomEntry = () => {
    const entry = customEntry.trim().replace(/\\/g, "/");
    if (!entry) return;
    if (includeEntries.includes(entry)) {
      toast.warning("该条目已在清单中");
      setCustomEntry("");
      return;
    }
    setIncludeEntries((prev) => [...prev, entry]);
    setCustomEntry("");
  };

  // 设置表单
  const [formVault, setFormVault] = useState("");
  const [formRemote, setFormRemote] = useState("");
  const [formAuto, setFormAuto] = useState(true);
  const [formInterval, setFormInterval] = useState(60);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<ProjectRecord[]>("docs_list_projects");
      setProjects(list);
      const map: Record<number, SyncStateRecord> = {};
      for (const p of list) {
        map[p.id] = await invoke<SyncStateRecord>("docs_get_state", { projectId: p.id });
      }
      setStates(map);
    } catch (e) {
      toast.error(`加载项目失败：${e}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    invoke<BackupSettings>("docs_get_settings").then((s) => {
      setSettings(s);
      setFormVault(s.vault_path);
      setFormRemote(s.remote ?? "");
      setFormAuto(s.auto_mode);
      setFormInterval(s.interval_minutes);
    });
    const unlisten = listen("docs-sync-done", () => refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const result = await invoke<BatchResult>("docs_sync_now");
      if (result.failed === 0 && result.errors.length === 0) {
        toast.success(
          `同步完成：${result.synced} 个项目，+${result.added}/-${result.deleted}` +
            (result.committed ? (result.pushed ? "，已 commit + push" : "，已 commit") : "")
        );
      } else if (result.synced > 0) {
        toast.warning(
          `部分完成：成功 ${result.synced}，失败 ${result.failed}` +
            (result.errors.length ? `：${result.errors[0]}` : "")
        );
      } else {
        toast.error(`同步失败：${result.errors[0] ?? "无项目或无变更"}`);
      }
      refresh();
    } catch (e) {
      toast.error(`同步失败：${e}`);
    } finally {
      setSyncing(false);
    }
  };

  const browsePath = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择项目目录" });
      if (typeof picked === "string" && picked) {
        setFormPath(picked);
        if (!formName.trim()) {
          setFormName(basenameOf(picked));
        }
      }
    } catch (e) {
      toast.error(`打开目录选择器失败：${e}`);
    }
  };

  const openPreview = async () => {
    const path = formPath.trim();
    if (!path) {
      toast.error("请先选择项目路径");
      return;
    }
    const name = formName.trim() || basenameOf(path);
    if (!name) {
      toast.error("请填写项目名与路径");
      return;
    }
    if (includeEntries.length === 0) {
      toast.error("请至少选择一个同步条目");
      return;
    }
    try {
      const res = await invoke<{ rows: PreviewRow[] }>("docs_preview_project", {
        name,
        repoPath: path,
        includeJson: JSON.stringify(includeEntries),
      });
      setPreviewRows(res.rows);
      setShowPreview(true);
    } catch (e) {
      toast.error(`预览失败：${e}`);
    }
  };

  const handleAdd = async () => {
    const path = formPath.trim();
    if (!path) {
      toast.error("请先选择项目路径");
      return;
    }
    const name = formName.trim() || basenameOf(path);
    if (!name) {
      toast.error("请填写项目名");
      return;
    }
    if (includeEntries.length === 0) {
      toast.error("请至少选择一个同步条目");
      return;
    }
    try {
      await invoke("docs_add_project", {
        name,
        repoPath: path,
        includeJson: JSON.stringify(includeEntries),
      });
      toast.success("项目已注册并完成首次同步");
      setShowAdd(false);
      setFormName("");
      setFormPath("");
      setIncludeEntries(["docs/"]);
      setCustomEntry("");
      refresh();
    } catch (e) {
      toast.error(`注册失败：${e}`);
    }
  };

  const handleRemove = async () => {
    if (!showRemove) return;
    try {
      await invoke("docs_remove_project", { id: showRemove.id });
      toast.success(`已移除 ${showRemove.name}（备份仓历史快照保留）`);
      setShowRemove(null);
      refresh();
    } catch (e) {
      toast.error(`移除失败：${e}`);
    }
  };

  const handleToggle = async (p: ProjectRecord) => {
    try {
      await invoke("docs_set_project_enabled", { id: p.id, enabled: !p.enabled });
      refresh();
    } catch (e) {
      toast.error(`操作失败：${e}`);
    }
  };

  const handleSaveSettings = async () => {
    try {
      await invoke("docs_set_settings", {
        vaultPath: formVault.trim() || undefined,
        remote: formRemote.trim() || null,
        autoMode: formAuto,
        intervalMinutes: formInterval,
      });
      const s = await invoke<BackupSettings>("docs_get_settings");
      setSettings(s);
      setShowSettings(false);
      toast.success("设置已保存");
    } catch (e) {
      toast.error(`保存失败：${e}`);
    }
  };

  const statusBadge = (p: ProjectRecord) => {
    const st = states[p.id];
    if (!st || !st.push_status) return null;
    if (st.push_status === "failed") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-500">
          <XCircle size={12} /> 失败
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">
        <CheckCircle2 size={12} /> 正常
      </span>
    );
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">文档备份中心</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            备份目标：{settings.vault_path || "未配置"}
            {settings.remote ? ` · 远端 ${settings.remote}` : " · 纯本地备份"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
          >
            <Settings2 size={15} /> 设置
          </button>
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {syncing ? <Loader2 size={15} className="animate-spin" /> : <CloudUpload size={15} />}
            {syncing ? "同步中…" : "立即同步"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
          >
            <Plus size={15} /> 注册项目
          </button>
        </div>
      </div>

      {/* 调度状态条 */}
      <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm text-[var(--color-text-secondary)]">
        <Clock size={14} />
        自动备份：{settings.auto_mode ? "开启" : "关闭"} · 间隔 {settings.interval_minutes} 分钟
      </div>

      {/* 项目卡片 */}
      {projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] py-16 text-[var(--color-text-secondary)]">
          <CloudUpload size={36} className="opacity-40" />
          <p>还没有注册任何项目</p>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500"
          >
            <Plus size={15} /> 注册第一个项目
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const st = states[p.id];
            return (
              <div
                key={p.id}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-medium text-[var(--color-text-primary)]">{p.name}</h3>
                      {statusBadge(p)}
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--color-text-secondary)]">{p.repo_path}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => handleToggle(p)}
                      title={p.enabled ? "停用" : "启用"}
                      className="rounded-md p-1.5 hover:bg-[var(--color-surface-hover)]"
                    >
                      <Power size={14} className={p.enabled ? "text-emerald-500" : "text-[var(--color-text-secondary)]"} />
                    </button>
                    <button
                      onClick={() => setShowRemove(p)}
                      title="移除"
                      className="rounded-md p-1.5 hover:bg-[var(--color-surface-hover)]"
                    >
                      <Trash2 size={14} className="text-red-400" />
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--color-text-secondary)]">
                  <span>上次同步：{st?.last_sync ?? "—"}</span>
                  <span>
                    变更：{st ? `+${st.added}/-${st.deleted}` : "—"}
                  </span>
                  <span>commit：{st?.last_commit ?? "—"}</span>
                  <span>push：{st?.push_status ?? "—"}</span>
                </div>
                {st?.last_error && (
                  <p className="mt-2 line-clamp-2 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500">
                    {st.last_error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 注册对话框 */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[560px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="text-lg font-semibold">注册项目</h2>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="text-[var(--color-text-secondary)]">项目路径</span>
                <div className="mt-1 flex gap-2">
                  <input
                    value={formPath}
                    onChange={(e) => setFormPath(e.target.value)}
                    placeholder="例如 D:\github\docs-backup-manager"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={browsePath}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
                  >
                    <FolderOpen size={14} /> 浏览
                  </button>
                </div>
              </label>
              <label className="block text-sm">
                <span className="text-[var(--color-text-secondary)]">项目名（备份落点子目录名，留空自动取文件夹名）</span>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={formPath.trim() ? basenameOf(formPath.trim()) : "例如 docs-backup-manager"}
                  className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </label>
              <div className="text-sm">
                <span className="text-[var(--color-text-secondary)]">同步清单（勾选常用条目，或添加自定义条目）</span>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                  {PRESET_ENTRIES.map((entry) => (
                    <label key={entry} className="flex items-center gap-1.5 font-mono text-xs">
                      <input
                        type="checkbox"
                        checked={includeEntries.includes(entry)}
                        onChange={() => toggleEntry(entry)}
                      />
                      {entry}
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={customEntry}
                    onChange={(e) => setCustomEntry(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomEntry();
                      }
                    }}
                    placeholder="自定义条目，如 src/api-specs/"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-xs outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={addCustomEntry}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]"
                  >
                    <Plus size={12} /> 添加
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {includeEntries.map((entry) => (
                    <span
                      key={entry}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 font-mono text-xs"
                    >
                      {entry}
                      <button
                        type="button"
                        onClick={() => toggleEntry(entry)}
                        className="text-[var(--color-text-secondary)] hover:text-red-500"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {includeEntries.length === 0 && (
                    <span className="text-xs text-red-500">清单为空，请至少选择一个条目</span>
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-secondary)]">
                落点：backup/&lt;项目名&gt;/（镜像同步，目标多余文件将被删除）；项目里暂不存在的条目会在同步时自动跳过。
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={openPreview}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
              >
                <FolderOpen size={14} /> 预览同步映射
              </button>
              <button onClick={handleAdd} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500">
                确认注册并首次同步
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 预览对话框 */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[640px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="text-lg font-semibold">同步映射预览（dry-run）</h2>
            <table className="mt-4 w-full text-xs">
              <thead className="text-[var(--color-text-secondary)]">
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2">源</th>
                  <th className="py-2">落点</th>
                  <th className="py-2 text-right">目标现存文件</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr key={r.entry} className="border-b border-[var(--color-border)]/50">
                    <td className="py-2 pr-2 font-mono">{r.src}</td>
                    <td className="py-2 pr-2 font-mono">{r.dst}</td>
                    <td className="py-2 text-right">{r.dstExistingFiles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setShowPreview(false)}
                className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 设置对话框 */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[480px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="text-lg font-semibold">备份设置</h2>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="text-[var(--color-text-secondary)]">备份目标目录（本地文件夹或 git 仓）</span>
                <input
                  value={formVault}
                  onChange={(e) => setFormVault(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </label>
              <label className="block text-sm">
                <span className="text-[var(--color-text-secondary)]">git 远端（可空 = 纯本地备份）</span>
                <input
                  value={formRemote}
                  onChange={(e) => setFormRemote(e.target.value)}
                  placeholder="git@github.com:Is-Ming/docs-vault.git"
                  className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </label>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={formAuto}
                    onChange={(e) => setFormAuto(e.target.checked)}
                  />
                  自动备份
                </label>
                <label className="flex items-center gap-2 text-sm">
                  间隔（分钟）
                  <input
                    type="number"
                    min={1}
                    value={formInterval}
                    onChange={(e) => setFormInterval(Number(e.target.value) || 60)}
                    className="w-20 rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1 text-sm outline-none focus:border-blue-500"
                  />
                </label>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={handleSaveSettings}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
              >
                保存
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移除确认 */}
      <ConfirmDialog
        open={!!showRemove}
        title={`移除项目 ${showRemove?.name ?? ""}`}
        message="仅移除注册信息，中央备份仓中的历史快照会保留。"
        confirmLabel="移除"
        onClose={() => setShowRemove(null)}
        onConfirm={async () => {
          await handleRemove();
        }}
      />
    </div>
  );
}
