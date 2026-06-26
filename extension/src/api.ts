import * as https from "https";
import * as http from "http";

/** Per-million-token pricing as reported by the server. */
export interface ModelPricing {
  input: number;
  output: number;
}

/** A toolchain dependency the candidate needs for the assigned challenge.
 *  `check` is a `<tool> <flag>` command the extension runs (without a shell)
 *  to verify the tool is installed. `minVersion` and per-OS `install` hints are
 *  display-only. Sourced from the challenge's metadata.json (the server
 *  normalizes both the flat and nested metadata shapes into this form). */
export interface Dependency {
  name: string;
  minVersion?: string;
  check: string;
  install?: { macos?: string; debian?: string; windows?: string };
}

/** Read-only challenge info for the pre-clone confirmation dialog. Fetched
 *  before validate-session so the candidate can verify (and install) the
 *  required toolchain BEFORE the session is activated and the timer starts. */
export interface SessionPreflight {
  challengeId: string;
  title: string;
  language: string;
  dependencies: Dependency[];
  /** Tooling the build fetches automatically (e.g. "Catch2 v3 …"). Informational
   *  only — no install check is run for these. */
  autoFetched: string[];
}

export interface SessionConfig {
  sessionId: string;
  sessionKey: string;
  repoUrl: string;
  branch: string;
  githubToken: string;
  /**
   * Epoch milliseconds at which `githubToken` stops being accepted by GitHub.
   * The server mints ~1hr installation tokens, but sessions may run longer,
   * so the extension refreshes the token before this deadline. 0 means
   * "unknown" — older servers that don't ship this field still work, but
   * sessions over ~50min may see a push fail when the token quietly expires.
   */
  githubTokenExpiresAt: number;
  llmProxyUrl: string;
  maxMinutes: number;
  llmBudgetUsd: number;
  challengeId: string;
  challengeDescription: string;
  /** Coding language of the challenge (e.g. "cpp", "python"). Surfaced as a
   *  badge on the session brief. "unknown" when the server omits it. */
  language: string;
  chatModel: string;
  availableChatModels: string[];
  /**
   * Epoch ms the interview countdown is anchored to. 0 until the clock starts:
   * validate-session deliberately does NOT start it (cloning the repo + the
   * window reload can take minutes the candidate shouldn't lose). The extension
   * calls reportSessionStarted() from the freshly-opened clone workspace, which
   * sets the server-authoritative start and fills this in. The deadline is
   * `startedAt + maxMinutes`.
   */
  startedAt: number;
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
  /**
   * True iff the candidate will be asked to record a short solution-explainer
   * video after clicking Submit. Surfaced in the dashboard as an upfront
   * notice so candidates know to have a webcam + mic ready before the timer
   * runs out — the recorder only opens post-submit.
   */
  requireEndVideo?: boolean;
  /**
   * Whether this interview includes the AI chat assistant. True (default) is
   * the normal "vibe coding" experience. False is a normal coding interview —
   * the AI chat is disabled and the LLM proxy refuses chat. Defaults to true
   * when the server omits the field, so older servers keep AI on.
   */
  aiAssistance: boolean;
}

/**
 * The interview countdown deadline, in epoch ms. A startedAt of 0 means the
 * clock hasn't been anchored yet (the clone just finished / is finishing and
 * reportSessionStarted hasn't recorded the server start) — treat it as starting
 * "now" so the candidate sees full time remaining and the session is never
 * judged expired during that window. Once anchored, startedAt > 0 and this is
 * just `startedAt + maxMinutes`.
 */
export function sessionDeadlineMs(config: SessionConfig): number {
  return (config.startedAt || Date.now()) + config.maxMinutes * 60_000;
}

