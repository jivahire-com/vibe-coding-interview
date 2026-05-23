import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { suppressNextApplyEvent } from '../telemetry';

export const AI_PROPOSED_SCHEME = "vibe-ai-proposed";

/**
 * Confirm `resolved` lies under `ws` after symlinks are followed. The naive
 * `resolved.startsWith(ws + sep)` check is symlink-blind.
 */
export function _isInsideWorkspace(ws: string, resolved: string): boolean {
  let wsReal: string;
  try { wsReal = fs.realpathSync(ws); } catch { wsReal = path.resolve(ws); }
  const wsRealNorm = wsReal.replace(/[\\/]+$/, "");

  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  let probeReal: string;
  try { probeReal = fs.realpathSync(probe); } catch { probeReal = probe; }

  const suffix = path.relative(probe, resolved);
  const finalPath = suffix ? path.join(probeReal, suffix) : probeReal;

  return finalPath === wsRealNorm || finalPath.startsWith(wsRealNorm + path.sep);
}

// ─── Hunk + session types ──────────────────────────────────────────────────

interface Hunk {
  index: number;
  originalLines: string[];   // red — lines present in original but removed in proposed
  newLines: string[];        // green — lines added in proposed
  // Line index in the ORIGINAL text where this hunk's removed lines begin.
  // Stable across status changes — used to recompose the document text.
  originalStart: number;
  // Current line positions in the document. Red comes first, green right after.
  // Recomputed by _composeDocText whenever statuses change.
  redStart: number;
  redEnd: number;            // exclusive
  greenStart: number;
  greenEnd: number;          // exclusive
  status: 'pending' | 'accepted' | 'rejected';
}

interface InlineSession {
  id: string;
  fileUri: vscode.Uri;
  fileKey: string;           // case-normalised fsPath for cross-platform map lookups
  originalFullText: string;
  originalLines: string[];   // line-split (no trailing EOL) — source of truth for compose
  eol: string;               // '\n' or '\r\n' — preserved on writeback
  proposedFullText: string;
  workspace: string;
  relativePath: string;
  hunks: Hunk[];
  _resolve: () => void;
}

const _inlineSessions = new Map<string, InlineSession>();

/**
 * Mirror the size of `_inlineSessions` into a context key so the editor
 * title-bar menu can show file-level Accept/Reject only when a diff is
 * actually in progress. Called from every mutation point on the map.
 */
function _updateDiffActiveContext(): void {
  try {
    void vscode.commands.executeCommand(
      'setContext',
      'vibe.diff.active',
      _inlineSessions.size > 0,
    );
  } catch {
    // No command host in tests — fine.
  }
}

/**
 * Look up the active inline-diff session for whichever file the user is
 * currently focused on. Used when a title-bar command fires without a
 * blockId argument (title-bar menu items don't pass arguments).
 */
export function _getSessionForActiveEditor(): InlineSession | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const key = _pathKey(ed.document.uri.fsPath);
  return [..._inlineSessions.values()].find((s) => s.fileKey === key);
}

/**
 * Cross-platform path key. Windows file systems are case-insensitive, so a
 * URI captured at apply time may not byte-equal the document URI VS Code
 * hands to the CodeLens provider. Normalise on lower-case for that platform.
 */
function _pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// ─── Status bar items (file-level Accept / Reject) ──────────────────────────
//
// CodeLens text can't be styled — colour and size are theme-fixed. Editor
// title-bar buttons only render as small monochrome icons, which the
// candidate couldn't see. The status bar is the only standard VS Code
// surface that supports BOTH text labels AND a background colour (limited
// to `prominentBackground` / `warningBackground` / `errorBackground`), so
// we render the file-level controls there. They appear at the bottom of
// the window with bright backgrounds whenever a diff session is active.

let _acceptStatusBarItem: vscode.StatusBarItem | undefined;
let _rejectStatusBarItem: vscode.StatusBarItem | undefined;

