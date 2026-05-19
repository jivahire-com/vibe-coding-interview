// Manual mock for the 'vscode' module — used by all unit tests.
// Each factory function returns a fresh object so tests don't share state.

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ProgressLocation = { Notification: 15, Window: 10, SourceControl: 1 };

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class Uri {
  constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly fsPath: string = path,
  ) {}

  toString() { return `${this.scheme}:${this.path}`; }

  static file(p: string): Uri { return new Uri('file', p, p); }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    const joined = [base.fsPath, ...parts].join('/');
    return new Uri(base.scheme, joined, joined);
  }

  static from(c: { scheme: string; path: string }): Uri {
    return new Uri(c.scheme, c.path, c.path);
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position | number, public readonly end: Position | number) {}
}

export class CodeLens {
  constructor(public readonly range: Range, public readonly command?: object) {}
}

export class WorkspaceEdit {
  private _edits: Array<{ uri: Uri; range: Range; text: string }> = [];
  replace(uri: Uri, range: Range, text: string): void { this._edits.push({ uri, range, text }); }
  getEdits() { return this._edits; }
}

// ─── window ──────────────────────────────────────────────────────────────────

export const window = {
  createStatusBarItem: jest.fn().mockImplementation(() => ({
    command: undefined as string | undefined,
    text: '',
    tooltip: '',
    backgroundColor: undefined as ThemeColor | undefined,
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  })),

  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),

  /** Test-controlled active editor. */
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,

  /**
   * Tab-group mock with mutable tab list so tests can simulate VS Code's
   * tab API. Tests push fake diff tabs onto _tabs; the close() implementation
   * removes them so production code's close-by-URI logic is verifiable.
   */
  tabGroups: {
    _tabs: [] as any[],
    get all() { return [{ tabs: (window as any).tabGroups._tabs }]; },
    close: jest.fn().mockImplementation(async (tab: any) => {
      const arr = (window as any).tabGroups._tabs as any[];
      const i = arr.indexOf(tab);
      if (i >= 0) arr.splice(i, 1);
      return true;
    }),
  },

  withProgress: jest.fn().mockImplementation(
    (_opts: unknown, task: (p: { report: () => void }) => Promise<void>) =>
      task({ report: jest.fn() }),
  ),

  registerWebviewViewProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),

  /** Stores the last registered callback so tests can fire window-state events. */
  _windowStateCallback: null as ((s: { focused: boolean }) => void) | null,
  onDidChangeWindowState: jest.fn().mockImplementation(
    (cb: (s: { focused: boolean }) => void) => {
      (window as any)._windowStateCallback = cb;
      return { dispose: jest.fn() };
    },
  ),

  /** Stores the last registered callback so tests can fire active-editor events. */
  _activeEditorCallback: null as ((e: unknown) => void) | null,
  onDidChangeActiveTextEditor: jest.fn().mockImplementation(
    (cb: (e: unknown) => void) => {
      (window as any)._activeEditorCallback = cb;
      return { dispose: jest.fn() };
    },
  ),
};

// ─── debug ───────────────────────────────────────────────────────────────────

export const debug = {
  _debugStartCallback: null as ((s: unknown) => void) | null,
  onDidStartDebugSession: jest.fn().mockImplementation((cb: (s: unknown) => void) => {
    (debug as any)._debugStartCallback = cb;
    return { dispose: jest.fn() };
  }),
};

// ─── tests ───────────────────────────────────────────────────────────────────

export const tests = {
  _testRunCallback: null as ((r: unknown) => void) | null,
  onDidStartTestRun: jest.fn().mockImplementation((cb: (r: unknown) => void) => {
    (tests as any)._testRunCallback = cb;
    return { dispose: jest.fn() };
  }),
};

// ─── workspace ───────────────────────────────────────────────────────────────

export const workspace = {
  workspaceFolders: undefined as Array<{ uri: Uri }> | undefined,

  /** Stores the last registered callback so tests can fire doc-change events. */
  _docChangeCallback: null as ((e: unknown) => void) | null,
  onDidChangeTextDocument: jest.fn().mockImplementation((cb: (e: unknown) => void) => {
    (workspace as any)._docChangeCallback = cb;
    return { dispose: jest.fn() };
  }),

  /** Stores the last registered callback so tests can fire doc-close events. */
  _docCloseCallback: null as ((doc: unknown) => void) | null,
  onDidCloseTextDocument: jest.fn().mockImplementation((cb: (doc: unknown) => void) => {
    (workspace as any)._docCloseCallback = cb;
    return { dispose: jest.fn() };
  }),

  registerTextDocumentContentProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  applyEdit: jest.fn().mockResolvedValue(true),
};

// ─── commands ────────────────────────────────────────────────────────────────

export const commands = {
  executeCommand: jest.fn().mockResolvedValue(undefined),
  registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
};

// ─── languages ───────────────────────────────────────────────────────────────

export const languages = {
  registerCodeLensProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
};

// ─── env ─────────────────────────────────────────────────────────────────────

export const env = {
  clipboard: {
    writeText: jest.fn().mockResolvedValue(undefined),
  },
};

/**
 * Marker class matching vscode.TabInputTextDiff so apply.ts can
 * `instanceof`-check tabs when looking for the diff to close.
 */
export class TabInputTextDiff {
  constructor(public readonly original: Uri, public readonly modified: Uri) {}
}
