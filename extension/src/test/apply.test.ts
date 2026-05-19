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
  _isInsideWorkspace,
  AI_PROPOSED_SCHEME,
} from '../chat/apply';

// ── Review-Bug 3: pure unit tests for _isInsideWorkspace ───────────────────

describe('_isInsideWorkspace (Review-Bug 3)', () => {
  let ws: string;
  let outside: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'iiw-ws-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'iiw-out-'));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('inside the workspace → true', () => {
    expect(_isInsideWorkspace(ws, path.join(ws, 'foo.txt'))).toBe(true);
  });

  test('a path purely outside (no symlink) → false', () => {
    expect(_isInsideWorkspace(ws, path.join(outside, 'foo.txt'))).toBe(false);
  });

  test('symlinked subdir pointing OUTSIDE → false (the bug)', () => {
    const link = path.join(ws, 'evil');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch {
      return; // symlinks unsupported
    }
    expect(_isInsideWorkspace(ws, path.join(link, 'leak.txt'))).toBe(false);
  });

  test('symlinked subdir pointing INSIDE the workspace → true', () => {
    const target = path.join(ws, 'real');
    fs.mkdirSync(target);
    const link = path.join(ws, 'alias');
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch {
      return;
    }
    expect(_isInsideWorkspace(ws, path.join(link, 'ok.txt'))).toBe(true);
  });

  test('parent of nonexistent file is realpathed (new files in symlinked dirs)', () => {
    // Workspace contains an /alias symlink to a real subdir; new file inside.
    const real = path.join(ws, 'real');
    fs.mkdirSync(real);
    const link = path.join(ws, 'alias');
    try { fs.symlinkSync(real, link, 'dir'); } catch { return; }
    expect(_isInsideWorkspace(ws, path.join(link, 'new', 'deeper', 'file.txt'))).toBe(true);
  });
});

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

// ── Multi-block surgical merge: the candidate-reported "Apply wiped my file" bug ──
//
// The LLM commonly responds with two or three updated methods stitched together,
// no surrounding class declaration. Old code path: looksLikeFullFile → false,
// _findRegion anchors only the first sig line, _findRegionBraces walks past
// every subsequent method, and the resulting "region" silently extends across
// the whole class body. Accept → entire class body replaced with just the
// snippet (two methods), losing every other method.
//
// New behavior: _splitSnippet breaks the snippet into top-level blocks,
// _findAllRegions anchors each block to its own signature line, _applyRegionsToText
// merges the changes into the original so the diff shows ONLY the affected
// regions. Accept applies each region surgically.