function _ensureStatusBarItems(): void {
  if (typeof vscode.window.createStatusBarItem !== 'function') return;
  // Priorities just below the JivaHire dashboard-toggle button (which sits at
  // 100), so Accept(99) and Reject(98) appear immediately to its right on the
  // left-aligned status bar. Adjacent integers guarantee they stay together —
  // no built-in or third-party item is going to register at exactly 98.5.
  if (!_acceptStatusBarItem) {
    _acceptStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    _acceptStatusBarItem.command = 'vibe.acceptAllHunks';
    // VS Code's StatusBarItem.backgroundColor only honours
    // `statusBarItem.warningBackground` (yellow) and `.errorBackground` (red);
    // every other ThemeColor is silently dropped to the default (dark) status
    // bar background. There is no built-in blue background. So we colour the
    // FOREGROUND text blue via the `charts.blue` ThemeColor — readable against
    // the default status bar background in both light and dark themes.
    _acceptStatusBarItem.color = new vscode.ThemeColor('charts.blue');
    _acceptStatusBarItem.tooltip = 'Accept every AI-proposed change in this file';
  }
  if (!_rejectStatusBarItem) {
    _rejectStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98,
    );
    _rejectStatusBarItem.command = 'vibe.rejectAllHunks';
    _rejectStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    _rejectStatusBarItem.tooltip = 'Reject every AI-proposed change in this file';
  }
}

/**
 * Show / hide the file-level Accept and Reject status bar items based on
 * whether there's an active inline-diff session. The labels include the
 * pending-hunk count so the candidate can see how many changes remain.
 */
function _refreshStatusBarItems(): void {
  _ensureStatusBarItems();
  if (!_acceptStatusBarItem || !_rejectStatusBarItem) return;

  if (_inlineSessions.size === 0) {
    _acceptStatusBarItem.hide();
    _rejectStatusBarItem.hide();
    return;
  }
  let pendingTotal = 0;
  for (const s of _inlineSessions.values()) {
    pendingTotal += s.hunks.filter((h) => h.status === 'pending').length;
  }
  if (pendingTotal === 0) {
    _acceptStatusBarItem.hide();
    _rejectStatusBarItem.hide();
    return;
  }
  _acceptStatusBarItem.text = `$(check-all)  ACCEPT FILE  (${pendingTotal})`;
  _rejectStatusBarItem.text = `$(close-all)  REJECT FILE`;
  _acceptStatusBarItem.show();
  _rejectStatusBarItem.show();
}

/**
 * Detect the predominant line ending in a text blob. Used so we write back
 * the same EOL the candidate's file already has — Windows files commonly use
 * CRLF, and mixing in pure-LF lines would visibly garble the diff.
 */
function _detectEol(text: string): string {
  // Count CRLF occurrences; if any are present and they're the majority of
  // line breaks, treat the file as CRLF.
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && crlf >= lf) return '\r\n';
  return '\n';
}

/**
 * Split text into lines, tolerating both `\n` and `\r\n`. Trailing CR is
 * stripped from every line. A trailing newline produces a trailing empty
 * line — preserved so we can faithfully reconstruct the original on accept.
 */
function _splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split(/\r?\n/);
}

// ─── Decorations (lazy-created so test-mock env stays lightweight) ──────────

let _redDecoration: vscode.TextEditorDecorationType | undefined;
let _greenDecoration: vscode.TextEditorDecorationType | undefined;

function _decorations(): { red: vscode.TextEditorDecorationType; green: vscode.TextEditorDecorationType } | undefined {
  if (typeof vscode.window.createTextEditorDecorationType !== 'function') return undefined;
  if (!_redDecoration) {
    _redDecoration = vscode.window.createTextEditorDecorationType({
      // Red tint only — no strike-through. The line-wide highlight is enough
      // to mark removed lines, and the strike made the text harder to read
      // for candidates who want to copy from it.
      backgroundColor: 'rgba(220, 60, 60, 0.32)',
      isWholeLine: true,
      overviewRulerColor: 'rgba(220, 60, 60, 0.9)',
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      before: {
        contentText: '− ',
        color: 'rgba(220, 60, 60, 0.95)',
        margin: '0 6px 0 0',
        fontWeight: 'bold',
      },
    });
  }
  if (!_greenDecoration) {
    _greenDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(60, 200, 100, 0.28)',
      isWholeLine: true,
      overviewRulerColor: 'rgba(60, 200, 100, 0.9)',
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      before: {
        contentText: '+ ',
        color: 'rgba(60, 200, 100, 1.0)',
        margin: '0 6px 0 0',
        fontWeight: 'bold',
      },
    });
  }
  return { red: _redDecoration, green: _greenDecoration };
}

