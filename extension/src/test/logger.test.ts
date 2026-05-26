import { Logger, setSharedLogger, getLogger, MAX_BUFFERED_RECORDS } from "../logger";
import type { SessionConfig } from "../api";

// Capture POST bodies sent by the Logger. http/https.request are mocked at
// module level — both libraries route through `_mockRequest` so a test can
// assert on the wire format and toggle success/failure between calls.
let _lastPosts: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
let _postOutcome: { ok: boolean; status?: number } = { ok: true, status: 204 };

function _mockRequest(opts: any, cb: (res: any) => void) {
  const chunks: Buffer[] = [];
  const req: any = {
    on(_evt: string, _fn: any) { return req; },
    write(b: any) { chunks.push(Buffer.from(b)); },
    setTimeout(_ms: number, _fn: any) { /* never fires in tests */ },
    destroy() { /* no-op */ },
    end() {
      // Synchronous-ish: schedule the response on the next microtask so the
      // Logger's POST Promise settles when the test awaits log.flush().
      const fire = () => {
        const status = _postOutcome.status ?? (_postOutcome.ok ? 204 : 500);
        if (_postOutcome.ok) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            _lastPosts.push({
              url: `${opts.hostname}:${opts.port ?? ""}${opts.path}`,
              body,
              headers: opts.headers,
            });
          } catch { /* malformed — ignore in tests */ }
        }
        cb({
          statusCode: status,
          on(evt: string, fn: any) {
            if (evt === "data") fn(Buffer.from(""));
            if (evt === "end") fn();
          },
        });
      };
      // Use queueMicrotask so it runs without waiting for the macrotask queue.
      queueMicrotask(fire);
    },
  };
  return req;
}

jest.mock("http", () => ({ request: jest.fn(_mockRequest) }));
jest.mock("https", () => ({ request: jest.fn(_mockRequest) }));

function makeContext(prePersisted: any = undefined) {
  const store: Record<string, unknown> = {};
  if (prePersisted !== undefined) store["vibe.logger.buffer"] = prePersisted;
  return {
    globalState: {
      get: jest.fn((k: string, d?: unknown) => (k in store ? store[k] : d)),
      update: jest.fn(async (k: string, v: unknown) => { store[k] = v; }),
      _store: store,
    },
    subscriptions: [] as Array<{ dispose(): void }>,
  } as any;
}

function makeConfig(): SessionConfig {
  return {
    sessionId: "sid-1",
    sessionKey: "KEY-001",
    repoUrl: "https://github.com/test/repo",
    branch: "interview/sid-1",
    githubToken: "ghtok",
    githubTokenExpiresAt: Date.now() + 60 * 60_000,
    llmProxyUrl: "http://server.test:1234",
    maxMinutes: 90,
    llmBudgetUsd: 2,
    challengeId: "cpp-lru-cache",
    challengeDescription: "",
    chatModel: "openai/gpt-4o-mini",
    availableChatModels: ["openai/gpt-4o-mini"],
    startedAt: Date.now(),
    pricingPerMillion: {},
  };
}

beforeEach(() => {
  _lastPosts = [];
  _postOutcome = { ok: true, status: 204 };
});

// ── basic emission ────────────────────────────────────────────────────────

test("each call writes a line to the OutputChannel and buffers the record", () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.info("hello", { k: 1 });
  log.warn("warn-msg");
  log.error("err-msg", { detail: "x" });
  expect(log.channel.appendLine).toHaveBeenCalledTimes(3);
  log.dispose();
});

test("setLevel suppresses records below the minimum", () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.setLevel("WARNING");
  log.debug("ignored");
  log.info("ignored");
  log.warn("kept");
  expect(log.channel.appendLine).toHaveBeenCalledTimes(1);
  log.dispose();
});

// ── pre-session buffering ─────────────────────────────────────────────────

test("flush is a no-op until a session is attached", async () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.info("pre-session");
  await log.flush();
  expect(_lastPosts.length).toBe(0);
  log.dispose();
});

