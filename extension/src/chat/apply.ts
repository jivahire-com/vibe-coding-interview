import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { suppressNextApplyEvent } from '../telemetry';

export const AI_PROPOSED_SCHEME = "vibe-ai-proposed";

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
  if (!resolved.startsWith(ws + path.sep) && resolved !== ws) {
    vscode.window.showErrorMessage(`Unsafe path: ${targetPath}`);
    return;
  }

  const originalText = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";

  const ext = path.extname(resolved).toLowerCase();
  const isFullFile = looksLikeFullFile(newText, originalText, ext);

  const proposedKey = `/${blockId}`;
  _proposedContent.set(proposedKey, newText);

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
  _proposedContent.delete(proposedKey);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  if (accepted) {
    // Bug #11: when the snippet looks like a full file BUT the existing file
    // is non-empty, require an explicit user confirmation before wiping
    // hand-written code. A snippet containing `#pragma once` (e.g. embedded
    // in a comment) or two top-level Python defs used to silently full-
    // replace whatever the candidate had.
    if (isFullFile && originalText.trim().length > 0) {
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
    if (isFullFile) {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      );
      wsEdit.replace(originalUri, fullRange, newText);
    } else {
      const region = _findRegion(originalText, newText, ext);
      if (region) {
        wsEdit.replace(originalUri, region, newText);
      } else {
        // Refuse to silently full-file-replace on a non-empty file when the
        // snippet doesn't look like a complete file. Surfacing this prevents
        // accidental wholesale overwrites (especially on Python where the old
        // brace-balancing heuristic always returned null).
        vscode.window.showWarningMessage(
          `Could not locate a matching region in ${path.basename(resolved)}. The snippet was not applied — copy it manually or ask the AI for a full-file replacement.`
        );
        _telemetryCallback?.("ai_apply_no_region_match", {
          file: path.relative(ws, resolved),
          block_id: blockId,
        });
        return;
      }
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
