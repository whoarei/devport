import type { IBuffer } from "@xterm/xterm";
import type { RunStatus } from "./api";
import type { OutputBuffer } from "./outputBuffer";
import i18n from "./i18n";
import { runResultLabel } from "./runState";

interface ConsoleWriter {
  buffer: { active: Pick<IBuffer, "baseY" | "cursorX" | "cursorY" | "getLine"> };
  reset(): void;
  write(data: string | Uint8Array, callback: () => void): void;
}

/** Keep at most one write inside xterm. The store owns all pending output. */
export function createConsoleReplay(term: ConsoleWriter, snapshot: () => {
  runId: string | null; buffer?: OutputBuffer; status?: RunStatus;
}) {
  let runId: string | null = null;
  let next = 0;
  let gaps = 0;
  let resultWritten = "";
  let writing = false;
  let disposed = false;
  const pump = () => {
    if (disposed || writing) return;
    const current = snapshot();
    const buffer = current.buffer;
    const result = runResultLabel(current.status);
    const hasMoreOutput = buffer && next < buffer.start + buffer.chunks.length;
    let message = "";
    // A resync can report completion before the remaining output batches arrive.
    // Replay the retained bytes so the result stays after the last output.
    if (current.runId !== runId || (resultWritten && (hasMoreOutput || resultWritten !== result))) {
      term.reset();
      runId = current.runId;
      next = 0;
      gaps = 0;
      resultWritten = "";
    }
    if (buffer && (buffer.gaps ?? 0) !== gaps) {
      term.reset();
      next = buffer.start;
      gaps = buffer.gaps ?? 0;
      resultWritten = "";
      message = `${i18n.t("replay.gap")}\r\n`;
    }
    if (buffer && next < buffer.start) {
      term.reset();
      next = buffer.start;
      resultWritten = "";
      message = `${i18n.t("replay.trimmed")}\r\n`;
    }
    const chunk = buffer?.chunks[next - buffer.start];
    let data = message || chunk;
    if (chunk && !message) next++;
    if (!data && result && !resultWritten) {
      const { active } = term.buffer;
      const line = active.getLine(active.baseY + active.cursorY);
      const newline = active.cursorX || line?.translateToString(true) ? "\r\n" : "";
      const tone = current.status?.state === "failed" || current.status?.exit_code ? 91 : 90;
      // CAN terminates an incomplete terminal escape before writing the UI result.
      data = `\x18${newline}\x1b[0;${tone}m[${result}]\x1b[0m\r\n`;
      resultWritten = result;
    }
    if (!data) return;
    writing = true;
    term.write(data, () => { writing = false; pump(); });
  };
  return { pump, dispose: () => { disposed = true; } };
}
