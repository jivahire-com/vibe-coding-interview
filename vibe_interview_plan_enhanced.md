# Jivahire Vibe-Coding Interview — Implementation Plan

## 1. What This Is

A **VS Code extension + backend pipeline** that evaluates how candidates use AI tools to solve coding challenges. Instead of banning AI, we measure **AI orchestration skill** — how effectively candidates prompt, iterate, debug, and direct AI-generated code.

**Core thesis:** The best engineers in 2026 aren't the ones who refuse to use AI. They're the ones who use it strategically — knowing when to prompt, when to reject, when to refactor, and when to write from scratch.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Candidate's Machine                                              │
│                                                                    │
│  VS Code                                                          │
│  ├── Jivahire Interview Sidecar (Extension)                      │
│  │   ├── Auth (Session Key)                                       │
│  │   ├── Workspace Manager (clone private branch)                │
│  │   ├── Chat Panel (proxied through LLM Token Mgmt Sidecar)    │
│  │   ├── Telemetry Agent (edit tracking, debug tracking)         │
│  │   └── Local Buffer (offline-safe, retry on reconnect)         │
│  └── Candidate's own tools (Copilot, ChatGPT, etc. — allowed)   │
│                                                                    │
│  ──────────────── HTTPS ─────────────────────────────────         │
│                                                                    │
│  Backend (Recruiter Node)                                         │
│  ├── Interview Session API (create, validate, submit)             │
│  ├── Telemetry Ingestion API (buffered events)                   │
│  ├── Challenge Pool (private repos, randomized assignment)        │
│  ├── LLM Token Management Sidecar (cost tracking, budgets)       │
│  └── AI Grader (multi-stage structured evaluation)                │
│                                                                    │
│  Recruiter Dashboard                                              │
│  └── View candidate scores, AI usage patterns, diffs, timelines  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Design Decisions

### 3.1 External AI tools are ALLOWED

**Do NOT ban Copilot, ChatGPT, or other tools.** It is unenforceable (candidates can use a phone, a browser, a second machine) and counterproductive (we're testing AI orchestration, not obedience).

Instead:
- The built-in Jivahire Chat is the **instrumented channel** — we capture full telemetry.
- External tools are allowed but **uninstrumented** — we can't see the prompts, but we can see the code that lands in the editor.
- The **delta** between what was prompted in our chat vs what ended up in the code reveals whether external tools were used and how effectively.
- The grading rubric evaluates the **outcome** (code quality, test pass rate, architectural decisions), not the tool choice.

### 3.2 Prompt history is stored in the candidate's repo

Raw prompts and AI responses from the built-in Jivahire Chat are stored as a file **inside the candidate's git branch** — committed alongside the code on every auto-commit. No separate database table, no cleanup worker.

**How it works:**
- The extension maintains a `.jivahire_chat_log.json` file in the repo root.
- Every chat exchange is appended to this file as a JSON object.
- The auto-commit tracker (Section 5.7) commits this file along with code changes every 3 minutes.
- The grader reads this file directly from the cloned branch — no DB query needed.

**File format (`.jivahire_chat_log.json`):**
```json
[
  {
    "sequence": 1,
    "timestamp": 1713091200000,
    "prompt_text": "How do I add JWT middleware to Express?",
    "response_text": "Here's how to add JWT auth middleware...",
    "model_used": "gpt-4o",
    "prompt_tokens": 42,
    "response_tokens": 380,
    "response_latency_ms": 1200,
    "topic_hint": "auth",
    "correction_loop": false
  },
  {
    "sequence": 2,
    "timestamp": 1713091500000,
    "prompt_text": "That middleware doesn't verify the token expiry. Fix it.",
    "response_text": "Good catch. Here's the corrected version...",
    "model_used": "gpt-4o",
    "prompt_tokens": 28,
    "response_tokens": 250,
    "response_latency_ms": 900,
    "topic_hint": "auth",
    "correction_loop": true
  }
]
```

**Why this is better than a DB table:**
- **No cleanup needed.** When you delete the candidate's branch, the prompts go with it. No separate retention policy.
- **Grader reads from one place.** Clone the branch → code + prompts + diffs are all right there.
- **Recruiter sees prompts in git.** The dashboard reads `.jivahire_chat_log.json` from the branch. No DB query.
- **Natural versioning.** Each auto-commit captures the prompt history at that point in time. You can see which prompts existed at snapshot #5 vs #10.

**Candidate consent:** The invitation email and extension startup screen state: "Your prompts to the AI assistant will be recorded in your submission for evaluation purposes."

**What is NOT stored:**
- Prompts from external tools (Copilot, ChatGPT, browser) — we can't capture those.
- Raw code content from the editor — only structured edit metrics (typed/pasted/AI character counts) in the telemetry table.

### 3.3 Start small

- **Phase 1 scope:** 5 challenge repos, 3 languages (TypeScript, Python, Rust).
- **Interview duration capped at 60 minutes.** This aligns with GitHub App token limits (1-hour max lifetime), avoids token refresh complexity, and reduces candidate fatigue. Industry standard for live coding assessments is 45–60 minutes.
- Scale to 20+ repos only after validating the telemetry → grading loop works.

---

## 4. Challenge Repository Design

### 4.1 Repository Structure

Each challenge is a **private GitHub repo** with a standardized structure:

```
challenge-ts-auth-api/
├── README.md                    # Visible to candidate — problem description + setup instructions
├── SETUP.md                     # Prerequisites and how to run tests locally
├── src/
│   ├── index.ts                 # Partially implemented starter code
│   ├── auth/                    # Module with intentional gaps
│   └── db/                      # Working database layer
├── tests/
│   ├── public.test.ts           # Tests candidate can see and run
│   └── hidden.test.ts           # Tests used by grader only (not in candidate's clone)
├── .jivahire/
│   ├── rubric.json              # Scoring rubric (stripped before candidate clone)
│   ├── traps.json               # Embedded issues to detect (stripped before clone)
│   └── metadata.json            # Language, difficulty, estimated time, tags
└── docker-compose.yml           # Local dev environment (DB, etc.)
```

### 4.2 Rubric Schema (`rubric.json`)

```json
{
  "challenge_id": "ts-auth-api",
  "language": "typescript",
  "difficulty": "mid",
  "estimated_minutes": 45,
  "max_minutes": 60,
  "tasks": [
    {
      "id": "task_1",
      "description": "Implement JWT authentication middleware",
      "test_file": "tests/hidden.test.ts",
      "test_pattern": "describe('JWT Auth')",
      "points": 30
    },
    {
      "id": "task_2",
      "description": "Fix the N+1 query in user listing endpoint",
      "test_file": "tests/hidden.test.ts",
      "test_pattern": "describe('Query Optimization')",
      "points": 25
    },
    {
      "id": "task_3",
      "description": "Add input validation and error handling",
      "test_file": "tests/hidden.test.ts",
      "test_pattern": "describe('Validation')",
      "points": 20
    }
  ],
  "traps": [
    {
      "id": "trap_1",
      "description": "Outdated bcrypt import with known vulnerability (CVE-2023-XXXX)",
      "detection": "Candidate updates the dependency or flags it",
      "points": 15
    },
    {
      "id": "trap_2",
      "description": "SQL injection in raw query on line 42 of db/queries.ts",
      "detection": "Candidate parameterizes the query",
      "points": 10
    }
  ],
  "total_points": 100
}
```

### 4.3 Challenge Pool (MVP — 5 repos)

| # | Challenge | Language | Difficulty | Focus |
|---|-----------|----------|-----------|-------|
| 1 | `ts-auth-api` | TypeScript | Mid | JWT auth, N+1 fix, input validation |
| 2 | `py-data-pipeline` | Python | Mid | Pandas optimization, error handling, data validation |
| 3 | `rs-cli-tool` | Rust | Mid-Senior | Async file processing, error types, CLI arg parsing |
| 4 | `ts-react-dashboard` | TypeScript/React | Mid | State management bug, API integration, component refactor |
| 5 | `py-fastapi-crud` | Python/FastAPI | Junior-Mid | CRUD completion, auth middleware, test writing |

### 4.4 Anti-Gaming

- **Private repos:** Candidates never see the repo URL. The extension clones a **one-time branch** created per session.
- **Randomized assignment:** If the challenge pool has 3+ repos per language, the system randomly assigns one. Candidates can't pre-solve.
- **Branch isolation:** Each candidate gets `interview/<session_id>` branch. After submission, branch is read-only.
- **Time limit:** Session has `max_minutes` from rubric. Extension shows a countdown. After expiry, auto-submit with whatever state exists.
- **`.jivahire/` directory stripped:** `rubric.json`, `traps.json`, and `hidden.test.ts` are removed before the candidate's branch is created. They only see `README.md`, `SETUP.md`, starter code, and public tests.

### 4.5 Test Environment Prerequisites

Each challenge's `SETUP.md` lists what the candidate needs installed:

| Challenge type | Prerequisites | Extension pre-check |
|---|---|---|
| TypeScript/Node.js | Node.js 20+, npm | Extension runs `node --version` on session start, warns if missing |
| Python | Python 3.11+, pip | Extension runs `python3 --version` on session start |
| Rust | Rust toolchain (rustup) | Extension runs `cargo --version` on session start |
| With database | Docker (for `docker-compose.yml`) | Extension runs `docker --version`, warns if missing |

The extension checks prerequisites after cloning and before the timer starts. If a prerequisite is missing, it shows a warning with install instructions but does **not** block the session — the candidate may have an alternative setup.

---

## 5. VS Code Extension — Jivahire Interview Sidecar

### 5.0 Project Setup & Build

**Scaffold:**
```bash
# Initialize extension project
mkdir jivahire-interview-sidecar && cd jivahire-interview-sidecar
npm init -y
npm install -D typescript @types/vscode esbuild @vscode/vsce
```

**Directory structure:**
```
jivahire-interview-sidecar/
├── package.json              # Extension manifest + npm scripts
├── tsconfig.json             # TypeScript config
├── esbuild.js                # Build script (bundles to single file)
├── src/
│   ├── extension.ts          # Main entry: activate(), deactivate()
│   ├── state.ts              # Session state machine
│   ├── session.ts            # Session validation, API calls
│   ├── git.ts                # Clone, auto-commit, push, credential setup
│   ├── telemetry.ts          # Edit tracking, event classification
│   ├── buffer.ts             # Telemetry buffer with offline retry
│   ├── autocommit.ts         # Silent 3-min auto-commit tracker
│   ├── timer.ts              # Countdown timer + status bar item
│   ├── prerequisites.ts      # Check node/python/rust/docker
│   ├── chatlog.ts            # Write .jivahire_chat_log.json
│   └── chat/
│       ├── provider.ts       # WebviewViewProvider (registers sidebar panel)
│       ├── panel.html         # Chat UI HTML template
│       └── bridge.ts         # postMessage bridge: webview ↔ extension host
├── media/
│   └── icon.svg              # Activity bar icon
├── static/
│   └── chat.css              # Chat panel styles (inlined into panel.html)
└── dist/                     # Build output (git-ignored)
    └── extension.js          # Single bundled file
```

**`tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**`esbuild.js`:**
```javascript
const esbuild = require('esbuild');
esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: process.argv.includes('--production'),
}).catch(() => process.exit(1));
```

**`package.json` scripts (add to the manifest from 5.1):**
```json
{
  "scripts": {
    "build": "node esbuild.js",
    "watch": "node esbuild.js --watch",
    "package": "vsce package --no-dependencies",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4",
    "@types/vscode": "^1.85.0",
    "esbuild": "^0.20",
    "@vscode/vsce": "^2.24"
  }
}
```

### 5.0.1 Session State Machine (`src/state.ts`)

The extension has exactly 6 states. Every action checks the current state before proceeding:

```typescript
export enum SessionState {
  IDLE = "idle",                   // Extension installed, no session started
  AUTHENTICATING = "authenticating", // Validating session key with backend
  CLONING = "cloning",             // Cloning repo branch
  ACTIVE = "active",               // Interview in progress (timer running)
  SUBMITTING = "submitting",       // Final commit + push + submit API call
  DONE = "done",                   // Submitted successfully — read-only
}

