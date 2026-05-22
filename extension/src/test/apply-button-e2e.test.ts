/**
 * End-to-end tests for the "Apply to file" button — inline diff approach.
 *
 * The current UX (Cursor-style inline diff):
 *   1. Clicking Apply writes a preview state to the file: original lines and
 *      new lines are both present, side by side, decorated red and green.
 *      The initial write is a single workspace.applyEdit call.
 *   2. Per-hunk and file-level Accept/Reject CodeLens appear in the file.
 *      Accept drops the red (original) lines for the hunk; Reject drops the
 *      green (new) lines. Either action triggers a SECOND applyEdit that
 *      rewrites the file to the chosen state.
 *   3. When the AI fence omits `file=`, the Apply button stays enabled and
 *      clicking it opens a workspace file picker so the candidate can pick
 *      the target manually — the candidate is never blocked.
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
  rejectAiChanges,
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

    (vscode.window as any).tabGroups._tabs.length = 0;
    (vscode.window as any).tabGroups.close.mockClear();
    (vscode.window as any).activeTextEditor = undefined;
  });

  afterEach(() => {
    _disposeApplyForTests();
    provider.dispose();
    (vscode.workspace as any).workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readApplyButton(html: string): {
    blockId: string;
    filePath: string;
    lang: string;
    codeText: string;
    isDisabled: boolean;
  } {
    const blockId = /data-apply-block-id="([^"]+)"/.exec(html)?.[1];
    const filePath = /data-apply-file="([^"]*)"/.exec(html)?.[1];
    const lang = /data-apply-lang="([^"]*)"/.exec(html)?.[1];
    const encoded = /data-apply-encoded="([^"]+)"/.exec(html)?.[1];
    if (!blockId || encoded === undefined || filePath === undefined || lang === undefined) {
      throw new Error(`Apply button data-attrs missing in HTML:\n${html.slice(0, 2000)}`);
    }
    const unescape = (s: string): string =>
      s.replace(/&#39;/g, "'")
       .replace(/&quot;/g, '"')
       .replace(/&gt;/g, '>')
       .replace(/&lt;/g, '<')
       .replace(/&amp;/g, '&');
    const buttonMatch = /<button[^>]*class="code-btn apply-btn"[^>]*>/.exec(html);
    const isDisabled = !!(buttonMatch && /\bdisabled\b/.test(buttonMatch[0]));
    return {
      blockId,
      filePath: unescape(filePath),
      lang: unescape(lang),
      codeText: decodeURIComponent(unescape(encoded)),
      isDisabled,
    };
  }

  test('clicking Apply applies changes inline and creates a session', async () => {
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
    expect(btn.isDisabled).toBe(false);

    expect(msgHandler).toBeDefined();
    msgHandler!({
      command: 'applyBlock',
      blockId: btn.blockId,
      filePath: btn.filePath,
      codeText: btn.codeText,
      lang: btn.lang,
    });

    // applyEdit fires immediately (inline approach — no diff dialog).
    await new Promise((r) => setImmediate(r));
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(_pendingSizeForTests()).toBe(1);

    // vscode.diff must NOT be called in the inline approach.
    const diffCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === 'vscode.diff');
    expect(diffCalls.length).toBe(0);

    // Accept drops the red (original) lines — a second applyEdit fires.
    acceptAiChanges(btn.blockId);
    await new Promise((r) => setImmediate(r));
    expect(_pendingSizeForTests()).toBe(0);
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
  });

  test('accept on a no-region-match snippet writes the final state (initial + accept = 2 edits)', async () => {
    fs.writeFileSync(targetFile, '// hand-written unrelated stuff\nint other() { return 0; }\n', 'utf8');

    const { applyCodeBlock } = await import('../chat/apply');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 99; }\n', 'blk-noregion');

    // Initial preview applied immediately — no modal.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

    acceptAiChanges('blk-noregion');
    await p;

    // Accept fires a second applyEdit that drops the original (red) lines.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    const acceptEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0];
    const acceptText = (acceptEdit.getEdits() as Array<{ text: string }>)[0].text;
    // Final state contains only the new content (no original lines).
    expect(acceptText).toContain('return 99');
    expect(acceptText).not.toContain('hand-written unrelated stuff');
  });

  test('reject on a no-region-match snippet calls applyEdit twice (apply then revert)', async () => {
    fs.writeFileSync(targetFile, '// original content\n', 'utf8');

    const { applyCodeBlock } = await import('../chat/apply');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 99; }\n', 'blk-reject');

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);

    rejectAiChanges('blk-reject');
    await p;

    // Reject: second applyEdit call to revert.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    // File was never physically written (it's a mock) but the second edit
    // should restore the original content.
    const revertEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0];
    const edits = revertEdit.getEdits() as Array<{ text: string }>;
    expect(edits[0].text).toBe('// original content\n');
  });

  test('snippet that DOES match a region applies as one full-file preview edit (no modal)', async () => {
    fs.writeFileSync(
      targetFile,
      'int helper() { return 1; }\nint main() {\n  return 0;\n}\nint other() { return 2; }\n',
      'utf8',
    );

    const { applyCodeBlock } = await import('../chat/apply');
    const p = applyCodeBlock('lru.cpp', 'int main() {\n  return 42;\n}', 'blk-region');

    // Initial preview applied immediately, no modal.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    const previewEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0][0];
    const previewText = (previewEdit.getEdits() as Array<{ text: string }>)[0].text;
    // Preview keeps the unchanged helper / other functions and shows BOTH
    // the original main() (red) and the new main() (green) inline.
    expect(previewText).toContain('int helper()');
    expect(previewText).toContain('int other()');
    expect(previewText).toContain('return 0');
    expect(previewText).toContain('return 42');

    acceptAiChanges('blk-region');
    await p;
    // Accept fires a second applyEdit that drops the red (original) lines.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    const finalEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0];
    const finalText = (finalEdit.getEdits() as Array<{ text: string }>)[0].text;
    expect(finalText).toContain('return 42');
    expect(finalText).not.toContain('return 0');
  });

  test('fence without file= renders Apply button as ENABLED (file picker fallback)', () => {
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
    const buttonMatch = /<button[^>]*class="code-btn apply-btn"[^>]*>/.exec(html);
    expect(buttonMatch).not.toBeNull();
    // Button is NOT disabled — clicking it triggers a workspace file picker.
    expect(buttonMatch![0]).not.toMatch(/\bdisabled\b/);
    // Helpful tooltip explains the fallback behaviour.
    expect(buttonMatch![0]).toMatch(/click to pick one from your workspace/);
  });

  test('Apply with no filePath opens a workspace file picker (no error popup)', async () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    // Stage a workspace with one file the picker can offer.
    fs.writeFileSync(targetFile, '// before\n', 'utf8');
    (vscode.workspace as any)._findFilesImpl = async () => [vscode.Uri.file(targetFile)];
    // User cancels the picker (resolves undefined).
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);

    msgHandler!({
      command: 'applyBlock',
      blockId: 'no-file-id',
      codeText: 'int x = 7;\n',
      lang: 'cpp',
      // filePath intentionally omitted — picker should open.
    });
    await new Promise((r) => setImmediate(r));

    // Picker was opened with a placeholder prompting for a target file.
    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    const placeholder = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][1]?.placeHolder ?? '';
    expect(placeholder).toMatch(/pick the file/i);

    // User cancelled → no error popup, no edit.
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  test('Apply with no filePath: picking a file routes through to applyCodeBlock', async () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    fs.writeFileSync(targetFile, '// before\n', 'utf8');
    (vscode.workspace as any)._findFilesImpl = async () => [vscode.Uri.file(targetFile)];
    // Picker returns the file's relative path.
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: 'lru.cpp' });

    msgHandler!({
      command: 'applyBlock',
      blockId: 'pick-then-apply',
      codeText: 'int x = 7;\n',
      lang: 'cpp',
      // filePath intentionally omitted
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // After the user picked the file, the apply went through.
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
    expect(_pendingSizeForTests()).toBe(1);
  });

  test('accepting changes: session resolves and final edit drops the original lines', async () => {
    const { applyCodeBlock } = await import('../chat/apply');

    fs.writeFileSync(targetFile, '// stuff\n', 'utf8');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 1; }\n', 'blk-close');

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(_pendingSizeForTests()).toBe(1);

    acceptAiChanges('blk-close');
    await p;

    expect(_pendingSizeForTests()).toBe(0);
    // Two applyEdit calls: initial preview + accept (drops red lines).
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
  });

  test('rejecting changes: revert applyEdit is called with original content', async () => {
    const { applyCodeBlock } = await import('../chat/apply');

    fs.writeFileSync(targetFile, '// original\n', 'utf8');
    const p = applyCodeBlock('lru.cpp', 'int main() { return 1; }\n', 'blk-reject2');

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);

    rejectAiChanges('blk-reject2');
    await p;

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    const revertEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0];
    const edits = revertEdit.getEdits() as Array<{ text: string }>;
    expect(edits[0].text).toBe('// original\n');
  });

  test('handleMessage routes applyBlock without crashing when codeText is undefined', () => {
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.setConfig(makeConfig());

    expect(() => msgHandler!({ command: 'applyBlock' })).not.toThrow();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });
});
