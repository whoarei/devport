import type { KeyboardEvent } from "react";

/** Line breaks delimit arguments; every other character is literal. */
export function parseRunArguments(text: string): string[] {
  return text.split(/\r\n|\n|\r/).filter(line => line.length > 0);
}

export function handleRunShortcut(event: KeyboardEvent<HTMLElement>, run: () => void): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    || event.key !== "Enter" || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  if (!event.repeat) run();
}
