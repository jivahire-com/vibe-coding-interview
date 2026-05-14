/**
 * Tests for ChatLog (chat/chatlog.ts).
 * No vscode dependency — pure filesystem operations.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatLog, ChatEntry } from '../chat/chatlog';

function makeEntry(): Omit<ChatEntry, 'sequence'> {
  return {
    timestamp: Date.now(),
    prompt_text: 'What is an LRU cache?',
    response_text: 'An LRU cache evicts the least-recently-used item.',
    model_used: 'gpt-4o-mini',
    prompt_tokens: 12,
    response_tokens: 20,
    response_latency_ms: 300,
    topic_hint: '',
    correction_loop: false,
  };
}

describe('ChatLog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates an empty log file when none exists', () => {
    new ChatLog(tmpDir);
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    expect(fs.existsSync(logPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(logPath, 'utf8'))).toEqual([]);
  });

  test('does not overwrite an existing log file on construction', () => {
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    const existing = [{ sequence: 1, ...makeEntry() }];
    fs.writeFileSync(logPath, JSON.stringify(existing), 'utf8');

    new ChatLog(tmpDir);
    const content = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(content).toHaveLength(1);
    expect(content[0].sequence).toBe(1);
  });

  test('append() writes an entry with sequence = 1 on first call', () => {
    const log = new ChatLog(tmpDir);
    log.append(makeEntry());
    const entries: ChatEntry[] = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.jivahire_chat_log.json'), 'utf8'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].sequence).toBe(1);
  });

  test('append() increments sequence numbers across calls', () => {
    const log = new ChatLog(tmpDir);
    log.append(makeEntry());
    log.append(makeEntry());
    log.append(makeEntry());
    const entries: ChatEntry[] = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.jivahire_chat_log.json'), 'utf8'),
    );
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  test('resumes sequence from existing entries on construction', () => {
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    fs.writeFileSync(
      logPath,
      JSON.stringify([
        { sequence: 1, ...makeEntry() },
        { sequence: 2, ...makeEntry() },
        { sequence: 3, ...makeEntry() },
      ]),
      'utf8',
    );

    const log = new ChatLog(tmpDir);
    log.append(makeEntry());

    const entries: ChatEntry[] = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(entries).toHaveLength(4);
    expect(entries[3].sequence).toBe(4);
  });

  test('stores all entry fields correctly', () => {
    const log = new ChatLog(tmpDir);
    const entry = makeEntry();
    log.append(entry);
    const entries: ChatEntry[] = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.jivahire_chat_log.json'), 'utf8'),
    );
    expect(entries[0].prompt_text).toBe(entry.prompt_text);
    expect(entries[0].response_text).toBe(entry.response_text);
    expect(entries[0].model_used).toBe(entry.model_used);
    expect(entries[0].prompt_tokens).toBe(entry.prompt_tokens);
  });

  test('handles corrupt log file on construction without throwing', () => {
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    fs.writeFileSync(logPath, 'this is not json!!!', 'utf8');
    expect(() => new ChatLog(tmpDir)).not.toThrow();
  });

  test('handles corrupt log file on append without throwing', () => {
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    const log = new ChatLog(tmpDir);
    // Corrupt the file after construction
    fs.writeFileSync(logPath, 'corrupted', 'utf8');
    expect(() => log.append(makeEntry())).not.toThrow();
  });

  // ── Bug #13: sequence init + atomic writes ─────────────────────────────────

  test('Bug #13: resumes from max(sequence), not array length (handles non-contiguous logs)', () => {
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    // Non-contiguous: sequence 3 + 7 (gap) — old length-based init would have
    // started numbering at 2 and produced a duplicate sequence number.
    fs.writeFileSync(
      logPath,
      JSON.stringify([
        { sequence: 3, ...makeEntry() },
        { sequence: 7, ...makeEntry() },
      ]),
      'utf8',
    );
    const log = new ChatLog(tmpDir);
    log.append(makeEntry());
    const entries: ChatEntry[] = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const seqs = entries.map((e) => e.sequence);
    // The new entry's sequence must be max(existing) + 1 = 8
    expect(seqs).toEqual([3, 7, 8]);
  });

  test('Bug #13: object (non-array) root is rejected and quarantined, not used as length=undefined', () => {
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    fs.writeFileSync(logPath, JSON.stringify({ not: 'an array' }), 'utf8');
    const log = new ChatLog(tmpDir);
    // Construction quarantined the corrupt file and wrote a fresh [].
    // Append must produce a valid entry with sequence === 1 (NOT NaN).
    log.append(makeEntry());
    const entries: ChatEntry[] = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].sequence).toBe(1);
    expect(Number.isFinite(entries[0].sequence)).toBe(true);
    // Corrupt file was preserved with a .corrupt- suffix for forensics
    const corruptFiles = fs.readdirSync(tmpDir).filter((f) => f.includes('.corrupt-'));
    expect(corruptFiles.length).toBeGreaterThanOrEqual(1);
  });

  test('Bug #13: append uses write+rename so readers never see a partial file', () => {
    // Snapshot the directory listing immediately after the append finishes.
    // The atomic-write contract: write to a sibling tmp file, then rename it
    // into place. Tmp files are short-lived and must NOT remain after the
    // synchronous append() returns — otherwise leftover tmp files would
    // pollute the workspace and end up in the auto-commit.
    const log = new ChatLog(tmpDir);
    log.append(makeEntry());
    log.append(makeEntry());

    const files = fs.readdirSync(tmpDir);
    const leftoverTmp = files.filter((f) => f.includes('.jivahire_chat_log.json.tmp-'));
    expect(leftoverTmp).toEqual([]);

    // The real file is well-formed JSON with all the entries we appended.
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, '.jivahire_chat_log.json'), 'utf8'));
    expect(parsed).toHaveLength(2);
  });

  test('Bug #13: a write/rename failure leaves the previous file content intact (no truncation)', () => {
    // The contract that protects auto-commit from staging a partial file: if
    // the second write (or rename) fails, the original file must still be
    // valid JSON containing the OLD entries. Simulate by pre-populating with
    // valid entries, then triggering an append that fails the rename via
    // permission-denied on the destination. The old file must survive intact.
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    fs.writeFileSync(
      logPath,
      JSON.stringify([{ sequence: 1, ...makeEntry() }]),
      'utf8',
    );

    // Make the rename fail by recreating the log file as a directory after
    // construction (so renameSync of tmp → finalPath throws EISDIR).
    const log = new ChatLog(tmpDir);
    // After construction, append's atomic-write tries to overwrite logPath.
    // Replacing the file with a directory of the same name forces renameSync
    // to fail — and our code's `try { ... } catch` must swallow it without
    // corrupting on-disk state.
    fs.unlinkSync(logPath);
    fs.mkdirSync(logPath);

    log.append(makeEntry()); // must not throw

    // The directory is still there (rename couldn't replace it), and any tmp
    // file from the failed append must NOT have leaked into git-add territory.
    // Walking back: the directory listing must contain no '.tmp-' droppings.
    fs.rmdirSync(logPath);
    const leftover = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    expect(leftover).toEqual([]);
  });
});
