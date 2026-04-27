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
  startedAt: number; // epoch ms, recorded client-side on validate
}

export async function validateSession(
  serverUrl: string,
  sessionKey: string
): Promise<SessionConfig> {
  const body = JSON.stringify({ session_key: sessionKey });
  const res = await post(`${serverUrl}/api/v1/validate-session`, body);
  return {
    sessionId: res.session_id,
    sessionKey,
    repoUrl: res.repo_url,
    branch: res.branch,
    githubToken: res.github_clone_token,
    llmProxyUrl: res.llm_proxy_url,
    maxMinutes: res.max_minutes,
    llmBudgetUsd: res.llm_budget_usd,
    challengeId: res.challenge_id,
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
        path: parsed.pathname,
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