test("setSession drains any pre-session records to the server", async () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.info("pre-1");
  log.info("pre-2");
  log.setSession(makeConfig());
  // setSession calls flush() in a void chain — await our own to give it a tick.
  await log.flush();
  expect(_lastPosts.length).toBeGreaterThanOrEqual(1);
  const allMessages = _lastPosts.flatMap((p) => p.body.records.map((r: any) => r.message));
  expect(allMessages).toEqual(expect.arrayContaining(["pre-1", "pre-2"]));
  expect(_lastPosts[0].headers["Authorization"]).toBe("Bearer KEY-001");
  log.dispose();
});

// ── persistence across crashes ────────────────────────────────────────────

test("restores buffered records from globalState on construction", async () => {
  const persisted = [
    { id: "old-1", ts: 1, level: "INFO" as const, message: "before-crash" },
  ];
  const ctx = makeContext(persisted);
  const log = new Logger(ctx);
  log.info("after-restart");
  log.setSession(makeConfig());
  await log.flush();
  const sent = _lastPosts.flatMap((p) => p.body.records.map((r: any) => r.message));
  expect(sent).toEqual(expect.arrayContaining(["before-crash", "after-restart"]));
  log.dispose();
});

test("dispose snapshots the buffer to globalState so activate() can resume", () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.info("not-yet-flushed-1");
  log.info("not-yet-flushed-2");
  log.dispose();
  const persisted = ctx.globalState._store["vibe.logger.buffer"] as Array<{ message: string }>;
  expect(persisted.map((r) => r.message)).toEqual(
    ["not-yet-flushed-1", "not-yet-flushed-2"],
  );
});

// ── failure path ──────────────────────────────────────────────────────────

test("on flush failure, records are restored at the head and resent on the next flush", async () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.setSession(makeConfig());
  await log.flush();  // drain any startup state
  _lastPosts = [];

  _postOutcome = { ok: false, status: 503 };
  log.info("A");
  log.info("B");
  await log.flush();
  // After the failed flush, nothing was successfully captured in _lastPosts.
  expect(_lastPosts.length).toBe(0);

  // A new record arrives during/after the failed POST; the next flush
  // should send [A, B, C] — old records first, no duplicates.
  log.info("C");
  _postOutcome = { ok: true, status: 204 };
  await log.flush();

  const sent = _lastPosts.flatMap((p) => p.body.records.map((r: any) => r.message));
  expect(sent).toEqual(["A", "B", "C"]);
  log.dispose();
});

test("errorFromException attaches error_class, error_message, and stack as context", async () => {
  const ctx = makeContext();
  const log = new Logger(ctx);
  log.setSession(makeConfig());
  await log.flush();
  _lastPosts = [];

  const err = new TypeError("nope");
  log.errorFromException("op_failed", err, { file: "x.ts" });
  await log.flush();

  const rec = _lastPosts[0].body.records[0];
  expect(rec.level).toBe("ERROR");
  expect(rec.context.error_class).toBe("TypeError");
  expect(rec.context.error_message).toBe("nope");
  expect(typeof rec.context.stack).toBe("string");
  expect(rec.context.file).toBe("x.ts");  // caller-supplied context preserved
  log.dispose();
});

// ── shared-instance accessor ──────────────────────────────────────────────

test("setSharedLogger / getLogger expose the singleton; dispose clears it", () => {
  expect(getLogger()).toBeUndefined();
  const ctx = makeContext();
  const log = new Logger(ctx);
  setSharedLogger(log);
  expect(getLogger()).toBe(log);
  log.dispose();
  expect(getLogger()).toBeUndefined();
});

// ── safety cap ────────────────────────────────────────────────────────────

test("MAX_BUFFERED_RECORDS export is sane (guards against accidentally removing the cap)", () => {
  expect(MAX_BUFFERED_RECORDS).toBeGreaterThan(0);
  expect(MAX_BUFFERED_RECORDS).toBeLessThanOrEqual(50_000);
});
