interface Writer { write(data: string | Uint8Array, callback: () => void): void }
interface Write {
  data: string | Uint8Array;
  sessionId?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Serialize output across sessions. Parser replies and OSC titles belong to
 * the session currently being parsed, including writes queued before reconnect. */
export function createTerminalDisplay(term: Writer) {
  const queue: Write[] = [];
  let active: Write | undefined;
  let disposed = false;
  const pump = () => {
    if (disposed || active || !queue.length) return;
    const entry = active = queue.shift()!;
    try {
      term.write(entry.data, () => {
        if (disposed) return;
        active = undefined;
        entry.resolve();
        pump();
      });
    } catch (error) {
      active = undefined;
      entry.reject(error);
      pump();
    }
  };
  return {
    get sessionId() { return active?.sessionId; },
    get writing() { return !!active; },
    write(data: string | Uint8Array, sessionId?: string): Promise<void> {
      if (disposed) return Promise.resolve();
      return new Promise((resolve, reject) => { queue.push({ data, sessionId, resolve, reject }); pump(); });
    },
    dispose() {
      disposed = true;
      active?.resolve();
      active = undefined;
      queue.splice(0).forEach(entry => entry.resolve());
    },
  };
}

/** Reset input modes without RIS/reset(), which would erase scrollback. Archive
 * the old viewport before a newly launched shell clears its screen. */
export function terminalSessionBoundary(rows: number, label: string): string {
  return "\x18\x1b[?1049l\x1b[!p\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b]8;;\x1b\\"
    // LF at the bottom adds scrollback; CSI S discards lines in xterm.js.
    + `\x1b[${rows};1H\r\n── ${label} ──` + "\r\n".repeat(rows) + "\x1b[H";
}
