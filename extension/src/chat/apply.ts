import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { suppressNextApplyEvent } from '../telemetry';

export const AI_PROPOSED_SCHEME = "vibe-ai-proposed";

/**
 * Confirm `resolved` lies under `ws` after symlinks are followed. The naive
 * `resolved.startsWith(ws + sep)` check is symlink-blind: if any directory in
 * the workspace is a symlink (e.g. `node_modules/.bin`), an AI suggestion
 * referencing a path through it can land outside the workspace while still
 * passing the string-prefix check.
 *
 * We can't realpath `resolved` itself because the file may not exist yet, so
 * we walk up to the nearest existing ancestor and realpath that. The
 * destination is safe iff its existing ancestor canonicalises to a path under
 * the workspace root's canonical form.
 */
export function _isInsideWorkspace(ws: string, resolved: string): boolean {
  let wsReal: string;
  try { wsReal = fs.realpathSync(ws); } catch { wsReal = path.resolve(ws); }
  const wsRealNorm = wsReal.replace(/[\\/]+$/, "");

  let probe = resolved;
  // Walk up to the nearest existing ancestor — we may be creating a new file.
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      // Reached filesystem root with nothing existing — cannot be inside ws.
      return false;
    }
    probe = parent;
  }
  let probeReal: string;
  try { probeReal = fs.realpathSync(probe); } catch { probeReal = probe; }

  // Compute the suffix of `resolved` that lies BELOW `probe` (the part we
  // didn't realpath). Re-attach it to the realpathed prefix and check that
  // the whole thing sits under the realpath of the workspace.
  const suffix = path.relative(probe, resolved);
  const finalPath = suffix ? path.join(probeReal, suffix) : probeReal;

  return finalPath === wsRealNorm || finalPath.startsWith(wsRealNorm + path.sep);
}

const _proposedContent = new Map<string, string>();

// Pending apply operations keyed by blockId
interface PendingApply {
  resolve: (accepted: boolean) => void;
  originalUri: vscode.Uri;
  newText: string;
  isFullFile: boolean;
  workspace: string;
  relativePath: string;
}
const _pending = new Map<string, PendingApply>();

// One-time subscription that watches for the diff document being closed
// without the user clicking Accept/Reject — see Bug #10 fix below.
let _closeWatcherRegistered = false;
let _closeWatcherDisposable: vscode.Disposable | undefined;

function _ensureCloseWatcher(): void {
  if (_closeWatcherRegistered) return;
  _closeWatcherRegistered = true;
  _closeWatcherDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.uri.scheme !== AI_PROPOSED_SCHEME) return;
    const blockId = doc.uri.path.replace(/^\//, "");
    const pending = _pending.get(blockId);
    if (pending) {
      // Bug #10: closing the diff tab without using the CodeLens used to
      // leave the promise pending forever. We now treat it as an implicit
      // Reject so the apply flow tears down: pending entry removed, proposed
      // content evicted from the in-memory cache, button re-enabled.
      pending.resolve(false);
    }
  });
}

/** Test hook: tears down the close watcher so test isolation is preserved. */
export function _disposeApplyForTests(): void {
  _closeWatcherDisposable?.dispose();
  _closeWatcherDisposable = undefined;
  _closeWatcherRegistered = false;
  _pending.clear();
  _proposedContent.clear();
}

export class AiProposedContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return _proposedContent.get(uri.path) ?? "";
  }
}

export class AiApplyCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== AI_PROPOSED_SCHEME) return [];
    const blockId = document.uri.path.replace(/^\//, "");
    if (!_pending.has(blockId)) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: "$(check) Accept AI changes",
        command: "vibe.acceptAiChanges",
        arguments: [blockId],
      }),
      new vscode.CodeLens(range, {
        title: "$(close) Reject",
        command: "vibe.rejectAiChanges",
        arguments: [blockId],
      }),
    ];
  }
}

let _codeLensProvider: AiApplyCodeLensProvider | undefined;

export function registerCodeLensProvider(p: AiApplyCodeLensProvider): void {
  _codeLensProvider = p;
}

let _telemetryCallback: ((event: string, payload: object) => void) | undefined;

export function setTelemetryCallback(cb: (event: string, payload: object) => void): void {
  _telemetryCallback = cb;
}

export function acceptAiChanges(blockId: string): void {
  const pending = _pending.get(blockId);
  if (pending) pending.resolve(true);
}

export function rejectAiChanges(blockId: string): void {
  const pending = _pending.get(blockId);
  if (pending) pending.resolve(false);
}

/**
 * @internal — exposed for tests so they can inspect whether an apply call
 * left a pending entry behind. Production code must never call this.
 */
export function _pendingSizeForTests(): number {
  return _pending.size;
}

