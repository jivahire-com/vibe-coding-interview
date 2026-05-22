# Technical Implementation — Extension UI Layout & AI Code Apply

This document provides the complete technical implementation details for:
1. JivaHire Dashboard + AI Chat placement in the VS Code secondary sidebar
2. The AI "Apply code to file" diff-based workflow

---

## Part 1: Dashboard + Chat Layout (Secondary Sidebar)

### How It Works

VS Code has two sidebars:
- **Primary sidebar** (left) — Explorer, Search, Source Control, etc.
- **Secondary sidebar / Auxiliary bar** (right) — custom extension views

Both the Dashboard and Chat are registered as `WebviewView` providers in the secondary sidebar. They stack vertically in a single container, with the Dashboard taking ~40% and Chat ~60% of the height.

```
┌──────────────┬────────────────────────┬──────────────────────┐
│   EXPLORER   │        EDITOR          │  JIVAHIRE INTERVIEW  │
│   (primary   │    (code editing)      │  ┌────────────────┐  │
│    sidebar)  │                        │  │   Dashboard    │  │
│              │                        │  │  (timer, tests │  │
│  - files     │                        │  │   checklist)   │  │
│  - folders   │                        │  ├────────────────┤  │
│              │                        │  │    AI Chat     │  │
│              │                        │  │  (messages,    │  │
│              │                        │  │   code blocks, │  │
│              │                        │  │   apply btns)  │  │
│              │                        │  └────────────────┘  │
└──────────────┴────────────────────────┴──────────────────────┘
```

### File: `extension/package.json`

The view container and views are declared in the `contributes` section:

```json
{
  "contributes": {
    "viewsContainers": {
      "secondarySidebar": [
        {
          "id": "vibe-interview-panel",
          "title": "JivaHire Interview",
          "icon": "media/jivahire-icon.svg"
        }
      ]
    },
    "views": {
      "vibe-interview-panel": [
        {
          "id": "vibe.dashboard",
          "name": "JivaHire Dashboard",
          "type": "webview",
          "visibility": "visible",
          "initialSize": 2
        },
        {
          "id": "vibe.chat",
          "name": "JivaHire Chat",
          "type": "webview",
          "visibility": "visible",
          "initialSize": 3
        }
      ]
    }
  }
}
```

**Key details:**
- `"secondarySidebar"` — places the container in the right auxiliary bar
- `"type": "webview"` — each view renders custom HTML via `WebviewViewProvider`
- `"initialSize": 2` / `3` — relative height ratio (Dashboard gets 2 parts, Chat gets 3)
- `"visibility": "visible"` — views are expanded by default

### File: `extension/src/extension.ts` — Provider Registration

```typescript
import { DashboardViewProvider } from "./welcome/panel";
import { ChatViewProvider } from "./chat/view";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dashboardProvider = new DashboardViewProvider(context);
  const chatProvider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("vibe.dashboard", dashboardProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("vibe.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    dashboardProvider,
    chatProvider
  );
}
```

**Key details:**
- `retainContextWhenHidden: true` — webview state (chat messages, timer) persists even when the view is collapsed or hidden behind another tab
- Both providers implement `vscode.WebviewViewProvider` (not `WebviewPanel`)
- Views are bound to IDs matching `package.json`: `"vibe.dashboard"`, `"vibe.chat"`

### File: `extension/src/extension.ts` — Layout Commands on Activation

When a session is active and the workspace is correct, we open both sidebars:

```typescript
// Layout: Explorer (left) | Editor (center) | Dashboard + Chat (right, stacked)
vscode.commands.executeCommand("workbench.view.explorer");
vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
vscode.commands.executeCommand("vibe.dashboard.focus");
```

When NO session is active (first launch), we show only the auxiliary bar so the candidate sees the session key entry form:

```typescript
vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
vscode.commands.executeCommand("vibe.dashboard.focus");
```

### File: `extension/src/welcome/panel.ts` — Dashboard WebviewViewProvider

```typescript
export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view: vscode.WebviewView | undefined;
  private config: SessionConfig | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    this.render();
  }

  setConfig(config: SessionConfig): void {
    this.config = config;
    this.render();
  }

  clearConfig(): void {
    this.config = undefined;
    this.render();
  }

  private render(): void {
    if (!this._view) return;
    this._view.webview.html = this.config
      ? this.renderBrief()      // Timer + test checklist + action buttons
      : this.renderOnboarding(); // Session key entry form
  }
}
```

