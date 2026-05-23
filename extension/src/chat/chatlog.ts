import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ChatEntry {
  sequence: number;
  timestamp: number;
  event_type: "chat";
  prompt_text: string;
  response_text: string;
  model_used: string;
  prompt_tokens: number;
  response_tokens: number;
  response_latency_ms: number;
  topic_hint: string;
  correction_loop: boolean;
}

export interface EventEntry {
  sequence: number;
  timestamp: number;
  event_type: string;
  payload: Record<string, unknown>;
}

export type LogEntry = ChatEntry | EventEntry;

export class ChatLog {
  private filePath: string;
  private sequence = 0;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, ".jivahire_chat_log.json");
    if (!fs.existsSync(this.filePath)) {
      this._atomicWrite("[]");
      return;
    }
    try {
      const existing = ChatLog._parseEntries(fs.readFileSync(this.filePath, "utf8"));
      // Bug fix: seed `sequence` from max(sequence) — not array.length — so a
      // resumed log whose last entry has sequence 7 keeps numbering at 8, even
      // if the array was previously trimmed or repaired.
      this.sequence = existing.reduce((m, e) => Math.max(m, e.sequence ?? 0), 0);
    } catch {
      // Quarantine the corrupt log so it's still recoverable for forensics.
      try { fs.renameSync(this.filePath, this.filePath + ".corrupt-" + Date.now() + ".json"); }
      catch { /* swallow — best-effort */ }
      this._atomicWrite("[]");
    }
  }

  append(entry: Omit<ChatEntry, "sequence" | "event_type">): void {
    try {
      const entries = ChatLog._parseEntries(fs.readFileSync(this.filePath, "utf8"));
      entries.push({ sequence: ++this.sequence, event_type: "chat", ...entry });
      this._atomicWrite(JSON.stringify(entries, null, 2));
    } catch (e) {
      console.warn("[ChatLog] append failed:", e);
    }
  }

  /**
   * Record a non-chat event (file change, edit, paste, test run, etc.) into
   * the same audit-trail log. Entries share the sequence counter with chat
   * appends so the grader sees a unified, monotonically ordered timeline.
   */
  appendEvent(event_type: string, payload: Record<string, unknown>): void {
    try {
      const entries = ChatLog._parseEntries(fs.readFileSync(this.filePath, "utf8"));
      entries.push({
        sequence: ++this.sequence,
        timestamp: Date.now(),
        event_type,
        payload,
      });
      this._atomicWrite(JSON.stringify(entries, null, 2));
    } catch (e) {
      console.warn("[ChatLog] appendEvent failed:", e);
    }
  }

  /**
   * Validate that the on-disk contents are a JSON array of entries. Returns
   * the array if valid; throws otherwise. Avoids the `existing.length` bug
   * where a corrupted `{}` would silently become `NaN` sequence numbers.
   */
  private static _parseEntries(raw: string): LogEntry[] {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("chat log root is not an array");
    }
    return parsed as LogEntry[];
  }

  /**
   * Write JSON to an out-of-workspace tmp file, then atomically rename it
   * into place. Falls back to copy+unlink if the rename crosses filesystems.
   *
   * Why out-of-workspace: the auto-commit cycle runs `git add -A`. A sibling
   * `.tmp-*` in the workspace can be enumerated and staged before the rename
   * completes, leaking intermediate chat-log snapshots into the candidate's
   * branch. Writing to os.tmpdir() keeps the tmp file invisible to git.
   *
   * `rename(2)` is atomic on POSIX, so a reader sees either the old complete
   * file or the new complete file, never a mix.
   */
  private _atomicWrite(content: string): void {
    const tmp = path.join(
      os.tmpdir(),
      `jivahire_chat_log.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmp, content, "utf8");
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (e: unknown) {
      // EXDEV: cross-device rename — happens when os.tmpdir() and the
      // workspace are on different filesystems (common in containers and
      // when /tmp is tmpfs). Copy then unlink as a fallback so the atomicity
      // guarantee for readers of the destination still holds (the destination
      // is replaced in one writeFileSync call).
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EXDEV") {
        try {
          // Lift read-only before overwriting (set on a previous write), then
          // restore it after. swallow chmod errors — they're best-effort.
          try { fs.chmodSync(this.filePath, 0o644); } catch { /* swallow */ }
          fs.writeFileSync(this.filePath, content, "utf8");
          try { fs.chmodSync(this.filePath, 0o444); } catch { /* swallow */ }
          try { fs.unlinkSync(tmp); } catch { /* swallow */ }
          return;
        } catch (writeErr) {
          try { fs.unlinkSync(tmp); } catch { /* swallow */ }
          throw writeErr;
        }
      }
      try { fs.unlinkSync(tmp); } catch { /* swallow */ }
      throw e;
    }
    // Deny writes so the candidate cannot tamper with the chat history.
    // rename(2) is controlled by directory permissions, not file permissions,
    // so future atomic writes succeed even with the file marked read-only.
    try { fs.chmodSync(this.filePath, 0o444); } catch { /* swallow */ }
  }
}