/** Default pricing fallback when the server omits the pricing table.
 *
 * Keep in sync with server/vibe/budget.py:MODEL_PRICING — the server's table
 * is authoritative, but if the extension is run against an older server that
 * doesn't yet ship `pricing_per_million`, these defaults keep the spend
 * meter sane for every model the picker offers. */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "anthropic/claude-opus-4.6": { input: 15.0, output: 75.0 },
  "anthropic/claude-sonnet-4.6": { input: 3.0, output: 15.0 },
  "anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0 },
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
  const requireEndVideo = res.require_end_video === true;
  // Default to AI-on when the server omits the field (older servers), so the
  // chat experience is unchanged unless the server explicitly disables it.
  const aiAssistance = res.ai_assistance !== false;

  return {
    sessionId: res.session_id,
    sessionKey,
    repoUrl: res.repo_url,
    branch: res.branch,
    githubToken: res.github_clone_token,
    githubTokenExpiresAt:
      typeof res.github_clone_token_expires_at === "number"
        ? res.github_clone_token_expires_at * 1000
        : 0,
    llmProxyUrl: rawProxyUrl,
    maxMinutes: res.max_minutes,
    llmBudgetUsd: res.llm_budget_usd,
    challengeId: res.challenge_id,
    challengeDescription: res.challenge_description ?? res.challenge_id ?? "",
    language: typeof res.language === "string" ? res.language : "unknown",
    chatModel: res.chat_model ?? "openai/gpt-4o",
    availableChatModels: res.available_chat_models ?? [res.chat_model ?? "openai/gpt-4o"],
    // 0 = clock not yet anchored. The countdown must not include the clone +
    // window-reload time, so we don't stamp a start here; the extension reports
    // clone-completion via reportSessionStarted() and fills this in then.
    startedAt: 0,
    pricingPerMillion: _normalisePricing(res.pricing_per_million),
    meetLink,
    videoPlatform,
    scheduledAt,
    requireEndVideo,
    aiAssistance,
  };
}

/**
 * Fetch read-only challenge info (language + tooling dependencies) for the
 * pre-clone confirmation dialog. This does NOT activate the session or start
 * the timer server-side — that happens only when the candidate confirms and
 * the extension goes on to call {@link validateSession}.
 */
