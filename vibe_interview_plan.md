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
  "max_minutes": 90,
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
   → Token is used once for clone + pushes, expires after session.max_minutes + 30 min
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
- **3-minute interval** is a balance: frequent enough to show progression, infrequent enough to not spam the git log. A 90-minute session produces ~30 commits — manageable.

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
    max_minutes INTEGER NOT NULL DEFAULT 90,
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
- Token lifetime: `session.max_minutes + 60 minutes` (enough for the interview + grace period).
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
    return token.token  # expires in 1 hour (GitHub default), re-issue if session is longer
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
```

---

## 8. Recruiter Dashboard

### 8.1 Session List View

Table showing all interview sessions for the recruiter's jobs:

| Candidate | Challenge | Language | Status | Score | AI Usage | Time | Actions |
|-----------|-----------|----------|--------|-------|----------|------|---------|
| John Doe | ts-auth-api | TypeScript | Graded | 7.8/10 | 45% human | 52 min | View |
| Jane Smith | py-data-pipeline | Python | Submitted | — | — | 71 min | Grade |

### 8.2 Session Detail View

When recruiter clicks "View":

1. **Score Card:** Composite score + breakdown (test pass rate, trap detection, AI orchestration, code quality, architectural reasoning).
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
