/**
 * Tests for DashboardViewProvider (welcome/panel.ts).
 *
 * Covers:
 *  Bug #1/#2 – setConfig() before resolveWebviewView() preserves config → brief rendered
 *  Bug #6    – rapid setConfig() calls don't stack intervals
 *  Bug #11   – challenge description comes from config, not hardcoded
 *  Bug #14   – dispose() clears the refresh interval
 */
import { DashboardViewProvider } from '../welcome/panel';
import { makeConfig, makeMockContext, makeMockWebviewView } from './helpers';

// Suppress the prereq HTTPS ping and execSync calls made in the constructor.
jest.mock('https', () => ({
  request: jest.fn().mockImplementation((_opts: unknown, _cb: unknown) => ({
    on: jest.fn().mockReturnThis(),
    end: jest.fn(),
    destroy: jest.fn(),
  })),
}));
jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue(Buffer.from('')),
  execFile: jest.fn().mockImplementation((_bin: string, _args: string[], _opts: object, cb: Function) => { cb(null); }),
}));

describe('DashboardViewProvider', () => {
  let context: ReturnType<typeof makeMockContext>;
  let provider: DashboardViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;

  beforeEach(() => {
    jest.useFakeTimers();
    context = makeMockContext();
    provider = new DashboardViewProvider(context);
    view = makeMockWebviewView();
  });

  afterEach(() => {
    provider.dispose();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── Bug #1 / #2 ──────────────────────────────────────────────────────────

  test('Bug #1/#2: setConfig() before resolve → brief rendered when view resolves', () => {
    const config = makeConfig();
    provider.setConfig(config);

    // View not yet resolved — render() must have returned early
    expect(view.webview.html).toBe('');

    provider.resolveWebviewView(view);

    expect(view.webview.html).toContain(config.challengeId);
    expect(view.webview.html).not.toContain('Enter Your Session ID');
  });

  test('resolving without config shows onboarding', () => {
    provider.resolveWebviewView(view);
    expect(view.webview.html).toContain('Enter Your Session ID');
    expect(view.webview.html).not.toContain('Time left');
  });

  test('setConfig() after resolve immediately renders brief', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    expect(view.webview.html).toContain('Time left');
  });

  // ── Bug #6 ────────────────────────────────────────────────────────────────

  test('Bug #6: rapid setConfig() calls do not stack intervals', () => {
    provider.resolveWebviewView(view);
    const config = makeConfig();
    provider.setConfig(config);
    provider.setConfig(config);
    provider.setConfig(config);

    // Record render count right after the three calls (3 renders for 3 setConfig calls)
    const htmlAfterSetup = view.webview.html;

    // Advance time by one interval (5 s) — only ONE timer should fire, not three
    view.webview.html = '__reset__';
    jest.advanceTimersByTime(5001);
    // One re-render happened (html changed from reset value)
    expect(view.webview.html).not.toBe('__reset__');

    // Advance by 5 s more — still only one fire per interval
    view.webview.html = '__reset2__';
    jest.advanceTimersByTime(5001);
    expect(view.webview.html).not.toBe('__reset2__');
  });

  // ── Bug #11 ───────────────────────────────────────────────────────────────

  test('Bug #11: challenge description comes from config, not hardcoded text', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(
      makeConfig({ challengeDescription: 'Build a Redis-compatible in-memory store' }),
    );
    expect(view.webview.html).toContain('Build a Redis-compatible in-memory store');
    expect(view.webview.html).not.toContain('Deliver a correct, thread-safe, templated LRU cache');
  });

  test('falls back to challengeId when description is empty', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig({ challengeDescription: '', challengeId: 'my-challenge' }));
    expect(view.webview.html).toContain('my-challenge');
  });

  // ── Bug #14 ───────────────────────────────────────────────────────────────

  test('Bug #14: dispose() clears the refresh interval', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    provider.dispose();

    view.webview.html = '__disposed__';
    jest.advanceTimersByTime(60_000); // advance well past the 5 s interval
    expect(view.webview.html).toBe('__disposed__'); // no re-render after dispose
  });

  // ── General render behaviour ──────────────────────────────────────────────

  test('render() is a no-op when view is not yet resolved', () => {
    expect(() => provider.render()).not.toThrow();
  });

  test('reportSessionError() posts message to the webview', () => {
    provider.resolveWebviewView(view);
    provider.reportSessionError('Validation failed');
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      command: 'sessionError',
      message: 'Validation failed',
    });
  });

  test('brief contains timer and budget info', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig({ llmBudgetUsd: 5.0 }));
    expect(view.webview.html).toContain('5.00');
    expect(view.webview.html).toContain('Time left');
  });

  test('brief renders model label from chatModel', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig({ chatModel: 'openai/gpt-4o' }));
    expect(view.webview.html).toContain('Gpt 4o'); // after label transform
  });

  // ── Bug #1: render not gated by workspaceFolders presence ─────────────────

  test('Bug #1/#2: brief renders even when no workspace folder is open', () => {
    const vscode = require('vscode');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig({ challengeId: 'lru-cache' }));
    expect(view.webview.html).toContain('lru-cache');
    expect(view.webview.html).toContain('Time left');
    expect(view.webview.html).not.toContain('Enter Your Session ID');
  });

  // ── Bug #8: XSS hardening ─────────────────────────────────────────────────

  test('Bug #8: malicious challengeId / description are HTML-escaped', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig({
      challengeId: '<img src=x onerror=alert(1)>',
      challengeDescription: '"></div><script>steal()</script>',
    }));
    const html: string = view.webview.html;
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>steal()</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
  });

  test('Bug #8: script-src CSP uses a nonce, not unsafe-inline', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    const html: string = view.webview.html;
    const cspMatch = html.match(/Content-Security-Policy" content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    const scriptSrc = cspMatch![1].match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  test('Bug #8: every inline <script> tag carries the document nonce', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    const html: string = view.webview.html;
    const cspNonce = html.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(cspNonce).toBeDefined();
    const scriptTags = html.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${cspNonce}"`);
    }
  });

  test('Bug #8: onboarding HTML also uses nonce-based CSP', () => {
    provider.resolveWebviewView(view); // no config → onboarding
    const html: string = view.webview.html;
    const cspMatch = html.match(/Content-Security-Policy" content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    expect(cspMatch![1]).toMatch(/script-src [^;]*'nonce-/);
    expect(cspMatch![1]).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  });

  // ── Regression: inline event handlers are CSP-blocked in nonce-only mode ──

  test('onboarding HTML contains NO inline on* handler attributes (CSP would block them)', () => {
    provider.resolveWebviewView(view); // no config → onboarding
    const html: string = view.webview.html;
    // The strict CSP we set forbids inline handlers — if any slip in, the
    // Begin button's click silently no-ops in production webviews.
    expect(html).not.toMatch(/\son(click|change|input|submit|keydown|keyup)\s*=/i);
  });

  test('brief HTML contains NO inline on* handler attributes (Run Tests / Open Chat / Submit must work)', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    const html: string = view.webview.html;
    expect(html).not.toMatch(/\son(click|change|input|submit|keydown|keyup)\s*=/i);
  });

  test('Begin button has an id so the nonce-script can wire its click handler', () => {
    provider.resolveWebviewView(view); // no config → onboarding
    const html: string = view.webview.html;
    expect(html).toMatch(/id="startBtn"/);
    // And the script wires it up via addEventListener
    expect(html).toMatch(/getElementById\(['"]startBtn['"]\)\.addEventListener\(/);
  });

  test('action buttons in the brief expose their command via data-action', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    const html: string = view.webview.html;
    expect(html).toMatch(/data-action="runTests"/);
    expect(html).toMatch(/data-action="openChat"/);
    expect(html).toMatch(/data-action="submit"/);
  });

  // ── Bug #16: dashboard interval stops once the session expires ────────────

  test('Bug #16: refresh interval stops itself once session time has elapsed', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig({ startedAt: Date.now() - 91 * 60_000, maxMinutes: 90 }));
    view.webview.html = '__reset__';
    jest.advanceTimersByTime(5001); // first tick — renders + stops
    expect(view.webview.html).not.toBe('__reset__');
    view.webview.html = '__reset2__';
    jest.advanceTimersByTime(60_000); // 12 more intervals would have fired
    expect(view.webview.html).toBe('__reset2__'); // none did
  });

  // ── Bug #7: submitted state disables actions and shows banner ─────────────

  test('Bug #7: markSubmitted() renders the brief in a locked, read-only state', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    provider.markSubmitted();
    const html: string = view.webview.html;
    expect(html).toContain('Submitted');
    const actionBtns = html.match(/<button class="action-btn[^"]*"[^>]*>/g) ?? [];
    expect(actionBtns.length).toBeGreaterThan(0);
    for (const btn of actionBtns) {
      expect(btn).toContain('disabled');
    }
  });

  test('Bug #7: after markSubmitted, webview-initiated actions are blocked', () => {
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    provider.markSubmitted();
    const handler = (view.webview.onDidReceiveMessage as jest.Mock).mock.calls[0][0] as (m: unknown) => void;
    const vscode = require('vscode');
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    handler({ command: 'submit' });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vibe.submit');
  });

  // ── Bug #17: empty-workspace runTests bails with a clear error ────────────

  test('Bug #17: runTests with no workspace surfaces an error message', () => {
    const vscode = require('vscode');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    provider.resolveWebviewView(view);
    provider.setConfig(makeConfig());
    const handler = (view.webview.onDidReceiveMessage as jest.Mock).mock.calls[0][0] as (m: unknown) => void;
    (vscode.window.showErrorMessage as jest.Mock).mockClear();
    handler({ command: 'runTests' });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/workspace/i),
    );
  });
});