### File: `extension/src/chat/view.ts` — Chat WebviewViewProvider

```typescript
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private messages: Message[] = [];
  private config: SessionConfig | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
  }

  setConfig(config: SessionConfig): void {
    this.config = config;
    this.selectedModel = config.availableChatModels[0] ?? config.chatModel;
    this.render();
  }

  private render(): void {
    if (!this._view || !this.config) return;
    // Renders full HTML with: model selector, message list, code blocks
    // with Apply/Copy buttons, input textarea, send button
    this._view.webview.html = `<!DOCTYPE html>...`;
  }
}
```

---

## Part 2: AI Code Apply — Full Implementation

### Overview

When the AI returns a code block with a `file=path` annotation, the chat renders an "Apply" button. Clicking it:

1. Opens a VS Code **diff editor** (original file vs. proposed changes)
2. Shows **Accept/Reject** options (notification + CodeLens)
3. On Accept: applies edits surgically (per-region) or as full-file replacement
4. On Reject: closes the diff, no changes made

### Architecture Diagram

```
Chat Webview                    Extension Host                     VS Code
─────────────                   ──────────────                     ───────
User clicks                     handleMessage()
[Apply] button ───postMessage──► { command: "applyBlock",
                                   blockId, filePath,
                                   codeText, lang }
                                        │
                                        ▼
                                applyCodeBlock(filePath, codeText, blockId)
                                        │
                                        ├─► Resolve path, security check
                                        ├─► Read original file
                                        ├─► Determine: full-file or surgical?
                                        ├─► If surgical: split snippet into blocks,
                                        │   anchor each to matching region in original,
                                        │   generate merged preview
                                        ├─► Store proposed content in memory map
                                        ├─► Register pending Promise
                                        │
                                        ▼
                                vscode.commands.executeCommand(    ───────► Opens diff editor
                                  "vscode.diff",                            (left: original,
                                  originalUri,                               right: proposed)
                                  proposedUri, title)
                                        │
                                        ├─► Show notification:
                                        │   [✓ Accept] [✗ Reject]
                                        │
                                        ▼
                                await Promise (blocked until
                                user clicks Accept/Reject/closes tab)
                                        │
                           ┌────────────┼────────────────┐
                           ▼            ▼                ▼
                       Accepted      Rejected       Tab closed
                           │            │                │
                           ▼            │                │
                    WorkspaceEdit       │           resolve(false)
                    (surgical or        │
                     full replace)      │
                           │            │
                           ▼            ▼
                    Close diff tab, cleanup memory
```

### File: `extension/src/chat/apply.ts` — Core Implementation

#### Constants & State

```typescript
export const AI_PROPOSED_SCHEME = "vibe-ai-proposed";

// In-memory store for proposed file content (keyed by `/${blockId}`)
const _proposedContent = new Map<string, string>();

// Pending apply operations (keyed by blockId) — one at a time
interface PendingApply {
  resolve: (accepted: boolean) => void;
  originalUri: vscode.Uri;
  newText: string;
  isFullFile: boolean;
  workspace: string;
  relativePath: string;
}
const _pending = new Map<string, PendingApply>();
```

#### Security: Path Traversal Prevention

```typescript
export function _isInsideWorkspace(ws: string, resolved: string): boolean {
  // Resolves symlinks on the nearest existing ancestor
  // Prevents AI suggesting paths like "../../../etc/passwd"
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
```

#### Content Provider (Virtual Document for Diff Right Side)

```typescript
export class AiProposedContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return _proposedContent.get(uri.path) ?? "";
  }
}
```

VS Code calls this when opening a document with scheme `vibe-ai-proposed`. It returns the proposed file content from memory.

#### CodeLens Provider (Accept/Reject Buttons in Diff)

```typescript
export class AiApplyCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  refresh(): void { this._onDidChange.fire(); }

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
```

#### Main Function: `applyCodeBlock()`