describe('multi-block surgical merge', () => {
  // Lazy import so test reload picks up the live module each suite.
  let _splitSnippet: (text: string, ext: string) => string[];
  let _findAllRegions: (original: string, snippet: string, ext: string) => Array<{ range: vscode.Range; replacement: string }> | null;
  let _applyRegionsToText: (original: string, matches: Array<{ range: vscode.Range; replacement: string }>) => string;
  let _normalizeIndent: (replacement: string, anchorIndent: string) => string;

  beforeAll(async () => {
    const mod = await import('../chat/apply');
    _splitSnippet = mod._splitSnippet;
    _findAllRegions = mod._findAllRegions;
    _applyRegionsToText = mod._applyRegionsToText;
    _normalizeIndent = mod._normalizeIndent;
  });

  test('_splitSnippet splits brace languages on top-level closing braces', () => {
    const snippet = [
      'setQuery(q) {',
      '  this.query = q;',
      '}',
      '',
      'getState() {',
      '  return { x: 1 };',
      '}',
    ].join('\n');
    const blocks = _splitSnippet(snippet, '.js');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('setQuery');
    expect(blocks[1]).toContain('getState');
  });

  test('_splitSnippet keeps a single block intact for one-method snippets', () => {
    const snippet = 'function foo() {\n  return 1;\n}';
    expect(_splitSnippet(snippet, '.js')).toEqual([snippet]);
  });

  test('_splitSnippet splits Python on top-level def boundaries', () => {
    const snippet = [
      '    def setQuery(self, q):',
      '        self.q = q',
      '',
      '    def getState(self):',
      '        return self.q',
    ].join('\n');
    const blocks = _splitSnippet(snippet, '.py');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('setQuery');
    expect(blocks[1]).toContain('getState');
  });

  test('_normalizeIndent prepends class-body indent to top-level method snippet', () => {
    const snippet = 'setQuery(q) {\n  this.q = q;\n}';
    const reindented = _normalizeIndent(snippet, '  ');
    expect(reindented).toBe('  setQuery(q) {\n    this.q = q;\n  }');
  });

  test('_normalizeIndent leaves blank lines unindented', () => {
    const snippet = 'foo() {\n\n  return 1;\n}';
    const reindented = _normalizeIndent(snippet, '  ');
    // Blank line stays blank (no trailing whitespace).
    expect(reindented.split('\n')[1]).toBe('');
  });

  test('_findAllRegions anchors every method of a multi-method snippet', () => {
    const original = [
      'class UserSearch {',
      '  constructor() {}',
      '',
      '  setQuery(q) {',
      '    this.q = q;',
      '  }',
      '',
      '  getState() {',
      '    return { x: 0 };',
      '  }',
      '}',
    ].join('\n');
    const snippet = [
      'setQuery(q) {',
      '  this.q = q;',
      '  this.dirty = true;',
      '}',
      '',
      'getState() {',
      '  return { x: 1 };',
      '}',
    ].join('\n');
    const matches = _findAllRegions(original, snippet, '.js');
    expect(matches).not.toBeNull();
    expect(matches!).toHaveLength(2);
    // Sorted by line; first should anchor setQuery, second getState.
    expect(matches![0].range.start.line).toBe(3);
    expect(matches![1].range.start.line).toBe(7);
    // Replacements are reindented to match the class body.
    expect(matches![0].replacement).toContain('  setQuery(q) {');
    expect(matches![1].replacement).toContain('  getState() {');
  });

  test('_applyRegionsToText splices every match in place — old code is preserved', () => {
    const original = [
      'class UserSearch {',
      '  constructor() { this.q = ""; }',
      '',
      '  setQuery(q) {',
      '    this.q = q;',
      '  }',
      '',
      '  getState() {',
      '    return { x: 0 };',
      '  }',
      '',
      '  destroy() { /* keep me */ }',
      '}',
    ].join('\n');
    const snippet = [
      'setQuery(q) {',
      '  this.q = q;',
      '  this.dirty = true;',
      '}',
      '',
      'getState() {',
      '  return { x: 1 };',
      '}',
    ].join('\n');
    const matches = _findAllRegions(original, snippet, '.js');
    expect(matches).not.toBeNull();
    const merged = _applyRegionsToText(original, matches!);

    // Untouched code is still there — this is the bug the user reported.
    expect(merged).toContain('constructor() { this.q = ""; }');
    expect(merged).toContain('destroy() { /* keep me */ }');
    // Surgical changes landed.
    expect(merged).toContain('this.dirty = true');
    expect(merged).toContain('return { x: 1 }');
    // Class scope didn't get flattened — class shell remains.
    expect(merged.startsWith('class UserSearch {')).toBe(true);
    expect(merged.trimEnd().endsWith('}')).toBe(true);
  });

  test('_findAllRegions returns null when any block fails to anchor', () => {
    const original = 'class A {\n  foo() { return 1; }\n}\n';
    const snippet = 'foo() { return 2; }\n\nbar() { return 3; }';
    // bar() does not exist in original → bail out, caller falls back to modal.
    expect(_findAllRegions(original, snippet, '.js')).toBeNull();
  });
});