// ─── Content provider stub kept for backward compatibility ─────────────────

export class AiProposedContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(_uri: vscode.Uri): string { return ""; }
}

// ─── CodeLens: per-hunk + file-level Accept/Reject ─────────────────────────

export class AiInlineHunkCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  refresh(): void { this._onDidChange.fire(); }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== "file") return [];
    const docKey = _pathKey(document.uri.fsPath);
    const session = [..._inlineSessions.values()].find((s) => s.fileKey === docKey);
    if (!session) return [];
    const pending = session.hunks.filter((h) => h.status === 'pending');
    if (pending.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];

    // File-level Accept All / Reject All at line 0. The same commands are
    // also bound in the editor title bar (see package.json), giving two
    // entry points — but the line-0 lens is where the user expects to see
    // the "whole-file" decision, and coloured emoji are the only way to
    // inject colour into a CodeLens (text colour is theme-fixed).
    const topRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(topRange, {
        title: `✅ Accept all (${pending.length})`,
        command: "vibe.acceptAllHunks",
        arguments: [session.id],
      }),
      new vscode.CodeLens(topRange, {
        title: `❌ Reject all`,
        command: "vibe.rejectAllHunks",
        arguments: [session.id],
      }),
    );

    for (const h of pending) {
      const anchorLine = h.redEnd > h.redStart ? h.redStart : h.greenStart;
      const safeLine = Math.max(0, Math.min(anchorLine, _docLineCount(document) - 1));
      const range = new vscode.Range(safeLine, 0, safeLine, 0);
      const greenCount = h.greenEnd - h.greenStart;
      const redCount = h.redEnd - h.redStart;
      const tag = `−${redCount} +${greenCount}`;
      // Coloured emoji draw the eye; CodeLens text colour and size are
      // fixed by VS Code and can't be styled directly.
      lenses.push(
        new vscode.CodeLens(range, {
          title: `✅ Accept  ${tag}`,
          command: "vibe.acceptHunk",
          arguments: [session.id, h.index],
        }),
        new vscode.CodeLens(range, {
          title: `❌ Reject`,
          command: "vibe.rejectHunk",
          arguments: [session.id, h.index],
        }),
      );
    }
    return lenses;
  }
}

function _docLineCount(doc: vscode.TextDocument): number {
  // Tests use a stripped-down TextDocument shape. Fall back when lineCount missing.
  return (doc as { lineCount?: number }).lineCount ?? 1;
}

// Alias for backward compatibility with extension.ts imports.
export const AiApplyCodeLensProvider = AiInlineHunkCodeLensProvider;

let _codeLensProvider: AiInlineHunkCodeLensProvider | undefined;
let _activeEditorListenerInstalled = false;

export function registerCodeLensProvider(p: AiInlineHunkCodeLensProvider): void {
  _codeLensProvider = p;
  // Reapply decorations whenever the candidate flips back to a file we have
  // an active diff session on — VS Code drops per-editor decorations when an
  // editor is closed and reopened, so we need to rehydrate them on focus.
  if (!_activeEditorListenerInstalled && typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    _activeEditorListenerInstalled = true;
    try {
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (!ed) return;
        const key = _pathKey(ed.document.uri.fsPath);
        const session = [..._inlineSessions.values()].find((s) => s.fileKey === key);
        if (session) {
          _refreshDecorations(session);
          _codeLensProvider?.refresh();
        }
      });
    } catch {
      // No window subscription in tests — fine.
    }
  }
}

let _telemetryCallback: ((event: string, payload: object) => void) | undefined;

export function setTelemetryCallback(cb: (event: string, payload: object) => void): void {
  _telemetryCallback = cb;
}

// ─── Accept / Reject — file-level (accept-all / reject-all) ────────────────

export function acceptAiChanges(blockId: string): void {
  // File-level accept: drop all red lines for pending hunks.
  void _resolveAllPending(blockId, 'accepted');
}

export function rejectAiChanges(blockId: string): void {
  // File-level reject: drop all green lines for pending hunks.
  void _resolveAllPending(blockId, 'rejected');
}

