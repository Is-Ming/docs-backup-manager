import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import { ToggleSwitch } from "../components/ToggleSwitch";

interface BackupSettings {
  vault_path: string;
  remote: string | null;
  branch: string;
  auto_mode: boolean;
  auto_backup: boolean;
  interval_minutes: number;
}

export function Settings() {
  const navigate = useNavigate();
  const [vaultPath, setVaultPath] = useState("");
  const [autoMode, setAutoMode] = useState(true);
  const [interval, setInterval] = useState(60);
  const [remote, setRemote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await invoke<BackupSettings>("docs_get_settings");
      setVaultPath(s.vault_path);
      setAutoMode(s.auto_mode);
      setInterval(s.interval_minutes);
      setRemote(s.remote);
    } catch (e) {
      toast.error(`读取设置失败：${e}`);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pickVault = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "选择备份目录" });
    if (typeof picked !== "string" || !picked || picked === vaultPath) return;
    try {
      await invoke("docs_set_settings", { vaultPath: picked });
      toast.success("备份目录已更新");
      load();
    } catch (e) {
      toast.error(`保存失败：${e}`);
    }
  };

  const save = async (patch: Record<string, unknown>) => {
    try {
      await invoke("docs_set_settings", patch);
      load();
    } catch (e) {
      toast.error(`保存失败：${e}`);
    }
  };

  return (
    <div className="app-page app-page-narrow">
      <div className="app-page-header">
        <h1 className="app-page-title">设置</h1>
        <p className="app-page-subtitle">备份目标、同步策略与数据管理</p>
      </div>

      <div className="flex flex-col gap-6">
        <div>
          <h2 className="app-section-title mb-2.5">备份目标</h2>
          <div className="app-panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-[13px] text-[var(--color-text-secondary)]">
                备份目录
                <small className="mt-0.5 block text-[12px] leading-[17px] text-[var(--color-text-muted)]">
                  支持普通本地文件夹（只同步）或 git 仓库（每轮同步后自动备份）
                </small>
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="max-w-[280px] truncate font-mono text-[12px] text-[var(--color-text-muted)]"
                  title={vaultPath}
                >
                  {vaultPath || "—"}
                </span>
                <button
                  onClick={pickVault}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--color-border-subtle)] px-2.5 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  <FolderOpen size={13} /> 更换
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-[13px] text-[var(--color-text-secondary)]">
                远端备份（git）
                <small className="mt-0.5 block text-[12px] leading-[17px] text-[var(--color-text-muted)]">
                  远端地址、备份历史与恢复在"备份"页统一管理
                </small>
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <span className="max-w-[280px] truncate font-mono text-[12px] text-[var(--color-text-muted)]">
                  {remote ?? "未配置"}
                </span>
                <button
                  onClick={() => navigate("/backup")}
                  className="inline-flex h-7 items-center rounded-lg border border-[var(--color-border-subtle)] px-2.5 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  前往备份页
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h2 className="app-section-title mb-2.5">同步策略</h2>
          <div className="app-panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-[13px] text-[var(--color-text-secondary)]">
                自动同步
                <small className="mt-0.5 block text-[12px] leading-[17px] text-[var(--color-text-muted)]">
                  按间隔自动同步所有启用的项目（同步 = 项目目录 → 备份目录）
                </small>
              </span>
              <ToggleSwitch
                checked={autoMode}
                onChange={() => {
                  setAutoMode(!autoMode);
                  save({ autoMode: !autoMode });
                }}
                title="自动同步"
              />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-[13px] text-[var(--color-text-secondary)]">间隔（分钟）</span>
              <input
                type="number"
                min={1}
                value={interval}
                onChange={(e) => {
                  const v = Number(e.target.value) || 60;
                  setInterval(v);
                  save({ intervalMinutes: v });
                }}
                className="h-8 w-24 rounded-lg border border-[var(--color-border-subtle)] bg-transparent px-2 text-right text-[13px] outline-none focus:border-[var(--color-border)]"
              />
            </div>
          </div>
          <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">改动即时保存，无需确认按钮。</p>
        </div>

        <div>
          <h2 className="app-section-title mb-2.5">关于</h2>
          <div className="app-panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
              <span className="text-[var(--color-text-secondary)]">版本</span>
              <span className="font-mono text-[12px] text-[var(--color-text-muted)]">0.1.0</span>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
              <span className="text-[var(--color-text-secondary)]">仓库</span>
              <span className="font-mono text-[12px] text-[var(--color-text-muted)]">
                github.com/Is-Ming/docs-backup-manager
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
              <span className="text-[var(--color-text-secondary)]">数据目录</span>
              <span className="font-mono text-[12px] text-[var(--color-text-muted)]">
                ~\.docs-backup-manager
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
