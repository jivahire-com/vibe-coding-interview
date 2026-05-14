/**
 * Tests for validateSession and submitSession (api.ts).
 * Mocks Node's http/https to avoid real network calls.
 */
import { validateSession, submitSession, isAllowedProxyHost } from '../api';

// ── HTTP mock ─────────────────────────────────────────────────────────────────

type ResponseStub = { statusCode: number; body: string };

function mockHttpResponse(stub: ResponseStub) {
  const makeLib = () => ({
    request: jest.fn().mockImplementation((_opts: unknown, cb: (res: any) => void) => {
      const res = {
        statusCode: stub.statusCode,
        on: jest.fn().mockImplementation((event: string, handler: (d?: any) => void) => {
          if (event === 'data') handler(stub.body);
          if (event === 'end') handler();
          return res;
        }),
      };
      cb(res);
      return {
        on: jest.fn().mockReturnThis(),
        write: jest.fn(),
        end: jest.fn(),
      };
    }),
  });

  jest.doMock('http', makeLib);
  jest.doMock('https', makeLib);
}

describe('validateSession', () => {
  beforeEach(() => jest.resetModules());

  test('parses a successful response into SessionConfig', async () => {
    const responsePayload = {
      session_id: 'abc123',
      repo_url: 'https://github.com/org/repo',
      branch: 'interview/abc123',
      github_clone_token: 'ghs_token',
      llm_proxy_url: 'http://server:8080',
      max_minutes: 90,
      llm_budget_usd: 2.5,
      challenge_id: 'lru-cache',
      challenge_description: 'Implement LRU',
      chat_model: 'openai/gpt-4o-mini',
    };

    mockHttpResponse({ statusCode: 200, body: JSON.stringify(responsePayload) });

    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'TEST-KEY');

    expect(config.sessionId).toBe('abc123');
    expect(config.sessionKey).toBe('TEST-KEY');
    expect(config.repoUrl).toBe('https://github.com/org/repo');
    expect(config.branch).toBe('interview/abc123');
    expect(config.githubToken).toBe('ghs_token');
    expect(config.llmProxyUrl).toBe('http://server:8080');
    expect(config.maxMinutes).toBe(90);
    expect(config.llmBudgetUsd).toBe(2.5);
    expect(config.challengeId).toBe('lru-cache');
    expect(config.challengeDescription).toBe('Implement LRU');
    expect(config.chatModel).toBe('openai/gpt-4o-mini');
    expect(typeof config.startedAt).toBe('number');
  });

  test('sets startedAt to approximately the current time', async () => {
    const before = Date.now();
    const responsePayload = {
      session_id: 'abc', repo_url: 'https://x', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };

    mockHttpResponse({ statusCode: 200, body: JSON.stringify(responsePayload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    const after = Date.now();

    expect(config.startedAt).toBeGreaterThanOrEqual(before);
    expect(config.startedAt).toBeLessThanOrEqual(after);
  });

  test('falls back to challengeId when challenge_description is absent', async () => {
    const responsePayload = {
      session_id: 'x', repo_url: 'https://x', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'fallback-id', chat_model: 'openai/gpt-4o-mini',
      // no challenge_description
    };

    mockHttpResponse({ statusCode: 200, body: JSON.stringify(responsePayload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.challengeDescription).toBe('fallback-id');
  });

  test('uses default chat model when chat_model is absent', async () => {
    const responsePayload = {
      session_id: 'x', repo_url: 'https://x', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c',
      // no chat_model
    };

    mockHttpResponse({ statusCode: 200, body: JSON.stringify(responsePayload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.chatModel).toBe('openai/gpt-4o-mini');
  });

  test('rejects on HTTP 4xx error', async () => {
    mockHttpResponse({ statusCode: 404, body: 'Not Found' });
    const { validateSession: validate } = await import('../api');
    await expect(validate('http://server:8080', 'BAD-KEY')).rejects.toThrow(/404/);
  });

  test('strips trailing slash from server URL', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });

    const httpMod = await import('http');
    const { validateSession: validate } = await import('../api');
    await validate('http://server:8080/', 'KEY'); // trailing slash

    const calls = (httpMod.request as jest.Mock).mock.calls;
    const opts = calls[0][0] as { path: string };
    expect(opts.path).not.toContain('//');
  });

  // ── Bug #9: SSRF / proxy host validation ─────────────────────────────────

  test('Bug #9: rejects llm_proxy_url on a different host than the auth server', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://attacker.example.com', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate } = await import('../api');
    await expect(validate('http://server:8080', 'KEY')).rejects.toThrow(/different host/);
  });

  test('Bug #9: accepts llm_proxy_url on the same host but different port', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:9000', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.llmProxyUrl).toBe('http://server:9000');
  });

  test('Bug #9: missing llm_proxy_url defaults to the auth server URL', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
      // no llm_proxy_url
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.llmProxyUrl).toBe('http://server:8080');
  });
});

describe('isAllowedProxyHost', () => {
  test('same hostname, any port → allowed', () => {
    expect(isAllowedProxyHost('http://srv:8080', 'http://srv:9000')).toBe(true);
  });
  test('different hostname → blocked', () => {
    expect(isAllowedProxyHost('http://srv:8080', 'http://other:8080')).toBe(false);
  });
  test('case-insensitive hostname comparison', () => {
    expect(isAllowedProxyHost('http://SRV.local', 'http://srv.local')).toBe(true);
  });
  test('unparseable URL → blocked (fail closed)', () => {
    expect(isAllowedProxyHost('http://srv', 'not a url')).toBe(false);
  });
});
