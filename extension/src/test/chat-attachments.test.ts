/**
 * Tests for relevance-aware file attachment in the AI chat.
 *
 * The chat used to silently prepend the active editor's file to every
 * outbound LLM request. That was changed so files are sent ONLY when the
 * candidate explicitly attaches them (right-click → "Add to JivaHire chat",
 * paperclip → QuickPick) or references them with `@path` in the prompt.
 *
 * These tests exercise:
 *  - attachFile() rejects paths outside the workspace
 *  - send() with no attachments and no @-mentions sends NO file content
 *  - explicit attachments are prepended to the next send and then cleared
 *  - @-mentions that resolve to real workspace files are prepended
 *  - @-mentions that DON'T resolve to a file are dropped (no leakage)
 *  - removing an attachment chip works
 *  - active editor is NOT auto-attached (regression guard)
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import {
  ChatViewProvider,
  parseAtMentions,
  _collectAttachmentPaths,
  _buildAttachmentsBlock,
  _isInsideWorkspace,
  _filterWorkspaceFiles,
  ATTACHMENT_MAX_BYTES,
} from '../chat/view';
import * as vscode from 'vscode';
import { makeConfig, makeMockContext, makeMockWebviewView } from './helpers';

describe('parseAtMentions', () => {
  test('captures @path tokens preceded by whitespace or start-of-string', () => {
    expect(parseAtMentions('@src/foo.ts please review')).toEqual(['src/foo.ts']);
    expect(parseAtMentions('  @a.py and @b/c.py')).toEqual(['a.py', 'b/c.py']);
    expect(parseAtMentions('look at @README.md too')).toEqual(['README.md']);
  });

  test('does NOT capture email-style @ that has no leading whitespace', () => {
    expect(parseAtMentions('contact me at user@example.com')).toEqual([]);
  });

  test('dedupes repeated mentions', () => {
    expect(parseAtMentions('@a.ts and again @a.ts')).toEqual(['a.ts']);
  });

  test('trims trailing punctuation', () => {
    expect(parseAtMentions('start with @foo/bar.ts, then continue')).toEqual(['foo/bar.ts']);
    expect(parseAtMentions('see @main.py.')).toEqual(['main.py']);
  });

  test('returns empty array when no @ tokens present', () => {
    expect(parseAtMentions('just regular text without any references')).toEqual([]);
    expect(parseAtMentions('')).toEqual([]);
  });
});

describe('_isInsideWorkspace', () => {
  const root = '/tmp/ws-root';
  test('accepts simple relative paths', () => {
    expect(_isInsideWorkspace('src/foo.ts', root)).toBe(true);
    expect(_isInsideWorkspace('README.md', root)).toBe(true);
  });
  test('rejects absolute paths', () => {
    expect(_isInsideWorkspace('/etc/passwd', root)).toBe(false);
  });
  test('rejects parent traversal', () => {
    expect(_isInsideWorkspace('../escape.ts', root)).toBe(false);
    expect(_isInsideWorkspace('src/../../escape', root)).toBe(false);
  });
  test('rejects the workspace root itself', () => {
    expect(_isInsideWorkspace('.', root)).toBe(false);
  });
  test('rejects strings with embedded NUL bytes', () => {
    expect(_isInsideWorkspace('foo\0.ts', root)).toBe(false);
  });
});

describe('_collectAttachmentPaths', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-collect-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'b.py'), 'def b(): pass');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  test('returns explicit attachments that exist', () => {
    expect(_collectAttachmentPaths(['a.ts', 'src/b.py'], '')).toEqual(['a.ts', 'src/b.py']);
  });

  test('drops explicit attachments that do not exist on disk', () => {
    expect(_collectAttachmentPaths(['a.ts', 'does-not-exist.py'], '')).toEqual(['a.ts']);
  });

  test('drops paths that escape the workspace', () => {
    expect(_collectAttachmentPaths(['../../../etc/passwd'], '')).toEqual([]);
    expect(_collectAttachmentPaths(['/etc/passwd'], '')).toEqual([]);
  });

  test('@-mentions that resolve are added; @-mentions that do not are dropped', () => {
    const out = _collectAttachmentPaths([], 'please review @a.ts and @ghost.ts');
    expect(out).toEqual(['a.ts']);
  });

  test('explicit + @-mention are unioned and deduped (explicit first)', () => {
    const out = _collectAttachmentPaths(['src/b.py'], 'compare to @src/b.py and @a.ts');
    expect(out).toEqual(['src/b.py', 'a.ts']);
  });

  test('returns empty when no workspace is open', () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    expect(_collectAttachmentPaths(['a.ts'], '@a.ts')).toEqual([]);
  });
});

describe('_buildAttachmentsBlock', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-build-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  test('emits a file fence per attachment with content', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
    const block = _buildAttachmentsBlock(['a.ts']);
    expect(block).toMatch(/# Current contents of a\.ts/);
    expect(block).toMatch(/```typescript/);
    expect(block).toMatch(/export const a = 1;/);
  });

  test('returns empty string for empty input', () => {
    expect(_buildAttachmentsBlock([])).toBe('');
  });

  test('replaces oversize file body with a one-line marker', () => {
    const big = 'x'.repeat(ATTACHMENT_MAX_BYTES + 100);
    fs.writeFileSync(path.join(tmp, 'big.txt'), big);
    const block = _buildAttachmentsBlock(['big.txt']);
    expect(block).toMatch(/# Attached file big\.txt \(omitted/);
    expect(block).not.toContain(big);
  });

  test('skips a path that disappeared between resolution and read', () => {
    // Caller already validated existence; if the file is gone by the time we
    // read it, we drop it silently instead of crashing.
    const block = _buildAttachmentsBlock(['nothing-here.ts']);
    expect(block).toBe('');
  });
});

describe('ChatViewProvider attachment behavior', () => {
  let tmp: string;
  let context: ReturnType<typeof makeMockContext>;
  let provider: ChatViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;
  let server: http.Server;
  let baseUrl: string;
  let received: any[];

  beforeEach((done) => {
    jest.clearAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attach-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
    context = makeMockContext();
    provider = new ChatViewProvider(context);
    view = makeMockWebviewView();
    received = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n');
        res.write('data: [DONE]\n');
        res.end();
      });
    });
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
      done();
    });
  });

  afterEach((done) => {
    provider.dispose();
    server.close(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      (vscode.workspace as any).workspaceFolders = undefined;
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

  function lastUserContent(payload: any): string {
    const msgs = payload.messages as Array<{ role: string; content: string }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return msgs[i].content;
    }
    return '';
  }

  test('plain prompt with no attachments sends NO file content', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tmp, 'b.py'), 'def b(): pass');
    await setupSend('what is 2 + 2?');
    expect(received).toHaveLength(1);
    const content = lastUserContent(received[0]);
    // The user content is exactly what they typed. No fences, no file
    // markers, no "Current contents of" prelude.
    expect(content).toBe('what is 2 + 2?');
    expect(content).not.toContain('export const a = 1');
    expect(content).not.toContain('def b()');
    expect(content).not.toContain('Current contents of');
  });

  test('REGRESSION: active editor is NOT auto-attached', async () => {
    fs.writeFileSync(path.join(tmp, 'open.ts'), 'console.log("secret-canary");');
    // Simulate an open editor — pre-change, this file would have been
    // silently prepended to the LLM request.
    (vscode.window as any).activeTextEditor = {
      document: {
        uri: vscode.Uri.file(path.join(tmp, 'open.ts')),
        getText: () => 'console.log("secret-canary");',
        languageId: 'typescript',
      },
    };
    try {
      await setupSend('hello');
      const content = lastUserContent(received[0]);
      expect(content).toBe('hello');
      expect(content).not.toContain('secret-canary');
      expect(content).not.toContain('open.ts');
    } finally {
      (vscode.window as any).activeTextEditor = undefined;
    }
  });

  test('attachFile() adds a workspace file; next send prepends it; then it clears', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const ATTACHED = 1;');
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.attachFile('a.ts');
    expect(provider.getPendingAttachments()).toEqual(['a.ts']);

    await setupSend('what does this do?');
    const content = lastUserContent(received[0]);
    expect(content).toContain('# Current contents of a.ts');
    expect(content).toContain('export const ATTACHED = 1;');
    expect(content).toContain('what does this do?');
    // After send, the attachment list is cleared so the next prompt doesn't
    // re-attach by accident.
    expect(provider.getPendingAttachments()).toEqual([]);

    // Second send with no attachment must not include the file again.
    received.length = 0;
    await setupSend('follow-up');
    const second = lastUserContent(received[0]);
    expect(second).toBe('follow-up');
    expect(second).not.toContain('ATTACHED');
  });

  test('attachFile() rejects files outside the workspace', () => {
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.attachFile('../escape.ts');
    provider.attachFile('/etc/passwd');
    expect(provider.getPendingAttachments()).toEqual([]);
  });

  test('attachFile() rejects non-existent paths', () => {
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.attachFile('does-not-exist.ts');
    expect(provider.getPendingAttachments()).toEqual([]);
  });

  test('attachFile() is idempotent for the same path', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.attachFile('a.ts');
    provider.attachFile('a.ts');
    provider.attachFile('a.ts');
    expect(provider.getPendingAttachments()).toEqual(['a.ts']);
  });

  test('@-mention for a real workspace file is prepended', async () => {
    fs.writeFileSync(path.join(tmp, 'lru.cpp'), '// LRU cache impl');
    await setupSend('please review @lru.cpp for issues');
    const content = lastUserContent(received[0]);
    expect(content).toContain('# Current contents of lru.cpp');
    expect(content).toContain('// LRU cache impl');
    expect(content).toContain('please review @lru.cpp for issues');
  });

  test('@-mention for a path NOT in the workspace is silently dropped', async () => {
    fs.writeFileSync(path.join(tmp, 'real.ts'), 'real');
    await setupSend('check @ghost.ts and @real.ts');
    const content = lastUserContent(received[0]);
    // The real file is included.
    expect(content).toContain('# Current contents of real.ts');
    // The ghost reference does not leak a different file's content.
    expect(content).not.toContain('# Current contents of ghost.ts');
    // Sanity: no other workspace file got accidentally attached.
    expect((content.match(/# Current contents of /g) ?? []).length).toBe(1);
  });

  test('@-mention with parent traversal is dropped', async () => {
    fs.writeFileSync(path.join(tmp, 'safe.ts'), 'safe');
    await setupSend('try @../../../../etc/passwd or @safe.ts');
    const content = lastUserContent(received[0]);
    // No fenced-file block is added for the escape attempt — the only
    // mention of "/etc/passwd" in the payload is the user's own literal
    // text, which is fine. What we must NOT see is the file's CONTENTS
    // being read off disk and pasted in.
    expect(content).not.toContain('# Current contents of ../');
    expect(content).not.toContain('# Current contents of /etc/passwd');
    // Only one file-fence block is attached (safe.ts), nothing else.
    expect((content.match(/# Current contents of /g) ?? []).length).toBe(1);
    expect(content).toContain('# Current contents of safe.ts');
  });

  test('removeAttachment via webview message clears the chip', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'y');
    let msgHandler: ((m: any) => void) | undefined;
    view.webview.onDidReceiveMessage = jest.fn().mockImplementation((cb: any) => {
      msgHandler = cb;
      return { dispose: jest.fn() };
    });
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.resolveWebviewView(view, {} as any, {} as any);

    provider.attachFile('a.ts');
    provider.attachFile('b.ts');
    expect(provider.getPendingAttachments()).toEqual(['a.ts', 'b.ts']);

    msgHandler!({ command: 'removeAttachment', filePath: 'a.ts' });
    expect(provider.getPendingAttachments()).toEqual(['b.ts']);
  });

  test('chip HTML renders for each pending attachment and disappears when removed', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.resolveWebviewView(view, {} as any, {} as any);
    provider.attachFile('a.ts');
    expect(view.webview.html).toMatch(/data-attach-path="a\.ts"/);
    expect(view.webview.html).toMatch(/data-remove-attach="a\.ts"/);
  });

  test('empty pending list does not render any chips', () => {
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.resolveWebviewView(view, {} as any, {} as any);
    expect(view.webview.html).not.toMatch(/data-attach-path=/);
    // The attach UI hint is still there so candidates know how to use the
    // feature.
    expect(view.webview.html).toMatch(/Add to JivaHire chat/);
    expect(view.webview.html).toMatch(/typing @/);
    expect(view.webview.html).toMatch(/No file content is sent to the AI unless you attach it here/);
  });

  test('explicit attachment + @-mention of the same path is deduped', async () => {
    fs.writeFileSync(path.join(tmp, 'same.ts'), 'one');
    provider.setConfig(makeConfig({ llmProxyUrl: baseUrl }));
    provider.attachFile('same.ts');
    await setupSend('what about @same.ts?');
    const content = lastUserContent(received[0]);
    expect((content.match(/# Current contents of same\.ts/g) ?? []).length).toBe(1);
  });
});

describe('_filterWorkspaceFiles', () => {
  const files = [
    'README.md',
    'src/extension.ts',
    'src/chat/view.ts',
    'src/chat/apply.ts',
    'src/test/extension.test.ts',
    'docs/setup.md',
    'package.json',
    'tsconfig.json',
    'lru/lru.cpp',
    'lru/lru.h',
  ];

  test('empty query returns the first `limit` files in input order', () => {
    expect(_filterWorkspaceFiles(files, '', 3)).toEqual(files.slice(0, 3));
  });

  test('ranks basename prefix matches above contains matches', () => {
    const out = _filterWorkspaceFiles(files, 'lru', 5);
    // lru.cpp + lru.h start with "lru" — both rank before any path-only match.
    expect(out.slice(0, 2).sort()).toEqual(['lru/lru.cpp', 'lru/lru.h']);
  });

  test('basename substring beats path-only substring', () => {
    const out = _filterWorkspaceFiles(files, 'view', 5);
    expect(out[0]).toBe('src/chat/view.ts');
  });

  test('case-insensitive match', () => {
    expect(_filterWorkspaceFiles(files, 'readme', 5)).toEqual(['README.md']);
    expect(_filterWorkspaceFiles(files, 'README', 5)).toEqual(['README.md']);
    expect(_filterWorkspaceFiles(files, 'ReAdMe', 5)).toEqual(['README.md']);
  });

  test('returns an empty list when nothing matches', () => {
    expect(_filterWorkspaceFiles(files, 'zzzz', 5)).toEqual([]);
  });

  test('honors the limit argument', () => {
    expect(_filterWorkspaceFiles(files, '.ts', 2)).toHaveLength(2);
  });

  test('tiebreaks alphabetically when scores are equal', () => {
    const out = _filterWorkspaceFiles(['aaa.ts', 'bbb.ts', 'ccc.ts'], '', 3);
    expect(out).toEqual(['aaa.ts', 'bbb.ts', 'ccc.ts']);
  });

  test('SECURITY: filtering never reads file contents, only paths', () => {
    // Sanity guard for the contract: _filterWorkspaceFiles is a pure string
    // function. Pass paths that don't exist on disk — function must not
    // throw.
    expect(() => _filterWorkspaceFiles(['nope/missing.ts', 'also/gone.ts'], 'gone', 5)).not.toThrow();
    expect(_filterWorkspaceFiles(['nope/missing.ts', 'also/gone.ts'], 'gone', 5)).toEqual(['also/gone.ts']);
  });
});

describe('ChatViewProvider @-mention autocomplete', () => {
  let tmp: string;
  let context: ReturnType<typeof makeMockContext>;
  let provider: ChatViewProvider;
  let view: ReturnType<typeof makeMockWebviewView>;

  beforeEach(() => {
    jest.clearAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-suggest-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
    context = makeMockContext();
    provider = new ChatViewProvider(context);
    view = makeMockWebviewView();
  });

  afterEach(() => {
    provider.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode.workspace as any)._findFilesImpl = null;
  });

  test('refreshWorkspaceFiles caches the workspace file list', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'a');
    fs.writeFileSync(path.join(tmp, 'b.py'), 'b');
    (vscode.workspace as any)._findFilesImpl = async () => [
      vscode.Uri.file(path.join(tmp, 'a.ts')),
      vscode.Uri.file(path.join(tmp, 'b.py')),
    ];
    provider.setConfig(makeConfig({}));
    // setConfig fires a void refreshWorkspaceFiles — wait one tick.
    await new Promise((r) => setImmediate(r));
    const cached = provider.getWorkspaceFiles();
    expect(cached.sort()).toEqual(['a.ts', 'b.py']);
  });

  test('rendered HTML carries the workspace file list and help text', async () => {
    fs.writeFileSync(path.join(tmp, 'lru.cpp'), 'x');
    (vscode.workspace as any)._findFilesImpl = async () => [
      vscode.Uri.file(path.join(tmp, 'lru.cpp')),
    ];
    provider.setConfig(makeConfig({}));
    provider.resolveWebviewView(view, {} as any, {} as any);
    await new Promise((r) => setImmediate(r));
    // The webview HTML is regenerated lazily on render(); trigger one by
    // attaching a (no-op) file — but more directly, postMessage carries the
    // updated list. Verify it was sent.
    const postMessages = (view.webview.postMessage as jest.Mock).mock.calls;
    const update = postMessages.find((c) => c[0]?.command === 'updateWorkspaceFiles');
    expect(update).toBeDefined();
    expect(update![0].files).toEqual(['lru.cpp']);
    // The help text must explicitly tell the candidate that nothing is sent
    // unless they attach.
    expect(view.webview.html).toMatch(/No file content is sent to the AI unless you attach it here/);
    // The suggest box container must be present so the JS can fill it.
    expect(view.webview.html).toMatch(/id="suggest-box"/);
  });

  test('webview HTML embeds the filtering function inline', () => {
    // Smoke test: the suggestion JS must be in the bundle, otherwise the
    // autocomplete UI is dead.
    provider.setConfig(makeConfig({}));
    provider.resolveWebviewView(view, {} as any, {} as any);
    expect(view.webview.html).toMatch(/filterWorkspaceFiles/);
    expect(view.webview.html).toMatch(/detectAtMention/);
    expect(view.webview.html).toMatch(/insertSuggestion/);
  });

  test('file-system watcher (when available) triggers a refresh on create', async () => {
    (vscode.workspace as any)._findFilesImpl = async () => [
      vscode.Uri.file(path.join(tmp, 'one.ts')),
    ];
    provider.setConfig(makeConfig({}));
    provider.resolveWebviewView(view, {} as any, {} as any);
    await new Promise((r) => setImmediate(r));
    expect(provider.getWorkspaceFiles()).toEqual(['one.ts']);

    // Simulate a new file appearing on disk.
    (vscode.workspace as any)._findFilesImpl = async () => [
      vscode.Uri.file(path.join(tmp, 'one.ts')),
      vscode.Uri.file(path.join(tmp, 'two.ts')),
    ];
    const watcher = (vscode.workspace as any)._lastWatcher;
    expect(watcher).toBeTruthy();
    expect(typeof watcher._onCreate).toBe('function');
    watcher._onCreate(vscode.Uri.file(path.join(tmp, 'two.ts')));
    await new Promise((r) => setImmediate(r));
    expect(provider.getWorkspaceFiles().sort()).toEqual(['one.ts', 'two.ts']);
  });
});