export async function preflightSession(
  serverUrl: string,
  sessionKey: string
): Promise<SessionPreflight> {
  const base = serverUrl.replace(/\/+$/, "");
  const body = JSON.stringify({ session_key: sessionKey });
  const res = await post(`${base}/api/v1/session-preflight`, body);

  const rawDeps = Array.isArray(res.dependencies) ? res.dependencies : [];
  const dependencies: Dependency[] = rawDeps
    .filter(
      (d: unknown): d is Record<string, unknown> =>
        !!d &&
        typeof d === "object" &&
        // The server emits `name`; tolerate a legacy `label` just in case.
        (typeof (d as { name?: unknown }).name === "string" ||
          typeof (d as { label?: unknown }).label === "string") &&
        typeof (d as { check?: unknown }).check === "string"
    )
    .map((d: Record<string, unknown>) => {
      const rawInstall = d.install;
      const install =
        rawInstall && typeof rawInstall === "object"
          ? (rawInstall as Dependency["install"])
          : undefined;
      return {
        name: (d.name ?? d.label) as string,
        minVersion: typeof d.min_version === "string" ? d.min_version : undefined,
        check: d.check as string,
        install,
      };
    });

  const autoFetched = Array.isArray(res.auto_fetched)
    ? res.auto_fetched.filter((s: unknown): s is string => typeof s === "string")
    : [];

  return {
    challengeId: typeof res.challenge_id === "string" ? res.challenge_id : "",
    title: typeof res.title === "string" ? res.title : (res.challenge_id ?? ""),
    language: typeof res.language === "string" ? res.language : "unknown",
    dependencies,
    autoFetched,
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

/**
 * Mint a fresh repo-scoped installation token for an active session. Called
 * by the auto-refresh timer in extension.ts shortly before the previous
 * token expires; without this, a 90-minute session would see auto-commit
 * pushes fail mid-interview when the original token quietly expires after
 * ~1hr.
 */
export async function refreshGithubToken(
  serverUrl: string,
  sessionKey: string
): Promise<{ token: string; expiresAt: number }> {
  const base = serverUrl.replace(/\/+$/, "");
  const res = (await post(`${base}/api/v1/refresh-github-token`, "{}", sessionKey)) as {
    github_clone_token?: unknown;
    github_clone_token_expires_at?: unknown;
  };
  if (typeof res.github_clone_token !== "string" || !res.github_clone_token) {
    throw new Error("refresh-github-token: missing token in response");
  }
  if (typeof res.github_clone_token_expires_at !== "number") {
    throw new Error("refresh-github-token: missing expires_at in response");
  }
  return {
    token: res.github_clone_token,
    expiresAt: res.github_clone_token_expires_at * 1000,
  };
}

/**
 * Report that the challenge clone has finished and the candidate is in the
 * workspace — this is what actually starts the interview countdown. The server
 * anchors started_at on the first call and returns the same value on every
 * later call (window reopens), so the deadline never drifts. Returns the
 * server-authoritative start time in epoch ms.
 */
export async function reportSessionStarted(
  serverUrl: string,
  sessionKey: string
): Promise<number> {
  const base = serverUrl.replace(/\/+$/, "");
  const res = (await post(`${base}/api/v1/session-started`, "{}", sessionKey)) as {
    started_at?: unknown;
  };
  if (typeof res.started_at !== "number" || res.started_at <= 0) {
    throw new Error("session-started: missing started_at in response");
  }
  return res.started_at * 1000;
}

export interface VideoUploadInfo {
  deadline_unix: number;
  min_duration_seconds: number;
  max_duration_seconds: number;
}

export interface SubmitResponse {
  status?: string;
  message?: string;
  video_upload?: VideoUploadInfo;
}

export async function submitSession(config: SessionConfig): Promise<SubmitResponse> {
  return (await post(
    `${config.llmProxyUrl}/api/v1/submit`,
    "{}",
    config.sessionKey
  )) as SubmitResponse;
}

/**
 * Report an interview-integrity violation (the candidate deleted the
 * `.jivahire/` tamper marker). The server stamps `invalidated_at` /
 * `invalidation_reason` so the recruiter dashboard surfaces the tamper, but
 * keeps the session `active` — the candidate continues working. Best-effort:
 * the extension warns the candidate regardless of whether this call succeeds.
 */
export async function invalidateSession(
  config: SessionConfig,
  reason: string
): Promise<void> {
  await post(
    `${config.llmProxyUrl}/api/v1/invalidate`,
    JSON.stringify({ reason }),
    config.sessionKey
  );
}

export interface VideoInitResponse {
  upload_url: string;
  s3_key: string;
  deadline_unix: number;
  min_duration_seconds: number;
  max_duration_seconds: number;
  prompts: string[];
}

export async function videoInit(config: SessionConfig): Promise<VideoInitResponse> {
  return (await post(
    `${config.llmProxyUrl}/api/v1/video/init`,
    "{}",
    config.sessionKey
  )) as VideoInitResponse;
}

export async function videoComplete(
  config: SessionConfig,
  s3Key: string,
  durationSeconds: number
): Promise<void> {
  await post(
    `${config.llmProxyUrl}/api/v1/video/complete`,
    JSON.stringify({ s3_key: s3Key, duration_seconds: durationSeconds }),
    config.sessionKey
  );
}

export interface BrowserLinkResponse {
  url: string;
  expires_unix: number;
}

/** Mint a short-lived browser-recording URL the candidate can open in any
 *  browser (incl. on a phone) when VS Code's webview has no camera. */
export async function videoBrowserLink(
  config: SessionConfig
): Promise<BrowserLinkResponse> {
  return (await post(
    `${config.llmProxyUrl}/api/v1/video/browser-link`,
    "{}",
    config.sessionKey
  )) as BrowserLinkResponse;
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
            // FastAPI returns `{"detail": ...}` for HTTPExceptions. Extract a
            // human-readable message so the candidate sees "This panel
            // interview is scheduled for …" instead of the raw JSON body.
            // `detail` may be a string or an object with a `.message` field
            // (used by the scheduled-too-early gate, which also ships
            // `scheduled_at` for client-side local-time formatting).
            let message = data;
            try {
              const parsed = JSON.parse(data) as { detail?: unknown };
              const detail = parsed?.detail;
              if (typeof detail === "string") {
                message = detail;
              } else if (
                detail && typeof detail === "object" &&
                typeof (detail as { message?: unknown }).message === "string"
              ) {
                message = (detail as { message: string }).message;
              }
            } catch { /* not JSON — leave raw body in message */ }
            settle(new Error(`HTTP ${res.statusCode}: ${message}`));
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
