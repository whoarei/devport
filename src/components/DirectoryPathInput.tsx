import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { errorMessage, type WorkspaceRef } from "../api";
import { DirectoryListingCache, directoryCompletionQuery, directorySuggestions } from "../directoryCompletion";
import { type TransferDirectory } from "../transferApi";
import "./DirectoryPathInput.css";

interface Props {
  value: string;
  endpoint: WorkspaceRef | null;
  contextKey: string;
  directory?: TransferDirectory | null;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  id?: string;
  onChange: (path: string) => void;
  onNavigate: (path: string) => void;
}

/** Shared by workspace selection and both transfer browsers. Suggestions never navigate on typing. */
export function DirectoryPathInput({ value, endpoint, contextKey, directory, disabled, label, placeholder, id, onChange, onNavigate }: Props) {
  const { t } = useTranslation();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cache = useRef(new DirectoryListingCache());
  const sequence = useRef(0);
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<{ value: string; items: string[]; error?: string } | null>(null);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  const expanded = editing && !disabled && !!result && result.value === value;
  const dismiss = () => { ++sequence.current; setEditing(false); setResult(null); };

  useEffect(() => {
    cache.current.clear();
    dismiss();
  }, [contextKey]);
  useEffect(() => {
    if (directory) cache.current.seed(directory);
    dismiss();
  }, [directory]);
  useEffect(() => {
    const request = ++sequence.current;
    if (!editing || disabled || !endpoint) return;
    const query = directoryCompletionQuery(endpoint, value);
    if (!query) { setResult(null); return; }
    const timer = setTimeout(() => {
      void cache.current.list(query.endpoint).then((directory) => {
        if (request === sequence.current) {
          setResult({ value, items: directorySuggestions(directory, query.prefix, query.windows).slice(0, 100) });
          setActive(0);
        }
      }, (error) => {
        if (request === sequence.current) setResult({ value, items: [], error: errorMessage(error) });
      });
    }, 220);
    return () => { clearTimeout(timer); ++sequence.current; };
  }, [value, endpoint?.type, endpoint?.type === "device" ? endpoint.device_id : "local", editing, disabled, contextKey, directory]);
  useEffect(() => () => { ++sequence.current; }, []);
  useEffect(() => {
    if (!expanded) return;
    const update = () => {
      const bounds = input.current?.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const upward = below < 150 && above > below;
      setPosition({ position: "fixed", visibility: "visible", left: Math.max(8, bounds.left), width: Math.min(bounds.width, window.innerWidth - 16),
        maxHeight: Math.max(60, Math.min(260, upward ? above : below)),
        ...(upward ? { bottom: window.innerHeight - bounds.top + 5 } : { top: bounds.bottom + 5 }) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [expanded]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);

  const navigate = (path: string) => { dismiss(); onNavigate(path); };
  return <div className="directory-path-input">
    <input ref={input} id={id} aria-label={label} placeholder={placeholder} value={value} disabled={disabled}
      spellCheck={false} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && result?.items.length ? `${listId}-${active}` : undefined}
      onChange={(event) => { ++sequence.current; setEditing(true); setResult(null); onChange(event.target.value); }}
      onBlur={dismiss}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && editing) { event.preventDefault(); event.stopPropagation(); dismiss(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!editing) setEditing(true);
          else if (result?.items.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + result.items.length) % result.items.length);
        }
        if (event.key === "Tab" && expanded && result?.items.length) {
          event.preventDefault();
          const path = result.items[active];
          const separator = endpoint?.type === "local" && path.includes("\\") ? "\\" : "/";
          ++sequence.current; setResult(null); onChange(path + separator);
        }
        if (event.key === "Enter") { event.preventDefault(); navigate(expanded && result?.items.length ? result.items[active] : value); }
      }} />
    {expanded && input.current && createPortal(<div ref={list} id={listId} className="directory-completions" role="listbox" aria-label={t("pathCompletion.suggestions")} style={position}
      onPointerDown={(event) => event.preventDefault()}>
      {result.items.map((path, index) => <button type="button" key={path} id={`${listId}-${index}`} role="option" aria-selected={index === active}
        title={path} onClick={() => navigate(path)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5h6l3 3h9v12H3V7Z" /></svg>
        <span>{path}</span>{index === active && <kbd>Tab</kbd>}
      </button>)}
      {!result.items.length && <p role="status">{result.error ? t("pathCompletion.failed", { message: result.error }) : t("pathCompletion.empty")}</p>}
    </div>, input.current.closest("dialog") ?? document.body)}
  </div>;
}