```typescript
export async function applyCodeBlock(
  targetPath: string,
  newText: string,
  blockId: string
): Promise<void> {
  // 1. Setup
  _ensureCloseWatcher();
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) { vscode.window.showErrorMessage("No workspace folder open."); return; }

  // 2. Security check
  const resolved = path.resolve(ws, targetPath);
  if (!_isInsideWorkspace(ws, resolved)) {
    vscode.window.showErrorMessage(`Unsafe path: ${targetPath}`);
    return;
  }

  // 3. Read original file
  const originalText = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";

  // 4. Determine edit mode
  const ext = path.extname(resolved).toLowerCase();
  const isFullFile = looksLikeFullFile(newText, originalText, ext);

  // 5. Plan edits: surgical (per-region) or full-file
  const matches: RegionMatch[] | null =
    isFullFile ? null : _findAllRegions(originalText, newText, ext);
  const proposedFileContent =
    matches && !isFullFile ? _applyRegionsToText(originalText, matches) : newText;
  const isSurgical = !isFullFile && matches !== null && matches.length > 0;

  // 6. Store proposed content and open diff
  const proposedKey = `/${blockId}`;
  _proposedContent.set(proposedKey, proposedFileContent);

  const originalUri = vscode.Uri.file(resolved);
  const proposedUri = vscode.Uri.from({ scheme: AI_PROPOSED_SCHEME, path: proposedKey });

  // 7. Open diff + show Accept/Reject (await user decision)
  const accepted = await new Promise<boolean>((resolve) => {
    _pending.set(blockId, { resolve, originalUri, newText, isFullFile, workspace: ws,
                            relativePath: path.relative(ws, resolved) });
    const title = `AI suggestion: ${path.basename(resolved)}`;
    vscode.commands.executeCommand("vscode.diff", originalUri, proposedUri, title).then(() => {
      _codeLensProvider?.refresh();
      // Fallback notification (CodeLens unreliable in diff editors)
      vscode.window.showInformationMessage(
        `AI suggestion for ${path.basename(resolved)} — review the diff and choose:`,
        "✓ Accept changes", "✗ Reject",
      ).then((choice) => {
        if (_pending.has(blockId)) {
          resolve(choice === "✓ Accept changes");
        }
      });
    });
  });

  // 8. Cleanup
  _pending.delete(blockId);
  await _closeDiffTab(proposedUri);
  _proposedContent.delete(proposedKey);

  // 9. Apply edits if accepted
  if (accepted) {
    if (!isSurgical && originalText.trim().length > 0) {
      // Full-file replace needs explicit confirmation
      const choice = await vscode.window.showWarningMessage(
        `This will REPLACE the entire contents of ${path.basename(resolved)}. Continue?`,
        { modal: true }, "Replace entire file",
      );
      if (choice !== "Replace entire file") return;
    }

    const wsEdit = new vscode.WorkspaceEdit();
    if (isSurgical && matches) {
      // Surgical: replace only matched regions (sorted last-to-first)
      const ordered = [...matches].sort((a, b) => b.range.start.line - a.range.start.line);
      for (const m of ordered) {
        wsEdit.replace(originalUri, m.range, m.replacement);
      }
    } else {
      // Full-file: replace everything
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      );
      wsEdit.replace(originalUri, fullRange, newText);
    }
    suppressNextApplyEvent();
    await vscode.workspace.applyEdit(wsEdit);
  }
}
```

#### Surgical Mode: Region Matching

The key innovation — instead of replacing the entire file, the system:
1. Splits the AI snippet into top-level blocks (by braces for C/JS/TS, by indent for Python)
2. Anchors each block to matching regions in the original file (first 40 chars of signature line)
3. Shows a merged preview in the diff (only changed methods highlighted)
4. Applies only the matched regions on Accept

```typescript
export interface RegionMatch {
  range: vscode.Range;      // Range in original file to replace
  replacement: string;       // New text for that range (indent-normalized)
}

export function _findAllRegions(
  originalText: string, newText: string, ext: string
): RegionMatch[] | null {
  const blocks = _splitSnippet(newText, ext);    // Split into top-level blocks
  if (blocks.length === 0) return null;
  const originalLines = originalText.split("\n");
  const matches: RegionMatch[] = [];
  const usedAnchors = new Set<number>();

  for (const block of blocks) {
    // Find where this block anchors in the original (by signature line)
    const region = _findRegionAvoiding(originalText, block, ext, usedAnchors);
    if (!region) return null;  // Can't anchor → fall back to full-file mode
    const startLine = region.start.line;
    const anchorIndent = originalLines[startLine].match(/^[ \t]*/)?.[0] ?? "";
    matches.push({ range: region, replacement: _normalizeIndent(block, anchorIndent) });
    usedAnchors.add(startLine);
  }

  // Check for overlaps
  matches.sort((a, b) => a.range.start.line - b.range.start.line);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].range.start.line <= matches[i - 1].range.end.line) return null;
  }
  return matches;
}
```

