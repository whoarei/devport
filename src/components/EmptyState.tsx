import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function EmptyState({ icon, title, description, compact = false, children }: {
  icon: IconName; title: string; description?: string; compact?: boolean; children?: ReactNode;
}) {
  return <div className={`empty-state${compact ? " empty-state-compact" : ""}`}>
    <span className="empty-state-icon"><Icon name={icon} /></span>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {children && <div className="empty-state-actions">{children}</div>}
  </div>;
}
