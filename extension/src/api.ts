import * as https from "https";
import * as http from "http";

/** Per-million-token pricing as reported by the server. */
export interface ModelPricing {
  input: number;
  output: number;
}

export interface SessionConfig {
  sessionId: string;
  sessionKey: string;
  repoUrl: string;
  branch: string;
  githubToken: string;
  llmProxyUrl: string;
  maxMinutes: number;
  llmBudgetUsd: number;
  challengeId: string;
  challengeDescription: string;
  chatModel: string;
  availableChatModels: string[];
  startedAt: number; // epoch ms, recorded client-side on validate
  /**
   * Per-million-token pricing for each available chat model, supplied by the
   * server so the client's budget meter never diverges from the proxy's
   * server-side budget enforcement when a new model is introduced.
   */
  pricingPerMillion: Record<string, ModelPricing>;
  /**
   * Panel-interview video call. When set, the candidate must join the link
   * and share their screen with the interviewer(s). Unset for async sessions.
   */
  meetLink?: string;
  videoPlatform?: string;
  /** Scheduled start time (epoch SECONDS, UTC). Drives the "starts in X min"
   *  countdown on the brief panel when in the future. */
  scheduledAt?: number;
}

/** Default pricing fallback when the server omits the pricing table. */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/gpt-4o-2024-11-20": { input: 2.5, output: 10.0 },
};

/** Default per-request HTTP timeout (ms). validate-session creates a GitHub
 *  branch on first call, which can take 10–30s on a slow GitHub API; bumped
 *  from 15s so candidates on regular consumer networks don't get spurious
 *  "Request timed out" failures before the branch is ready. */
export const POST_TIMEOUT_MS = 60_000;

/**
 * Returns true when `proxyUrl` is on the same hostname as `serverUrl`. This is
 * the trust boundary for SSRF defence: the bearer session key and every chat
 * prompt are POSTed to `llmProxyUrl`, so we cannot honour a hostname that
 * differs from the one the candidate authenticated to.
 */
export function isAllowedProxyHost(serverUrl: string, proxyUrl: string): boolean {
  try {
    const a = new URL(serverUrl);
    const b = new URL(proxyUrl);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch {
    return false;
  }
}

export async function validateSession(
  serverUrl: string,
  sessionKey: string
): Promise<SessionConfig> {
  const base = serverUrl.replace(/\/+$/, "");
  const body = JSON.stringify({ session_key: sessionKey });
  const res = await post(`${base}/api/v1/validate-session`, body);

  // SSRF defence: the validate-session server is trusted to authenticate the
  // candidate; we cannot let it redirect subsequent chat / telemetry / submit
  // traffic — which carries the bearer session key — to an arbitrary host.
  // Default the proxy URL to `serverUrl` when the server omits it, and fall
  // back to `serverUrl` when the server points us at a different hostname.
  // The bearer token therefore only ever travels to the host the candidate
  // authenticated to, regardless of what the server claims.
  const advertisedProxyUrl: string = res.llm_proxy_url ?? base;
  const rawProxyUrl: string = isAllowedProxyHost(base, advertisedProxyUrl)
    ? advertisedProxyUrl
    : base;

  // Defence-in-depth: validate-session is trusted, but treat the meet link as
  // untrusted webview content downstream — only accept https URLs and reject
  // anything that could embed scripts (javascript:, data:, vbscript:).
  const rawMeet = typeof res.meet_link === "string" ? res.meet_link.trim() : "";
  const meetLink = rawMeet.startsWith("https://") ? rawMeet : undefined;
  const videoPlatform = typeof res.video_platform === "string"
    ? res.video_platform
    : undefined;
  const scheduledAt = typeof res.scheduled_at === "number" && res.scheduled_at > 0
    ? res.scheduled_at
    : undefined;

  return {
    sessionId: res.session_id,
    sessionKey,
    repoUrl: res.repo_url,
    branch: res.branch,
    githubToken: res.github_clone_token,
    llmProxyUrl: rawProxyUrl,
    maxMinutes: res.max_minutes,
    llmBudgetUsd: res.llm_budget_usd,
    challengeId: res.challenge_id,
    challengeDescription: res.challenge_description ?? res.challenge_id ?? "",
    chatModel: res.chat_model ?? "openai/gpt-4o-mini",
    availableChatModels: res.available_chat_models ?? [res.chat_model ?? "openai/gpt-4o-mini"],
    startedAt: Date.now(),
    pricingPerMillion: _normalisePricing(res.pricing_per_million),
    meetLink,
    videoPlatform,
    scheduledAt,
  };
}

/**
 * Convert a server-supplied pricing dict into the canonical shape, falling
 * back to {@link DEFAULT_MODEL_PRICING} when the server omits it. Bug fix:
 * the client used to hard-code pricing in chat/view.ts, so any model the
 * server added (e.g. an Anthropic or Gemini option) silently fell through
 * to GPT-4o rates and the candidate's spent meter diverged from the proxy's
 * actual budget enforcement.
 */
function _normalisePricing(raw: unknown): Record<string, ModelPricing> {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MODEL_PRICING };
  const out: Record<string, ModelPricing> = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!p || typeof p !== "object") continue;
    const entry = p as { input?: unknown; output?: unknown };
    if (typeof entry.input === "number" && typeof entry.output === "number") {
      out[model] = { input: entry.input, output: entry.output };
    }
  }
  // Layer the defaults underneath so unknown server-listed models still get
  // a plausible price if the table is incomplete. Server entries win on
  // overlap.
  return { ...DEFAULT_MODEL_PRICING, ...out };
}

export async function submitSession(config: SessionConfig): Promise<void> {
  await post(
    `${config.llmProxyUrl}/api/v1/submit`,
    "{}",
    config.sessionKey
  );
}

function post(url: string, body: string, bearerToken?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    let settled = false;
    const settle = (err?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            settle(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            try { settle(undefined, JSON.parse(data)); } catch { settle(undefined, {}); }
          }
        });
      }
    );
    req.on("error", (e) => settle(e));
    // Bug fix: a hung server used to spin the "Submitting…" / "Validating…"
    // notification forever. Drop the connection after POST_TIMEOUT_MS so the
    // candidate gets a real error and can retry.
    req.setTimeout(POST_TIMEOUT_MS, () => {
      try { req.destroy(); } catch { /* swallow */ }
      settle(new Error(`Request timed out after ${POST_TIMEOUT_MS}ms`));
    });
    req.write(body);
    req.end();
  });
}
