import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// Scheme used for the proposed (AI) side of the diff editor
export const AI_PROPOSED_SCHEME = "vibe-ai-proposed";

// In-memory store for proposed content keyed by a unique token
const _proposedContent = new Map<string, string>();

export class AiProposedContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return _proposedContent.get(uri.path) ?? "";
  }
}

let _telemetryCallback: ((event: string, payload: object) => void) | undefined;

export function setTelemetryCallback(cb: (event: string, payload: object) => void): void {
  _telemetryCallback = cb;
}

/**
 * Open a diff editor showing the AI suggestion vs the current file.
 * On Accept the workspace file is overwritten; on Reject nothing changes.
 */
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

  // Resolve path relative to workspace; reject traversal outside
  const resolved = path.resolve(ws, targetPath);
  if (!resolved.startsWith(ws + path.sep) && resolved !== ws) {
    vscode.window.showErrorMessage(`Unsafe path: ${targetPath}`);
    return;
  }

  const originalText = fs.existsSync(resolved)
    ? fs.readFileSync(resolved, "utf8")
    : "";

  // Determine replacement range: full-file replacement if it looks like a complete file
  // (has #pragma once / include guards, or the new text is >= 80% of original size)
  const isFullFile =
    newText.includes("#pragma once") ||
    newText.includes("#ifndef ") ||
    originalText.length === 0 ||
    newText.length >= originalText.length * 0.8;

  const proposedKey = `/${blockId}`;
  _proposedContent.set(proposedKey, newText);

  const originalUri = vscode.Uri.file(resolved);
  const proposedUri = vscode.Uri.from({
    scheme: AI_PROPOSED_SCHEME,
    path: proposedKey,
    query: path.basename(resolved),
  });

  const title = `AI suggestion: ${path.basename(resolved)}`;
  await vscode.commands.executeCommand("vscode.diff", originalUri, proposedUri, title);

  const choice = await vscode.window.showInformationMessage(
    `Apply AI changes to ${path.basename(resolved)}?`,
    { modal: false },
    "Accept",
    "Reject"
  );

  const accepted = choice === "Accept";

  if (accepted) {
    const wsEdit = new vscode.WorkspaceEdit();
    if (isFullFile) {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      );
      wsEdit.replace(originalUri, fullRange, newText);
    } else {
      // Partial replacement: find the function/class block whose signature appears in newText
      const region = _findRegion(originalText, newText);
      if (region) {
        wsEdit.replace(originalUri, region, newText);
      } else {
        // Fall back to full-file replacement
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        );
        wsEdit.replace(originalUri, fullRange, newText);
      }
    }
    await vscode.workspace.applyEdit(wsEdit);
  }

  // Close the diff editor tab
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  _proposedContent.delete(proposedKey);

  _telemetryCallback?.(accepted ? "edit_ai_applied" : "ai_apply_rejected", {
    file: path.relative(ws, resolved),
    chars_added: accepted ? newText.length : 0,
    chars_removed: accepted ? originalText.length : 0,
    block_id: blockId,
  });
}

/**
 * Attempt to locate the smallest top-level function or class in originalText
 * whose opening signature appears in newText.  Returns a VS Code Range or null.
 */
function _findRegion(originalText: string, newText: string): vscode.Range | null {
  // Extract first non-empty line from newText as the signature to search for
  const sigLine = newText.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!sigLine || sigLine.length < 8) return null;

  const lines = originalText.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(sigLine.slice(0, 40)));
  if (startIdx < 0) return null;

  // Scan for matching closing brace (balanced)
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (depth === 0 && i > startIdx) break;
  }

  if (endIdx <= startIdx) return null;
  return new vscode.Range(
    new vscode.Position(startIdx, 0),
    new vscode.Position(endIdx, lines[endIdx].length)
  );
}
