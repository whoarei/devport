import { foldGutter } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import i18n from "./i18n";

/** Match the workbench chevrons without depending on the editor's font glyphs. */
export function editorFoldGutter() {
  return foldGutter({ markerDOM: (open) => {
    const marker = document.createElement("span");
    marker.className = "cm-foldMarker";
    marker.dataset.folded = String(!open);
    marker.title = i18n.t(open ? "editor.foldLine" : "editor.unfoldLine");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ width: "14", height: "14", viewBox: "0 0 20 20", fill: "none",
      stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      icon.setAttribute(name, value);
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", open ? "m5 8 5 5 5-5" : "m8 5 5 5-5 5");
    icon.append(path);
    marker.append(icon);
    return marker;
  } });
}

/** CodeMirror reuses unchanged markers when the phrase compartment changes. */
export function refreshEditorFoldLabels(view: EditorView) {
  for (const marker of view.dom.querySelectorAll<HTMLElement>(".cm-foldMarker")) {
    marker.title = view.state.phrase(marker.dataset.folded === "true" ? "Unfold line" : "Fold line");
  }
}
