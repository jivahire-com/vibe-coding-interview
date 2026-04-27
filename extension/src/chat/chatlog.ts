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
      fs.writeFileSync(this.filePath, "[]", "utf8");
    } else {
      try {
        const existing = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        this.sequence = existing.length;
      } catch {}
    }
  }

  append(entry: Omit<ChatEntry, "sequence">): void {
    try {
      const entries: ChatEntry[] = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      entries.push({ sequence: ++this.sequence, ...entry });
      fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), "utf8");
    } catch {}
  }
}
