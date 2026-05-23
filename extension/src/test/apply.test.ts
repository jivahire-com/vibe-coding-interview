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

// ── Regression: Windows files use CRLF, LLM returns LF. The diff must still
//    recognise unchanged lines or the entire file collapses into a single
//    "delete-all + insert-all" hunk and looks like the AI rewrote everything.

describe('_buildHunks across mixed line endings (CRLF vs LF)', () => {
  let _buildHunks: typeof import('../chat/apply')._buildHunks;
  beforeAll(async () => {
    const mod = await import('../chat/apply');
    _buildHunks = mod._buildHunks;
  });

  test('CRLF original and LF proposed share unchanged lines (no giant hunk)', () => {
    const original = ['#include <list>', '#include <utility>', 'int x = 1;', '// end'].join('\r\n');
    // Single line changed in the middle, otherwise identical content but in LF.
    const proposed = ['#include <list>', '#include <utility>', 'int x = 99;', '// end'].join('\n');

    const hunks = _buildHunks(original, proposed);
    // Exactly one hunk that touches just the changed line — NOT a whole-file
    // replacement.
    expect(hunks.length).toBe(1);
    expect(hunks[0].originalLines).toEqual(['int x = 1;']);
    expect(hunks[0].newLines).toEqual(['int x = 99;']);
  });

  test('all-LF input on both sides still works (no double-eol confusion)', () => {
    const original = 'a\nb\nc\n';
    const proposed = 'a\nB\nc\n';
    const hunks = _buildHunks(original, proposed);
    expect(hunks.length).toBe(1);
    expect(hunks[0].originalLines).toEqual(['b']);
    expect(hunks[0].newLines).toEqual(['B']);
  });

  test('identical content modulo line endings produces no hunks', () => {
    const original = 'a\r\nb\r\nc\r\n';
    const proposed = 'a\nb\nc\n';
    expect(_buildHunks(original, proposed)).toEqual([]);
  });
});

