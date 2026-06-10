import { type SessionConfig, DEFAULT_MODEL_PRICING } from '../api';
import * as vscode from 'vscode';

export function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: 'aabbccdd-1122-3344-5566-778899aabbcc',
    sessionKey: 'TEST-KEY-123',
    repoUrl: 'https://github.com/test/challenge-lru',
    branch: 'interview/aabbccdd',
    githubToken: 'ghs_testtoken',
    githubTokenExpiresAt: Date.now() + 60 * 60_000,
    llmProxyUrl: 'http://localhost:9999',
    maxMinutes: 90,
    llmBudgetUsd: 2.0,
    challengeId: 'lru-cache-challenge',
    challengeDescription: 'Implement a thread-safe LRU cache',
    language: 'cpp',
    chatModel: 'openai/gpt-4o-mini',
    availableChatModels: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
    startedAt: Date.now(),
    pricingPerMillion: { ...DEFAULT_MODEL_PRICING },
    ...overrides,
  };
}

export function makeMockContext(stateMap: Record<string, unknown> = {}): any {
  const state = new Map<string, unknown>(Object.entries(stateMap));
  return {
    globalState: {
      get: jest.fn().mockImplementation((key: string, def?: unknown) =>
        state.has(key) ? state.get(key) : def,
      ),
      update: jest.fn().mockImplementation((key: string, value: unknown) => {
        state.set(key, value);
        return Promise.resolve();
      }),
    },
    subscriptions: [] as any[],
    extensionUri: vscode.Uri.file('/ext'),
  };
}

export function makeMockWebviewView(): any {
  return {
    webview: {
      html: '',
      options: {},
      cspSource: 'mock-csp-source',
      asWebviewUri: jest.fn().mockImplementation((u: any) => ({
        toString: () => `vscode-resource:${u.fsPath ?? u.path}`,
      })),
      postMessage: jest.fn().mockResolvedValue(true),
      onDidReceiveMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    },
    show: jest.fn(),
    onDidChangeVisibility: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onDidDispose: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  };
}