export class SessionStateMachine {
  private _state: SessionState = SessionState.IDLE;
  private _onStateChange = new vscode.EventEmitter<SessionState>();
  readonly onStateChange = this._onStateChange.event;

  get state(): SessionState { return this._state; }

  transition(to: SessionState): void {
    const allowed: Record<SessionState, SessionState[]> = {
      [SessionState.IDLE]:           [SessionState.AUTHENTICATING],
      [SessionState.AUTHENTICATING]: [SessionState.CLONING, SessionState.IDLE],     // fail → back to idle
      [SessionState.CLONING]:        [SessionState.ACTIVE, SessionState.IDLE],       // fail → back to idle
      [SessionState.ACTIVE]:         [SessionState.SUBMITTING],
      [SessionState.SUBMITTING]:     [SessionState.DONE, SessionState.ACTIVE],       // fail → back to active
      [SessionState.DONE]:           [],                                              // terminal
    };
    if (!allowed[this._state].includes(to)) {
      throw new Error(`Invalid state transition: ${this._state} → ${to}`);
    }
    this._state = to;
    this._onStateChange.fire(to);
  }
}
```

### 5.0.2 Main Entry Point (`src/extension.ts`)

```typescript
import * as vscode from 'vscode';
import { SessionStateMachine, SessionState } from './state';
import { validateSession, submitSession, SessionConfig } from './session';
import { TelemetryTracker } from './telemetry';
import { TelemetryBuffer } from './buffer';
import { AutoCommitTracker } from './autocommit';
import { TimerController } from './timer';
import { ChatViewProvider } from './chat/provider';
import { ChatLogWriter } from './chatlog';
import { cloneRepo, setupGitCredentials } from './git';
import { checkPrerequisites } from './prerequisites';

let state: SessionStateMachine;
let telemetry: TelemetryTracker;
let buffer: TelemetryBuffer;
let autoCommit: AutoCommitTracker;
let timer: TimerController;
let chatLog: ChatLogWriter;
let config: SessionConfig;

export function activate(context: vscode.ExtensionContext) {
  state = new SessionStateMachine();
  buffer = new TelemetryBuffer(context.globalState);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('jivahire.startSession', () => startSession(context)),
    vscode.commands.registerCommand('jivahire.submitWork', () => submitWork()),
  );

  // Register chat panel (sidebar webview)
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('jivahire.chatPanel', chatProvider),
  );

  // Listen for chat messages from webview → extension host
  chatProvider.onMessage(async (msg) => {
    if (msg.type === 'chat_request') {
      // Forward to LLM sidecar, stream response back to webview
      const response = await sendToLLM(msg.text, chatProvider);
      // Append to .jivahire_chat_log.json
      chatLog.append({
        prompt_text: msg.text,
        response_text: response.text,
        model_used: response.model,
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        response_tokens: response.usage?.completion_tokens ?? 0,
        response_latency_ms: response.latency_ms,
      });
      // Record telemetry event
      buffer.enqueue({ session_id: config.session_id, event_type: 'chat_exchange', /* ... */ });
    }
    if (msg.type === 'insert_code') {
      // "Insert to Editor" button clicked in chat webview
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await editor.edit(editBuilder => {
          editBuilder.insert(editor.selection.active, msg.code);
        });
        // Track as AI-inserted code (distinct from typed, pasted, or AI-streamed)
        buffer.enqueue({
          session_id: config.session_id,
          timestamp: Date.now(),
          event_type: 'ai_insert',
          payload: {
            file_path: vscode.workspace.asRelativePath(editor.document.uri),
            characters_inserted: msg.code.length,
            source: 'chat_insert',
          },
        });
      } else {
        vscode.window.showWarningMessage('Open a file in the editor first, then click Insert.');
      }
    }
  });

  // --- Session Resume: check for an interrupted session ---
  const savedSession = context.globalState.get<SessionConfig>('active_session');
  if (savedSession) {
    resumeSession(context, savedSession);
  }
}

/**
 * Resume an interrupted session (VS Code restarted, extension reloaded).
 * Skips auth + clone (already done), restores timer with remaining time.
 */
async function resumeSession(context: vscode.ExtensionContext, saved: SessionConfig) {
  config = saved;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceFolder) {
    // Workspace not open — session can't be resumed, clear saved state
    context.globalState.update('active_session', undefined);
    return;
  }

  // Calculate remaining time
  const elapsedMs = Date.now() - (config.started_at ?? Date.now());
  const remainingMinutes = Math.max(0, config.max_minutes - Math.floor(elapsedMs / 60000));

  if (remainingMinutes <= 0) {
    // Time already expired — auto-submit
    vscode.window.showWarningMessage('Your interview session has expired. Auto-submitting...');
    state.transition(SessionState.AUTHENTICATING);
    state.transition(SessionState.CLONING);
    state.transition(SessionState.ACTIVE);
    await submitWork();
    context.globalState.update('active_session', undefined);
    return;
  }

  // Resume services
  state.transition(SessionState.AUTHENTICATING);
  state.transition(SessionState.CLONING);
  state.transition(SessionState.ACTIVE);
  chatLog = new ChatLogWriter(workspaceFolder);
  telemetry = new TelemetryTracker(buffer, config.session_id);
  telemetry.start();
  autoCommit = new AutoCommitTracker();
  autoCommit.start(workspaceFolder);
  timer = new TimerController(remainingMinutes, () => submitWork());
  timer.start();

  vscode.window.showInformationMessage(
    `Session resumed! ${remainingMinutes} minutes remaining.`
  );
}

async function startSession(context: vscode.ExtensionContext) {
  if (state.state !== SessionState.IDLE) {
    vscode.window.showWarningMessage('Interview session already in progress.');
    return;
  }

  // 1. Prompt for session key
  const sessionKey = await vscode.window.showInputBox({
    prompt: 'Enter your interview session key',
    placeHolder: 'e.g., XYZ-123',
    ignoreFocusOut: true,
  });
  if (!sessionKey) return;

  // 2. Validate with backend
  state.transition(SessionState.AUTHENTICATING);
  try {
    config = await validateSession(sessionKey);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Session validation failed: ${err.message}`);
    state.transition(SessionState.IDLE);
    return;
  }

  // 3. Clone repo
  state.transition(SessionState.CLONING);
  try {
    const workspaceFolder = await cloneRepo(config.repo_url, config.branch, config.github_clone_token);
    // Open cloned folder as workspace
    await vscode.commands.executeCommand('vscode.openFolder', workspaceFolder, { forceNewWindow: false });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to clone repo: ${err.message}. Check that git is installed.`);
    state.transition(SessionState.IDLE);
    return;
  }

  // 4. Check prerequisites (non-blocking)
  await checkPrerequisites(config.challenge_language);

  // 5. Start services
  state.transition(SessionState.ACTIVE);
  config.started_at = Date.now(); // record start time for session resume
  context.globalState.update('active_session', config); // persist for resume on restart
  chatLog = new ChatLogWriter(workspaceFolder);
  telemetry = new TelemetryTracker(buffer, config.session_id);
  telemetry.start();
  autoCommit = new AutoCommitTracker();
  autoCommit.start(workspaceFolder);
  timer = new TimerController(config.max_minutes, () => submitWork());
  timer.start();

  vscode.window.showInformationMessage(
    `Interview started! You have ${config.max_minutes} minutes. Use the Jivahire Chat in the sidebar for AI assistance.`
  );
}

async function submitWork() {
  if (state.state !== SessionState.ACTIVE) return;
  state.transition(SessionState.SUBMITTING);

  try {
    autoCommit.stop();
    timer.stop();
    telemetry.stop();
    await autoCommit.finalCommit();
    await buffer.flush();
    await submitSession(config.session_id, config.session_key);
    state.transition(SessionState.DONE);
    // Clear saved session so resume doesn't trigger on next activate
    context.globalState.update('active_session', undefined);
    vscode.window.showInformationMessage(
      'Submitted successfully! You may close VS Code and uninstall the extension.'
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Submission failed: ${err.message}. Try again.`);
    state.transition(SessionState.ACTIVE);
    autoCommit.start(vscode.workspace.workspaceFolders![0].uri);
    timer.resume();
    telemetry.start();
  }
}

export async function deactivate(): Promise<void> {
  try {
    await autoCommit?.finalCommit();
    await buffer?.flush();
  } catch {
    // VS Code is closing — best effort
  }
}
```

### 5.0.3 Chat Webview Provider (`src/chat/provider.ts`)

The chat panel runs in an iframe (webview). Communication between the webview and the extension host uses `postMessage`:

```typescript
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _onMessage = new vscode.EventEmitter<{ type: string; text: string }>();
  readonly onMessage = this._onMessage.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml();

    // Receive messages from webview
    view.webview.onDidReceiveMessage((msg) => {
      this._onMessage.fire(msg);
    });
  }

  // Send message back to webview (for streaming response chunks)
  postToWebview(msg: any) {
    this._view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" 
        content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family); padding: 8px; margin: 0; }
    #messages { overflow-y: auto; flex: 1; }
    .msg { margin: 8px 0; padding: 8px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; }
    .msg.user { background: var(--vscode-input-background); }
    .msg.assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .msg .role { font-weight: bold; font-size: 0.85em; margin-bottom: 4px; }
    .msg pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; position: relative; }
    .msg code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .insert-btn { position: absolute; top: 4px; right: 4px; padding: 2px 8px; font-size: 0.75em;
                  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                  border: none; border-radius: 3px; cursor: pointer; opacity: 0.8; }
    .insert-btn:hover { opacity: 1; }
    #input-area { display: flex; gap: 4px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
    #prompt { flex: 1; resize: none; min-height: 60px; padding: 6px; background: var(--vscode-input-background);
              color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    #send { padding: 6px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; border-radius: 4px; cursor: pointer; align-self: flex-end; }
    #send:hover { background: var(--vscode-button-hoverBackground); }
    #send:disabled { opacity: 0.5; cursor: not-allowed; }
    .streaming-indicator { color: var(--vscode-descriptionForeground); font-style: italic; }
    #container { display: flex; flex-direction: column; height: 100vh; }
  </style>
</head>
<body>
  <div id="container">
    <div id="messages"></div>
    <div id="input-area">
      <textarea id="prompt" placeholder="Ask the AI assistant..." rows="3"></textarea>
      <button id="send">Send</button>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const promptEl = document.getElementById('prompt');
    const sendBtn = document.getElementById('send');
    let streaming = false;

    sendBtn.addEventListener('click', () => sendMessage());
    promptEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function sendMessage() {
      const text = promptEl.value.trim();
      if (!text || streaming) return;
      appendMessage('user', text);
      promptEl.value = '';
      streaming = true;
      sendBtn.disabled = true;
      // Create placeholder for assistant response
      const assistantEl = appendMessage('assistant', '');
      assistantEl.innerHTML = '<div class="role">AI Assistant</div><span class="streaming-indicator">Thinking...</span>';
      vscode.postMessage({ type: 'chat_request', text });
    }

    function appendMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'assistant') {
        // Render markdown (code blocks with syntax formatting, bold, lists, etc.)
        div.innerHTML = '<div class="role">AI Assistant</div>' + marked.parse(text);
        addInsertButtons(div);
      } else {
        div.innerHTML = '<div class="role">You</div>' + escapeHtml(text);
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    // Add "Insert to Editor" buttons on every code block in AI responses
    function addInsertButtons(msgElement) {
      const codeBlocks = msgElement.querySelectorAll('pre code');
      codeBlocks.forEach((block) => {
        const wrapper = block.parentElement;
        wrapper.style.position = 'relative';
        const btn = document.createElement('button');
        btn.textContent = '\uD83D\uDCCB Insert to Editor';
        btn.className = 'insert-btn';
        btn.onclick = () => {
          vscode.postMessage({ type: 'insert_code', code: block.textContent });
          btn.textContent = '\u2713 Inserted';
          btn.disabled = true;
          setTimeout(() => { btn.textContent = '\uD83D\uDCCB Insert to Editor'; btn.disabled = false; }, 2000);
        };
        wrapper.insertBefore(btn, wrapper.firstChild);
      });
    }

    // Receive streamed response chunks from extension host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'chat_chunk') {
        const lastMsg = messagesEl.lastElementChild;
        if (lastMsg?.classList.contains('assistant')) {
          const indicator = lastMsg.querySelector('.streaming-indicator');
          if (indicator) indicator.remove();
          // Render with markdown (code blocks get syntax formatting + Insert buttons)
          lastMsg.innerHTML = '<div class="role">AI Assistant</div>' + marked.parse(msg.fullText);
          addInsertButtons(lastMsg);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      } else if (msg.type === 'chat_done') {
        streaming = false;
        sendBtn.disabled = false;
        promptEl.focus();
      } else if (msg.type === 'chat_error') {
        const lastMsg = messagesEl.lastElementChild;
        if (lastMsg?.classList.contains('assistant')) {
          lastMsg.innerHTML = '<div class="role">AI Assistant</div><span style="color:var(--vscode-errorForeground)">' + escapeHtml(msg.error) + '</span>';
        }
        streaming = false;
        sendBtn.disabled = false;
      }
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}
```

### 5.0.4 LLM Streaming Bridge (`src/chat/bridge.ts`)

The extension host handles the actual HTTP call to the LLM sidecar (the webview cannot make cross-origin requests):

```typescript
import { ChatViewProvider } from './provider';

export async function sendToLLM(
  userMessage: string,
  chatProvider: ChatViewProvider,
  config: SessionConfig,
  conversationHistory: Array<{ role: string; content: string }>
): Promise<{ text: string; model: string; usage: any; latency_ms: number }> {
  const startTime = Date.now();
  conversationHistory.push({ role: 'user', content: userMessage });

  const response = await fetch(`${config.llm_proxy_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.llm_api_key}`,
      'Content-Type': 'application/json',
      'X-Feature-ID': `interview_${config.session_id}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: conversationHistory,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    chatProvider.postToWebview({ type: 'chat_error', error: `AI error (${response.status}): ${errText}` });
    throw new Error(errText);
  }

  // Parse SSE stream
  let fullText = '';
  let model = '';
  let usage: any = null;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\\n');
    buffer = lines.pop() || ''; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed.model) model = parsed.model;
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          chatProvider.postToWebview({ type: 'chat_chunk', fullText });
        }
      } catch { /* skip unparseable chunks */ }
    }
  }

  chatProvider.postToWebview({ type: 'chat_done' });
  conversationHistory.push({ role: 'assistant', content: fullText });

  return {
    text: fullText,
    model,
    usage,
    latency_ms: Date.now() - startTime,
  };
}
```

### 5.0.5 Timer Controller (`src/timer.ts`)

```typescript
export class TimerController {
  private statusBarItem: vscode.StatusBarItem;
  private interval: NodeJS.Timeout | null = null;
  private remainingSeconds: number;
  private onExpire: () => void;

