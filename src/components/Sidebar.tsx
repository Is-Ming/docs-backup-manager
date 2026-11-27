import { Link, useLocation } from "react-router-dom";
import { cn } from "../utils";

/**
 * 侧边栏：首页 / 备份中心 / 备份 / 设置。
 * 图标为线性 SVG（档案盒/云/齿轮），刻意避开"上传箭头"形态。
 */
const icon = (paths: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {paths.split("|").map((d, i) => (
      <path key={i} d={d} />
    ))}
  </svg>
);

const ARCHIVE = "M2 3h20v5H2z|M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8|M10 12h4";
const HOME = "m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22V12h6v10";
const CLOUD = "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z";
const GEAR =
  "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z";

const NAV_ITEMS = [
  { to: "/", label: "首页", icon: icon(HOME) },
  { to: "/center", label: "备份中心", icon: icon(ARCHIVE) },
  { to: "/backup", label: "备份", icon: icon(CLOUD) },
  { to: "/settings", label: "设置", icon: icon(GEAR) },
];

export function Sidebar() {
  const location = useLocation();

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-2 px-4 py-4">
        {icon(ARCHIVE)}
        <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
          docs-backup-manager
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-2">
        {NAV_ITEMS.map(({ to, label, icon: ic }) => {
          const active =
            to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);
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
              {ic}
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-3 text-[11px] text-[var(--color-text-secondary)]">
        项目文档 · 单向 · 保真 · 自动同步
      </div>
    </aside>
  );
}
