import type { SVGProps } from "react";

const paths = {
  folder: <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h4l2 2h6A1.5 1.5 0 0 1 17.5 7.5v8A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z" />,
  folderOpen: <><path d="M2.5 10V5.5A1.5 1.5 0 0 1 4 4h4l2 2h6a1.5 1.5 0 0 1 1.5 1.5V9" /><path d="M4 9h13.5l-2 8h-13Z" /></>,
  file: <><path d="M11.5 2.5H5A1.5 1.5 0 0 0 3.5 4v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5Z" /><path d="M11.5 2.5v5h5" /></>,
  code: <path d="m6.5 6-4 4 4 4m7-8 4 4-4 4m-2-11-3 14" />,
  config: <><path d="M3 5h14M3 10h14M3 15h14" /><path d="M7 3v4m6 1v4m-6 1v4" /></>,
  text: <path d="M4 4h12M4 8h12M4 12h12M4 16h7" />,
  chevronRight: <path d="m8 5 5 5-5 5" />,
  chevronDown: <path d="m5 8 5 5 5-5" />,
  close: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  plus: <path d="M10 4v12M4 10h12" />,
  terminal: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="m6 7 3 3-3 3m5 0h3" /></>,
  server: <><rect x="3" y="3" width="14" height="6" rx="1.5" /><rect x="3" y="11" width="14" height="6" rx="1.5" /><path d="M6 6h.01M6 14h.01M10 6h4m-4 8h4" /></>,
  monitor: <><rect x="2.5" y="3" width="15" height="11" rx="1.5" /><path d="M6 17h8m-4-3v3" /></>,
  serial: <path d="M7 2v4m6-4v4M5 6h10v3a5 5 0 0 1-10 0Zm5 8v4" />,
  arrowUp: <path d="M10 16V4m-5 5 5-5 5 5" />,
  arrowRight: <path d="M4 10h12m-5-5 5 5-5 5" />,
  arrowLeft: <path d="M16 10H4m5-5-5 5 5 5" />,
  refresh: <path d="M16.5 8A7 7 0 1 0 17 12M17 3v5h-5" />,
  alert: <><circle cx="10" cy="10" r="7.5" /><path d="M10 6v5m0 3h.01" /></>,
  play: <path d="m7 4 9 6-9 6Z" />,
  check: <path d="m4 10 4 4 8-8" />,
  more: <><circle cx="4" cy="10" r=".7" /><circle cx="10" cy="10" r=".7" /><circle cx="16" cy="10" r=".7" /></>,
} as const;

export type IconName = keyof typeof paths;

/** Shared optical size and stroke for workbench controls and file browsers. */
export function Icon({ name, className = "", ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`ui-icon ${className}`} {...props}>{paths[name]}</svg>;
}

export function FileIcon({ name, directory = false, expanded = false }: { name: string; directory?: boolean; expanded?: boolean }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const kind = directory ? "folder" : /^(py|sh|bash|ps1|bat|cmd|js|jsx|ts|tsx|rs|c|cpp|h|hpp|go|java|html|css|sql)$/.test(extension) ? "code"
    : /^(json|toml|yaml|yml|ini|conf|xml)$/.test(extension) || /^(Dockerfile|CMakeLists\.txt|\.gitignore)$/i.test(name) ? "config"
    : /^(md|txt|rst|log)$/.test(extension) ? "text" : "file";
  return <Icon name={directory && expanded ? "folderOpen" : kind} className={`file-icon file-icon-${kind}`} />;
}