/**
 * Close the diff tab keyed by `proposedUri`. We can't rely on
 * `workbench.action.closeActiveEditor` because the diff editor may not be
 * the active editor at resolve time (CodeLens clicks can shift focus, the
 * destructive-confirm modal steals focus). Leaving the diff tab open is what
 * candidates were reporting as "after Accept the file still looks all green
 * and red."
 *
 * Strategy:
 *  1. Find every diff tab whose `modified` URI uses our AI-proposed scheme —
 *     URI-path equality alone proved unreliable in production (some VS Code
 *     versions normalise the path or wrap the Uri), so we anchor on the scheme
 *     and close every match. Only one AI diff is ever open at a time, so the
 *     broader sweep is safe.
 *  2. After the tabGroups close, if the active editor is STILL a diff using
 *     our scheme (race observed when modal focus-stealing leaves the close
 *     promise pending), force-close via the workbench command as a fallback.
 */
async function _closeDiffTab(proposedUri: vscode.Uri): Promise<void> {
  const targetPath = proposedUri.path;
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { modified?: vscode.Uri } | undefined;
      const mod = input?.modified;
      if (!mod) continue;
      if (mod.scheme === AI_PROPOSED_SCHEME || mod.path === targetPath) {
        toClose.push(tab);
      }
    }
  }
  for (const tab of toClose) {
    try { await vscode.window.tabGroups.close(tab); }
    catch { /* tab already gone — fine */ }
  }

  // Belt-and-braces: if any AI-proposed tab survived (some VS Code builds
  // ignore tabGroups.close on tabs whose document was disposed mid-flight),
  // poke the workbench command. Cheap, idempotent, and matches the worst-case
  // visual symptom the candidate reported in the screenshot.
  const stillOpen = vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => {
      const m = (t.input as { modified?: vscode.Uri } | undefined)?.modified;
      return m?.scheme === AI_PROPOSED_SCHEME;
    }),
  );
  if (stillOpen) {
    try {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } catch { /* command not available in this host — ignore */ }
  }
}

export async function applyCodeBlock(
  targetPath: string,
  newText: string,
  blockId: string
): Promise<void> {
  _ensureCloseWatcher();
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

  const originalText = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";

  const ext = path.extname(resolved).toLowerCase();
  const isFullFile = looksLikeFullFile(newText, originalText, ext);

  // Plan the edits upfront. When the snippet is a partial set of top-level
  // blocks (e.g. two methods), anchor each block to its region in the
  // original — this lets us preview the *merged* file in the diff and apply
  // surgical replacements on Accept. The previous code passed `newText` raw
  // to the diff editor, which painted the entire original as deleted and the
  // snippet as a wholesale overwrite — candidates reported clicking Apply
  // and watching their file get wiped to a few lines.
  const matches: RegionMatch[] | null =
    isFullFile ? null : _findAllRegions(originalText, newText, ext);
  const proposedFileContent =
    matches && !isFullFile ? _applyRegionsToText(originalText, matches) : newText;
  const isSurgical = !isFullFile && matches !== null && matches.length > 0;

  const proposedKey = `/${blockId}`;
  _proposedContent.set(proposedKey, proposedFileContent);

  const originalUri = vscode.Uri.file(resolved);
  const proposedUri = vscode.Uri.from({
    scheme: AI_PROPOSED_SCHEME,
    path: proposedKey,
  });

  // Register pending BEFORE opening the diff so the CodeLens provider's first
  // query (triggered when the diff document opens) sees the entry and renders
  // the Accept/Reject buttons.
  const accepted = await new Promise<boolean>((resolve) => {
    _pending.set(blockId, { resolve, originalUri, newText, isFullFile, workspace: ws, relativePath: path.relative(ws, resolved) });
    const title = `AI suggestion: ${path.basename(resolved)}`;
    vscode.commands.executeCommand("vscode.diff", originalUri, proposedUri, title).then(() => {
      _codeLensProvider?.refresh();
    });
  });

  _pending.delete(blockId);
  // Close the tab BEFORE evicting the proposed content. If we delete first,
  // any pending paint of the diff editor (e.g. while VS Code processes the
  // close request) re-queries the content provider, gets back "" because the
  // entry is gone, and the candidate sees a momentary all-green / all-red
  // flash before the tab actually disappears.
  await _closeDiffTab(proposedUri);
  _proposedContent.delete(proposedKey);

  if (accepted) {
    const wouldFullReplace = !isSurgical;

    // Bug #11 + apply-button bug: any wholesale overwrite on a non-empty file
    // still requires an explicit confirm modal. Surgical multi-region apply
    // skips the modal — the diff already showed the merged result, so what
    // the candidate visually approved is exactly what gets written.
    if (wouldFullReplace && originalText.trim().length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `This will REPLACE the entire contents of ${path.basename(resolved)} (${originalText.length} chars). Continue?`,
        { modal: true },
        "Replace entire file",
      );
      if (choice !== "Replace entire file") {
        _telemetryCallback?.("ai_apply_full_file_declined", {
          file: path.relative(ws, resolved),
          block_id: blockId,
        });
        return;
      }
    }

    const wsEdit = new vscode.WorkspaceEdit();
    if (isSurgical && matches) {
      // Apply from last to first so earlier ranges stay valid as the document
      // shifts. VS Code's WorkspaceEdit handles non-overlapping edits in one
      // pass, but we sort defensively to keep behavior identical to a manual
      // splice.
      const ordered = [...matches].sort(
        (a, b) => b.range.start.line - a.range.start.line,
      );
      for (const m of ordered) {
        wsEdit.replace(originalUri, m.range, m.replacement);
      }
    } else {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      );
      wsEdit.replace(originalUri, fullRange, newText);
    }
    suppressNextApplyEvent();
    await vscode.workspace.applyEdit(wsEdit);
  }

  _telemetryCallback?.(accepted ? "edit_ai_applied" : "ai_apply_rejected", {
    file: path.relative(ws, resolved),
    chars_added: accepted ? newText.length : 0,
    chars_removed: accepted ? originalText.length : 0,
    block_id: blockId,
  });
}

