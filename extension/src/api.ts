import * as https from "https";
import * as http from "http";

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
}

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

  // Bug fix (SSRF): the validate-session server is trusted to authenticate the
  // candidate; we cannot let it redirect subsequent chat / telemetry / submit
  // traffic — which carries the bearer session key — to an arbitrary host.
  // Default the proxy URL to `serverUrl` when the server omits it, and reject
  // anything pointing at a different hostname.
  const rawProxyUrl: string = res.llm_proxy_url ?? base;
  if (!isAllowedProxyHost(base, rawProxyUrl)) {
    let proxyHost = "<unparseable>";
    try { proxyHost = new URL(rawProxyUrl).hostname; } catch { /* keep default */ }
    throw new Error(
      `Server returned llm_proxy_url on a different host (${proxyHost}) than the auth server. ` +
      `Refusing to send the session bearer token to an unverified endpoint.`,
    );
  }

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
  };
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
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            try { resolve(JSON.parse(data)); } catch { resolve({}); }
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
