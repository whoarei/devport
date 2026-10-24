import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { eventText, useEventStore } from "../eventStore";
import { Icon } from "./Icon";

export function EventCenter() {
  const { t, i18n } = useTranslation();
  const events = useEventStore((state) => state.events);
  const running = useEventStore((state) => state.running);
  const clearing = useEventStore((state) => state.clearing);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const restoreFocus = (trigger: HTMLButtonElement, index = 0) => {
    if (trigger.isConnected || document.activeElement !== document.body) return;
    const remaining = panel.current?.querySelectorAll<HTMLButtonElement>(".event-dismiss:not(:disabled)");
    (remaining?.[Math.min(index, remaining.length - 1)] ?? closeButton.current ?? button.current)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  return <div className="event-center" ref={container}>
    <button ref={button} type="button" className={`titlebar-button event-center-button${open ? " active" : ""}`}
      aria-label={t("events.button", { count: events.length })} title={t("events.title")}
      aria-expanded={open} aria-controls="app-event-panel" onClick={() => setOpen((value) => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {events.length > 0 && <span className="event-count" aria-hidden="true">{events.length > 99 ? "99+" : events.length}</span>}
    </button>
    <span className="sr-only" role="status">{t("events.button", { count: events.length })}</span>
    {open && <section ref={panel} id="app-event-panel" className="event-panel" aria-label={t("events.title")} aria-busy={clearing}>
      <header><h3>{t("events.title")}</h3><span>{events.length}</span>
        <div className="event-header-actions">
          {events.length > 0 && <><button type="button" className="event-clear" disabled={clearing || events.every((event) => running.includes(event.id))}
            onClick={async (click) => {
              const trigger = click.currentTarget;
              await useEventStore.getState().clear();
              restoreFocus(trigger);
            }}>{t(clearing ? "events.clearing" : "events.clear")}</button><span className="event-header-divider" aria-hidden="true" /></>}
          <button ref={closeButton} type="button" className="event-close" aria-label={t("events.close")} title={t("events.close")}
            onClick={() => { setOpen(false); button.current?.focus(); }}><Icon name="close" /></button>
        </div>
      </header>
      {events.length === 0 ? <p className="event-empty">{t("events.empty")}</p> : <ol>
        {events.map((event, index) => <li key={event.id} className={`event-item${event.level === "error" ? " event-error" : ""}`}>
          <div className="event-item-heading">
            <div className="event-item-summary">
              <strong>{eventText(event.title)}</strong>
              <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString(i18n.language === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            <div className="event-item-actions">
              {event.action && <button type="button" className="event-action" disabled={clearing || running.includes(event.id)}
                onClick={async (click) => {
                  const actionButton = click.currentTarget;
                  await useEventStore.getState().runAction(event.id);
                  restoreFocus(actionButton, index);
                }}>{eventText(event.action.label)}</button>}
              <button type="button" className="event-dismiss" disabled={clearing || running.includes(event.id)}
                aria-label={`${t("events.dismiss")}: ${eventText(event.title)}`} title={t("events.dismiss")}
                onClick={async (click) => {
                  const trigger = click.currentTarget;
                  await useEventStore.getState().remove(event.id);
                  restoreFocus(trigger, index);
                }}><Icon name="close" /></button>
            </div>
          </div>
          {event.message && <p>{eventText(event.message)}</p>}
          {event.actionError && <p className="event-action-error" role="alert">{event.actionError}</p>}
        </li>)}
      </ol>}
    </section>}
  </div>;
}
