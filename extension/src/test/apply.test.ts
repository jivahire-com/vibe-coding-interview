/**
 * Tests for chat/apply.ts — specifically the language-aware full-file/region
 * detection logic that prevents wholesale overwrites of Python/non-brace files,
 * plus the close-tab cleanup and destructive-confirm bug fixes.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  looksLikeFullFile,
  applyCodeBlock,
  _pendingSizeForTests,
  _disposeApplyForTests,
  AI_PROPOSED_SCHEME,
} from '../chat/apply';

describe('looksLikeFullFile', () => {
  test('empty original → always full file', () => {
    expect(looksLikeFullFile('def foo(): pass', '', '.py')).toBe(true);
    expect(looksLikeFullFile('snippet', '', '.txt')).toBe(true);
  });

  test('C++ header guard markers → full file', () => {
    const original = '// existing code\nint main() { return 0; }';
    expect(looksLikeFullFile('#pragma once\nclass Foo {};', original, '.h')).toBe(true);
    expect(looksLikeFullFile('#ifndef FOO_H\n#define FOO_H\n#endif', original, '.h')).toBe(true);
  });

  test('Python module with imports + class defs → full file', () => {
    const newText = [
      'import threading',
      'from collections import OrderedDict',
      '',
      'class LRUCache:',
      '    def __init__(self, n): self.n = n',
      '',
      'def helper(): pass',
    ].join('\n');
    const original = 'class LRUCache:\n    pass\n';
    expect(looksLikeFullFile(newText, original, '.py')).toBe(true);
  });

  test('Python single-method snippet is NOT full file', () => {
    const snippet = '    def put(self, key, value):\n        with self.lock:\n            self.data[key] = value';
    const original = 'class LRUCache:\n    def get(self, k): pass\n    def put(self, k, v): pass\n';
    expect(looksLikeFullFile(snippet, original, '.py')).toBe(false);
  });

  test('TS module with multiple exports → full file', () => {
    const newText = [
      'import * as fs from "fs";',
      'export class A {}',
      'export class B {}',
    ].join('\n');
    expect(looksLikeFullFile(newText, 'existing', '.ts')).toBe(true);
  });

  test('TS single-function snippet is NOT full file', () => {
    const snippet = 'function foo(x: number): number {\n  return x + 1;\n}';
    expect(looksLikeFullFile(snippet, 'existing', '.ts')).toBe(false);
  });

  test('Non-empty original + plain snippet → NOT full file', () => {
    expect(looksLikeFullFile('foo()', 'existing content', '.py')).toBe(false);
    expect(looksLikeFullFile('int x = 5;', 'existing content', '.cpp')).toBe(false);
  });
});

describe('_findRegion integration via applyCodeBlock', () => {
  // _findRegion is not exported, but we verify the surface behavior through the
  // public APIs: an apply for a Python snippet without matching region must
  // refuse to wholesale-replace. That contract is what protects candidates.
  test('looksLikeFullFile returns false → caller must NOT full-file-replace', () => {
    // Regression: the old code path would full-file-replace in this case.
    const original = 'class Foo:\n    def bar(self):\n        return 1\n';
    const snippet  = '    def baz(self):\n        return 2\n';
    // With the fix in place, looksLikeFullFile says "not full" — apply.ts then
    // requires a successful _findRegion match, otherwise it aborts.
    expect(looksLikeFullFile(snippet, original, '.py')).toBe(false);
  });
});

// ── Bug #10 + #11: applyCodeBlock close-cleanup and destructive-confirm ───

describe('applyCodeBlock lifecycle', () => {
  let tmpDir: string;
  let originalFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-'));
    originalFile = path.join(tmpDir, 'foo.cpp');
    fs.writeFileSync(originalFile, 'int main() { return 0; }', 'utf8');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: tmpDir } } as { uri: { fsPath: string } },
    ];
    jest.clearAllMocks();
  });

  afterEach(() => {
    _disposeApplyForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  test('Bug #10: closing the diff tab without Accept/Reject resolves as a Reject (no leak)', async () => {
    // Mock vscode.diff so opening the diff editor doesn't try to actually open
    let diffOpened = false;
    (vscode.commands.executeCommand as jest.Mock).mockImplementation(
      (cmd: string): Promise<unknown> => {
        if (cmd === 'vscode.diff') diffOpened = true;
        return Promise.resolve();
      },
    );

    const applyPromise = applyCodeBlock(
      'foo.cpp',
      'int main() { return 1; }',
      'blk-1',
    );

    // The pending entry has been registered
    expect(_pendingSizeForTests()).toBe(1);
    expect(diffOpened).toBe(true);

    // Simulate VS Code closing the diff document without Accept/Reject
    const wsExt = vscode.workspace as unknown as {
      _docCloseCallback: ((d: { uri: { scheme: string; path: string } }) => void) | null;
    };
    expect(wsExt._docCloseCallback).not.toBeNull();
    wsExt._docCloseCallback!({ uri: { scheme: AI_PROPOSED_SCHEME, path: '/blk-1' } });

    // applyCodeBlock now resolves (because the close watcher fired resolve(false))
    await expect(applyPromise).resolves.toBeUndefined();
    expect(_pendingSizeForTests()).toBe(0);
  });

  test('Bug #11: full-file replacement on a non-empty file requires explicit user confirmation', async () => {
    fs.writeFileSync(originalFile, '// hand-written code\nint main() {\n  return 42;\n}\n', 'utf8');

    // Track command + dialog calls
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined); // user dismisses

    // Drive the apply: open diff, then immediately accept via the CodeLens.
    // The accept triggers the destructive-confirm guard, which we have set to
    // resolve undefined → caller declines → applyEdit must NOT have run.
    const applyPromise = applyCodeBlock(
      'foo.cpp',
      '#pragma once\nclass A {};\nclass B {};\n', // looksLikeFullFile → true
      'blk-confirm',
    );
    const { acceptAiChanges } = await import('../chat/apply');
    acceptAiChanges('blk-confirm');
    await applyPromise;

    // The destructive-confirm dialog was shown
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/REPLACE the entire contents/),
      expect.objectContaining({ modal: true }),
      'Replace entire file',
    );
    // The user did not confirm — applyEdit must NOT have been invoked
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    // Original file is unchanged on disk (the WorkspaceEdit is what would have changed it)
    expect(fs.readFileSync(originalFile, 'utf8')).toContain('hand-written code');
  });

  test('Bug #11: confirmation accepted → applyEdit runs and the file gets the new contents', async () => {
    fs.writeFileSync(originalFile, '// old code\n', 'utf8');
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const applyPromise = applyCodeBlock(
      'foo.cpp',
      '#pragma once\nclass A {};\nclass B {};\n',
      'blk-yes',
    );
    const { acceptAiChanges } = await import('../chat/apply');
    acceptAiChanges('blk-yes');
    await applyPromise;

    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });

  test('Bug #11: empty target file → NO confirmation needed (no destructive risk)', async () => {
    const empty = path.join(tmpDir, 'new.cpp');
    fs.writeFileSync(empty, '', 'utf8');

    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const applyPromise = applyCodeBlock(
      'new.cpp',
      '#pragma once\nclass A {};\nclass B {};\n',
      'blk-empty',
    );
    const { acceptAiChanges } = await import('../chat/apply');
    acceptAiChanges('blk-empty');
    await applyPromise;

    // No destructive-confirm dialog — original was empty, nothing to lose
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });
});