describe('_closeDiffTab robustness (Bug: green/red diff stays open after Accept)', () => {
  let tmpDir: string;
  let target: string;
  let acceptAiChanges: typeof import('../chat/apply').acceptAiChanges;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-diff-'));
    target = path.join(tmpDir, 'foo.cpp');
    fs.writeFileSync(target, '// stuff\n', 'utf8');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: tmpDir } } as { uri: { fsPath: string } },
    ];
    jest.clearAllMocks();
    const mod = await import('../chat/apply');
    acceptAiChanges = mod.acceptAiChanges;
  });

  afterEach(() => {
    _disposeApplyForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  test('closes the AI diff tab even when stored URI path differs from the recorded path', async () => {
    const { applyCodeBlock } = await import('../chat/apply');
    const { TabInputTextDiff } = await import('vscode') as unknown as {
      TabInputTextDiff: new (orig: vscode.Uri, mod: vscode.Uri) => unknown;
    };

    // Simulate VS Code returning a tab whose `modified.path` is normalised
    // and no longer matches what we passed. Pre-fix, the closer would skip
    // this tab and the candidate would stare at green/red highlighting.
    (vscode.commands.executeCommand as jest.Mock).mockImplementation(
      (cmd: string, _orig: vscode.Uri, proposed: vscode.Uri): Promise<unknown> => {
        if (cmd === 'vscode.diff') {
          const normalised = vscode.Uri.from({
            scheme: proposed.scheme,
            path: proposed.path + '?normalised', // arbitrary normalisation
          });
          (vscode.window as unknown as { tabGroups: { _tabs: unknown[] } }).tabGroups._tabs.push({
            input: new TabInputTextDiff(_orig, normalised),
          });
        }
        return Promise.resolve();
      },
    );
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const p = applyCodeBlock('foo.cpp', 'int main() { return 1; }\n', 'blk-close-fallback');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-close-fallback');
    await p;

    // Scheme-based fallback should still close the tab.
    expect((vscode.window as unknown as { tabGroups: { _tabs: unknown[] } }).tabGroups._tabs.length).toBe(0);
  });

  test('falls back to closeActiveEditor when tabGroups.close fails to remove the tab', async () => {
    const { applyCodeBlock } = await import('../chat/apply');
    const { TabInputTextDiff } = await import('vscode') as unknown as {
      TabInputTextDiff: new (orig: vscode.Uri, mod: vscode.Uri) => unknown;
    };

    let closeCalls = 0;
    (vscode.commands.executeCommand as jest.Mock).mockImplementation(
      (cmd: string, ...args: unknown[]): Promise<unknown> => {
        if (cmd === 'vscode.diff') {
          const proposed = args[1] as vscode.Uri;
          (vscode.window as unknown as { tabGroups: { _tabs: unknown[] } }).tabGroups._tabs.push({
            input: new TabInputTextDiff(args[0] as vscode.Uri, proposed),
          });
        }
        if (cmd === 'workbench.action.closeActiveEditor') {
          closeCalls++;
          // Simulate the command actually removing the tab.
          (vscode.window as unknown as { tabGroups: { _tabs: unknown[] } }).tabGroups._tabs.length = 0;
        }
        return Promise.resolve();
      },
    );
    // tabGroups.close is a no-op — does NOT remove the tab. This is the
    // production-observed failure mode that the fallback exists for.
    (vscode.window as unknown as { tabGroups: { close: jest.Mock } }).tabGroups.close
      = jest.fn().mockResolvedValue(false);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const p = applyCodeBlock('foo.cpp', 'int main() { return 1; }\n', 'blk-stuck-tab');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-stuck-tab');
    await p;

    // Fallback fired and the tab is gone.
    expect(closeCalls).toBeGreaterThanOrEqual(1);
    expect((vscode.window as unknown as { tabGroups: { _tabs: unknown[] } }).tabGroups._tabs.length).toBe(0);
  });
});

