import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Archive,
  FolderOpen,
  Info,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  CheckCircle2,
  XCircle,
  Clock,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ToggleSwitch } from "../components/ToggleSwitch";

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
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [states, setStates] = useState<Record<number, SyncStateRecord>>({});
  const [settings, setSettings] = useState<BackupSettings>(emptySettings);
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showRemove, setShowRemove] = useState<ProjectRecord | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [showDetail, setShowDetail] = useState<ProjectRecord | null>(null);
  const [detailEntries, setDetailEntries] = useState<string[]>([]);
  const [detailCustom, setDetailCustom] = useState("");
  const [bk, setBk] = useState<{
    remote: string | null;
    last_backup: string | null;
    push_status: string | null;
  } | null>(null);

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

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<ProjectRecord[]>("docs_list_projects");
      setProjects(list);
      const map: Record<number, SyncStateRecord> = {};
      for (const p of list) {
        map[p.id] = await invoke<SyncStateRecord>("docs_get_state", { projectId: p.id });
      }
      setStates(map);
      setBk(
        await invoke("docs_get_backup_status") as {
          remote: string | null;
          last_backup: string | null;
          push_status: string | null;
        }
      );
    } catch (e) {
      toast.error(`加载项目失败：${e}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    invoke<BackupSettings>("docs_get_settings").then(setSettings);
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
      toast.error(`导入失败：${e}`);
    }
  };

  const handleSyncOne = async (p: ProjectRecord) => {
    try {
      const [added, deleted] = await invoke<[number, number]>("docs_sync_one", { id: p.id });
      toast.success(`${p.name} 同步完成：+${added}/-${deleted}`);
      refresh();
    } catch (e) {
      toast.error(`${p.name} 同步失败：${e}`);
      refresh();
    }
  };

  const openDetail = (p: ProjectRecord) => {
    setMenuOpenId(null);
    try {
      setDetailEntries(JSON.parse(p.include_json) as string[]);
    } catch {
      setDetailEntries([]);
    }
    setDetailCustom("");
    setShowDetail(p);
  };

  const toggleDetailEntry = (entry: string) => {
    setDetailEntries((prev) =>
      prev.includes(entry) ? prev.filter((e) => e !== entry) : [...prev, entry]
    );
  };

  const addDetailCustom = () => {
    const entry = detailCustom.trim().replace(/\\/g, "/");
    if (!entry || detailEntries.includes(entry)) {
      setDetailCustom("");
      return;
    }
    setDetailEntries((prev) => [...prev, entry]);
    setDetailCustom("");
  };

  const applyDetail = async () => {
    if (!showDetail) return;
    if (detailEntries.length === 0) {
      toast.error("请至少选择一个同步条目");
      return;
    }
    try {
      await invoke("docs_set_project_include", {
        id: showDetail.id,
        includeJson: JSON.stringify(detailEntries),
      });
      await invoke("docs_sync_one", { id: showDetail.id });
      toast.success("清单已更新并完成同步");
      setShowDetail(null);
      refresh();
    } catch (e) {
      toast.error(`操作失败：${e}`);
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

  return (
    <div
      className="flex h-full flex-col gap-6 overflow-y-auto p-6"
      onClick={() => setMenuOpenId(null)}
    >
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">备份中心</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            备份目标：{settings.vault_path || "未配置"}
            {bk?.remote ? ` · 远端已配置` : " · 未配置远端（本地文件夹）"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate("/settings")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
          >
            <Settings2 size={15} /> 设置
          </button>
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent-dark)] px-3 py-2 text-sm text-white hover:bg-[var(--color-accent)] disabled:opacity-50"
          >
            <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
            {syncing ? "同步中…" : "立即同步"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
          >
            <Plus size={15} /> 导入项目
          </button>
        </div>
      </div>

      {/* 状态条：同步（每项目）与备份（整个备份仓 → 远端）分开展示 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm text-[var(--color-text-secondary)]">
        <span className="flex items-center gap-2">
          <Clock size={14} />
          自动同步：{settings.auto_mode ? "开启" : "关闭"} · 间隔 {settings.interval_minutes} 分钟
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          📦 备份（整个备份仓 → 远端 git，全项目同一备份时间）：
          {bk?.remote
            ? `上次备份 ${bk.last_backup ?? "—"} · ${
                bk.push_status === "pushed"
                  ? "已推送"
                  : bk.push_status === "failed"
                    ? "推送失败"
                    : "仅本地 commit"
              }`
            : "未配置远端，无此步骤（到\"备份\"页配置）"}
        </span>
      </div>

      {/* 项目卡片（对齐 skills-manager skill 卡片） */}
      {projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] py-16 text-[var(--color-text-secondary)]">
          <Archive size={36} className="opacity-40" />
          <p>还没有导入任何项目</p>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent-dark)] px-3 py-2 text-sm text-white hover:bg-[var(--color-accent)]"
          >
            <Plus size={15} /> 导入第一个项目
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const st = states[p.id];
            const failed = st?.push_status === "failed";
            return (
              <div
                key={p.id}
                onClick={() => openDetail(p)}
                className="group relative cursor-pointer flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] transition-all hover:-translate-y-px hover:border-[var(--color-border)] hover:shadow-[var(--shadow-card-hover)]"
              >
                {/* 头部：启用圆点 + 名称 + "…"菜单 + 开关 */}
                <div className="flex items-center gap-2.5 px-3.5 pb-1.5 pt-3">
                  <span
                    title={p.enabled ? "已启用" : "已停用"}
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      p.enabled
                        ? "bg-[var(--color-accent-light)] shadow-[0_0_0_3px_var(--color-accent-bg)]"
                        : "bg-[var(--color-surface-active)]"
                    }`}
                  />
                  <h3
                    className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent-light)]"
                    title={p.name}
                  >
                    {p.name}
                  </h3>
                  <div className="relative shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      title="更多操作"
                      aria-label="更多操作"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === p.id ? null : p.id);
                      }}
                      className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {menuOpenId === p.id && (
                      <div className="absolute right-0 top-full z-30 mt-1 min-w-[176px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg">
                        {p.enabled && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(null);
                              handleSyncOne(p);
                            }}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                          >
                            <RefreshCw size={13} className="opacity-70" /> 立即同步此项目
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetail(p);
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                        >
                          <Info size={13} className="opacity-70" /> 查看详情
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(null);
                            setShowRemove(p);
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]"
                        >
                          <X size={13} className="opacity-70" /> 移除（快照保留）
                        </button>
                      </div>
                    )}
                  </div>
                  <ToggleSwitch
                    checked={p.enabled}
                    onChange={() => handleToggle(p)}
                    title={p.enabled ? "停用：暂停此项目的自动同步" : "启用：恢复此项目的自动同步"}
                  />
                </div>
                {/* 主体：路径 + 清单 + 错误 */}
                <div className="px-3.5 pb-3">
                  <p className="truncate text-[12px] text-[var(--color-text-muted)]" title={p.repo_path}>
                    {p.repo_path}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {((): string[] => {
                      try {
                        return JSON.parse(p.include_json) as string[];
                      } catch {
                        return [];
                      }
                    })().map((c) => (
                      <span
                        key={c}
                        className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-text-tertiary)]"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                  {st?.last_error && (
                    <p className="mt-2 line-clamp-2 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500">
                      {st.last_error}
                    </p>
                  )}
                </div>
                {/* 页脚 */}
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-border-faint)] px-3.5 py-2.5">
                  <span className="min-w-0 truncate text-[12px] text-[var(--color-text-muted)]">
                    上次同步：{st?.last_sync ?? "—"} · 变更：
                    {st ? `+${st.added}/-${st.deleted}` : "—"}
                  </span>
                  {failed ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-500">
                      <XCircle size={12} /> 失败
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] px-2 py-0.5 text-xs text-[var(--color-accent)]">
                      <CheckCircle2 size={12} /> 正常
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 注册对话框 */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[560px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="text-lg font-semibold">导入项目</h2>
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
              <button onClick={handleAdd} className="rounded-lg bg-[var(--color-accent-dark)] px-4 py-2 text-sm text-white hover:bg-[var(--color-accent)]">
                确认导入并首次同步
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

      {/* 项目详情对话框 */}
      {showDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[560px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h2 className="text-lg font-semibold">
              {showDetail.name}
              <span
                className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 align-middle text-xs ${
                  showDetail.enabled
                    ? "border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                    : "border border-[var(--color-border)] text-[var(--color-text-muted)]"
                }`}
              >
                {showDetail.enabled ? "已启用" : "已停用"}
              </span>
            </h2>
            {(() => {
              const st = states[showDetail.id];
              return (
                <div className="mt-3 grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  <span className="text-[var(--color-text-muted)]">项目路径</span>
                  <span className="truncate font-mono text-[12px] text-[var(--color-text-secondary)]" title={showDetail.repo_path}>
                    {showDetail.repo_path}
                  </span>
                  <span className="text-[var(--color-text-muted)]">上次同步</span>
                  <span className="text-[var(--color-text-secondary)]">{st?.last_sync ?? "—"}</span>
                  <span className="text-[var(--color-text-muted)]">本轮变更</span>
                  <span className="text-[var(--color-text-secondary)]">
                    {st ? `+${st.added} / -${st.deleted}` : "—"}
                  </span>
                  <span className="text-[var(--color-text-muted)]">落点</span>
                  <span className="truncate font-mono text-[12px] text-[var(--color-text-muted)]">
                    backup/{showDetail.name}/
                  </span>
                </div>
              );
            })()}
            {states[showDetail.id]?.last_error && (
              <p className="mt-2 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500">
                {states[showDetail.id]!.last_error}
              </p>
            )}
            <div className="mt-4 text-sm">
              <span className="text-[var(--color-text-secondary)]">
                同步清单（可编辑，应用后自动同步一次）
              </span>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {PRESET_ENTRIES.map((entry) => (
                  <label key={entry} className="flex items-center gap-1.5 font-mono text-xs">
                    <input
                      type="checkbox"
                      checked={detailEntries.includes(entry)}
                      onChange={() => toggleDetailEntry(entry)}
                    />
                    {entry}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={detailCustom}
                  onChange={(e) => setDetailCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDetailCustom();
                    }
                  }}
                  placeholder="自定义条目，如 src/api-specs/"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={addDetailCustom}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]"
                >
                  <Plus size={12} /> 添加
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detailEntries.map((entry) => (
                  <span
                    key={entry}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] px-2 py-0.5 font-mono text-xs text-[var(--color-accent)]"
                  >
                    {entry}
                    <button
                      type="button"
                      onClick={() => toggleDetailEntry(entry)}
                      className="opacity-60 hover:text-red-500 hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {detailEntries.length === 0 && (
                  <span className="text-xs text-red-500">清单为空，请至少选择一个条目</span>
                )}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowDetail(null)}
                className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
              <button
                onClick={applyDetail}
                className="rounded-lg bg-[var(--color-accent-dark)] px-4 py-2 text-sm text-white hover:bg-[var(--color-accent)]"
              >
                应用并同步
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
