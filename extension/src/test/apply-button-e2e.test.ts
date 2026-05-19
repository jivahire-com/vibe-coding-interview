/**
 * End-to-end tests for the "Apply to file" button.
 *
 * Reproduces the candidate-reported bug: clicking the Apply button in the
 * rendered chat view loads briefly ("Opening diff…") and then nothing
 * happens — no diff opens, no file changes.
 *
 * We don't have a real browser, so we exercise the path in three pieces:
 *   1. Render the chat HTML with an assistant message containing a fenced
 *      code block and pull the data-attributes off the rendered button.
 *   2. Reproduce what the webview's JS click handler would do — decode the
 *      base64-ish payload, build the postMessage shape, and feed it to the
 *      ChatViewProvider's onDidReceiveMessage callback.
 *   3. Drive the apply.ts state machine (accept) and verify the file gets
 *      updated.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../chat/view';
import {
  _disposeApplyForTests,
  _pendingSizeForTests,
  acceptAiChanges,
} from '../chat/apply';
import { makeConfig, makeMockContext, makeMockWebviewView } from './helpers';

describe('Apply button end-to-end', () => {
  let context: ReturnType<typeof makeMockContext>;
  let provider: ChatViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;
  let tmpDir: string;
  let targetFile: string;
  let msgHandler: ((m: unknown) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-e2e-'));
    targetFile = path.join(tmpDir, 'lru.cpp');
    fs.writeFileSync(targetFile, '// old code\n', 'utf8');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

    context = makeMockContext();
    provider = new ChatViewProvider(context);
    view = makeMockWebviewView();
    msgHandler = undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });

    // vscode.diff resolves quickly in the real editor; mock it so the test
    // can drive the rest of the flow synchronously.
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    // Reset tabGroups + active editor + quick-pick between tests so each
    // case starts from a known-clean state.
    (vscode.window as any).tabGroups._tabs.length = 0;
    (vscode.window as any).tabGroups.close.mockClear();
    (vscode.window as any).activeTextEditor = undefined;
    (vscode.window as any).showQuickPick.mockClear();
  });

  afterEach(() => {
    _disposeApplyForTests();
    provider.dispose();
    (vscode.workspace as any).workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Parse a button's data-* attributes out of the rendered HTML so the test
   * walks the same wire as the browser would. Returns the decoded values.
   */
  function readApplyButton(html: string): {
    blockId: string;
    filePath: string;
    lang: string;
    codeText: string;
  } {
    const blockId = /data-apply-block-id="([^"]+)"/.exec(html)?.[1];
    const filePath = /data-apply-file="([^"]*)"/.exec(html)?.[1];
    const lang = /data-apply-lang="([^"]*)"/.exec(html)?.[1];
    const encoded = /data-apply-encoded="([^"]+)"/.exec(html)?.[1];
    if (!blockId || encoded === undefined || filePath === undefined || lang === undefined) {
      throw new Error(`Apply button data-attrs missing in HTML:\n${html.slice(0, 2000)}`);
    }
    // HTML attribute entity decoding for the bits escAttr produces.
    const unescape = (s: string): string =>
      s.replace(/&#39;/g, "'")
       .replace(/&quot;/g, '"')
       .replace(/&gt;/g, '>')
       .replace(/&lt;/g, '<')
       .replace(/&amp;/g, '&');
    return {
      blockId,
      filePath: unescape(filePath),
      lang: unescape(lang),
      codeText: decodeURIComponent(unescape(encoded)),
    };
  }

  test('clicking Apply opens a diff with the proposed code', async () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    (provider as any).messages = [
      { role: 'user', content: 'fix it' },
      {
        role: 'assistant',
        content: 'Try:\n```cpp file=lru.cpp\nint main() { return 1; }\n```',
        model: 'openai/gpt-4o-mini',
        promptTokens: 1, completionTokens: 1, latencyMs: 1,
      },
    ];
    (provider as any).render();

    const btn = readApplyButton(view.webview.html);
    expect(btn.filePath).toBe('lru.cpp');
    expect(btn.lang).toBe('cpp');
    expect(btn.codeText).toBe('int main() { return 1; }\n');

    // Simulate the webview JS posting the click through to the extension.
    expect(msgHandler).toBeDefined();
    msgHandler!({
      command: 'applyBlock',
      blockId: btn.blockId,
      filePath: btn.filePath,
      codeText: btn.codeText,
      lang: btn.lang,
    });

    // Give the apply microtasks a chance to schedule the diff command.
    await new Promise((r) => setImmediate(r));

    const diffCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === 'vscode.diff');
    expect(diffCalls.length).toBe(1);
    // The proposed URI must be the AI-proposed scheme keyed by blockId.
    const proposedUri = diffCalls[0][2] as vscode.Uri;
    expect(proposedUri.scheme).toBe('vibe-ai-proposed');
    expect(proposedUri.path).toBe(`/${btn.blockId}`);

    // A pending entry exists so the Accept CodeLens can resolve it.
    expect(_pendingSizeForTests()).toBe(1);

    // The diff shows old file vs the snippet, which is essentially a full-file
    // replacement (the snippet shares no region with the original). On Accept,
    // we must surface a modal so the candidate explicitly confirms the
    // wholesale overwrite (the diff IS what they saw; this is the safety net).
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    // Simulate the user clicking the Accept CodeLens.
    acceptAiChanges(btn.blockId);
    // Wait for the applyCodeBlock promise chain to finish.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The pending entry has been torn down.
    expect(_pendingSizeForTests()).toBe(0);
    // The confirmation modal was shown (destructive op safety net).
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/REPLACE the entire contents/),
      expect.objectContaining({ modal: true }),
      'Replace entire file',
    );
    // workspace.applyEdit was called to write the new contents.
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });

  // ── Core bug: snippet doesn't match a region, user accepts the diff ──
  //
  // The diff editor visually shows original-vs-snippet (i.e. full-file
  // replacement). The user clicks Accept. Pre-fix, the region-matching
  // heuristic returns null, applyCodeBlock fires a non-modal toast warning,
  // and the file is unchanged. From the candidate's perspective: "I clicked
  // Apply, it loaded, then nothing happened" — exactly the reported bug.

  test('accept on a no-region-match snippet shows a confirm modal, then writes', async () => {
    fs.writeFileSync(targetFile, '// hand-written unrelated stuff\nint other() { return 0; }\n', 'utf8');

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const { applyCodeBlock } = await import('../chat/apply');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 99; }\n', 'blk-noregion');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-noregion');
    await p;

    // The modal was shown explaining the destructive nature.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/REPLACE the entire contents/),
      expect.objectContaining({ modal: true }),
      'Replace entire file',
    );
    // And applyEdit fired (the new behavior — pre-fix, this never ran).
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });

  test('accept on a no-region-match snippet, user declines modal → no write', async () => {
    fs.writeFileSync(targetFile, '// hand-written unrelated stuff\nint other() { return 0; }\n', 'utf8');

    // User dismisses the modal (returns undefined)
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const { applyCodeBlock } = await import('../chat/apply');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 99; }\n', 'blk-decline');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-decline');
    await p;

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    // User declined → no edit, file unchanged on disk.
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(fs.readFileSync(targetFile, 'utf8')).toContain('hand-written unrelated stuff');
  });

  test('snippet that DOES match a region applies surgically (no modal)', async () => {
    // First line of snippet matches an existing line in the file → _findRegion
    // can lock onto the function and we replace just its body, not the whole
    // file. No destructive confirmation needed.
    fs.writeFileSync(
      targetFile,
      'int helper() { return 1; }\nint main() {\n  return 0;\n}\nint other() { return 2; }\n',
      'utf8',
    );

    const { applyCodeBlock } = await import('../chat/apply');
    const p = applyCodeBlock('lru.cpp', 'int main() {\n  return 42;\n}', 'blk-region');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-region');
    await p;

    // No modal — region match means surgical replacement, no wholesale overwrite.
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });

  // ── No-file= behavior: button stays clickable; on click we open a
  //    QuickPick so the candidate picks the target. We never silently route
  //    to the active editor — the AI's snippet might belong elsewhere.

  test('Apply button is always clickable (never disabled by the UI)', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());
    (provider as any).messages = [
      {
        role: 'assistant',
        content: '```cpp\nint x = 7;\n```',
        model: 'openai/gpt-4o-mini',
        promptTokens: 1, completionTokens: 1, latencyMs: 1,
      },
    ];
    (provider as any).render();

    const html: string = view.webview.html;
    const applyMatch = /<button[^>]*class="code-btn apply-btn"[^>]*>/.exec(html);
    expect(applyMatch).not.toBeNull();
    // No `disabled` attribute — UI-side gating is OFF.
    expect(applyMatch![0]).not.toMatch(/\sdisabled\b/);
  });

  test('Apply with no filePath opens a QuickPick (never silent active-editor routing)', async () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    // Even with an active editor present, we must not silently route a
    // file-less snippet to it. The fallback is a QuickPick the candidate
    // explicitly answers.
    (vscode.window as any).activeTextEditor = {
      document: { uri: vscode.Uri.file(targetFile) },
    };
    (vscode.workspace as any).asRelativePath = jest.fn().mockImplementation((u: any) =>
      path.relative(tmpDir, u.fsPath ?? u),
    );
    (vscode.workspace as any).findFiles = jest.fn().mockResolvedValue([]);
    // Candidate dismisses the QuickPick → no apply, no diff.
    (vscode.window as any).showQuickPick.mockResolvedValue(undefined);

    msgHandler!({
      command: 'applyBlock',
      blockId: 'no-file-id',
      codeText: 'int x = 7;\n',
      lang: 'cpp',
      // filePath intentionally omitted
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // QuickPick was shown — the candidate, not the extension, picks the target.
    expect((vscode.window as any).showQuickPick).toHaveBeenCalled();
    // Dismissed → no diff opened.
    const diffCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === 'vscode.diff');
    expect(diffCalls.length).toBe(0);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  test('Apply with no filePath: QuickPick selection IS used as target', async () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    (vscode.window as any).activeTextEditor = {
      document: { uri: vscode.Uri.file(targetFile) },
    };
    (vscode.workspace as any).asRelativePath = jest.fn().mockImplementation((u: any) =>
      typeof u === 'string' ? u : path.relative(tmpDir, u.fsPath ?? u),
    );
    (vscode.workspace as any).findFiles = jest.fn().mockResolvedValue([]);
    // Candidate picks "lru.cpp" from the QuickPick.
    (vscode.window as any).showQuickPick.mockResolvedValue({ label: 'lru.cpp' });

    msgHandler!({
      command: 'applyBlock',
      blockId: 'pick-id',
      codeText: 'int x = 7;\n',
      lang: 'cpp',
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const diffCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === 'vscode.diff');
    expect(diffCalls.length).toBe(1);
    const originalUri = diffCalls[0][1] as vscode.Uri;
    expect(originalUri.fsPath).toBe(targetFile);
  });

  // ── Diff tab leaks green/red highlighting after Accept ──
  //
  // Reproduces: "When the code is accepted the file in editor is all green
  // and red, after accepted it should not look like that." The current code
  // calls `workbench.action.closeActiveEditor`, which is brittle — when the
  // diff isn't the active editor at resolve time (CodeLens clicks can move
  // focus, modals steal focus), the diff tab survives and the candidate
  // keeps staring at the colored gutter long after Accept. We close the
  // specific diff tab by URI via the tabGroups API instead.

  test('accepting changes closes the diff tab (no green/red highlighting left over)', async () => {
    const { applyCodeBlock } = await import('../chat/apply');
    const { TabInputTextDiff } = await import('vscode') as any;

    // The "open" diff tab the extension is currently showing. We seed it on
    // the mock as VS Code would after vscode.diff() opens.
    let recordedProposed: vscode.Uri | null = null;
    (vscode.commands.executeCommand as jest.Mock).mockImplementation(
      (cmd: string, _orig: vscode.Uri, proposed: vscode.Uri): Promise<unknown> => {
        if (cmd === 'vscode.diff') {
          recordedProposed = proposed;
          (vscode.window as any).tabGroups._tabs.push({
            input: new TabInputTextDiff(_orig, proposed),
          });
        }
        return Promise.resolve();
      },
    );
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    fs.writeFileSync(targetFile, '// stuff\n', 'utf8');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 1; }\n', 'blk-close');
    await new Promise((r) => setImmediate(r));

    // The diff tab is in fact open.
    expect((vscode.window as any).tabGroups._tabs.length).toBe(1);
    expect(recordedProposed).not.toBeNull();

    acceptAiChanges('blk-close');
    await p;

    // After Accept, the diff tab must have been closed via the tabGroups API.
    expect((vscode.window as any).tabGroups.close).toHaveBeenCalled();
    expect((vscode.window as any).tabGroups._tabs.length).toBe(0);
  });

  test('rejecting changes also closes the diff tab', async () => {
    const { applyCodeBlock, rejectAiChanges } = await import('../chat/apply');
    const { TabInputTextDiff } = await import('vscode') as any;

    (vscode.commands.executeCommand as jest.Mock).mockImplementation(
      (cmd: string, _orig: vscode.Uri, proposed: vscode.Uri): Promise<unknown> => {
        if (cmd === 'vscode.diff') {
          (vscode.window as any).tabGroups._tabs.push({
            input: new TabInputTextDiff(_orig, proposed),
          });
        }
        return Promise.resolve();
      },
    );

    const p = applyCodeBlock('lru.cpp', 'int main() { return 1; }\n', 'blk-reject');
    await new Promise((r) => setImmediate(r));
    rejectAiChanges('blk-reject');
    await p;

    expect((vscode.window as any).tabGroups._tabs.length).toBe(0);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  test('handleMessage routes applyBlock without crashing when codeText is undefined', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    // Empty payload — must not crash, must not call applyCodeBlock.
    expect(() => msgHandler!({ command: 'applyBlock' })).not.toThrow();
    const diffCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === 'vscode.diff');
    expect(diffCalls.length).toBe(0);
  });
});