async function _resolveAllPending(blockId: string, status: 'accepted' | 'rejected'): Promise<void> {
  const session = _inlineSessions.get(blockId);
  if (!session) return;
  let mutated = false;
  const transitionedHunks: Hunk[] = [];
  for (const h of session.hunks) {
    if (h.status === 'pending') {
      h.status = status;
      mutated = true;
      transitionedHunks.push(h);
    }
  }
  if (mutated) {
    await _writeSessionState(session);
    if (status === 'rejected' && transitionedHunks.length > 0) {
      _emitRejectedTelemetry(session, transitionedHunks);
    }
  }
  // Always refresh + resolve if everything is done — even if nothing changed,
  // the session may have been left dangling.
  _refreshDecorations(session);
  _codeLensProvider?.refresh();
  _refreshStatusBarItems();
  if (session.hunks.every((h) => h.status !== 'pending')) {
    session._resolve();
  }
}

// ─── Per-hunk accept / reject ──────────────────────────────────────────────

export function acceptHunk(blockId: string, hunkIndex: number): void {
  void _resolveHunk(blockId, hunkIndex, 'accepted');
}

export function rejectHunk(blockId: string, hunkIndex: number): void {
  void _resolveHunk(blockId, hunkIndex, 'rejected');
}

async function _resolveHunk(blockId: string, hunkIndex: number, status: 'accepted' | 'rejected'): Promise<void> {
  const session = _inlineSessions.get(blockId);
  if (!session) return;
  const hunk = session.hunks.find((h) => h.index === hunkIndex);
  if (!hunk || hunk.status !== 'pending') return;
  hunk.status = status;
  await _writeSessionState(session);
  if (status === 'rejected') _emitRejectedTelemetry(session, [hunk]);
  _refreshDecorations(session);
  _codeLensProvider?.refresh();
  _refreshStatusBarItems();
  if (session.hunks.every((h) => h.status !== 'pending')) {
    session._resolve();
  }
}

/**
 * Emit one `edit_ai_rejected` event per apply-session whenever the candidate
 * declines AI-proposed hunks. The grader uses this as the strongest signal for
 * the AI Judgment & Rejection dimension — telemetry-only, ungameable.
 *
 * `chars` is the byte length the AI proposed to add in the rejected hunks
 * (joined with `\n`). Matches the convention used by `edit_ai_applied` so the
 * server's per-session counters can sum both event types uniformly.
 */
function _emitRejectedTelemetry(session: InlineSession, hunks: Hunk[]): void {
  if (!_telemetryCallback || hunks.length === 0) return;
  const chars = hunks.reduce((sum, h) => sum + h.newLines.join('\n').length, 0);
  _telemetryCallback("edit_ai_rejected", {
    file: session.relativePath,
    block_id: session.id,
    chars,
    hunks: hunks.length,
  });
}

/** @internal */
export function _pendingSizeForTests(): number {
  return _inlineSessions.size;
}

/** @internal */
export function _disposeApplyForTests(): void {
  for (const session of _inlineSessions.values()) {
    session._resolve();
  }
  _inlineSessions.clear();
  _updateDiffActiveContext();
  _refreshStatusBarItems();
}

// ─── Document text rebuilding ──────────────────────────────────────────────

/**
 * Compose the document text from the session's hunks at their current status.
 * Walks the original text and applies each hunk: pending shows red+green,
 * accepted shows green only, rejected shows red (original) only.
 * Also updates the in-memory line positions on each hunk to match the result.
 */
