/** Ctrl+C interrupts the workload once; stopping a run is a separate action. */
export function handleRunConsoleKey(
  event: Pick<KeyboardEvent, "type" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "key" | "repeat">,
  selection: string,
  send: (data: string) => void,
  copy: (text: string) => void,
): boolean {
  if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey
    || event.shiftKey || event.key.toLowerCase() !== "c") return true;
  if (!event.repeat) {
    if (selection) copy(selection);
    else send("\x03");
  }
  return false;
}