describe('applyCodeBlock surgical multi-block merge (Bug: Apply wipes file)', () => {
  let tmpDir: string;
  let target: string;
  let acceptAiChanges: typeof import('../chat/apply').acceptAiChanges;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-apply-'));
    target = path.join(tmpDir, 'user_search.js');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: tmpDir } } as { uri: { fsPath: string } },
    ];
    jest.clearAllMocks();
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    const mod = await import('../chat/apply');
    acceptAiChanges = mod.acceptAiChanges;
  });

  afterEach(() => {
    _disposeApplyForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  test('two-method JS snippet anchors both regions — NO modal, NO file wipe', async () => {
    const original = [
      'class UserSearch {',
      '  constructor() { this.q = ""; }',
      '',
      '  setQuery(q) {',
      '    this.q = q;',
      '  }',
      '',
      '  getState() {',
      '    return { totalPages: Math.floor(this.total / this.pageSize) };',
      '  }',
      '',
      '  destroy() { /* keep me */ }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(target, original, 'utf8');

    const snippet = [
      'setQuery(q) {',
      '  this.q = q;',
      '  this.dirty = true;',
      '}',
      '',
      'getState() {',
      '  return { totalPages: Math.ceil(this.total / this.pageSize) };',
      '}',
    ].join('\n');

    const p = applyCodeBlock('user_search.js', snippet, 'blk-multi');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-multi');
    await p;

    // No destructive-confirm modal — surgical merge means the diff already
    // showed exactly what gets written.
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();

    // The WorkspaceEdit should contain TWO surgical edits, not one full-file edit.
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0][0];
    const edits = edit.getEdits() as Array<{ range: vscode.Range; text: string }>;
    expect(edits.length).toBe(2);
    // Each edit text contains exactly one of the methods, properly reindented.
    const joined = edits.map((e) => e.text).join('\n');
    expect(joined).toContain('this.dirty = true');
    expect(joined).toContain('Math.ceil');
    expect(joined).not.toContain('destroy()'); // we don't touch the untouched method
  });

  test('partial snippet that cannot anchor any block → still shows full-file modal', async () => {
    fs.writeFileSync(target, '// existing js file\nfunction other() { return 1; }\n', 'utf8');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const snippet = 'function brandNewFunction() {\n  return 42;\n}';
    const p = applyCodeBlock('user_search.js', snippet, 'blk-noanchor');
    await new Promise((r) => setImmediate(r));
    acceptAiChanges('blk-noanchor');
    await p;

    // Modal fires because the snippet cannot be safely merged.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/REPLACE the entire contents/),
      expect.objectContaining({ modal: true }),
      'Replace entire file',
    );
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

  // ── Review-Bug 3: symlink-aware path-traversal guard ───────────────────

  test('Review-Bug 3: a symlink directory inside the workspace cannot be traversed to write outside', async () => {
    // Create an /outside directory and link it from within the workspace.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-outside-'));
    const linkInside = path.join(tmpDir, 'evil');
    try {
      fs.symlinkSync(outside, linkInside, 'dir');
    } catch (e) {
      // Some test environments (Windows in CI) cannot create symlinks. Skip.
      // eslint-disable-next-line no-console
      console.warn('symlink unsupported on this platform — skipping', e);
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    (vscode.window.showErrorMessage as jest.Mock).mockClear();
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    // Try to apply via the symlinked dir to a path that physically lands in
    // /outside. Pre-fix code only checked `resolved.startsWith(ws + sep)` and
    // would have allowed this.
    await applyCodeBlock('evil/leaked.txt', 'pwn', 'blk-symlink');

    // Must have been rejected with the unsafe-path error and never opened a diff.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Unsafe path/),
    );
    const cmdCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls;
    expect(cmdCalls.find((c) => c[0] === 'vscode.diff')).toBeUndefined();

    // And the file was never written
    expect(fs.existsSync(path.join(outside, 'leaked.txt'))).toBe(false);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('Review-Bug 3: applying to a NEW file (parent exists, file does not) is allowed', async () => {
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Replace entire file');

    const newFile = path.join(tmpDir, 'subdir', 'new.cpp');
    fs.mkdirSync(path.dirname(newFile));
    // Sanity: file does not exist yet.
    expect(fs.existsSync(newFile)).toBe(false);

    const applyPromise = applyCodeBlock('subdir/new.cpp', '#pragma once\nclass A {};\nclass B {};\n', 'blk-newfile');
    const { acceptAiChanges } = await import('../chat/apply');
    acceptAiChanges('blk-newfile');
    await applyPromise;

    // No "Unsafe path" error — the guard correctly walked up to /tmpDir/subdir
    // (which exists) and confirmed it's inside the workspace realpath.
    const errCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls;
    expect(errCalls.find((c) => /Unsafe path/.test(String(c[0])))).toBeUndefined();
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
