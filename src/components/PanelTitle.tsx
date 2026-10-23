import type { MouseEvent, ReactNode } from "react";
import { Icon } from "./Icon";

interface PanelTitleProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** 追加的 class，用于复用区域特有样式（如控制台标题） */
  className?: string;
  /** 标题栏右键菜单（在操作按钮上右键时不触发） */
  onContextMenu?: (event: MouseEvent) => void;
  /** 标题右侧的额外操作按钮（不参与折叠切换） */
  children?: ReactNode;
}

/** 可折叠面板的标题条：点击或 Enter/Space 切换折叠状态。 */
export function PanelTitle({ title, collapsed, onToggle, className, onContextMenu, children }: PanelTitleProps) {
  return (
    <div
      className={`panel-title panel-title-collapsible${className ? ` ${className}` : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="panel-heading">
        <span className="panel-chevron"><Icon name={collapsed ? "chevronRight" : "chevronDown"} /></span>
        <span>{title}</span>
      </span>
      {children && (
        <span className="panel-actions" onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}>
          {children}
        </span>
      )}
    </div>
  );
}
