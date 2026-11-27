import { Link, useLocation } from "react-router-dom";
import { CloudUpload, Settings } from "lucide-react";
import { cn } from "../utils";

/**
 * 极简侧边栏：docs-backup-manager 只关注文档备份。
 * 原 skills-manager 的技能库/Presets/工作区等功能已裁剪（M2/M3 按需重建）。
 */
const NAV_ITEMS = [
  {
    to: "/",
    label: "文档备份中心",
    icon: CloudUpload,
  },
  {
    to: "/settings",
    label: "设置",
    icon: Settings,
  },
];

export function Sidebar() {
  const location = useLocation();

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* 应用标识 */}
      <div className="flex items-center gap-2 px-4 py-4">
        <CloudUpload size={20} className="text-blue-500" />
        <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
          docs-backup-manager
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-[var(--color-surface-hover)] font-medium text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-3 text-[11px] text-[var(--color-text-secondary)]">
        项目文档 · 单向 · 保真 · 自动备份
      </div>
    </aside>
  );
}
