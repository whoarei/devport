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
  /** Row action menus follow their button; pointer context menus retain fixed coordinates. */
  anchor?: HTMLElement;
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
  const focusSubmenu = useRef(false);
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
    const scale = rect.width / element.offsetWidth || 1;
    element.style.left = `${left / scale}px`;
    element.style.top = `${top / scale}px`;
    if (focusSubmenu.current) {
      element.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
      focusSubmenu.current = false;
    }
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
          onClick={() => { focusSubmenu.current = true; setSubOpen(!subOpen); }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault(); event.stopPropagation();
            focusSubmenu.current = true; setSubOpen(true);
          }}
        >
          <span className="menu-check" aria-hidden="true" />
          <span className="menu-label">{entry.label}</span>
          <span className="menu-arrow" aria-hidden="true">▸</span>
        </button>
        {subOpen && (
          <div className="menu-dropdown menu-subdropdown context-submenu" role="menu" ref={sub}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
              event.preventDefault(); event.stopPropagation(); setSubOpen(false);
              wrap.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
            }}>
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
      const scale = width / element.offsetWidth || 1;
      const anchor = menu.anchor?.getBoundingClientRect();
      const x = anchor ? anchor.right - width : menu.x;
      let y = anchor ? anchor.bottom + 3 : menu.y;
      if (anchor && y + height > window.innerHeight - margin && anchor.top - height - 3 >= margin) y = anchor.top - height - 3;
      element.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin)) / scale}px`;
      element.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin)) / scale}px`;
    };
    // 首次绘制前定位，并跟随窗口、字体及换行造成的尺寸变化。
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(element);
    window.addEventListener("resize", reposition);
    if (menu.anchor) window.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [menu]);
  const open = menu !== null;
  useLayoutEffect(() => {
    const element = container.current;
    if (!open || !element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      if (element.contains(document.activeElement) || document.activeElement === document.body) opener?.focus();
    };
  }, [open, menu?.anchor]);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menu.anchor?.contains(event.target as Node)) return;
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
    <div className="menu-dropdown context-menu" role="menu" ref={container} style={{ left: menu.x, top: menu.y }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'))
          .filter((item) => item.closest('[role="menu"]') === (event.target as HTMLElement).closest('[role="menu"]'));
        if (!items.length) return;
        event.preventDefault(); event.stopPropagation();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {menu.entries.map((entry, index) => entry === "separator"
        ? <div key={index} className="menu-separator" role="separator" />
        : <MenuItem key={index} entry={entry} disabled={disabled} close={onClose} />)}
    </div>
  );
}