function _composeDocText(session: InlineSession): string {
  // Reconstruct ops by walking the proposed sequence using hunk metadata.
  // Each hunk knows what was removed and what was added. Equal regions
  // between hunks we can recover from the original text.
  const lines: string[] = [];
  const originalLines = session.originalLines;

  // Sort hunks by their original-text start. We need to know where each hunk
  // sat in the ORIGINAL text. Track that as we go through hunks in document
  // order: the first hunk's originalLines occupy original positions [origCursor,
  // origCursor + originalLines.length). Equal text between hunks sits in the
  // gap.
  // Hunks were created in document order during _buildPreview, so they already
  // correspond to the original-text order too.
  let origCursor = 0;
  for (const h of session.hunks) {
    // Determine how many equal lines came before this hunk:
    //   - When the hunk was built, its redStart in preview-text equaled
    //     the number of equal-or-already-consumed lines emitted so far.
    //     But since per-hunk positions shift after operations, we cannot
    //     rely on h.redStart here. Instead we track origCursor by counting
    //     originalLines from previous hunks.
    // We need to know how many equal lines from the original come between
    // origCursor and the start of this hunk's removed lines. We store that
    // implicitly: it's the "originalStart" relative to origCursor.
    // To recover it without storing extra data: walk the originalLines until
    // we find a slice that matches h.originalLines. But that's fuzzy. So:
    // we instead persisted the start in the session via the `originalStart`
    // property — see _buildPreview.
    const start = h.originalStart;
    // Emit equal lines from origCursor to start
    for (let i = origCursor; i < start; i++) lines.push(originalLines[i] ?? '');

    // Update hunk's red position to where it will land in the composed text
    h.redStart = lines.length;
    if (h.status === 'rejected') {
      // Show original lines only (red zone occupies their position).
      for (const ol of h.originalLines) lines.push(ol);
      h.redEnd = lines.length;
      h.greenStart = lines.length;
      h.greenEnd = lines.length;
    } else if (h.status === 'accepted') {
      // Show new lines only (no red zone).
      h.redEnd = lines.length;
      h.greenStart = lines.length;
      for (const nl of h.newLines) lines.push(nl);
      h.greenEnd = lines.length;
    } else {
      // Pending: show original, then new.
      for (const ol of h.originalLines) lines.push(ol);
      h.redEnd = lines.length;
      h.greenStart = lines.length;
      for (const nl of h.newLines) lines.push(nl);
      h.greenEnd = lines.length;
    }

    origCursor = start + h.originalLines.length;
  }
  // Trailing equal lines.
  for (let i = origCursor; i < originalLines.length; i++) lines.push(originalLines[i] ?? '');

  return lines.join(session.eol);
}

async function _writeSessionState(session: InlineSession): Promise<void> {
  const desired = _composeDocText(session);
  const wsEdit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  );
  wsEdit.replace(session.fileUri, fullRange, desired);
  suppressNextApplyEvent();
  await vscode.workspace.applyEdit(wsEdit);
}

// ─── Decoration refresh ────────────────────────────────────────────────────

function _refreshDecorations(session: InlineSession): void {
  const decos = _decorations();
  if (!decos) return;
  const editors = vscode.window.visibleTextEditors ?? [];
  for (const ed of editors) {
    const docPath = ed.document?.uri?.fsPath;
    if (!docPath || _pathKey(docPath) !== session.fileKey) continue;
    const redRanges: vscode.Range[] = [];
    const greenRanges: vscode.Range[] = [];
    for (const h of session.hunks) {
      if (h.status !== 'pending') continue;
      if (h.redEnd > h.redStart) {
        redRanges.push(new vscode.Range(h.redStart, 0, h.redEnd - 1, Number.MAX_SAFE_INTEGER));
      }
      if (h.greenEnd > h.greenStart) {
        greenRanges.push(new vscode.Range(h.greenStart, 0, h.greenEnd - 1, Number.MAX_SAFE_INTEGER));
      }
    }
    try {
      ed.setDecorations?.(decos.red, redRanges);
      ed.setDecorations?.(decos.green, greenRanges);
    } catch {
      // Decoration API not available (tests).
    }
  }
}

// ─── applyCodeBlock — main entry point ─────────────────────────────────────

async function _ensureFileOpen(session: InlineSession): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(session.fileUri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    // Non-fatal — tests run without a real editor host.
  }
}

function _refreshUi(session: InlineSession): void {
  _refreshDecorations(session);
  _codeLensProvider?.refresh();
}

