import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | {
      label: string;
      detail?: string;
      danger?: boolean;
      disabled?: boolean;
      /** 悬停展开的子菜单（与 MenuBar 同一套样式）；设置后自身不再触发 onSelect */
      children?: MenuEntry[];
      onSelect?: () => void;
    }
  | "separator";

export interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

/** 保存弹出锚点；实际边界在菜单渲染后测量，条目数参数兼容现有调用。 */
export function contextMenuPosition(clientX: number, clientY: number, _entryCount: number) {
  return { x: clientX, y: clientY };
}

function MenuItem({ entry, disabled, close }: {
  entry: Exclude<MenuEntry, "separator">;
  disabled?: boolean;
  close: () => void;
}) {
  const [subOpen, setSubOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const itemDisabled = disabled || entry.disabled;
  // .context-menu 带 overflow-y: auto（长菜单可滚动），会裁剪 absolute 定位的子菜单，
  // 所以子菜单改用 fixed 按视口坐标展开，并在右缘 / 下缘越界时翻转
  useLayoutEffect(() => {
    if (!subOpen) return;
    const anchor = wrap.current?.getBoundingClientRect();
    const element = sub.current;
    if (!anchor || !element) return;
    const rect = element.getBoundingClientRect();
    let left = anchor.right - 2;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, anchor.left - rect.width + 2);
    let top = anchor.top - 5;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - rect.height);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [subOpen]);
  if (entry.children) {
    return (
      <div
        className="menu-submenu"
        ref={wrap}
        onMouseEnter={() => { if (!itemDisabled) setSubOpen(true); }}
        onMouseLeave={() => setSubOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={subOpen}
          className="menu-item"
          disabled={itemDisabled}
        >
          <span className="menu-check" aria-hidden="true" />
          <span className="menu-label">{entry.label}</span>
          <span className="menu-arrow" aria-hidden="true">▸</span>
        </button>
        {subOpen && (
          <div className="menu-dropdown menu-subdropdown context-submenu" role="menu" ref={sub}>
            {entry.children.map((child, index) => child === "separator"
              ? <div key={index} className="menu-separator" role="separator" />
              : <MenuItem key={index} entry={child} disabled={disabled} close={close} />)}
          </div>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${entry.danger ? " menu-item-danger" : ""}`}
      disabled={itemDisabled}
      onClick={() => { close(); entry.onSelect?.(); }}
    >
      <span className="menu-check" aria-hidden="true" />
      <span className="menu-label">{entry.label}</span>
      {entry.detail && <span className="menu-detail">{entry.detail}</span>}
    </button>
  );
}

export function ContextMenu({ menu, disabled, onClose }: {
  menu: MenuState | null;
  /** 面板级禁用（如运行期间禁止文件修改）；单项禁用用 entry.disabled */
  disabled?: boolean;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!menu || !element) return;
    const reposition = () => {
      const { width, height } = element.getBoundingClientRect();
      const margin = 8;
      element.style.left = `${Math.max(margin, Math.min(menu.x, window.innerWidth - width - margin))}px`;
      element.style.top = `${Math.max(margin, Math.min(menu.y, window.innerHeight - height - margin))}px`;
    };
    // 首次绘制前定位，并跟随窗口、字体及换行造成的尺寸变化。
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(element);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return (
    <div className="menu-dropdown context-menu" role="menu" ref={container} style={{ left: menu.x, top: menu.y }}>
      {menu.entries.map((entry, index) => entry === "separator"
        ? <div key={index} className="menu-separator" role="separator" />
        : <MenuItem key={index} entry={entry} disabled={disabled} close={onClose} />)}
    </div>
  );
}