#### Full-File Detection Heuristics

```typescript
export function looksLikeFullFile(newText: string, originalText: string, ext: string): boolean {
  if (originalText.trim().length === 0) return true;          // Empty file → always full
  if (newText.includes("#pragma once")) return true;           // C++ header guard
  if (/^\s*#ifndef\s/m.test(newText)) return true;            // Include guard

  // Python: multiple top-level definitions = whole module
  if (ext === ".py" || ext === ".pyi") {
    const topLevel = newText.split("\n")
      .filter(l => /^(import |from |class |def |async def )/.test(l));
    if (topLevel.length >= 2) return true;
  }

  // JS/TS: multiple exports = whole module
  if ([".ts", ".js", ".tsx", ".jsx"].includes(ext)) {
    if (/^\s*(import |export )/m.test(newText)) {
      const topLevelExports = (newText.match(/^export /gm) ?? []).length;
      if (topLevelExports >= 2) return true;
    }
  }
  return false;
}
```

#### Indent Normalization

LLMs often emit code at column 0 even when the target is inside a class body. This fixes the indent:

```typescript
export function _normalizeIndent(replacement: string, anchorIndent: string): string {
  const lines = replacement.split("\n");
  const firstNonBlank = lines.find(l => l.trim().length > 0);
  if (!firstNonBlank) return replacement;
  const snippetIndent = firstNonBlank.match(/^[ \t]*/)?.[0] ?? "";
  if (anchorIndent === snippetIndent) return replacement;

  if (anchorIndent.length > snippetIndent.length) {
    // Under-indented → add prefix
    const prefix = anchorIndent.slice(snippetIndent.length);
    return lines.map(l => l.trim().length === 0 ? l : prefix + l).join("\n");
  }
  // Over-indented → strip excess
  const excess = snippetIndent.slice(anchorIndent.length);
  return lines.map(l => l.startsWith(excess) ? l.slice(excess.length) : l).join("\n");
}
```

### File: `extension/src/chat/view.ts` — Chat-to-Apply Pipeline

#### How Code Blocks Are Rendered (in webview HTML)

The `formatContent()` function parses the AI response text and renders code blocks with Apply/Copy buttons:

```typescript
// Server-side TypeScript (runs during render())
function formatContent(s: string): string {
  const fenceRe = /```(\w*)(?: file=([^\s`]+))?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(s)) !== null) {
    const lang = m[1] || "";
    const filePath = m[2] || "";       // e.g. "include/lru_cache.hpp"
    const code = m[3];
    const blockId = `blk-rendered-${++blockCounter}-${renderTs}`;
    const encoded = encodeURIComponent(code);
    const applyLabel = filePath
      ? `&#11015; Apply to ${filePath.split("/").pop()}`
      : "&#11015; Apply to file…";
    // Render HTML button with data attributes
    parts.push(
      `<button class="code-btn apply-btn"
         data-apply-block-id="${blockId}"
         data-apply-file="${filePath}"
         data-apply-lang="${lang}"
         data-apply-encoded="${encoded}">${applyLabel}</button>`
    );
  }
}
```

#### How the Apply Click Reaches the Extension

In the webview `<script>`:

```javascript
// Event delegation on document.body catches dynamically-rendered buttons
document.body.addEventListener('click', function(ev) {
  let el = ev.target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.applyBlockId) {
      applyBlock(el.dataset.applyBlockId, el.dataset.applyFile,
                 el.dataset.applyEncoded, el.dataset.applyLang, el);
      return;
    }
    el = el.parentNode;
  }
});