const BRACE_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".java", ".cs", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".kt", ".scala", ".swift",
]);

const INDENT_EXTS = new Set([".py", ".pyi", ".yaml", ".yml", ".coffee", ".pyx"]);

export function looksLikeFullFile(newText: string, originalText: string, ext: string): boolean {
  if (originalText.trim().length === 0) return true;
  if (newText.includes("#pragma once") || /^\s*#ifndef\s/m.test(newText)) return true;
  if (ext === ".py" || ext === ".pyi") {
    // Heuristic: starts with a module-level construct AND defines >=2 top-level
    // names (imports / classes / functions) — looks like a whole module.
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

function _findRegion(originalText: string, newText: string, ext: string): vscode.Range | null {
  const sigLine = newText.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!sigLine || sigLine.length < 8) return null;

  const lines = originalText.split("\n");
  const needle = sigLine.slice(0, 40);
  const startIdx = lines.findIndex((l) => l.includes(needle));
  if (startIdx < 0) return null;

  if (INDENT_EXTS.has(ext)) {
    return _findRegionIndent(lines, startIdx);
  }
  if (BRACE_EXTS.has(ext) || ext === "") {
    return _findRegionBraces(lines, startIdx);
  }
  return null;
}

export interface RegionMatch {
  range: vscode.Range;
  replacement: string;
}

/**
 * Split a snippet into top-level blocks. An "updated version of file X" reply
 * from the LLM often contains two or three methods stitched together with no
 * surrounding class declaration; the apply path used to treat the whole
 * concatenation as one anchor, which collapsed every change but the first
 * into wholesale-file overwrites. Splitting first lets each block anchor on
 * its own signature line.
 */
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
  // Discard a trailing block whose braces never balanced — applying half an
  // unclosed function would corrupt the file.
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

/**
 * Anchor every top-level block in `newText` to its region in `originalText`.
 * Returns null when any block can't be anchored (we then fall back to
 * full-file replacement with an explicit confirm modal). Overlapping
 * anchors also bail out — if two snippet blocks both want the same region
 * we cannot apply them in parallel.
 *
 * Each anchored block is reindented to match the original line's leading
 * whitespace so a method emitted at column 0 by the LLM still lands inside
 * the class body it belongs to.
 */
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

/**
 * Reindent a snippet so its first non-blank line has the same leading
 * whitespace as the file region it's replacing. LLMs commonly emit
 * class methods at column 0 even when the target class body is indented;
 * without this, the spliced method lands one level too shallow and breaks
 * the surrounding scope.
 */
export function _normalizeIndent(replacement: string, anchorIndent: string): string {
  const lines = replacement.split("\n");
  const firstNonBlank = lines.find((l) => l.trim().length > 0);
  if (!firstNonBlank) return replacement;
  const snippetIndent = firstNonBlank.match(/^[ \t]*/)?.[0] ?? "";
  if (anchorIndent === snippetIndent) return replacement;
  // Mixed tabs/spaces — leave the snippet alone rather than risk corruption.
  if (anchorIndent && snippetIndent && anchorIndent[0] !== snippetIndent[0]) return replacement;

  if (anchorIndent.length > snippetIndent.length) {
    const prefix = anchorIndent.slice(snippetIndent.length);
    return lines
      .map((l) => (l.trim().length === 0 ? l : prefix + l))
      .join("\n");
  }
  // Snippet over-indented relative to target — strip the excess prefix from
  // any line that has it, leave the rest alone.
  const excess = snippetIndent.slice(anchorIndent.length);
  return lines
    .map((l) => (l.startsWith(excess) ? l.slice(excess.length) : l))
    .join("\n");
}

/** Like _findRegion but skips anchors already claimed by an earlier block. */
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

/**
 * Splice every matched region's replacement into the original text, producing
 * the file content that would result from applying all edits. Used to render
 * an accurate preview in the diff editor so the user sees the merged outcome
 * (a few changed methods) rather than a misleading full-file overwrite view.
 */
export function _applyRegionsToText(originalText: string, matches: RegionMatch[]): string {
  if (matches.length === 0) return originalText;
  const lines = originalText.split("\n");
  // Apply from last to first so earlier line indices stay valid.
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
  // Trim trailing blank lines so we don't accidentally swallow whitespace
  // between top-level constructs.
  while (endIdx > startIdx && lines[endIdx].trim().length === 0) endIdx--;
  return new vscode.Range(
    new vscode.Position(startIdx, 0),
    new vscode.Position(endIdx, lines[endIdx].length)
  );
}