export async function applyCodeBlock(
  targetPath: string,
  newText: string,
  blockId: string
): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const resolved = path.resolve(ws, targetPath);
  if (!_isInsideWorkspace(ws, resolved)) {
    vscode.window.showErrorMessage(`Unsafe path: ${targetPath}`);
    return;
  }

  const fileKey = _pathKey(resolved);

  // Auto-reject any prior active session on the same file so two diffs don't
  // collide. If the user starts a new apply, they're done with the old one.
  for (const [oldId, s] of [..._inlineSessions]) {
    if (oldId !== blockId && s.fileKey === fileKey) {
      await _resolveAllPending(oldId, 'rejected');
    }
  }

  const originalText = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
  const originalUri = vscode.Uri.file(resolved);
  const eol = _detectEol(originalText) || _detectEol(newText) || '\n';
  const originalLines = _splitLines(originalText);

  // Compute the proposed final text using surgical regions when possible.
  const ext = path.extname(resolved).toLowerCase();
  const isFullFile = looksLikeFullFile(newText, originalText, ext);
  const matches: RegionMatch[] | null =
    isFullFile ? null : _findAllRegions(originalText, newText, ext);
  const isSurgical = !isFullFile && matches !== null && matches.length > 0;

  let proposedText: string;
  if (isSurgical && matches) {
    proposedText = _applyRegionsToText(originalText, matches);
  } else {
    proposedText = newText;
  }

  // Build line-level hunks between original and proposed — using
  // EOL-normalised line splits so a CRLF-ended file diffs cleanly against a
  // LF-ended LLM snippet. Without this every line on Windows would carry a
  // stray `\r` and LCS would treat the entire file as one giant replace.
  const hunks = _buildHunks(originalText, proposedText);

  // Register session synchronously so callers (and tests) can find it
  // immediately after the function returns.
  const session: InlineSession = {
    id: blockId,
    fileUri: originalUri,
    fileKey,
    originalFullText: originalText,
    originalLines,
    eol,
    proposedFullText: proposedText,
    workspace: ws,
    relativePath: path.relative(ws, resolved),
    hunks,
    _resolve: () => {},
  };
  const lifecyclePromise = new Promise<void>((resolve) => {
    session._resolve = resolve;
  });
  _inlineSessions.set(blockId, session);
  _updateDiffActiveContext();
  _refreshStatusBarItems();

  if (hunks.length === 0) {
    // Nothing to change — resolve immediately.
    _inlineSessions.delete(blockId);
    _updateDiffActiveContext();
  _refreshStatusBarItems();
    _telemetryCallback?.("edit_ai_applied", {
      file: session.relativePath,
      chars_added: 0,
      chars_removed: 0,
      block_id: blockId,
    });
    return;
  }

  // Kick off the initial preview write SYNCHRONOUSLY so the applyEdit call
  // lands in any mock/observer before we yield. The promise is awaited below
  // alongside the editor-open promise.
  const initialApply = _writeSessionState(session);
  // Open the file in parallel so the user sees the diff in the visible editor.
  const editorOpened = _ensureFileOpen(session);
  await Promise.all([initialApply, editorOpened]);

  // Refresh decorations + CodeLenses AFTER both the edit has applied and the
  // file is in front of the user. Without this, freshly-opened editors miss
  // the very first decoration/lens paint.
  _refreshUi(session);

  await lifecyclePromise;
  _inlineSessions.delete(blockId);
  _updateDiffActiveContext();
  _refreshStatusBarItems();

  _telemetryCallback?.("edit_ai_applied", {
    file: session.relativePath,
    chars_added: newText.length,
    chars_removed: originalText.length,
    block_id: blockId,
  });
}

// ─── looksLikeFullFile, region matching (preserved from prior impl) ────────

const BRACE_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".java", ".cs", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".kt", ".scala", ".swift",
]);

const INDENT_EXTS = new Set([".py", ".pyi", ".yaml", ".yml", ".coffee", ".pyx"]);

