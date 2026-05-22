/**
 * Tests for ChatViewProvider (chat/view.ts).
 *
 * Covers:
 *  Bug #3  – resolveWebviewView() after setConfig() renders the chat UI
 *  Bug #4  – handleMessage("send") with no config does not crash
 *  Bug #7  – ChatLog is created with the correct workspace path
 *  Bug #15 – dispose() does not throw (provider is disposable)
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ChatViewProvider, buildFileFence, STREAM_TIMEOUT_MS } from '../chat/view';
import * as vscode from 'vscode';
import { makeConfig, makeMockContext, makeMockWebviewView } from './helpers';

// We don't want ChatLog to actually touch the filesystem in most tests.
// Override workspaceFolders to a real temp dir where needed.
describe('ChatViewProvider', () => {
  let context: ReturnType<typeof makeMockContext>;
  let provider: ChatViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-view-test-'));
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: tmpDir } },
    ];
    context = makeMockContext();
    provider = new ChatViewProvider(context);
    view = makeMockWebviewView();
  });

  afterEach(() => {
    provider.dispose();
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Bug #3 ────────────────────────────────────────────────────────────────

  test('Bug #3: resolveWebviewView() after setConfig() renders chat HTML', () => {
    const config = makeConfig();
    provider.setConfig(config);
    provider.resolveWebviewView(view, {} as any, {} as any);

    expect(view.webview.html).toContain('model-select');
    expect(view.webview.html).toContain('budget');
  });

  test('resolveWebviewView() without config produces no HTML (render guard)', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    // render() returns early when config is not set
    expect(view.webview.html).toBe('');
  });

  test('setConfig() before resolve stores config; resolve then renders', () => {
    provider.setConfig(makeConfig());
    // view not yet set — html is still empty
    expect(view.webview.html).toBe('');
    provider.resolveWebviewView(view, {} as any, {} as any);
    expect(view.webview.html).not.toBe('');
  });

  // ── Bug #4 ────────────────────────────────────────────────────────────────

  test('Bug #4: send message with no config does not crash', () => {
    let msgHandler: ((m: any) => void) | undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });

    provider.resolveWebviewView(view, {} as any, {} as any);

    // Config not set — send command must be silently ignored
    expect(() => {
      msgHandler?.({ command: 'send', text: 'hello world' });
    }).not.toThrow();
  });

  test('Bug #4: copyText command without config does not crash', () => {
    let msgHandler: ((m: any) => void) | undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });
    provider.resolveWebviewView(view, {} as any, {} as any);
    expect(() => {
      msgHandler?.({ command: 'copyText', text: 'some text' });
    }).not.toThrow();
  });

  // ── Bug #7 ────────────────────────────────────────────────────────────────

  test('Bug #7: ChatLog created with the current workspace path', () => {
    const config = makeConfig();
    provider.setConfig(config);

    // The chat log file should exist in the temp workspace
    const logFile = path.join(tmpDir, '.jivahire_chat_log.json');
    expect(fs.existsSync(logFile)).toBe(true);
  });

  test('Bug #7: second setConfig() call does not recreate ChatLog with wrong path', () => {
    const config = makeConfig();
    provider.setConfig(config);

    const logFileBefore = path.join(tmpDir, '.jivahire_chat_log.json');
    const mtimeBefore = fs.statSync(logFileBefore).mtimeMs;

    // Change workspace — should NOT affect the already-created ChatLog
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-view-test2-'));
    try {
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir2 } }];
      provider.setConfig(config); // second call — ChatLog guard should prevent recreation

      // original log file still exists and is the one being used
      expect(fs.existsSync(logFileBefore)).toBe(true);
      // new dir does NOT get a log file (ChatLog not recreated)
      expect(fs.existsSync(path.join(tmpDir2, '.jivahire_chat_log.json'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  // ── Bug #15 / dispose ─────────────────────────────────────────────────────

  test('Bug #15: dispose() does not throw', () => {
    expect(() => provider.dispose()).not.toThrow();
  });

  test('dispose() can be called multiple times safely', () => {
    expect(() => {
      provider.dispose();
      provider.dispose();
    }).not.toThrow();
  });

  // ── General render behaviour ──────────────────────────────────────────────

  test('render() is no-op when view is not set', () => {
    provider.setConfig(makeConfig());
    // render() is called internally but view is undefined — no throw
    // (resolveWebviewView not called yet)
    expect(view.webview.html).toBe('');
  });

  test('rendered HTML contains model label from config', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig({ chatModel: 'openai/gpt-4o' }));
    expect(view.webview.html).toContain('Gpt 4o');
  });

  // ── Bug #1: budget exhausted state persists across renders ────────────────

  test('Bug #1: budgetExhausted state disables input and shows banner on render', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    // Simulate the budgetExhausted being set (as send() would on the error chunk)
    (provider as any).budgetExhausted = true;
    (provider as any).render();

    const html: string = view.webview.html;
    // Banner is visible
    expect(html).toMatch(/id="budget-warn"[^>]*display:block/);
    // Input is disabled
    expect(html).toMatch(/<vscode-text-area[^>]*disabled/);
    // Send button is disabled
    expect(html).toMatch(/id="send-btn"[^>]*disabled/);
  });

  test('Bug #1: fresh session (budget not exhausted) has banner hidden + input enabled', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    const html: string = view.webview.html;
    expect(html).not.toMatch(/id="budget-warn"[^>]*display:block/);
    // No `disabled` attribute on the text-area
    expect(html).not.toMatch(/<vscode-text-area[^>]*disabled/);
  });

  // ── Bug #4/#5: per-message model badge ────────────────────────────────────

  test('Bug #4/#5: assistant message badges use the per-message model, not current selection', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig({
      chatModel: 'openai/gpt-4o-mini',
      availableChatModels: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
    }));

    // Manually push messages as if two different models were used historically
    (provider as any).messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1', model: 'openai/gpt-4o-mini', promptTokens: 10, completionTokens: 20, latencyMs: 100 },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2', model: 'openai/gpt-4o', promptTokens: 10, completionTokens: 20, latencyMs: 100 },
    ];
    // Switch the "current" selection to gpt-4o
    (provider as any).selectedModel = 'openai/gpt-4o';
    (provider as any).render();

    const html: string = view.webview.html;
    // Past message badges must reflect the model used at send time
    expect(html).toMatch(/Gpt 4o Mini/);
    expect(html).toMatch(/Gpt 4o/);
  });

  // ── Bug #11: file fence escalation ────────────────────────────────────────

  test('Bug #11: file fence escalates beyond longest backtick run', () => {
    const content = 'before\n```\nthis is markdown inside the file\n```\nafter';
    const block = buildFileFence('README.md', 'markdown', content);
    // Longest backtick run in content is 3 → fence must be at least 4
    expect(block).toMatch(/````markdown/);
    expect(block).toMatch(/\n````\n/);
  });

  test('Bug #11: plain file uses 3-backtick fence', () => {
    const block = buildFileFence('foo.py', 'python', 'def foo():\n    pass');
    expect(block).toMatch(/```python/);
    expect(block).not.toMatch(/````python/);
  });

  test('Bug #11: handles multiple backtick runs of varying length', () => {
    const content = 'a `single` and a ```triple``` and `````five`````';
    const block = buildFileFence('x.md', 'md', content);
    // Longest run is 5 backticks → fence must be ≥6
    const fenceMatch = block.match(/^# (File context|Current)[^\n]*\n[^\n]*\n(`+)/m);
    expect(fenceMatch).not.toBeNull();
    expect(fenceMatch![2].length).toBeGreaterThanOrEqual(6);
  });

  // ── Sanity: STREAM_TIMEOUT_MS is reasonable ───────────────────────────────

  test('Bug #3: STREAM_TIMEOUT_MS is finite and below 5 minutes', () => {
    expect(STREAM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STREAM_TIMEOUT_MS).toBeLessThan(5 * 60_000);
  });

  // ── Regression: chat HTML contains no inline event handlers ───────────────
  // The webview's CSP is `script-src ${cspSource} 'nonce-${nonce}'` with no
  // `'unsafe-inline'`, so any `onclick=` / `onchange=` attribute is silently
  // dropped by the browser and the corresponding control becomes a no-op.

  test('chat HTML has no inline on* attributes (CSP would block them)', () => {
    provider.setConfig(makeConfig());
    provider.resolveWebviewView(view, {} as any, {} as any);
    const html: string = view.webview.html;
    // The static markup must be CSP-clean.
    expect(html).not.toMatch(/\son(click|change|input|submit|keydown|keyup)\s*=/i);
  });

  test('chip buttons in the empty state expose their prompt via data-chip', () => {
    provider.setConfig(makeConfig());
    provider.resolveWebviewView(view, {} as any, {} as any);
    const html: string = view.webview.html;
    // Empty state renders the chips
    expect(html).toMatch(/data-chip="/);
    // And not the broken inline form
    expect(html).not.toMatch(/onclick="useChip/);
  });

  test('model selector has an id so the nonce-script can listen for changes', () => {
    provider.setConfig(makeConfig());
    provider.resolveWebviewView(view, {} as any, {} as any);
    const html: string = view.webview.html;
    expect(html).toMatch(/<select[^>]*id="model-select"/);
    expect(html).not.toMatch(/onchange="changeModel/);
  });
});

// ── Bug #2 / #3 / #10: streamChat against a real http server ───────────────

import * as http from 'http';

describe('ChatViewProvider streamChat error handling', () => {
  let context: ReturnType<typeof makeMockContext>;
  let provider: ChatViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;

  beforeEach((done) => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-view-err-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    context = makeMockContext();
    provider = new ChatViewProvider(context);
    view = makeMockWebviewView();
    server = http.createServer();
    server.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterEach((done) => {
    provider.dispose();
    server.close(() => {
      (vscode.workspace as any).workspaceFolders = undefined;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      done();
    });
  });

  function setupSend(text: string): Promise<void> {
    let msgHandler: ((m: any) => void) | undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.resolveWebviewView(view, {} as any, {} as any);

    // We need to wait until isLoading flips back to false (send() completes)
    return new Promise<void>((resolve) => {
      msgHandler?.({ command: 'send', text });
      const poll = setInterval(() => {
        if ((provider as any).isLoading === false) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
  }

  test('Bug #2: 500 response surfaces error and does NOT log to chat', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });

    await setupSend('hello');

    // The error message must have surfaced
    expect((vscode.window.showErrorMessage as jest.Mock)).toHaveBeenCalled();
    const arg = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0];
    expect(arg).toMatch(/AI chat error/);

    // Chat log must NOT contain an "Error:" response
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(entries).toEqual([]);

    // The optimistically-pushed user message must have been removed so the user can retry
    expect((provider as any).messages).toEqual([]);

    // Bug #15: the original prompt must be sent BACK to the webview so the
    // user can retry without re-typing. The webview cleared the textarea on
    // send; without this restorePrompt the candidate had to start over.
    const postCalls = (view.webview.postMessage as jest.Mock).mock.calls;
    const restoreCall = postCalls.find((c: unknown[]) => {
      const m = c[0] as { command: string; text?: string };
      return m.command === 'restorePrompt';
    });
    expect(restoreCall).toBeDefined();
    expect(restoreCall![0]).toEqual({ command: 'restorePrompt', text: 'hello' });
  });

  test('Bug #2: 402 budget-exceeded surfaces as an error, no silent success', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'budget exhausted' }));
    });

    await setupSend('still trying');

    expect((vscode.window.showErrorMessage as jest.Mock)).toHaveBeenCalled();
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(entries).toEqual([]);
  });

  test('Bug #10: successful response IS logged with the request-time model', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }) + '\n');
      res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
    });

    let msgHandler: ((m: any) => void) | undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });
    provider.setConfig(makeConfig({
      llmProxyUrl: baseUrl,
      chatModel: 'openai/gpt-4o-mini',
      availableChatModels: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
    }));
    provider.resolveWebviewView(view, {} as any, {} as any);

    const done = new Promise<void>((resolve) => {
      msgHandler?.({ command: 'send', text: 'hi' });
      const poll = setInterval(() => {
        if ((provider as any).isLoading === false &&
            (provider as any).messages.length === 2) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    // Before send completes, "user" switches the model — must NOT change the
    // recorded model for the in-flight request.
    setTimeout(() => {
      msgHandler?.({ command: 'changeModel', model: 'openai/gpt-4o' });
    }, 10);

    await done;

    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].response_text).toBe('Hello world');
    // The logged model must be the request-time model, not the post-switch model
    expect(entries[0].model_used).toBe('openai/gpt-4o-mini');

    // Per-message model is captured on the assistant message
    const msgs = (provider as any).messages;
    expect(msgs[1].model).toBe('openai/gpt-4o-mini');
  });

  test('Bug #2: budget-exhausted chunk sets persistent state, banner survives render', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) + '\n');
      res.write('data: ' + JSON.stringify({ error: { message: 'budget exhausted' } }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
    });

    await setupSend('hello');

    // The provider must have flagged budgetExhausted
    expect((provider as any).budgetExhausted).toBe(true);
    // And the rendered HTML must show the banner + disabled input
    expect(view.webview.html).toMatch(/id="budget-warn"[^>]*display:block/);
    expect(view.webview.html).toMatch(/<vscode-text-area[^>]*disabled/);
  });

  // ── Review-Bug 2: budget-exhausted response is NOT logged to chat-log ──

  test('Review-Bug 2: budget-exhausted stream does NOT append a phantom assistant turn', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Server delivers ONE delta chunk, then the budget error before [DONE]
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'half-' } }] }) + '\n');
      res.write('data: ' + JSON.stringify({ error: { message: 'budget exhausted' } }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
    });

    await setupSend('what is the answer?');

    // Pre-fix, this would log an entry with response_text='half-' and
    // prompt_text='what is the answer?' — polluting the audit trail.
    const logPath = path.join(tmpDir, '.jivahire_chat_log.json');
    const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(entries).toEqual([]);

    // The optimistic user message must also be removed from the in-memory
    // history so the visible chat matches what was actually exchanged.
    expect((provider as any).messages).toEqual([]);

    // Provider stays flagged as budget-exhausted across renders.
    expect((provider as any).budgetExhausted).toBe(true);
  });

  // ── Review-Bug 12: malformed SSE chunks are logged, not silently dropped ──

  test('Review-Bug 12: malformed SSE chunks emit a warning to the console', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // First chunk is valid; second is malformed JSON; third is the [DONE] sentinel.
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n');
      res.write('data: {malformed json\n');
      res.write('data: [DONE]\n');
      res.end();
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await setupSend('hi');
      // The malformed chunk produced a console.warn — pre-fix it was swallowed.
      const malformedWarn = warnSpy.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('dropped malformed SSE chunk'),
      );
      expect(malformedWarn).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── Bug A: budget-exhausted SSE stream restores the candidate's prompt ──
  //
  // Symmetry with the generic error path: the textarea is cleared on send, so
  // if the request fails (including budget exhaustion mid-stream) we MUST send
  // a `restorePrompt` postMessage so the candidate doesn't lose their text.

  test('Bug A: budget-exhausted mid-stream sends restorePrompt with original text', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ error: { message: 'budget exhausted' } }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
    });

    const userText = 'a long carefully crafted prompt the candidate worked hard on';
    await setupSend(userText);

    expect((provider as any).budgetExhausted).toBe(true);

    const postCalls = (view.webview.postMessage as jest.Mock).mock.calls;
    const restoreCall = postCalls.find((c: unknown[]) => {
      const m = c[0] as { command: string; text?: string };
      return m.command === 'restorePrompt';
    });
    expect(restoreCall).toBeDefined();
    expect(restoreCall![0]).toEqual({ command: 'restorePrompt', text: userText });
  });

  // ── Bug B: changeModel clears budget-exhausted flag ──────────────────────
  //
  // The server enforces the per-model budget; if the candidate switches to a
  // cheaper model, the textarea must re-enable so they can try the cheaper
  // model. The next send will re-flag if the new model is also over budget.

  test('Bug B: changeModel resets budgetExhausted and re-enables the input', async () => {
    let msgHandler: ((m: unknown) => void) | undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });
    provider.setConfig(makeConfig({
      llmProxyUrl: baseUrl,
      availableChatModels: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
    }));
    provider.resolveWebviewView(view, {} as any, {} as any);

    (provider as any).budgetExhausted = true;
    (provider as any).render();
    // Sanity: rendered HTML reflects the disabled state pre-switch.
    expect(view.webview.html).toMatch(/id="budget-warn"[^>]*display:block/);
    expect(view.webview.html).toMatch(/<vscode-text-area[^>]*disabled/);

    msgHandler!({ command: 'changeModel', model: 'openai/gpt-4o' });

    expect((provider as any).budgetExhausted).toBe(false);
    const html: string = view.webview.html;
    expect(html).not.toMatch(/id="budget-warn"[^>]*display:block/);
    expect(html).not.toMatch(/<vscode-text-area[^>]*disabled/);
    expect(html).not.toMatch(/id="send-btn"[^>]*disabled/);
  });

  // ── Bug C: HTTP error strings are humanized before reaching the toast ────

  test('Bug C: 402 surfaces plain-English budget message, not raw HTTP', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(402, { 'Content-Type': 'text/html' });
      res.end('<html>budget exceeded</html>');
    });
    await setupSend('hi');
    const arg = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0] as string;
    expect(arg).not.toMatch(/HTTP 402/);
    expect(arg).not.toMatch(/<html>/);
    expect(arg.toLowerCase()).toMatch(/budget/);
  });

  test('Bug C: 429 surfaces a rate-limit retry message, not raw HTTP', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('rate limit slammed');
    });
    await setupSend('hi');
    const arg = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0] as string;
    expect(arg).not.toMatch(/HTTP 429/);
    expect(arg).not.toMatch(/rate limit slammed/);
    expect(arg.toLowerCase()).toMatch(/too many requests|retry/);
  });

  test('Bug C: 500 surfaces a service-unavailable message, not raw HTML body', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<html><body>nginx 500</body></html>');
    });
    await setupSend('hi');
    const arg = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0] as string;
    expect(arg).not.toMatch(/HTTP 500/);
    expect(arg).not.toMatch(/<html>/);
    expect(arg).not.toMatch(/nginx/);
    expect(arg.toLowerCase()).toMatch(/temporarily unavailable|retry/);
  });
});

// ── Review-Bug 1: Apply button persists in the rendered (non-streaming) HTML ──

describe('ChatViewProvider rendered code-block markup (Review-Bug 1)', () => {
  let context: ReturnType<typeof makeMockContext>;
  let provider: ChatViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-view-render-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    context = makeMockContext();
    provider = new ChatViewProvider(context);
    view = makeMockWebviewView();
  });

  afterEach(() => {
    provider.dispose();
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Review-Bug 1: persistent assistant fence renders with Apply + Copy data attributes', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    (provider as any).messages = [
      { role: 'user', content: 'show me' },
      {
        role: 'assistant',
        content: 'Here is the code:\n```cpp file=src/lru.cpp\nint x = 1;\n```\nDone.',
        model: 'openai/gpt-4o-mini',
        promptTokens: 1, completionTokens: 1, latencyMs: 10,
      },
    ];
    (provider as any).render();

    const html: string = view.webview.html;
    // Pre-fix, the TS-side formatContent emitted bare <pre><code> only.
    // Post-fix, it must mirror the streaming-side HTML and include the Apply
    // and Copy data attributes the webview's click delegate listens for.
    expect(html).toMatch(/data-apply-block-id="blk-rendered-/);
    expect(html).toMatch(/data-apply-file="src\/lru\.cpp"/);
    expect(html).toMatch(/data-apply-lang="cpp"/);
    expect(html).toMatch(/data-apply-encoded="/);
    expect(html).toMatch(/data-copy-encoded="/);
    // Apply button label includes the file basename
    expect(html).toMatch(/Apply to lru\.cpp/);
  });

  test('fence without file= renders Apply button as ENABLED with file-picker tooltip', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    (provider as any).messages = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '```python\ndef foo(): pass\n```',
        model: 'openai/gpt-4o-mini',
        promptTokens: 1, completionTokens: 1, latencyMs: 10,
      },
    ];
    (provider as any).render();
    const html: string = view.webview.html;
    expect(html).toMatch(/data-apply-block-id="blk-rendered-/);
    expect(html).toMatch(/data-apply-lang="python"/);
    // No file= → label invites the candidate to pick a file. Button is ENABLED:
    // clicking it opens a workspace file picker rather than blocking the user.
    expect(html).toMatch(/Apply to file/);
    const applyMatch = /<button[^>]*class="code-btn apply-btn"[^>]*>/.exec(html);
    expect(applyMatch).not.toBeNull();
    expect(applyMatch![0]).not.toMatch(/\bdisabled\b/);
    expect(applyMatch![0]).toMatch(/click to pick one from your workspace/);
  });

  test('Review-Bug 1: code content is HTML-escaped (no XSS through assistant fences)', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    (provider as any).messages = [
      { role: 'assistant', content: '```html\n<script>alert(1)</script>\n```',
        model: 'openai/gpt-4o-mini', promptTokens: 1, completionTokens: 1, latencyMs: 1 },
    ];
    (provider as any).render();
    const html: string = view.webview.html;
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('Apply + Copy buttons swap their label after a click for visible feedback', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    const html: string = view.webview.html;
    // The webview-side click handlers must call flashButtonLabel so the user
    // sees "Copied!" / "Opening diff…" instead of an unresponsive button. The
    // copy/apply paths used to fire postMessage silently — users routinely
    // reported "the button doesn't work" because the click had no visible
    // effect even though the round-trip succeeded.
    expect(html).toContain('flashButtonLabel');
    expect(html).toContain('Copied!');
    expect(html).toContain('Opening diff');
  });

  // ── System prompt enforces file= on every code fence ───────────────────
  //
  // The Apply button is gated on `file=path` being present. Without a server-
  // side prompt instructing the LLM to include it, the AI commonly emits bare
  // ```cpp` fences which leave Apply disabled. We inject a system prompt at
  // request time so the AI consistently produces file=-tagged code blocks.

  test('streamChat injects a system prompt instructing the LLM to use file=path', async () => {
    const testServer = http.createServer();
    const receivedBodies: any[] = [];
    testServer.on('request', (req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', () => {
        receivedBodies.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n');
        res.write('data: [DONE]\n');
        res.end();
      });
    });
    await new Promise<void>((r) => testServer.listen(0, r));
    const port = (testServer.address() as { port: number }).port;

    try {
      let msgHandler: ((m: any) => void) | undefined;
      const localView = makeMockWebviewView();
      const localProvider = new ChatViewProvider(makeMockContext());
      localView.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
        msgHandler = cb;
        return { dispose: jest.fn() };
      });
      localProvider.setConfig(makeConfig({ llmProxyUrl: `http://127.0.0.1:${port}` }));
      localProvider.resolveWebviewView(localView, {} as any, {} as any);

      await new Promise<void>((resolve) => {
        msgHandler!({ command: 'send', text: 'help me' });
        const poll = setInterval(() => {
          if ((localProvider as any).isLoading === false) { clearInterval(poll); resolve(); }
        }, 20);
      });

      expect(receivedBodies.length).toBe(1);
      const msgs = receivedBodies[0].messages as Array<{ role: string; content: string }>;
      // First message is the system prompt.
      expect(msgs[0].role).toBe('system');
      // It must instruct the LLM to use the file= syntax.
      expect(msgs[0].content).toMatch(/file=/);
      // The "Apply button is disabled without file=" gating MUST be mentioned
      // so the LLM understands the practical consequence.
      expect(msgs[0].content.toLowerCase()).toMatch(/apply/);
    } finally {
      await new Promise<void>((r) => testServer.close(() => r()));
    }
  });

  // ── Review-Bug 6: chat view honours server-supplied pricing ────────────

  test('Review-Bug 6: spent meter uses server-supplied pricing for unknown models', async () => {
    // Set up a real local SSE server that returns one chunk + usage.
    const testServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n');
      res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
    });
    await new Promise<void>((r) => testServer.listen(0, r));
    const port = (testServer.address() as { port: number }).port;
    try {
      let msgHandler: ((m: unknown) => void) | undefined;
      view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
        msgHandler = cb;
        return { dispose: jest.fn() };
      });
      // Use a model name NOT in the bundled DEFAULT_MODEL_PRICING. Server-
      // supplied pricing must take precedence.
      provider.setConfig(makeConfig({
        llmProxyUrl: `http://127.0.0.1:${port}`,
        chatModel: 'mystery/super-cheap',
        availableChatModels: ['mystery/super-cheap'],
        pricingPerMillion: { 'mystery/super-cheap': { input: 0.01, output: 0.02 } },
      }));
      provider.resolveWebviewView(view, {} as any, {} as any);

      await new Promise<void>((resolve) => {
        msgHandler!({ command: 'send', text: 'hi' });
        const poll = setInterval(() => {
          if ((provider as any).isLoading === false &&
              (provider as any).messages.length === 2) {
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });

      // 1M prompt tokens × $0.01 + 1M completion tokens × $0.02 = $0.03
      expect((provider as any).spentUsd).toBeCloseTo(0.03, 4);
    } finally {
      await new Promise<void>((r) => testServer.close(() => r()));
    }
  });
});