function applyBlock(blockId, filePath, encoded, lang, btn) {
  const codeText = decodeURIComponent(encoded);
  vscode.postMessage({ command: 'applyBlock', blockId, filePath, codeText, lang });
  flashButtonLabel(btn, '&#8987; Opening diff…', 2000);
}
```

#### How the Extension Handles the Message

```typescript
private async handleMessage(msg): Promise<void> {
  if (msg.command === "applyBlock" && msg.codeText && msg.blockId) {
    let filePath = msg.filePath;
    if (!filePath) {
      // No file= annotation — show QuickPick for manual target selection
      filePath = await resolveTargetFile(msg.lang);
      if (!filePath) return;
    }
    applyCodeBlock(filePath, msg.codeText, msg.blockId).catch((err) => {
      vscode.window.showErrorMessage(`Apply failed: ${err.message}`);
    });
  }
}
```

### File: `extension/src/extension.ts` — Command Registration

```typescript
// Accept/Reject commands (called by CodeLens or notification buttons)
vscode.commands.registerCommand("vibe.acceptAiChanges", (blockId: string) => {
  acceptAiChanges(blockId);
});
vscode.commands.registerCommand("vibe.rejectAiChanges", (blockId: string) => {
  rejectAiChanges(blockId);
});

// Programmatic entry point for external callers
vscode.commands.registerCommand("vibe.applyCodeBlock",
  (filePath: string, codeText: string, blockId: string) => {
    return import("./chat/apply").then((m) => m.applyCodeBlock(filePath, codeText, blockId));
  }
);
```

### LLM System Prompt (ensures `file=` annotation)

The chat system prompt explicitly instructs the AI to always include the file path:

```typescript
export const SYSTEM_PROMPT = [
  "When you provide code, ALWAYS specify the target file in the fence:",
  "",
  "```<language> file=<relative/path/to/file.ext>",
  "<code>",
  "```",
  "",
  "Rules:",
  "- Path is RELATIVE to workspace root (e.g. file=src/lru.cpp)",
  "- Keep signature lines IDENTICAL so the anchor matches correctly",
  "- Provide ONLY changed functions — surrounding code is preserved",
  "- NEVER use placeholders like '// ... rest unchanged ...'",
].join("\n");
```

### Tab Close Handling (Bug #10 Fix)

If the user closes the diff tab without clicking Accept/Reject, the pending promise is resolved as Reject:

```typescript
function _ensureCloseWatcher(): void {
  if (_closeWatcherRegistered) return;
  _closeWatcherRegistered = true;
  _closeWatcherDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.uri.scheme !== AI_PROPOSED_SCHEME) return;
    const blockId = doc.uri.path.replace(/^\//, "");
    const pending = _pending.get(blockId);
    if (pending) pending.resolve(false); // Treat as implicit Reject
  });
}
```

### Diff Tab Cleanup

After Accept/Reject, the diff tab is explicitly closed to avoid orphan tabs:

```typescript
async function _closeDiffTab(proposedUri: vscode.Uri): Promise<void> {
  // 1. Find all tabs whose modified URI uses our scheme
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const mod = (tab.input as { modified?: vscode.Uri })?.modified;
      if (mod?.scheme === AI_PROPOSED_SCHEME) toClose.push(tab);
    }
  }
  // 2. Close them
  for (const tab of toClose) {
    try { await vscode.window.tabGroups.close(tab); } catch {}
  }
  // 3. Belt-and-braces fallback
  const stillOpen = vscode.window.tabGroups.all.some(g =>
    g.tabs.some(t => (t.input as any)?.modified?.scheme === AI_PROPOSED_SCHEME)
  );
  if (stillOpen) {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
}
```

---

## Summary of Files Involved

| File | Role |
|------|------|
| `extension/package.json` | Declares view containers, views, commands |
| `extension/src/extension.ts` | Registers providers, commands, layout logic |
| `extension/src/welcome/panel.ts` | Dashboard `WebviewViewProvider` (timer, tests, onboarding) |
| `extension/src/chat/view.ts` | Chat `WebviewViewProvider` (messages, streaming, code block rendering) |
| `extension/src/chat/apply.ts` | Apply logic (diff, surgical edit, CodeLens, security) |
| `extension/src/chat/chatlog.ts` | Writes `.jivahire_chat_log.json` (audit trail) |
| `extension/src/telemetry.ts` | Tracks edit events, sends to server |
| `extension/src/submit.ts` | Submission flow (git push + server call) |
| `extension/src/timer.ts` | Countdown timer + status bar display |

---

## Build & Deploy

```bash
cd extension
npm run build                    # esbuild bundles to dist/extension.js
npx vsce package --no-dependencies --allow-missing-repository
code --uninstall-extension jivahire.jivahire-vibe-coding-interview
code --install-extension jivahire-vibe-coding-interview-0.1.19.vsix
# Reload VS Code window
```