export function looksLikeFullFile(newText: string, originalText: string, ext: string): boolean {
  if (originalText.trim().length === 0) return true;
  if (newText.includes("#pragma once") || /^\s*#ifndef\s/m.test(newText)) return true;
  if (ext === ".py" || ext === ".pyi") {
    const lines = newText.split("\n");
    const topLevel = lines.filter((l) => /^(import |from |class |def |async def )/.test(l));
    if (topLevel.length >= 2) return true;
  }
  if ((ext === ".ts" || ext === ".js" || ext === ".tsx" || ext === ".jsx") &&
      /^\s*(import |export )/m.test(newText)) {
    const topLevelExports = (newText.match(/^export /gm) ?? []).length;
    if (topLevelExports >= 2) return true;
  }
  return false;
}

export interface RegionMatch {
  range: vscode.Range;
  replacement: string;
}

export function _splitSnippet(newText: string, ext: string): string[] {
  if (INDENT_EXTS.has(ext)) return _splitSnippetIndent(newText);
  if (BRACE_EXTS.has(ext) || ext === "") return _splitSnippetBraces(newText);
  return [newText];
}

function _splitSnippetBraces(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let depth = 0;
  let sawOpen = false;

  const flush = (): void => {
    while (current.length > 0 && current[current.length - 1].trim().length === 0) current.pop();
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
    sawOpen = false;
    depth = 0;
  };

  for (const line of lines) {
    if (!sawOpen && current.length === 0 && line.trim().length === 0) continue;
    current.push(line);
    for (const ch of line) {
      if (ch === "{") { depth++; sawOpen = true; }
      else if (ch === "}") { depth = Math.max(0, depth - 1); }
    }
    if (sawOpen && depth === 0) flush();
  }
  if (sawOpen && depth !== 0) return [text];
  if (current.length > 0) {
    while (current.length > 0 && current[current.length - 1].trim().length === 0) current.pop();
    if (current.length > 0) blocks.push(current.join("\n"));
  }
  return blocks.length > 0 ? blocks : [text];
}

function _splitSnippetIndent(text: string): string[] {
  const lines = text.split("\n");
  let baseIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent < baseIndent) baseIndent = indent;
  }
  if (baseIndent === Infinity) return [text];

  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    while (current.length > 0 && current[current.length - 1].trim().length === 0) current.pop();
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) current.push(line);
      continue;
    }
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent === baseIndent && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return blocks.length > 0 ? blocks : [text];
}

export function _findAllRegions(
  originalText: string,
  newText: string,
  ext: string,
): RegionMatch[] | null {
  const blocks = _splitSnippet(newText, ext);
  if (blocks.length === 0) return null;
  const originalLines = originalText.split("\n");
  const matches: RegionMatch[] = [];
  const usedAnchors = new Set<number>();
  for (const block of blocks) {
    const region = _findRegionAvoiding(originalText, block, ext, usedAnchors);
    if (!region) return null;
    const startLine = (region.start as vscode.Position).line;
    const anchorIndent = originalLines[startLine].match(/^[ \t]*/)?.[0] ?? "";
    matches.push({ range: region, replacement: _normalizeIndent(block, anchorIndent) });
    usedAnchors.add(startLine);
  }
  matches.sort((a, b) => a.range.start.line - b.range.start.line);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].range.start.line <= matches[i - 1].range.end.line) return null;
  }
  return matches;
}

export function _normalizeIndent(replacement: string, anchorIndent: string): string {
  const lines = replacement.split("\n");
  const firstNonBlank = lines.find((l) => l.trim().length > 0);
  if (!firstNonBlank) return replacement;
  const snippetIndent = firstNonBlank.match(/^[ \t]*/)?.[0] ?? "";
  if (anchorIndent === snippetIndent) return replacement;
  if (anchorIndent && snippetIndent && anchorIndent[0] !== snippetIndent[0]) return replacement;

  if (anchorIndent.length > snippetIndent.length) {
    const prefix = anchorIndent.slice(snippetIndent.length);
    return lines
      .map((l) => (l.trim().length === 0 ? l : prefix + l))
      .join("\n");
  }
  const excess = snippetIndent.slice(anchorIndent.length);
  return lines
    .map((l) => (l.startsWith(excess) ? l.slice(excess.length) : l))
    .join("\n");
}

function _findRegionAvoiding(
  originalText: string,
  newText: string,
  ext: string,
  used: Set<number>,
): vscode.Range | null {
  const sigLine = newText.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!sigLine || sigLine.length < 8) return null;
  const lines = originalText.split("\n");
  const needle = sigLine.slice(0, 40);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    if (lines[i].includes(needle)) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  if (INDENT_EXTS.has(ext)) return _findRegionIndent(lines, startIdx);
  if (BRACE_EXTS.has(ext) || ext === "") return _findRegionBraces(lines, startIdx);
  return null;
}

export function _applyRegionsToText(originalText: string, matches: RegionMatch[]): string {
  if (matches.length === 0) return originalText;
  const lines = originalText.split("\n");
  const ordered = [...matches].sort(
    (a, b) => b.range.start.line - a.range.start.line,
  );
  let result = lines.slice();
  for (const m of ordered) {
    const startLine = (m.range.start as vscode.Position).line;
    const startChar = (m.range.start as vscode.Position).character;
    const endLine = (m.range.end as vscode.Position).line;
    const endChar = (m.range.end as vscode.Position).character;
    const before = result[startLine].substring(0, startChar);
    const after = result[endLine].substring(endChar);
    const replacementLines = m.replacement.split("\n");
    replacementLines[0] = before + replacementLines[0];
    replacementLines[replacementLines.length - 1] =
      replacementLines[replacementLines.length - 1] + after;
    result = result
      .slice(0, startLine)
      .concat(replacementLines)
      .concat(result.slice(endLine + 1));
  }
  return result.join("\n");
}