  constructor(maxMinutes: number, onExpire: () => void) {
    this.remainingSeconds = maxMinutes * 60;
    this.onExpire = onExpire;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.tooltip = 'Interview time remaining';
  }

  start(): void {
    this.updateDisplay();
    this.statusBarItem.show();
    this.interval = setInterval(() => {
      this.remainingSeconds--;
      this.updateDisplay();
      if (this.remainingSeconds <= 0) {
        this.stop();
        vscode.window.showWarningMessage('Time is up! Auto-submitting your work...');
        this.onExpire();
      }
      // Warning at 5 minutes
      if (this.remainingSeconds === 300) {
        vscode.window.showWarningMessage('5 minutes remaining!');
      }
    }, 1000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.statusBarItem.hide();
  }

  resume(): void { this.start(); }

  private updateDisplay(): void {
    const min = Math.floor(this.remainingSeconds / 60);
    const sec = this.remainingSeconds % 60;
    const icon = this.remainingSeconds <= 300 ? '$(warning)' : '$(clock)';
    this.statusBarItem.text = `${icon} ${min}:${sec.toString().padStart(2, '0')}`;
    this.statusBarItem.color = this.remainingSeconds <= 300 ? new vscode.ThemeColor('errorForeground') : undefined;
  }
}
```

### 5.0.6 Chat Log Writer (`src/chatlog.ts`)

```typescript
import * as fs from 'fs';
import * as path from 'path';

interface ChatEntry {
  sequence: number;
  timestamp: number;
  prompt_text: string;
  response_text: string;
  model_used: string;
  prompt_tokens: number;
  response_tokens: number;
  response_latency_ms: number;
  topic_hint: string;
  correction_loop: boolean;
}

export class ChatLogWriter {
  private filePath: string;
  private sequence = 0;

  constructor(workspaceFolder: vscode.Uri) {
    this.filePath = path.join(workspaceFolder.fsPath, '.jivahire_chat_log.json');
    // Initialize with empty array if file doesn't exist
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]', 'utf-8');
    }
  }

  append(entry: Omit<ChatEntry, 'sequence' | 'timestamp' | 'topic_hint' | 'correction_loop'>): void {
    this.sequence++;
    const fullEntry: ChatEntry = {
      sequence: this.sequence,
      timestamp: Date.now(),
      topic_hint: this.classifyTopic(entry.prompt_text),
      correction_loop: this.isCorrection(entry.prompt_text),
      ...entry,
    };

    // Read current array, append, write back
    const current: ChatEntry[] = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    current.push(fullEntry);
    fs.writeFileSync(this.filePath, JSON.stringify(current, null, 2), 'utf-8');
  }

  private classifyTopic(prompt: string): string {
    const lower = prompt.toLowerCase();
    if (lower.match(/auth|jwt|token|login|password/)) return 'auth';
    if (lower.match(/sql|query|database|db|postgres/)) return 'database';
    if (lower.match(/test|assert|expect|mock|jest/)) return 'testing';
    if (lower.match(/error|bug|fix|debug|crash|fail/)) return 'debugging';
    if (lower.match(/refactor|clean|rename|extract/)) return 'refactoring';
    return 'general';
  }

  private isCorrection(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return /that.*(wrong|incorrect|doesn't work|broke|error|fix|not right|try again)/i.test(lower);
  }
}
```

### 5.0.7 Git Operations (`src/git.ts`)

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export async function cloneRepo(
  repoUrl: string,
  branch: string,
  token: string
): Promise<vscode.Uri> {
  // Build authenticated URL: https://x-access-token:<token>@github.com/org/repo.git
  const authedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);

  // Clone to a temp directory inside the user's home
  const cloneDir = path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    'jivahire-interviews',
    branch.replace('/', '-')
  );

  // Clone with depth=1 for speed (full history not needed — auto-commits build on top)
  await execAsync(`git clone --branch "${branch}" --single-branch "${authedUrl}" "${cloneDir}"`);

  // Configure git inside the repo to use the token for pushes
  await execAsync(`git -C "${cloneDir}" config credential.helper store`);
  // The token is already embedded in the remote URL from the clone

  return vscode.Uri.file(cloneDir);
}

export async function setupGitCredentials(workspaceFolder: vscode.Uri, token: string): Promise<void> {
  const dir = workspaceFolder.fsPath;
  // Set committer identity (required for commits)
  await execAsync(`git -C "${dir}" config user.email "interview@jivahire.com"`);
  await execAsync(`git -C "${dir}" config user.name "Jivahire Interview"`);
}
```

```json
{
  "name": "jivahire-interview-sidecar",
  "displayName": "Jivahire Interview Sidecar",
  "publisher": "jivahire",
  "version": "1.0.0",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["onCommand:jivahire.startSession"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "jivahire.startSession", "title": "Jivahire: Start Interview" },
      { "command": "jivahire.submitWork", "title": "Jivahire: Submit & Finish" }
    ],
    "viewsContainers": {
      "activitybar": [{
        "id": "jivahire-chat",
        "title": "Jivahire Chat",
        "icon": "media/icon.svg"
      }]
    },
    "views": {
      "jivahire-chat": [{
        "type": "webview",
        "id": "jivahire.chatPanel",
        "name": "AI Assistant"
      }]
    }
  }
}
```

### 5.2 Session Lifecycle

```
1. Candidate runs "Jivahire: Start Interview" command
2. Extension prompts for Session Key (e.g., "XYZ-123")
3. Extension calls POST /api/v1/interviews/validate-session
   → Backend returns: repo_url, branch, **github_clone_token** (short-lived), challenge metadata, LLM proxy URL, session expiry
4. Extension clones the repo branch into a new workspace using the clone token
   → `git clone --branch <branch> https://x-access-token:<github_clone_token>@github.com/<org>/<repo>.git`
   → Token is used once for clone + pushes, expires in 1 hour (GitHub maximum). Session capped at 60 min so token always outlives the session.
5. Extension starts telemetry tracking
6. Extension starts **auto-commit timer** (every 3 minutes)
7. Extension shows Chat Panel (proxied through LLM sidecar)
8. Timer starts (from session.max_minutes)
9. Candidate works...
   → Every 3 minutes: extension silently commits + pushes all changes (see 5.7)
10. Candidate clicks "Submit & Finish" (or timer expires → auto-submit)
11. Extension:
    a. Final auto-commit + push (captures any changes since last auto-commit)
    b. Sends final telemetry payload to backend
    c. Calls POST /api/v1/interviews/submit
    d. Shows "Submitted successfully" message
    e. Closes the workspace
```

**Extension deactivation safety:** The extension's `deactivate()` export (called when VS Code closes) performs a best-effort final auto-commit + push + telemetry flush. If VS Code is force-killed, the session expiry worker (Section 6.5) handles cleanup.

```typescript
// extension.ts
export async function deactivate(): Promise<void> {
  // Best-effort: commit, push, flush telemetry
  // If VS Code is shutting down, this has ~5 seconds to complete
  try {
    await autoCommitTracker.finalCommit(workspaceFolder);
    await telemetryBuffer.flush();
  } catch {
    // VS Code is closing — can't do anything more.
    // Session expiry worker will handle grading from whatever was pushed.
  }
}
```

### 5.3 Telemetry Agent (`src/telemetry.ts`)

The extension tracks **structured events**, not raw content:

```typescript
interface TelemetryEvent {
  session_id: string;
  timestamp: number;        // epoch ms
  event_type: EventType;
  payload: Record<string, unknown>;
}

type EventType =
  | "edit_batch"         // aggregated edit stats (not raw text)
  | "chat_exchange"      // prompt metadata
  | "ai_insert"          // code inserted via "Insert to Editor" button in chat
  | "debug_session"      // debug start/stop/breakpoints
  | "test_run"           // test execution results
  | "file_open"          // which files were viewed
  | "submit";            // final submission

// Edit batch — aggregated every 30 seconds
interface EditBatchPayload {
  file_path: string;          // relative path only
  characters_typed: number;   // human keystrokes
  characters_pasted: number;  // paste events (Ctrl+V)
  characters_ai_stream: number; // inserted via AI completion stream
  characters_ai_inserted: number; // inserted via "Insert to Editor" button (tracked separately)
  lines_added: number;
  lines_deleted: number;
  edit_velocity: number;      // chars per second (distinguishes typing vs paste vs AI)
}

