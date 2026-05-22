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

  test('Bug #9: llm_proxy_url on a different host is ignored, auth server URL is used', async () => {
    // SSRF defence: if the server returns a proxy host that doesn't match the
    // host the candidate authenticated to, we silently fall back to the auth
    // server URL so the bearer token never travels to an unverified endpoint.
    // (Previously this threw, but that blocked legitimate deployments where
    //  the server's advertised proxy URL was misconfigured.)
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://attacker.example.com', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.llmProxyUrl).toBe('http://server:8080');
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

// ── Review-Bug 6: server-supplied per-model pricing ────────────────────────

describe('validateSession pricing (Review-Bug 6)', () => {
  beforeEach(() => jest.resetModules());

  test('Review-Bug 6: includes server-supplied pricing_per_million in the config', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'anthropic/claude-3-opus',
      pricing_per_million: {
        'anthropic/claude-3-opus': { input: 15.0, output: 75.0 },
        'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
      },
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.pricingPerMillion['anthropic/claude-3-opus']).toEqual({ input: 15.0, output: 75.0 });
    expect(config.pricingPerMillion['openai/gpt-4o-mini']).toEqual({ input: 0.15, output: 0.6 });
  });

  test('Review-Bug 6: missing pricing_per_million falls back to bundled defaults', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate, DEFAULT_MODEL_PRICING } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.pricingPerMillion['openai/gpt-4o-mini'])
      .toEqual(DEFAULT_MODEL_PRICING['openai/gpt-4o-mini']);
  });

  test('Review-Bug 6: malformed pricing entries are skipped, not crashed on', async () => {
    const payload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
      pricing_per_million: {
        'broken/model': 'not an object',
        'partial/model': { input: 1.0 }, // missing output
        'good/model': { input: 1.0, output: 2.0 },
      },
    };
    mockHttpResponse({ statusCode: 200, body: JSON.stringify(payload) });
    const { validateSession: validate } = await import('../api');
    const config = await validate('http://server:8080', 'KEY');
    expect(config.pricingPerMillion['good/model']).toEqual({ input: 1.0, output: 2.0 });
    expect(config.pricingPerMillion['broken/model']).toBeUndefined();
    expect(config.pricingPerMillion['partial/model']).toBeUndefined();
  });

  // ── Multi-model picker: bundled defaults cover every advertised model ───
  //
  // The chat picker advertises four models. If the server omits
  // `pricing_per_million`, the bundled DEFAULT_MODEL_PRICING is the only
  // way the extension's spend meter stays accurate — every advertised model
  // MUST have a fallback entry.
  test('DEFAULT_MODEL_PRICING covers every advertised picker model', async () => {
    const { DEFAULT_MODEL_PRICING } = await import('../api');
    for (const m of [
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash-lite',
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.6',
    ]) {
      expect(DEFAULT_MODEL_PRICING[m]).toBeDefined();
      expect(typeof DEFAULT_MODEL_PRICING[m].input).toBe('number');
      expect(typeof DEFAULT_MODEL_PRICING[m].output).toBe('number');
      // Output is always >= input for these providers.
      expect(DEFAULT_MODEL_PRICING[m].output)
        .toBeGreaterThanOrEqual(DEFAULT_MODEL_PRICING[m].input);
    }
  });
});

// ── Review-Bug 9: POST timeout ─────────────────────────────────────────────

describe('post() timeout (Review-Bug 9)', () => {
  beforeEach(() => jest.resetModules());

  test('Review-Bug 9: a server that never responds rejects with a timeout error', async () => {
    // Stub http.request so the response callback NEVER fires AND the timeout
    // path runs synchronously (via the exposed `_armTimeout` test seam).
    let timeoutHandler: (() => void) | undefined;
    const reqHandle = {
      on: jest.fn().mockReturnThis(),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
      setTimeout: jest.fn().mockImplementation((_ms: number, cb: () => void) => {
        timeoutHandler = cb;
      }),
    };
    const stub = {
      request: jest.fn().mockImplementation((_opts: unknown, _cb: (r: unknown) => void) => {
        // Never call _cb — the response never arrives
        return reqHandle;
      }),
    };
    jest.doMock('http', () => stub);
    jest.doMock('https', () => stub);

    const { validateSession: validate } = await import('../api');
    const promise = validate('http://server:8080', 'KEY');
    // Fire the timeout
    expect(timeoutHandler).toBeDefined();
    timeoutHandler!();
    await expect(promise).rejects.toThrow(/timed out/);
    expect(reqHandle.destroy).toHaveBeenCalled();
  });

  test('Review-Bug 9: setTimeout is configured on every outgoing request', async () => {
    const setTimeoutSpy = jest.fn();
    const reqHandle = {
      on: jest.fn().mockReturnThis(),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
      setTimeout: setTimeoutSpy,
    };
    const responsePayload = {
      session_id: 'x', repo_url: 'u', branch: 'b', github_clone_token: 't',
      llm_proxy_url: 'http://server:8080', max_minutes: 60, llm_budget_usd: 2,
      challenge_id: 'c', challenge_description: 'c', chat_model: 'openai/gpt-4o-mini',
    };
    const stub = {
      request: jest.fn().mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        // Respond synchronously with a successful payload so the test
        // exercises the success path AND the setTimeout still got called.
        process.nextTick(() => {
          const res = {
            statusCode: 200,
            on: jest.fn().mockImplementation((event: string, handler: (d?: unknown) => void) => {
              if (event === 'data') handler(JSON.stringify(responsePayload));
              if (event === 'end') handler();
              return res;
            }),
          };
          cb(res);
        });
        return reqHandle;
      }),
    };
    jest.doMock('http', () => stub);
    jest.doMock('https', () => stub);

    const { validateSession: validate, POST_TIMEOUT_MS } = await import('../api');
    await validate('http://server:8080', 'KEY');
    expect(setTimeoutSpy).toHaveBeenCalledWith(POST_TIMEOUT_MS, expect.any(Function));
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