function _findRegionBraces(lines: string[], startIdx: number): vscode.Range | null {
  let depth = 0;
  let endIdx = startIdx;
  let sawOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; sawOpen = true; }
      else if (ch === "}") { depth--; if (sawOpen && depth === 0) { endIdx = i; break; } }
    }
    if (sawOpen && depth === 0 && i >= startIdx) {
      endIdx = i;
      break;
    }
  }
  if (!sawOpen || endIdx <= startIdx) return null;
  return new vscode.Range(
    new vscode.Position(startIdx, 0),
    new vscode.Position(endIdx, lines[endIdx].length)
  );
}

function _findRegionIndent(lines: string[], startIdx: number): vscode.Range | null {
  const startLine = lines[startIdx];
  const baseIndent = startLine.match(/^[ \t]*/)?.[0].length ?? 0;
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) { endIdx = i; continue; }
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    endIdx = i;
  }
  if (endIdx <= startIdx) return null;
  while (endIdx > startIdx && lines[endIdx].trim().length === 0) endIdx--;
  return new vscode.Range(
    new vscode.Position(startIdx, 0),
    new vscode.Position(endIdx, lines[endIdx].length)
  );
}

// ─── Line-level diff (LCS) + hunk construction ─────────────────────────────

interface DiffOp { op: 'equal' | 'delete' | 'insert'; line: string }

/**
 * LCS-based line diff. O(m*n) — good for typical code-block sizes (< 2000 lines).
 * For pathological inputs we'd want Myers, but a $2 budget caps the candidate's
 * snippet size well below that.
 */
export function _lineDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[0..i-1] and b[0..j-1]. Use Uint32 for memory.
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  const ops: DiffOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ op: 'equal', line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: 'insert', line: b[j - 1] });
      j--;
    } else {
      ops.push({ op: 'delete', line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Build hunks from a line-level diff. Each hunk groups contiguous
 * delete+insert ops. `originalStart` records the line index in the ORIGINAL
 * text where the hunk's removed lines begin — needed so we can recompose the
 * document text from the original + per-hunk status.
 */
export function _buildHunks(original: string, proposed: string): Hunk[] {
  if (original === proposed) return [];
  // EOL-normalise both sides. Without this a CRLF original would carry a
  // trailing `\r` on every line and never match the LF-only proposed text,
  // and the diff would degrade into one giant "delete-all + insert-all" hunk.
  const a = _splitLines(original);
  const b = _splitLines(proposed);
  if (a.length === 0 && b.length === 0) return [];
  if (a.join('\n') === b.join('\n')) return [];
  const ops = _lineDiff(a, b);

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let hunkCounter = 0;
  let origCursor = 0;
  let previewLineCursor = 0;

  const finalize = (): void => {
    if (!current) return;
    if (current.originalLines.length === 0 && current.newLines.length === 0) {
      current = null;
      return;
    }
    hunks.push(current);
    current = null;
  };

  for (const op of ops) {
    if (op.op === 'equal') {
      finalize();
      origCursor++;
      previewLineCursor++;
      continue;
    }
    if (!current) {
      current = {
        index: hunkCounter++,
        originalLines: [],
        newLines: [],
        redStart: previewLineCursor,
        redEnd: previewLineCursor,
        greenStart: previewLineCursor,
        greenEnd: previewLineCursor,
        status: 'pending',
        originalStart: origCursor,
      };
    }
    if (op.op === 'delete') {
      current.originalLines.push(op.line);
      origCursor++;
      previewLineCursor++;
      current.redEnd = previewLineCursor;
      current.greenStart = previewLineCursor;
      current.greenEnd = previewLineCursor;
    } else {
      // insert
      current.newLines.push(op.line);
      previewLineCursor++;
      current.greenEnd = previewLineCursor;
    }
  }
  finalize();
  return hunks;
}