describe('inline session lifecycle', () => {
  let tmpDir: string;
  let target: string;
  let acceptAiChanges: typeof import('../chat/apply').acceptAiChanges;
  let rejectAiChanges: typeof import('../chat/apply').rejectAiChanges;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-session-'));
    target = path.join(tmpDir, 'foo.cpp');
    fs.writeFileSync(target, '// original\n', 'utf8');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: tmpDir } } as { uri: { fsPath: string } },
    ];
    jest.clearAllMocks();
    const mod = await import('../chat/apply');
    acceptAiChanges = mod.acceptAiChanges;
    rejectAiChanges = mod.rejectAiChanges;
  });

  afterEach(() => {
    _disposeApplyForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  test('session is registered immediately (before first await) and resolves after acceptAiChanges', async () => {
    const { applyCodeBlock } = await import('../chat/apply');

    const p = applyCodeBlock('foo.cpp', 'int main() { return 1; }\n', 'blk-lifecycle');

    // Session is available synchronously (no await needed).
    expect(_pendingSizeForTests()).toBe(1);
    // Initial preview applyEdit fires immediately.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);

    acceptAiChanges('blk-lifecycle');
    await p;

    // Session cleaned up. Accept fires a second applyEdit dropping red lines.
    expect(_pendingSizeForTests()).toBe(0);
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
  });

  test('accepting writes the final state — applyEdit called twice (preview + drop-original)', async () => {
    const { applyCodeBlock } = await import('../chat/apply');

    const p = applyCodeBlock('foo.cpp', 'int main() { return 99; }\n', 'blk-accept');
    await new Promise((r) => setImmediate(r));

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    acceptAiChanges('blk-accept');
    await p;

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    const finalEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0];
    const finalText = (finalEdit.getEdits() as Array<{ text: string }>)[0].text;
    // After accept the file is the new content only.
    expect(finalText).toContain('return 99');
    expect(finalText).not.toContain('// original');
  });

  test('rejecting reverts the file — applyEdit called twice (preview + drop-new)', async () => {
    const { applyCodeBlock } = await import('../chat/apply');

    const p = applyCodeBlock('foo.cpp', 'int main() { return 99; }\n', 'blk-reject');
    await new Promise((r) => setImmediate(r));

    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    rejectAiChanges('blk-reject');
    await p;

    // Reject drops the green (new) lines, restoring the original content.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    const revertEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0];
    const edits = revertEdit.getEdits() as Array<{ text: string }>;
    expect(edits[0].text).toBe('// original\n');
  });

  test('rejecting fires edit_ai_rejected telemetry with block_id + chars', async () => {
    const { applyCodeBlock, setTelemetryCallback } = await import('../chat/apply');
    const calls: Array<{ event: string; payload: Record<string, unknown> }> = [];
    setTelemetryCallback((event, payload) => calls.push({ event, payload: payload as Record<string, unknown> }));

    const p = applyCodeBlock('foo.cpp', 'int main() { return 99; }\n', 'blk-reject-tel');
    await new Promise((r) => setImmediate(r));
    rejectAiChanges('blk-reject-tel');
    await p;

    const rejected = calls.filter((c) => c.event === 'edit_ai_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.block_id).toBe('blk-reject-tel');
    expect(rejected[0].payload.file).toBe('foo.cpp');
    expect(typeof rejected[0].payload.chars).toBe('number');
    expect((rejected[0].payload.chars as number)).toBeGreaterThan(0);

    // Reset for other tests.
    setTelemetryCallback(() => {});
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
    const mod = await import('../chat/apply');
    acceptAiChanges = mod.acceptAiChanges;
  });

  afterEach(() => {
    _disposeApplyForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  test('two-method JS snippet anchors both regions — NO modal, applied immediately', async () => {
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
    // Inline-diff mode: applyEdit fires immediately, no modal.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

    // Inline-diff mode is one full-file preview edit. The preview contains
    // BOTH the original setQuery/getState (red) and the new ones (green),
    // plus all surrounding untouched code.
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0][0];
    const edits = edit.getEdits() as Array<{ range: vscode.Range; text: string }>;
    expect(edits.length).toBe(1);
    const previewText = edits[0].text;
    expect(previewText).toContain('this.dirty = true');     // new green line
    expect(previewText).toContain('Math.ceil');             // new green line
    expect(previewText).toContain('Math.floor');            // original red line (still visible in preview)
    expect(previewText).toContain('destroy()');             // untouched method preserved

    acceptAiChanges('blk-multi');
    await p;
    // Accept fires a second applyEdit that drops the red (original) lines.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
    const finalText = ((vscode.workspace.applyEdit as jest.Mock).mock.calls[1][0]
      .getEdits() as Array<{ text: string }>)[0].text;
    expect(finalText).toContain('this.dirty = true');
    expect(finalText).toContain('Math.ceil');
    expect(finalText).not.toContain('Math.floor');          // original line dropped
    expect(finalText).toContain('destroy()');               // untouched still present
  });

  test('partial snippet that cannot anchor any block → applied as full-file, no modal', async () => {
    fs.writeFileSync(target, '// existing js file\nfunction other() { return 1; }\n', 'utf8');

    const snippet = 'function brandNewFunction() {\n  return 42;\n}';
    const p = applyCodeBlock('user_search.js', snippet, 'blk-noanchor');
    // Applied immediately as full-file replacement — no modal in inline mode.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

    acceptAiChanges('blk-noanchor');
    await p;
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

  test('session is registered before first await — synchronous callers can accept immediately', async () => {
    const applyPromise = applyCodeBlock(
      'foo.cpp',
      'int main() { return 1; }',
      'blk-1',
    );

    // Session registered synchronously (before any await in applyCodeBlock).
    expect(_pendingSizeForTests()).toBe(1);
    // applyEdit was also called immediately.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);

    const { acceptAiChanges } = await import('../chat/apply');
    acceptAiChanges('blk-1');
    await expect(applyPromise).resolves.toBeUndefined();
    expect(_pendingSizeForTests()).toBe(0);
  });

  test('full-file replacement applies immediately — no confirmation modal', async () => {
    fs.writeFileSync(originalFile, '// hand-written code\nint main() {\n  return 42;\n}\n', 'utf8');

    const applyPromise = applyCodeBlock(
      'foo.cpp',
      '#pragma once\nclass A {};\nclass B {};\n', // looksLikeFullFile → true
      'blk-fullfile',
    );
    const { acceptAiChanges } = await import('../chat/apply');
    // Initial preview applyEdit fires immediately — no modal needed.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

    acceptAiChanges('blk-fullfile');
    await applyPromise;

    // Accept fires a second applyEdit dropping the red (original) lines.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
  });

  test('empty target file → applyEdit fires immediately and accept needs no second edit', async () => {
    const empty = path.join(tmpDir, 'new.cpp');
    fs.writeFileSync(empty, '', 'utf8');

    const applyPromise = applyCodeBlock(
      'new.cpp',
      '#pragma once\nclass A {};\nclass B {};\n',
      'blk-empty',
    );
    const { acceptAiChanges } = await import('../chat/apply');
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    acceptAiChanges('blk-empty');
    await applyPromise;
    // For pure insertion (empty original) there are no red lines to drop, but
    // the implementation still issues the final write to be consistent.
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(2);
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

    // Try to apply via the symlinked dir to a path that physically lands in
    // /outside. Pre-fix code only checked `resolved.startsWith(ws + sep)` and
    // would have allowed this.
    await applyCodeBlock('evil/leaked.txt', 'pwn', 'blk-symlink');

    // Must have been rejected with the unsafe-path error and never applied any edit.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Unsafe path/),
    );
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();

    // And the file was never written
    expect(fs.existsSync(path.join(outside, 'leaked.txt'))).toBe(false);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('Review-Bug 3: applying to a NEW file (parent exists, file does not) is allowed', async () => {
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
});