// Chat exchange — includes raw prompt and response text for thought process analysis
interface ChatExchangePayload {
  prompt_text: string;          // full user prompt text
  response_text: string;        // full AI response text
  prompt_length: number;        // character count of user prompt
  response_length: number;      // character count of AI response
  response_tokens: number;      // from LLM sidecar usage tracking
  model_used: string;           // e.g., "gpt-4o"
  response_latency_ms: number;
  topic_hint: string;           // auto-classified: "auth", "database", "testing", "debugging", etc.
  correction_loop: boolean;     // true if this prompt references a previous AI response error
}
```

**Detection logic for AI vs human edits:**

```typescript
// In onDidChangeTextDocument handler
function classifyEdit(event: vscode.TextDocumentChangeEvent): "typed" | "pasted" | "ai_stream" {
  for (const change of event.contentChanges) {
    const chars = change.text.length;
    const lines = change.text.split("\n").length - 1;

    // AI stream: single character or small chunk inserted rapidly
    // (AI completions arrive as a stream of small insertions)
    if (chars <= 3 && isInAiStreamWindow()) return "ai_stream";

    // Paste: large block inserted in single event
    if (chars > 50 || lines > 3) return "pasted";

    // Human typing: everything else
    return "typed";
  }
}
```

### 5.4 Chat Panel (`src/chat/panel.ts`)

The chat panel is a Webview that proxies requests through the LLM Token Management Sidecar:

```typescript
// Chat panel sends requests to the LLM sidecar, NOT directly to OpenRouter/OpenAI
const LLM_PROXY_URL = sessionConfig.llm_proxy_url;
// e.g., "http://sidecar:8080/interview_chat/v1"

async function sendMessage(userMessage: string): Promise<string> {
  const response = await fetch(`${LLM_PROXY_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${sessionConfig.llm_api_key}`,
      "Content-Type": "application/json",
      "X-Feature-ID": `interview_${sessionConfig.session_id}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: conversationHistory,
      stream: true,
    }),
  });
  // Stream response to chat UI...
}
```

**Cost control:** Each interview session has a **token budget** enforced by the LLM sidecar:
- Budget set per session via `POST /internal/budgets` before the interview starts.
- Feature ID = `interview_<session_id>` → per-session cost tracking.
- When budget exhausted, candidate sees "AI assistance budget reached. Complete the task with your own knowledge."
- Default budget: ~$2.00 per interview (configurable by recruiter).

### 5.5 Local Buffer & Offline Safety (`src/buffer.ts`)

Telemetry events are buffered locally to survive network interruptions:

```typescript
class TelemetryBuffer {
  private buffer: TelemetryEvent[] = [];
  private readonly FLUSH_INTERVAL_MS = 10_000; // flush every 10s
  private readonly MAX_BUFFER_SIZE = 500;       // flush if buffer gets large
  private readonly STORAGE_KEY = "jivahire_telemetry_buffer";

  // On network failure: store to VS Code globalState (persists across restarts)
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    try {
      await this.sendToBackend(this.buffer);
      this.buffer = [];
      this.clearPersistedBuffer();
    } catch (err) {
      // Network failure — persist to disk, retry on next flush
      this.persistBuffer();
      console.warn("Telemetry flush failed, buffered locally", err);
    }
  }
}
```

### 5.6 Distribution & One-Click Install

- **Primary: VS Code Marketplace** (public listing). Publish under the "Jivahire" publisher. The extension does nothing without a valid session key, so public listing is safe. The invitation email includes a one-click install link:
  ```
  vscode:extension/jivahire.jivahire-interview-sidecar
  ```
  Clicking this link opens VS Code and installs the extension automatically. No manual VSIX download needed.

- **Fallback: VSIX download.** For candidates whose company blocks Marketplace, or for offline installs. The email includes a direct `.vsix` download link as a backup. Install instructions:
  ```
  1. Download the .vsix file from the link below
  2. Open VS Code → Extensions (Ctrl+Shift+X) → "..." menu → "Install from VSIX..."
  3. Select the downloaded file
  ```

- **Candidate install experience (2 steps total):**
  ```
  Step 1: Click install link in email → extension installs automatically
  Step 2: Press Ctrl+Shift+P → type "Jivahire" → select "Start Interview" → enter session key
  ```
  Everything else (clone, workspace, chat, timer) happens automatically after the session key is entered.

### 5.7 Auto-Commit Tracker (`src/autocommit.ts`)

The extension silently commits and pushes every 3 minutes. This creates a **git timeline** of how the code evolved — not just a start-to-end diff.

```typescript
class AutoCommitTracker {
  private readonly INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  private commitNumber = 0;
  private timer: NodeJS.Timeout | null = null;

  start(workspaceFolder: vscode.Uri): void {
    this.timer = setInterval(() => this.commitAndPush(workspaceFolder), this.INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async commitAndPush(workspaceFolder: vscode.Uri): Promise<void> {
    const git = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
    const repo = git?.repositories[0];
    if (!repo) return;

    // Check if there are any changes to commit
    const changes = repo.state.workingTreeChanges;
    if (changes.length === 0) return; // nothing changed since last commit

    this.commitNumber++;
    const timestamp = new Date().toISOString();

    try {
      // Stage all changes
      await repo.add([]);
      // Commit with structured message (used by grader to reconstruct timeline)
      await repo.commit(`[jivahire-auto] snapshot #${this.commitNumber} at ${timestamp}`, { all: true });
      // Push silently
      await repo.push();
    } catch (err) {
      // Git failures are non-fatal — log and continue
      console.warn(`Auto-commit #${this.commitNumber} failed:`, err);
    }
  }

  // Called on submit — final snapshot
  async finalCommit(workspaceFolder: vscode.Uri): Promise<void> {
    this.commitNumber++;
    const git = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
    const repo = git?.repositories[0];
    if (!repo) return;
    await repo.add([]);
    await repo.commit(`[jivahire-submit] final submission`, { all: true });
    await repo.push();
  }
}
```

**Key design decisions:**
- **Commit messages are prefixed with `[jivahire-auto]`** so the grader can distinguish auto-commits from any manual commits the candidate makes.
- **Final commit is tagged `[jivahire-submit]`** — the grader uses this as the endpoint.
- **No-change check:** If nothing changed since the last auto-commit, skip. No empty commits.
- **Silent:** Candidate does not see commit notifications. No terminal output. The extension runs git commands via the VS Code Git API, not shell commands.
- **Failure tolerant:** If a push fails (network issue), the commit stays local. Next auto-commit will push everything. The final submit ensures all commits are pushed.
- **3-minute interval** is a balance: frequent enough to show progression, infrequent enough to not spam the git log. A 60-minute session produces ~20 commits — manageable.

**What the git log looks like after a session:**
```
abcdef1 [jivahire-submit] final submission
abcdef2 [jivahire-auto] snapshot #15 at 2026-04-14T10:45:00Z
abcdef3 [jivahire-auto] snapshot #14 at 2026-04-14T10:42:00Z
....
abcdef0 [jivahire-auto] snapshot #1 at 2026-04-14T10:03:00Z
initial  Initial challenge setup (by system)
```

---

## 6. Backend — Interview Session & Telemetry APIs

### 6.1 Database Schema

Add to the **recruiter node** PostgreSQL database:

```sql
-- Interview session management
CREATE TABLE interview_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES candidates(id),
    recruiter_id UUID NOT NULL REFERENCES users(id),
    job_id UUID REFERENCES jobs(id),
    challenge_id VARCHAR NOT NULL,            -- e.g., "ts-auth-api"
    session_key VARCHAR(20) UNIQUE NOT NULL,  -- e.g., "XYZ-123"
    branch_name VARCHAR NOT NULL,             -- "interview/<session_id>"
    status VARCHAR NOT NULL DEFAULT 'pending', -- pending | active | submitted | expired | graded
    llm_budget_usd DOUBLE PRECISION NOT NULL DEFAULT 2.00,
    max_minutes INTEGER NOT NULL DEFAULT 60,
    started_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'active', 'submitted', 'expired', 'graded'))
);

CREATE INDEX idx_sessions_key ON interview_sessions (session_key);
CREATE INDEX idx_sessions_candidate ON interview_sessions (candidate_id);

