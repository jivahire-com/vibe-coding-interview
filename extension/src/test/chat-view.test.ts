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

  test('budget display shows $0.000 spent on fresh session', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig({ llmBudgetUsd: 2.0 }));
    expect(view.webview.html).toContain('$0.000');
    expect(view.webview.html).toContain('$2.00');
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
    const fenceMatch = block.match(/^# Current[^\n]*\n(`+)/m);
    expect(fenceMatch).not.toBeNull();
    expect(fenceMatch![1].length).toBeGreaterThanOrEqual(6);
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
});

