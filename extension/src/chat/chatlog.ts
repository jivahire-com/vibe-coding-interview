import * as fs from "fs";
import * as path from "path";

export interface ChatEntry {
  sequence: number;
  timestamp: number;
  prompt_text: string;
  response_text: string;
  model_used: string;
  prompt_tokens: number;
  response_tokens: number;
  response_latency_ms: number;
  topic_hint: string;
  correction_loop: boolean;
}

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

  append(entry: Omit<ChatEntry, "sequence">): void {
    try {
      const entries = ChatLog._parseEntries(fs.readFileSync(this.filePath, "utf8"));
      entries.push({ sequence: ++this.sequence, ...entry });
      this._atomicWrite(JSON.stringify(entries, null, 2));
    } catch (e) {
      console.warn("[ChatLog] append failed:", e);
    }
  }

  /**
   * Validate that the on-disk contents are a JSON array of entries. Returns
   * the array if valid; throws otherwise. Avoids the `existing.length` bug
   * where a corrupted `{}` would silently become `NaN` sequence numbers.
   */
  private static _parseEntries(raw: string): ChatEntry[] {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("chat log root is not an array");
    }
    return parsed as ChatEntry[];
  }

  /**
   * Write JSON to a sibling tmp file, then atomically rename it into place.
   *
   * Why: the auto-commit cycle (every 3 minutes) runs `git add -A` against
   * the workspace. If `git add` reads the chat-log mid-write, it stages a
   * truncated / partial-JSON file — corrupting the audit trail that the
   * grader depends on. `rename(2)` is atomic on POSIX, so a reader sees
   * either the old complete file or the new complete file, never a mix.
   */
  private _atomicWrite(content: string): void {
    const tmp = this.filePath + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, content, "utf8");
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      // The rename failed; make sure we don't leave a stale `.tmp-` file in
      // the workspace where the next `git add -A` would stage it.
      try { fs.unlinkSync(tmp); } catch { /* swallow */ }
      throw e;
    }
  }
}