-- Telemetry events (structured, no raw text)
CREATE TABLE interview_telemetry (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES interview_sessions(id),
    timestamp BIGINT NOT NULL,               -- epoch ms
    event_type VARCHAR NOT NULL,             -- edit_batch, chat_exchange, debug_session, test_run, file_open
    payload JSONB NOT NULL,                  -- structured event payload (no raw prompts/code)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_telemetry_session ON interview_telemetry (session_id, timestamp);

-- Grading results
CREATE TABLE interview_grades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES interview_sessions(id) UNIQUE,
    -- Automated scores (from tests)
    tests_passed INTEGER NOT NULL DEFAULT 0,
    tests_total INTEGER NOT NULL DEFAULT 0,
    traps_detected INTEGER NOT NULL DEFAULT 0,
    traps_total INTEGER NOT NULL DEFAULT 0,
    -- Telemetry-derived scores
    total_tokens_used INTEGER NOT NULL DEFAULT 0,
    llm_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    human_code_ratio DOUBLE PRECISION,        -- 0.0 to 1.0 (% of final code from human typing)
    correction_loops INTEGER NOT NULL DEFAULT 0, -- how many times candidate fixed AI mistakes
    active_time_seconds INTEGER NOT NULL DEFAULT 0,
    -- LLM-evaluated scores (Phase 2)
    ai_orchestration_score INTEGER,           -- 1-10
    code_quality_score INTEGER,               -- 1-10
    architectural_reasoning_score INTEGER,    -- 1-10
    grader_summary TEXT,                      -- LLM-generated summary for recruiter
    -- Developer confidence (behavioral analysis — is this a practicing developer?)
    developer_confidence_score INTEGER,       -- 0-100 (computed from telemetry signals)
    developer_confidence_verdict VARCHAR,     -- 'developer', 'uncertain', 'non_developer'
    developer_confidence_signals JSONB,       -- breakdown: typed_ratio, files_explored, post_ai_edits, etc.
    -- Composite
    total_score DOUBLE PRECISION,             -- weighted composite (computed)
    graded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6.2 API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/interviews/sessions` | Recruiter JWT | Create interview session (assign challenge, generate session key) |
| `POST` | `/api/v1/interviews/validate-session` | Session Key | Validate session key → return repo URL, branch, **GitHub clone token**, config, LLM proxy URL |
| `POST` | `/api/v1/interviews/telemetry` | Session Key | Ingest batch of telemetry events |
| `POST` | `/api/v1/interviews/submit` | Session Key | Final submission (triggers grading pipeline) |
| `GET` | `/api/v1/interviews/sessions/:id` | Recruiter JWT | Get session details + grade |
| `GET` | `/api/v1/interviews/sessions/:id/timeline` | Recruiter JWT | Get telemetry timeline for replay |

### 6.3 Session Creation Flow (Recruiter)

```python
# POST /api/v1/interviews/sessions
# Body: { "candidate_id": "...", "job_id": "...", "language": "typescript", "difficulty": "mid" }

def create_interview_session(request):
    # 1. Select random challenge matching language + difficulty
    challenge = select_random_challenge(language, difficulty)

    # 2. Generate session key
    session_key = generate_session_key()  # e.g., "XYZ-123"

    # 3. Create private branch from challenge repo
    branch = f"interview/{session.id}"
    create_branch_without_jivahire_dir(challenge.repo, branch)
    # ^ Clones repo, removes .jivahire/ directory (rubric, traps, hidden tests), pushes branch

    # 4. Create LLM budget for this session via sidecar
    requests.post(f"{LLM_SIDECAR_URL}/internal/budgets", json={
        "feature_id": f"interview_{session.id}",
        "limit_usd": session.llm_budget_usd,
    }, headers={"X-Admin-Token": SIDECAR_ADMIN_TOKEN})

    # 5. Save session, send invitation email to candidate
    ...
```

### 6.5 Server-Side Timer Enforcement

The timer is enforced in **two places** — client (extension) and server (backend):

**Client-side (extension):**
- Extension shows a visible countdown timer in the status bar.
- When timer hits zero: auto-commit + push + submit. No user interaction needed.
- Candidate can submit early at any time.

**Server-side (backend):**
- Every API call from the extension (`/telemetry`, `/submit`, LLM chat via sidecar) checks:
  ```python
  if session.started_at + timedelta(minutes=session.max_minutes) < now():
      return Response({"error": "Session expired"}, status=403)
  ```
- The LLM sidecar budget is set to expire at session end (budget is monthly, but the feature_id is session-scoped — when the session expires, the backend deletes the budget via `DELETE /internal/budgets/interview_<session_id>`).
- **If the extension never submits** (crash, closed laptop, lost internet): a Celery Beat task runs every 10 minutes and catches expired sessions:
  ```python
  @celery_app.task
  def auto_submit_expired_sessions():
      """Auto-submit sessions where time ran out and extension didn't submit."""
      expired = InterviewSession.objects.filter(
          status='active',
          started_at__isnull=False,
      ).annotate(
          deadline=F('started_at') + timedelta(minutes=1) * F('max_minutes')
      ).filter(deadline__lt=now())

      for session in expired:
          session.status = 'submitted'  # not 'expired' — we grade it normally
          session.submitted_at = now()
          session.save()
          grade_interview.delay(session.id)  # grade whatever was pushed
  ```
- This means: whether the candidate submits manually, the timer auto-submits, or the extension crashes — the session is always graded.

### 6.7 GitHub Clone Token

**Problem:** The extension needs to clone a private repo. Hardcoding a PAT in the extension is insecure.

**Solution:** The backend generates a **short-lived GitHub token** when the session is validated:

- Use a **GitHub App** installed on the challenge repos org. The backend calls GitHub's API to create an **installation access token** scoped to the specific repo, with `contents: write` permission (for push).
- Token lifetime: 1 hour (GitHub App installation token maximum). Since interviews are capped at 60 minutes, the token always covers the full session. No refresh mechanism needed.
- Token is returned in the `/validate-session` response. The extension uses it for clone and push.
- After the session expires, the token expires automatically. No revocation needed.

```python
# In validate_session view
from github import GithubIntegration

def create_clone_token(repo_name: str, expires_minutes: int) -> str:
    integration = GithubIntegration(app_id=GITHUB_APP_ID, private_key=GITHUB_APP_KEY)
    installation_id = integration.get_installation(org_name).id
    token = integration.get_access_token(
        installation_id,
        permissions={"contents": "write"},
        repositories=[repo_name],
    )
    return token.token  # expires in 1 hour (GitHub max) — matches 60-min interview cap
```

### 6.4 Submission & Grading Pipeline

```
Candidate clicks "Submit"
    │
    ▼
Extension pushes final commit, sends last telemetry batch
    │
    ▼
Backend marks session as "submitted"
    │
    ▼
Celery task: grade_interview(session_id)
    │
    ├── Step 0: Clone candidate's branch, fetch full commit history
    │   └── `git log --oneline --format='%H %s' | grep '\[jivahire-'`
    │       Parse auto-commit timestamps and diffs between consecutive snapshots
    │       Result: list of (commit_hash, timestamp, diff_from_previous)
    │
    ├── Step 1: Run hidden tests against candidate's branch (final commit)
    │   └── Copy hidden.test.ts back in, run tests
    │       Result: tests_passed, tests_total
    │
    ├── Step 2: Check traps
    │   └── Diff candidate's branch against original
    │       Check if trap patterns were addressed
    │       Result: traps_detected, traps_total
    │
    ├── Step 3: Compute telemetry metrics
    │   └── Query interview_telemetry for this session
    │       Aggregate: human_code_ratio, correction_loops, total_tokens, active_time
    │
    ├── Step 3a: Compute developer confidence score
    │   └── Analyze behavioral telemetry signals (see Section 7.6)
    │       Inputs: edit_batch events, file_open events, ai_insert events, debug/test events, chat_log
    │       Output: developer_confidence_score (0-100), verdict, signal breakdown
    │
    ├── Step 3b: Read prompt history from repo
    │   └── Parse `.jivahire_chat_log.json` from the cloned branch
    │       Pass conversation as structured input to Evaluation 2 (AI Orchestration)
    │
    ├── Step 4: LLM evaluation (structured, multi-prompt)
    │   └── See Section 7
    │
    └── Step 5: Compute composite score, save to interview_grades
        └── Mark session as "graded"
```

---

## 7. AI Grader — Multi-Stage Structured Evaluation

### 7.1 Why NOT a single prompt

A single "score this candidate 1-10" prompt is unreliable. LLMs are inconsistent graders without structure. Instead, use **3 focused evaluations** with clear rubrics:

### 7.2 Evaluation 1: Code Quality (from commit history + final diff)

```
System: You are a senior code reviewer evaluating a candidate's code submission.

Input:
- Challenge description: {README.md content}
- Final git diff: {candidate's total diff against starter code}
- Commit timeline (auto-snapshots every 3 min):
  Snapshot #1 (t=3min): {summary of changes — files modified, lines added/deleted}
  Snapshot #2 (t=6min): {summary}
  ...
  Snapshot #N (t=final): {summary}
- Language: {language}

Evaluate on these dimensions only. Score each 1-10:
1. Correctness: Does the code implement the requirements?
2. Readability: Clean naming, structure, formatting?
3. Error handling: Edge cases covered? Graceful failures?
4. Security: Any obvious vulnerabilities introduced?

Respond in JSON:
{"correctness": N, "readability": N, "error_handling": N, "security": N, "observations": "..."}
```

### 7.3 Evaluation 2: AI Orchestration Fluency (from telemetry)

```
System: You are evaluating how effectively a developer used AI tools during a coding task.

Input:
- Total prompts sent: {count}
- Average prompt length: {chars}
- Correction loops (re-prompting to fix AI errors): {count}
- Human-typed code ratio: {ratio}%
- Files modified: {list}
- Time breakdown: {active time, idle time}
- Chat topic distribution: {auth: 40%, database: 30%, testing: 20%, other: 10%}
- First 10 prompts (abbreviated to 200 chars each): {list of prompts}
- Last 5 prompts (abbreviated to 200 chars each): {list of prompts}

Evaluate:
1. Strategic prompting: Did they break the problem into focused prompts, or dump everything at once?
2. Critical evaluation: Did they blindly accept AI output, or iterate and correct?
3. Independence: Could they make progress without AI for key decisions?
4. Efficiency: Did they use AI where it adds value (boilerplate) vs waste time on things faster to type?

Respond in JSON:
{"strategic_prompting": N, "critical_evaluation": N, "independence": N, "efficiency": N, "observations": "..."}
```

### 7.4 Evaluation 3: Architectural Reasoning (from diff + telemetry)

```
System: You are a senior architect evaluating a candidate's technical decision-making.

Input:
- Challenge description: {README.md}
- Git diff: {diff}
- Trap 1: {trap description} — Detected: {yes/no}
- Trap 2: {trap description} — Detected: {yes/no}
- Test results: {passed}/{total}

Evaluate:
1. Problem decomposition: Did they tackle tasks in a logical order?
2. Trap detection: Did they identify and fix the embedded issues?
3. Design choices: Appropriate patterns, not over-engineered?

Respond in JSON:
{"problem_decomposition": N, "trap_detection": N, "design_choices": N, "observations": "..."}
```

### 7.5 Composite Score

```python
def compute_composite(grade: InterviewGrade) -> float:
    # Automated (deterministic) — 40%
    test_score = (grade.tests_passed / grade.tests_total) * 10 if grade.tests_total > 0 else 0
    trap_score = (grade.traps_detected / grade.traps_total) * 10 if grade.traps_total > 0 else 0
    automated = (test_score * 0.25 + trap_score * 0.15)

    # LLM-evaluated — 60%
    llm = (
        grade.code_quality_score * 0.25 +
        grade.ai_orchestration_score * 0.20 +
        grade.architectural_reasoning_score * 0.15
    )

    return automated + llm  # out of 10

    # Note: developer_confidence_score is NOT included in composite.
    # It is displayed separately on the dashboard as an independent signal.
    # Recruiters decide how to weigh it — the system does not auto-reject.
```

### 7.6 Developer Confidence Score (Behavioral Signal)

Computed purely from telemetry during grading. Nothing is gated or blocked — the interview runs fully open with all AI tools available. This score tells the recruiter **how the candidate behaved in the editor**, not what code they produced.

**Signal design philosophy — base vs. bonus:**

Signals are split into two categories based on their fakeability:

- **Base signals (max 75 pts):** Behaviors that any developer is likely to exhibit during a normal session. Both presence and quality are scored.
  - File exploration breadth (15 pts)
  - Post-AI-insert modifications (20 pts)
  - Prompt specificity (30 pts) — weighted highest because in 2026 developers type less but prompt with precision
  - Test runs (10 pts)
- **Bonus signals (asymmetric, max +25 pts):** IDE-native actions that are **hard to fake** but a developer may legitimately skip under time pressure. **Presence = strong evidence; absence = neutral, not penalized.**
  - Debugger session (+15) — setting breakpoints, stepping through frames, inspecting variables
  - Go-to-definition usage (+5) — language-server navigation
  - Find-references usage (+5) — symbol-aware codebase navigation

**Why asymmetric?** A senior developer under a 60-minute time crunch may skip the debugger entirely (use `console.log`, let AI fix the bug, or the bug was obvious). Penalizing them for skipping it would punish efficient engineers. But a PM/manager almost never sets a breakpoint — they don't have the muscle memory. So if we *see* debugger usage, confidence shoots up; if we *don't* see it, we learn nothing.

```python
def compute_developer_confidence(telemetry_events: list, chat_log: list) -> dict:
    """
    Analyzes editor behavior to determine if the candidate is a practicing developer.
    Not used for gating — computed post-interview and shown to the recruiter.

    Base signals (always scored): file exploration, AI output modification,
    prompt specificity, test runs.
    Bonus signals (presence-only, never penalized): debugger usage, go-to-definition,
    find-references. These are hard to fake but legitimately skippable under time pressure.
    """
    signals = {}

    edit_batches = [e for e in telemetry_events if e['event_type'] == 'edit_batch']
    ai_inserts = [e for e in telemetry_events if e['event_type'] == 'ai_insert']

    # ===== BASE SIGNALS (max 75 pts) =====

    # --- Signal 1: File exploration breadth (15 pts) ---
    # Developers read the codebase before editing. Non-developers only open files AI mentions.
    files_opened = set(
        e['payload']['file_path'] for e in telemetry_events if e['event_type'] == 'file_open'
    )
    signals['files_explored'] = len(files_opened)

    # --- Signal 2: Post-AI-insert modifications (20 pts) ---
    # Developers modify AI output (rename vars, adjust logic, delete unused parts).
    # Non-developers accept AI output wholesale.
    post_ai_edits = 0
    for ai_event in ai_inserts:
        subsequent_typed = [
            e for e in edit_batches
            if e['payload']['file_path'] == ai_event['payload']['file_path']
            and 0 < (e['timestamp'] - ai_event['timestamp']) < 60_000
            and e['payload']['characters_typed'] > 0
        ]
        if subsequent_typed:
            post_ai_edits += 1
    signals['ai_output_modified_ratio'] = round(
        post_ai_edits / max(len(ai_inserts), 1), 2
    )

    # --- Signal 3: Prompt specificity (30 pts) ---
    # Developers use code-specific terms in prompts. Non-developers use vague descriptions.
    # Weighted highest because modern developers rely less on manual typing.
    if chat_log:
        code_terms = ['function', 'variable', 'line', 'error', 'type', 'return',
                      'parameter', 'import', 'async', 'null', 'index', 'array',
                      'object', 'class', 'method', 'callback', 'promise']
        prompts_with_code_terms = sum(
            1 for c in chat_log
            if any(kw in c['prompt_text'].lower() for kw in code_terms)
        )
        signals['prompt_specificity'] = round(prompts_with_code_terms / len(chat_log), 2)
    else:
        signals['prompt_specificity'] = None  # candidate didn't use chat

    # --- Signal 4: Test runs (10 pts) ---
    # Developers run tests iteratively to check their work.
    test_events = [e for e in telemetry_events if e['event_type'] == 'test_run']
    signals['test_runs'] = len(test_events)

    base_score = (
        min(signals['files_explored'] / 5, 1.0) * 15 +
        signals.get('ai_output_modified_ratio', 0) * 20 +
        (signals.get('prompt_specificity', 0) or 0) * 30 +
        min(signals['test_runs'] / 3, 1.0) * 10
    )

    # ===== BONUS SIGNALS (asymmetric, presence-only, max +25 pts) =====
    # Hard to fake; absence is NEVER penalized (developer may skip under time pressure).

    debug_events = [e for e in telemetry_events if e['event_type'] == 'debug_session']
    signals['used_debugger'] = len(debug_events) > 0

    goto_def_events = [e for e in telemetry_events if e['event_type'] == 'goto_definition']
    signals['used_goto_definition'] = len(goto_def_events) > 0

    find_ref_events = [e for e in telemetry_events if e['event_type'] == 'find_references']
    signals['used_find_references'] = len(find_ref_events) > 0

    bonus = 0
    if signals['used_debugger']:
        bonus += 15  # very hard to fake — strong dev signal
    if signals['used_goto_definition']:
        bonus += 5
    if signals['used_find_references']:
        bonus += 5

    score = min(base_score + bonus, 100)

    if score >= 60:
        verdict = 'developer'
    elif score >= 35:
        verdict = 'uncertain'
    else:
        verdict = 'non_developer'

    return {
        'confidence_score': round(score),
        'base_score': round(base_score),
        'bonus_score': bonus,
        'signals': signals,
        'verdict': verdict,
    }
```

**Worked examples:**

*Example A — Senior developer, AI-heavy, no debugger (time-pressured):*
- Opens 8 files (15 pts), modifies 80% of AI output (16 pts), 90% of prompts use code terms (27 pts), runs tests 5 times (10 pts)
- Skips debugger, uses go-to-definition (+5)
- **Base 68 + Bonus 5 = 73 → `developer`** ✅ (not punished for skipping debugger)

*Example B — Mid developer who actually debugs:*
- Opens 5 files (15 pts), modifies 50% of AI output (10 pts), 60% specific prompts (18 pts), 3 test runs (10 pts)
- Uses debugger (+15), go-to-definition (+5)
- **Base 53 + Bonus 20 = 73 → `developer`** ✅

*Example C — Product manager pretending:*
- Opens 2 files (6 pts), 10% post-AI edits (2 pts), 20% specific prompts (6 pts), 1 test run (3 pts)
- No debugger, no IDE navigation
- **Base 17 + Bonus 0 = 17 → `non_developer`** ✅

*Example D — Non-developer who clicks around to look busy:*
- Opens 6 files (15 pts), 0% post-AI edits (0 pts), 15% specific prompts (4 pts), runs tests 4 times (10 pts)
- No debugger, no go-to-definition (doesn't know the shortcut)
- **Base 29 + Bonus 0 = 29 → `non_developer`** ✅ (gameable signals don't carry it alone)

**How recruiters should read it:**

| Score | Verdict | What it means |
|-------|---------|---------------|
| 60-100 | `developer` | Behaves like a practicing developer — explores code, modifies AI output, prompts with precision, often uses IDE-native tooling |
| 35-59 | `uncertain` | Mixed signals — could be a junior developer heavily relying on AI, or a non-developer who knows some basics |
| 0-34 | `non_developer` | Shallow exploration, accepts AI wholesale, vague prompts, no IDE-native usage — likely not a developer |

**Important:** This score is a **signal, not a verdict**. A junior developer using AI heavily for an unfamiliar language might score 40. A senior developer who skips the debugger entirely but prompts surgically might score 75. The recruiter sees the full breakdown (base + bonus + per-signal) and decides.

---

### 7.7 Token Efficiency Score (Formula-Based, No Calibration)

Measures how efficiently the candidate used the LLM relative to a **deterministic max-token allowance computed from the repo size and challenge difficulty**. No senior-engineer calibration runs needed — the allowance is derived from a formula at challenge authoring time.

We use the term **"tokens"** (not "budget") throughout because we are literally counting LLM tokens — not dollars, not API quota.

#### Why not a code graph (graphify) integration?

By design, the Jivahire chat **does not do agentic multi-file scanning**. The whole repo context is passed to the LLM in one go on each turn. This is a deliberate choice for the interview context:

| Concern | Whole-repo dump (chosen) | Graph-based retrieval (graphify) |
|---|---|---|
| Repo size | Fine for ≤30k tokens (our challenges target 8k–25k) | Required only for 100k+ token codebases |
| Token accounting | **Deterministic** — same context for every candidate on the same challenge | Non-deterministic — retrieval varies by query |
| Fairness | Two candidates on `ts-auth-api` are scored against the same baseline | Candidates with luckier graph traversals get an advantage |
| Engineering cost | Tokenize files once at authoring time | Runtime graph build, embedding store, retrieval tuning |
| Auditability | Recruiter can replay exactly what was sent | Hard to reconstruct what the model saw |

**Verdict:** Whole-repo dump for MVP. Graphify-style retrieval is only worth integrating if challenges grow beyond ~30k tokens.

#### Core idea — repo dump is "free", only conversation tokens count

The initial repo context is **system overhead, not candidate cost**:

- The first time the LLM is invoked, the extension sends the full repo as a **cached system message** (using OpenAI/Anthropic prompt caching where available). This is sent once, billed once at a discounted cache-write rate, and **excluded from the candidate's token meter**.
- Every subsequent turn reuses the cached context for free (cache hit) — only the candidate's prompt and the LLM's response are added.
- The candidate's `actual_tokens` = sum of `prompt_tokens + response_tokens` in `.jivahire_chat_log.json` **excluding** the initial cached system context.

```python
# What we count vs what we don't
SYSTEM_CONTEXT_TOKENS = repo_tokens          # NOT counted — sent once, cached
CANDIDATE_TOKENS      = sum(prompt + response for each chat turn)  # counted
```

This makes the comparison fair across challenges of different sizes: a candidate working on a 5k-token repo and one working on a 25k-token repo are both judged on **how much conversation they needed**, not on how big their repo happened to be.

#### Computing the max tokens per challenge (formula, no calibration)

Done **once at challenge authoring time**, stored in `rubric.json`. No senior-engineer runs required.

**Formula:**

```
max_tokens = (repo_tokens × context_reload_factor)
           + (per_task_overhead × num_tasks)
           + difficulty_tokens
```

Where:

| Variable | Value | Reasoning |
|---|---|---|
| `repo_tokens` | Computed via `tiktoken` over source files | Static — sum of all challenge source files |
| `context_reload_factor` | **1.5** | Even with caching, candidates legitimately re-include changed files ~1.5× during a session |
| `per_task_overhead` | **3,500 tokens** | Average tokens for one clarification + LLM response per rubric task (~5–8 turns × 500 tokens) |
| `num_tasks` | From `rubric.json` `tasks[]` length | Counted from the rubric definition |
| `difficulty_tokens` | junior=8k, mid=15k, senior=25k | Allows for harder problems needing more iteration |

**Computation script:**

```python
# scripts/compute_max_tokens.py
import tiktoken
from pathlib import Path

EXCLUDE = {'.git', 'node_modules', 'dist', '__pycache__', 'target', '.jivahire'}
SOURCE_EXT = {'.ts', '.tsx', '.js', '.py', '.rs', '.go', '.java', '.cpp', '.h', '.hpp', '.json', '.md'}

DIFFICULTY_TOKENS = {'junior': 8_000, 'mid': 15_000, 'senior': 25_000}
CONTEXT_RELOAD_FACTOR = 1.5
PER_TASK_OVERHEAD = 3_500

def compute_repo_tokens(repo_root: Path, model: str = 'gpt-4o') -> int:
    enc = tiktoken.encoding_for_model(model)
    total = 0
    for path in repo_root.rglob('*'):
        if any(part in EXCLUDE for part in path.parts):
            continue
        if path.is_file() and path.suffix in SOURCE_EXT:
            try:
                total += len(enc.encode(path.read_text(encoding='utf-8')))
            except UnicodeDecodeError:
                continue
    return total

def compute_max_tokens(repo_root: Path, num_tasks: int, difficulty: str) -> dict:
    repo_tokens = compute_repo_tokens(repo_root)
    max_tokens = int(
        repo_tokens * CONTEXT_RELOAD_FACTOR
        + PER_TASK_OVERHEAD * num_tasks
        + DIFFICULTY_TOKENS[difficulty]
    )
    return {
        'repo_tokens': repo_tokens,
        'num_tasks': num_tasks,
        'difficulty': difficulty,
        'max_tokens': max_tokens,
        'formula': f'{repo_tokens} × 1.5 + {PER_TASK_OVERHEAD} × {num_tasks} + {DIFFICULTY_TOKENS[difficulty]}',
    }
```

**Persisted in `rubric.json`:**

```json
{
  "challenge_id": "ts-auth-api",
  "difficulty": "mid",
  "token_limits": {
    "model": "gpt-4o",
    "repo_tokens": 12400,
    "num_tasks": 3,
    "max_tokens": 44100,
    "formula": "12400 × 1.5 + 3500 × 3 + 15000",
    "computed_on": "2026-05-08"
  }
}
```

**Note:** `repo_tokens` here is shown for transparency but **is not added to the candidate's meter** — it's the cached system context. `max_tokens` represents the conversation tokens the candidate is allowed to spend.

**Caching clarification:** the formula uses `repo_tokens × 1.5` because even with prompt caching, the model may need to re-read updated files after the candidate edits them (cache invalidates on changed content). If your provider's cache fully covers re-reads, set `context_reload_factor = 0` and `max_tokens` collapses to `per_task_overhead × num_tasks + difficulty_tokens` — pure conversation cost.

#### Computing the candidate's score

```python
def compute_token_efficiency(chat_log: list, max_tokens: int) -> dict:
    """
    Scores candidate's token usage as a percentage of the formula-derived max tokens.
    < 50% → seasoned developer (efficient)
    50–80% → acceptable
    > 80% → likely not seasoned (excessive iteration / vague prompts)
    > 100% → hit cap (session auto-paused)
    """
    actual_tokens = sum(c['prompt_tokens'] + c['response_tokens'] for c in chat_log)
    pct = (actual_tokens / max_tokens) * 100

    if pct < 50:
        bucket = 'seasoned'
        efficiency_score = 100
        verdict = 'Used less than half the allowed tokens — efficient prompting'
    elif pct < 80:
        bucket = 'acceptable'
        # Linear decay from 90 at 50% to 60 at 80%
        efficiency_score = round(90 - 30 * (pct - 50) / 30)
        verdict = 'Within acceptable range — typical mid-level usage'
    elif pct <= 100:
        bucket = 'inefficient'
        # Linear decay from 50 at 80% to 20 at 100%
        efficiency_score = round(50 - 30 * (pct - 80) / 20)
        verdict = 'High token usage — likely not a seasoned developer'
    else:
        bucket = 'exhausted'
        efficiency_score = 0
        verdict = 'Exceeded max tokens — session auto-paused'

    return {
        'actual_tokens': actual_tokens,
        'max_tokens': max_tokens,
        'usage_pct': round(pct, 1),
        'bucket': bucket,
        'efficiency_score': efficiency_score,
        'verdict': verdict,
        'turns': len(chat_log),
        'tokens_per_turn': round(actual_tokens / max(len(chat_log), 1)),
    }
```

#### Worked example — `ts-auth-api` challenge

Formula: `repo_tokens=12,400`, `num_tasks=3`, `difficulty=mid` → `max_tokens = 12,400 × 1.5 + 3,500 × 3 + 15,000 = 44,100 tokens`

| Candidate | Turns | Actual tokens | % of max | Bucket | Score | Read as |
|---|---:|---:|---:|---|---:|---|
| Alice (surgical prompts, references file paths) | 6 | 18,500 | 42% | `seasoned` | 100 | Half the allowance — clearly experienced |
| Bob (mid, normal back-and-forth) | 11 | 28,200 | 64% | `acceptable` | 76 | Standard mid-level usage |
| Carol (lots of "make it better" prompts) | 18 | 38,000 | 86% | `inefficient` | 41 | Over 80% — excessive iteration |
| Dan (vague PM-style prompts, regenerated whole files) | 24 | 47,000 | 107% | `exhausted` | 0 | Exceeded max tokens — auto-paused |

#### Why this is better than calibration

| Calibration approach (rejected) | Formula approach (chosen) |
|---|---|
| Needs 3–5 senior engineers per challenge | Zero human dependency |
| Recalibrate when challenge changes | Recompute one script |
| Slow to scale to 20+ challenges | Add a challenge in minutes |
| Calibrators may be unrepresentative | Formula is uniform across all challenges |
| Subjective ("what does 'senior' mean?") | Deterministic and auditable |

**Trade-off:** the formula is approximate. Tune `CONTEXT_RELOAD_FACTOR`, `PER_TASK_OVERHEAD`, and `DIFFICULTY_TOKENS` after the first 50 real candidates by looking at the distribution of `actual_tokens` and adjusting so ~25% land in `seasoned`, ~50% in `acceptable`, ~20% in `inefficient`, ~5% in `exhausted`. This is a one-time tuning, not per-challenge calibration.

#### How this combines with other scores

`efficiency_score` is **not** added to the composite grade directly. It is shown separately in the recruiter dashboard alongside `developer_confidence_score` and the rubric score:

- A candidate can solve the problem perfectly while using lots of tokens (still hireable)
- A candidate can use few tokens but produce broken code (efficient noise)
- Recruiters want these as **independent axes**, not blended into one number

Three signals shown side-by-side: rubric score (correctness) × dev confidence (behavior) × token efficiency (cost discipline) — recruiter decides the weighting.

#### When to revisit (graphify trigger)

Re-evaluate the whole-repo-dump approach **only** if:
- A challenge's `repo_tokens` exceeds 30,000 (then context-window cost dominates)
- Median `actual_tokens` across calibrators exceeds 80,000 (then candidates can't afford a full context per turn)
- We add multi-repo or system-design challenges where navigation matters

Until then, the simple deterministic approach gives better fairness and cleaner accounting than graph-based retrieval.

---

## 7A. Grading Rubrics (Aligned with Plan)

> **Philosophy:** The best engineers in 2026 aren't those who refuse AI. They're the ones who use it strategically — knowing when to prompt, when to reject, when to refactor, and when to write from scratch. These rubrics evaluate *AI orchestration skill*, not just code output.

### 7A.1 Three Independent Score Axes

Each session produces **three independent scores**, never blended into one number. The recruiter sees all three and decides their own weighting.

| Axis | Range | Source | Section |
|---|---|---|---|
| **Composite score** | 0.0 – 10.0 | Automated tests + LLM evaluations | 7A.2 |
| **Token efficiency** | 0 – 100 + bucket | Deterministic formula | 7.7 |
| **Developer confidence** | 0 – 100 + verdict | Telemetry signals | 7.6 |

> **Token efficiency and developer confidence are NOT part of the composite.** They are independent axes. Reasoning: a candidate can solve the problem perfectly while using lots of tokens (still hireable); a candidate can use few tokens but produce broken code (efficient noise). Recruiters want these as separate signals.

---

### 7A.2 Composite Score Formula

| Dimension | Weight | Source |
|---|---|---|
| Test pass rate | 25% | Automated (hidden test suite) |
| Trap detection | 15% | Automated (planted bug detection) |
| Code quality | 20% | LLM evaluation |
| Prompt quality | 15% | LLM evaluation |
| AI orchestration | 15% | LLM evaluation |
| Architectural reasoning | 10% | LLM evaluation |
| **Total** | **100%** | |

**Formula:**

```
composite_score = (tests_passed / tests_total × 10) × 0.25
                + (traps_detected / traps_total × 10) × 0.15
                + code_quality_score × 0.20
                + prompt_quality_score × 0.15
                + ai_orchestration_score × 0.15
                + architectural_reasoning_score × 0.10
```

All LLM scores are on a **1–10 scale**. Composite result out of **10**.

---

### 7A.3 Automated Grading (40% of composite)

#### Hidden Test Suite (25%)
Candidates see and run the *public* tests. The grader re-runs a separate *hidden* suite covering edge cases, concurrency correctness, and security scenarios. Each test is tagged; the grader records which tags pass.

#### Trap Detection (15%)
Every challenge repo has **planted bugs** — intentional defects in the starter code. `.jivahire/traps.json` defines each trap and the test tag that reveals whether the candidate fixed it. Traps are unannounced.

---

### 7A.4 LLM Evaluations (60% of composite)

All evaluations use GPT-4o-mini with `temperature=0`. Each returns a score (1–10) and 2–3 sentences of reasoning. Recruiters see the reasoning text in the session detail view.

#### 1. Code Quality (20%)

**Measures:** Whether submitted code is correct, readable, and handles edge cases.

**Inputs:** challenge description, rubric tasks, known traps + fixed-status, hidden test results, candidate's source.

**Criteria** (challenge-specific, with defaults):

| Criterion | Description |
|---|---|
| Correctness | Does it pass tests and fix planted traps? |
| Idiomatic language use | Proper conventions, standard library use |
| Clarity and naming | Readable structure, well-named identifiers |
| Edge case handling | Robust failure modes, boundary conditions |

#### 2. Prompt Quality (15%)

**Measures:** How precisely the candidate communicates with the AI.

**Inputs:** prompts from `.jivahire_chat_log.json` (up to 20).

**Classification step** — each prompt classified as:

| Class | Definition | Example |
|---|---|---|
| `vague` | No technical context | *"fix this"*, *"make it work"* |
| `specific` | Describes the symptom | *"function X returns the wrong value"* |
| `professional` | Cites exact errors, types, line numbers, or runtime behaviour | *"function X returns Y for input Z because the loop terminates one iteration early"* |

**Scoring scale:**

| Score | Meaning |
|---|---|
| 9–10 | Consistently professional |
| 7–8 | Mostly specific |
| 5–6 | Mixed |
| 3–4 | Mostly vague |
| 1–2 | All layman — zero technical context |

#### 3. AI Orchestration (15%)

**Measures:** Whether candidate used AI strategically — iterating, correcting, applying judgment — rather than blindly copying.

**Inputs:** up to 20 chat exchanges (prompt + first 400 chars of response) + first 3,000 chars of submitted code.

| Criterion | Description |
|---|---|
| Prompt quality | Specific and targeted vs vague |
| Critical evaluation | Did they understand and adapt AI suggestions? |
| Iterative refinement | Did they follow up when AI output was wrong? |
| Independence | Evidence of own reasoning alongside AI use |

#### 4. Architectural Reasoning (10%)

**Measures:** Quality of design decisions the candidate was *responsible for* — not choices already in starter code.

**Inputs:** full rubric (including `starter_code_note`) + candidate's full source.

**Important constraint:** evaluator is explicitly instructed *not to credit* candidates for algorithms, data structures, or patterns already in the starter code. Only candidate-made decisions are scored.

| Criterion | Description |
|---|---|
| Algorithm choice | Only if candidate selected (not inherited) |
| Data structure choice | Only if candidate selected (not inherited) |
| Concurrency/sync design | Lock placement, primitive choice, deadlock avoidance |
| Edge-case awareness | Boundary handling, capacity constraints, unexpected inputs |

---

### 7A.5 Per-Challenge Rubrics

#### Challenge: Thread-Safe TTL Cache (`python-ttl-cache`)

**Language:** Python | **Difficulty:** Mid | **Estimated time:** 45 min | **Time limit:** 90 min

**Task:** Make an existing TTL cache thread-safe, enforce TTL expiry on reads, and fix planted bugs in eviction and edge-case handling. Get/put must remain amortised O(1).

> **Note to graders:** The data structure (`collections.OrderedDict` with `move_to_end`-based promotion) is provided in the starter code. Do **not** credit the candidate for the algorithm or data-structure choice — only their additions and fixes.

**Task Scoring:**

| Task | Points | Test Marker |
|---|---|---|
| Basic cache correctness | 25 | `basic` |
| Thread safety | 30 | `thread` |
| Edge cases | 20 | `edge` |
| TTL expiry enforcement | 25 | `ttl` |
| **Total** | **100** | |

**Planted Traps:**

| Trap | Description | Points |
|---|---|---|
| Race condition | `get`/`put` mutate `OrderedDict` (`move_to_end`, `popitem`, `__setitem__`) without synchronisation. The GIL does **not** make compound operations atomic. | 20 |
| Off-by-one eviction | Eviction loop uses `> capacity` instead of `>= capacity`; cache grows one entry beyond limit before evicting. | 10 |
| Capacity-zero no-op | `capacity=0`: eviction check `(0 > 0)` is false, so the first `put` inserts an entry instead of being a no-op. | 10 |
| TTL not enforced on read | `get()` does not check TTL; expired entries are returned as if still valid. The starter stores `inserted_at` but never compares it to `time.monotonic() - ttl`. | 15 |

**Code Quality Criteria:**
- Correctness (tests pass and traps fixed)
- Thread safety — lock placement and no data races on `OrderedDict`
- Idiomatic Python — type hints, context managers, `time.monotonic` for TTL
- Clarity and naming

**Architectural Criteria:**
- Synchronisation primitive choice (`threading.Lock` vs `threading.RLock`)
- Lock placement and granularity (per-method, scope of critical section)
- Deadlock avoidance (no nested locking, no reentrant calls)
- Edge case handling (capacity=0 no-op, eviction boundary, TTL on get)
- Monotonic time source (`time.monotonic` vs `time.time`)

---

#### Challenge: Thread-Safe LRU Cache (`cpp-lru-cache`)

**Language:** C++ | **Difficulty:** Mid | **Estimated time:** 45 min | **Time limit:** 90 min

**Task:** Make an existing LRU cache thread-safe and fix planted bugs in eviction and edge-case handling. Get/put must remain O(1).

> **Note to graders:** The data structure (`std::list` + `std::unordered_map` with splice-based eviction) is provided in the starter code. Do **not** credit the candidate for the algorithm or data-structure choice — only their additions and fixes.

**Task Scoring:**

| Task | Points | Test Tag |
|---|---|---|
| Basic cache correctness | 30 | `[basic]` |
| Thread safety | 35 | `[thread]` |
| Edge cases | 20 | `[edge]` |
| **Total** | **85** (normalised to 100) | |

**Planted Traps:**

| Trap | Description | Points |
|---|---|---|
| Race condition | `get`/`put` mutate `std::list` and `std::unordered_map` without synchronisation. | 20 |
| Off-by-one eviction | Eviction loop uses `> capacity` instead of `>= capacity`; cache grows one entry beyond limit. | 10 |
| Capacity-zero no-op | `capacity=0`: eviction check `(0 > 0)` is false, so the first `put` inserts an entry instead of being a no-op. | 10 |

**Code Quality Criteria:**
- Correctness (tests pass and traps fixed)
- Thread safety — mutex/lock usage and no data races
- Idiomatic C++ — move semantics, const correctness, RAII
- Clarity and naming

**Architectural Criteria:**
- Synchronisation primitive choice (`std::mutex` vs `std::shared_mutex`)
- Lock placement and granularity (per-method, scope of critical section)
- Deadlock avoidance (no nested locking, no recursive locks)
- Edge case handling (capacity=0 no-op, eviction boundary off-by-one)
- Const-correctness of locking strategy (e.g. `size()` under shared lock)

---

#### Challenge: Wafer Chamber Telemetry Aggregator (`cpp-wafer-telemetry`)

**Language:** C++17 | **Difficulty:** Mid–Senior | **Estimated time:** 60 min | **Time limit:** 60 min | **Domain:** Streaming metrics aggregation (semiconductor fab flavour)

**Task:** Complete a multi-threaded wafer-process telemetry aggregator. The repo deliberately mixes three file states to exercise different skills:

| File | State | What candidate does |
|---|---|---|
| `sensor_reading.h` | Complete schema | Read only |
| `spc_limits.{h,cpp}` | Complete reference | Read only — may reference from prompts |
| `chamber_aggregator.{h,cpp}` | Partial with planted bugs | Tasks 1–4 |
| `excursion_reporter.h` | Interface only, **no `.cpp`** | Task 5 — design + implement from scratch |
| `main.cpp` | Complete demo | Read only |

> **Note to graders:** The aggregator's storage layout (`unordered_map` nesting) and the SPC algorithm are provided. Do **not** credit the candidate for those choices. **Do** credit the candidate for the `ExcursionReporter` design — that file is missing entirely. This is where the 10% architectural-reasoning weight is earnable.

**Task Scoring:**

| Task | Points | Test Tag | Type |
|---|---:|---|---|
| 1. Thread-safe `ingest()` | 25 | `[thread]` | Fix existing |
| 2. Numerically stable rolling stats (Welford or equivalent) | 20 | `[stats]` | Fix existing |
| 3. Wire `SpcLimits` + excursion counting + forward to reporter | 15 | `[spc]` | Connect existing |
| 4. `on_wafer_complete()` lifecycle + late-reading drop | 15 | `[lifecycle]` | Complete partial |
| 5. Design and implement `ExcursionReporter` from scratch | 25 | `[reporter]` `[reporter_concurrent]` | Build new |
| **Total** | **100** | | |

**Planted Traps:**

| Trap | Description | Points |
|---|---|---:|
| Race condition on hot path | `ingest()` mutates `live_` (nested `unordered_map`) without any lock. Multi-thread test triggers UB. | 20 |
| Numerical instability | `compute_running_stats` uses textbook `(sum_sq - sum²/n)/(n-1)` — catastrophic cancellation on `760 ± 0.001 Torr` series. Hidden test demands `WithinRel(0.001, 0.10)`. | 15 |
| Late-reading resurrection | `ingest()` does no completed-wafer check; readings arriving after `on_wafer_complete()` resurrect freed state. | 10 |
| Reporter shutdown leak | If candidate's `ExcursionReporter` does not drain in destructor, hidden test catches lost excursions. | 10 |

**Code Quality Criteria:**
- Correctness (public + hidden tests pass; planted traps fixed)
- Thread safety — chosen primitive justified; no data races under TSan
- Numerical correctness — single-pass O(1)/sample stable variance algorithm
- Idiomatic C++17 — RAII, `std::unique_ptr` for pimpl, move semantics, `noexcept` where appropriate
- Clarity and naming

**Architectural Criteria** (most of these are earnable only on Task 5):
- **Reporter queue design** — `std::queue + condvar` vs lock-free vs SPSC ring buffer; trade-off justified
- **Backpressure policy** — block / drop-oldest / drop-newest / coalesce; explicit choice with rationale (in code or `DESIGN.md`)
- **Threading model** — single drain thread vs thread pool; how it interacts with the aggregator's hot path
- **Shutdown discipline** — drain + join in destructor; idempotent `shutdown()`; no hangs, no lost events under chosen policy
- **Pimpl boundary** — does the candidate honour the header's `Impl` opaque type or leak implementation details into `excursion_reporter.h`?
- For Tasks 1–4: lock granularity (per-chamber sharded vs global), choice of `std::mutex` vs `std::shared_mutex`, deadlock avoidance, monotonic time source

---

### 7A.6 Anti-Gaming Measures

| Measure | How it works |
|---|---|
| Private repos | Candidates never see the repo URL; extension clones a one-time branch |
| Randomised challenge assignment | Random selection from a pool per language/difficulty |
| Branch isolation | Each candidate gets `interview/<session_id>` — read-only after submission |
| Traps stripped from candidate branch | `.jivahire/` directory (rubric, traps, hidden tests) removed before clone |
| Time limit | Enforced client-side (extension countdown) and server-side (Celery auto-submit) |
| Token cap | Per-session `max_tokens` enforced by sidecar — candidate sees an exhausted message; session auto-paused |

---

### 7A.7 Drift-Fix Summary (vs prior rubric)

| Was | Now | Why |
|---|---|---|
| Token efficiency in composite (10%) | Independent axis (0–100), not in composite | Different scale, different purpose; blending corrupts both signals |
| Flat 30,000-token baseline | Per-challenge `max_tokens` formula (section 7.7) | Fairness across challenges of different sizes |
| LLM-evaluated 1–10 with ratio bands | Deterministic % buckets: <50/50–80/80–100/>100 | Removes LLM nondeterminism for an objective measure |
| Term "budget" | Term "tokens" / "max_tokens" | Accurate — we count tokens, not money |
| No developer-confidence axis | Added as 3rd independent axis (section 7.6) | Distinguishes practicing developers from non-devs |
| Tests 20% / Traps 10% in composite | Tests 25% / Traps 15% | Absorbed the freed 10% from removed token-efficiency dimension |

---

## 8. Recruiter Dashboard

### 8.1 Session List View

Table showing all interview sessions for the recruiter's jobs:

| Candidate | Challenge | Language | Status | Score | Dev Confidence | AI Usage | Time | Actions |
|-----------|-----------|----------|--------|-------|----------------|----------|------|---------|
| John Doe | ts-auth-api | TypeScript | Graded | 7.8/10 | 82 — Developer | 45% human | 52 min | View |
| Jane Smith | py-data-pipeline | Python | Graded | 6.1/10 | 24 — Non-developer | 3% human | 58 min | View |
| Bob Lee | rs-cli-tool | Rust | Graded | 5.5/10 | 45 — Uncertain | 22% human | 60 min | View |

### 8.2 Session Detail View

When recruiter clicks "View":

1. **Score Card:** Composite score + breakdown (test pass rate, trap detection, AI orchestration, code quality, architectural reasoning) + **Developer Confidence** badge (score, verdict, and expandable signal breakdown: typed ratio, files explored, post-AI edits, prompt specificity, debugger usage, test runs).
2. **Commit Timeline:** Visual timeline showing each auto-commit snapshot. For each snapshot: timestamp, files changed, lines added/deleted, diff preview. Recruiters can click any snapshot to see the full diff at that point. This shows the candidate's progression — what they tackled first, when they got stuck, when they made breakthroughs.
3. **AI Usage Chart:** Timeline showing human typing vs AI-generated code over the session duration, correlated with the commit timeline.
4. **Prompt History Viewer:** Scrollable conversation view loaded from `.jivahire_chat_log.json` in the candidate's branch. Shows prompts and AI responses in order. Includes topic tags and correction loop indicators.
5. **Chat Summary:** Number of prompts, correction loops, topic distribution — aggregate stats above the prompt viewer.
6. **Diff Viewer:** Candidate's final git diff (the total submission).
7. **Grader Summary:** LLM-generated 3-sentence summary of the candidate's approach.
8. **Cost:** Total LLM tokens consumed and cost for this interview.

---

## 9. Integration with Existing JivaHire

| Existing Component | Integration |
|---|---|
| **Recruiter Node (Django)** | Interview session APIs live here. New Django app: `interviews/`. |
| **Candidate Hub** | Candidate receives interview invitation email via existing email pipeline. Session key included in email. |
| **LLM Token Mgmt Sidecar** | Chat panel routes through sidecar. Per-session budget via `X-Feature-ID: interview_<session_id>`. |
| **Celery** | Grading pipeline runs as Celery tasks (clone, test, LLM evaluation). |
| **Job model** | Interview session links to job_id for context. |

---

## 10. Cost Estimate Per Interview

| Component | Cost |
|---|---|
| LLM usage (candidate chat, ~50K tokens) | ~$0.50 (Gemini Flash) to ~$2.00 (GPT-4o) |
| LLM grading (3 evaluations, ~10K tokens) | ~$0.10 (Gemini Flash) to ~$0.50 (GPT-4o) |
| GitHub (private repo branch) | Free (included in GitHub plan) |
| Compute (Celery grading task) | Negligible (runs tests for ~30s) |
| **Total per interview** | **~$0.60 to $2.50** |

Budget is configurable per session. Default: $2.00 for candidate chat + $0.50 for grading = $2.50 max.

---

## 11. Candidate Experience

### 11.1 Invitation Email

```
Subject: Your JivaHire Technical Interview — [Company Name]

Hi [Candidate Name],

You've been invited to a coding interview for [Job Title] at [Company Name].

What to expect:
• A real coding challenge in [Language] (approximately [Time] minutes)
• You'll work in VS Code with an AI assistant available
• You can use ANY tools you're comfortable with — AI assistants, docs, Stack Overflow
• Your prompts to the built-in AI assistant will be recorded for evaluation purposes
• We evaluate HOW you solve problems, not WHETHER you use AI

Setup:
1. Install the Jivahire Interview Sidecar extension:
   [Download VSIX] or [VS Code Marketplace Link]
2. Open VS Code and run command: "Jivahire: Start Interview"
3. Enter your session key: [SESSION_KEY]
4. The extension will set up your workspace automatically.

After submitting:
• Your submission will be reviewed within [X] business days.
• You'll receive feedback on your approach.

Questions? Reply to this email.
```

### 11.2 Post-Submission

After the candidate submits:
- Extension shows: "Submitted successfully. You may close VS Code and uninstall the extension."
- Candidate receives email confirmation: "Your submission has been received. We'll review it within [X] days."
- (Optional) After grading: send candidate a **summary score** and brief feedback. This is a differentiator — most companies give zero feedback.

---

## 12. Implementation Milestones

### Phase 1: Foundation (MVP)

| # | Task | Deliverable |
|---|------|------------|
| 1 | Build 5 challenge repos (3 languages) | Private GitHub repos with rubrics, traps, public + hidden tests |
| 2 | VS Code extension — auth + workspace + chat | Extension that validates session key, clones repo, shows chat panel |
| 3 | VS Code extension — telemetry agent | Edit tracking (typed/pasted/AI), chat metadata, debug/test tracking |
| 4 | Backend — session management APIs | Create session, validate key, ingest telemetry, submit |
| 5 | Backend — automated grading (tests + traps) | Celery task: clone branch, run hidden tests, check traps |
| 6 | Backend — session timer enforcement + auto-submit worker | Server-side timer check on all APIs + Celery Beat for crash recovery |
| 7 | Recruiter dashboard — session list + score card | Basic view of sessions and automated scores |

### Phase 2: AI Grading

| # | Task | Deliverable |
|---|------|------------|
| 8 | LLM grading pipeline (3 evaluations) | Celery task: code quality, AI orchestration, architectural reasoning |
| 9 | Composite score computation | Weighted formula combining automated + LLM scores |
| 10 | Recruiter dashboard — full detail view | Commit timeline, prompt viewer, charts, diff viewer, grader summary, cost |

### Phase 3: Scale & Polish

| # | Task | Deliverable |
|---|------|------------|
| 11 | Add 10-15 more challenge repos | Broader language/difficulty coverage |
| 12 | Candidate feedback email | Automated post-grading feedback with summary |
| 13 | Analytics for recruiters | Aggregate stats: average scores by challenge, AI usage trends |
| 14 | Extension polish | Better UI, error handling, offline recovery testing |

---

## 13. Security & Privacy

| Concern | Mitigation |
|---|---|
| Session key brute force | Rate limit `/validate-session` (5 attempts per IP per hour). Keys are 6+ chars with mixed case + digits. |
| Prompt data privacy | Prompts stored in `.jivahire_chat_log.json` in the candidate's git branch. Deleted when branch is deleted. Recruiter-only access. Candidate consented at session start. |
| Code submission privacy | Git diff stored in DB. Candidate's branch deleted after grading (configurable retention). |
| LLM cost abuse | Per-session budget enforced by sidecar. Candidate can't exceed $2.00 unless recruiter raises limit. |
| Extension permissions | Extension requests minimum permissions: workspace access (for editing), network (for telemetry + chat). No file system access outside workspace. |
| Challenge leakage | Private repos. `.jivahire/` stripped from candidate branch. Randomized assignment from pool. |
| Prompt history retention | Prompts live in the git branch. When the branch is deleted (configurable retention), prompts are deleted with it. No separate cleanup needed. |
