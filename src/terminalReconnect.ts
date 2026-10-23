type ReconnectKey = Pick<KeyboardEvent, "type" | "key" | "repeat" | "isComposing" | "keyCode"
  | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "preventDefault">;

/** Only a physical Enter reconnects. Consume that press until release, even if
 * the new session connects before key-repeat/keypress arrives. */
export function createTerminalReconnectKey(canReconnect: () => boolean, reconnect: () => void) {
  let consumed = false;
  return (event: ReconnectKey): boolean => {
    if (event.key !== "Enter") return true;
    if (event.type === "keydown" && !event.repeat) consumed = false;
    if (consumed) {
      if (event.type === "keyup") consumed = false;
      event.preventDefault();
      return false;
    }
    if (event.type !== "keydown" || event.repeat || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || !canReconnect()) return true;
    consumed = true;
    event.preventDefault();
    reconnect();
    return false;
  };
}
