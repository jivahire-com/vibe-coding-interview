# Deploying Vibe Coding Interview to a New Server

This guide deploys the two runtime services — the **main server** (candidate API +
recruiter dashboard + LLM proxy) and the **grader** (the worker that compiles, runs
hidden tests, and scores submissions) — onto a fresh host with Docker.

Both services are defined in [docker-compose.yml](docker-compose.yml) and brought up
with a single `docker compose up`.

## Architecture (what you're deploying)

| Service | Container | What it does | Port |
|---|---|---|---|
| **backend** (main server) | `server/Dockerfile` | FastAPI/uvicorn. Serves the candidate API, recruiter dashboard, LLM proxy, and the `.vsix` extension download. | `8080` |
| **worker** (grader) | `worker/Dockerfile` | APScheduler loop. Polls the `jobs` table every 10s, clones the candidate branch, runs hidden tests, runs the 3-stage LLM grading, writes scores. Also auto-submits expired sessions. | — |

Both containers share one **SQLite database** on the `./data` volume — that is the only
state. There is no separate Postgres/Redis to provision.

```
candidate (VS Code ext) ──HTTPS──> [ reverse proxy ] ──> backend :8080 ──┐
                                                                          ├── ./data/vibe.db (shared)
recruiter (browser)     ──HTTPS──> [ reverse proxy ] ──> backend :8080 ──┤
                                                                          │
                                          worker (grader) ───────────────┘
```

### What is baked into the image vs. mounted

- **Baked in at build time** (changing these requires `--build`): `server/`, `challenges/`,
  the Python deps, and the extension `.vsix` (`COPY extension/*.vsix`).
- **Bind-mounted at runtime** (changing these does *not* need a rebuild):
  - `./data` → DB + logs (both containers, read-write)
  - `./extension` → mounted read-only into the backend so it can serve the `.vsix` download

## Prerequisites on the new server

- Docker Engine + the Docker Compose plugin (`docker compose version`)
- `git`
- Outbound network access to: OpenRouter (LLM), GitHub (challenge clones), and
  optionally SendGrid (invite email) and AWS S3/CloudFront (post-submit video)
- A public HTTPS URL for the host (candidates' extensions and invite emails point at it)

## Step 1 — Get the code

```bash
git clone https://github.com/jivahire-com/vibe-coding-interview.git
cd vibe-coding-interview
```

## Step 2 — Provide an extension `.vsix`

The `.vsix` is **gitignored**, so it will not be in a fresh clone, but the backend image
needs one at build time (`COPY extension/*.vsix`) and serves it as the candidate download.
Do one of the following:

- **Copy a prebuilt `.vsix`** into `extension/` from an existing deployment, or
- **Build it** on a machine with Node 20:
  ```bash
  cd extension
  npm ci
  npm run build      # esbuild bundle
  npm run package    # produces jivahire-vibe-coding-interview-<version>.vsix
  cd ..
  ```

> **Pointing the extension at this server.** The extension's baked-in default is
> `https://interview.jivahire.com` (`extension/src/extension.ts`, `DEFAULT_SERVER_URL`).
> Candidates can override it by entering the new server URL when they activate. If you
> want the new URL baked in as the default, edit `DEFAULT_SERVER_URL`, re-run
> `npm run build && npm run package`, and ship that `.vsix`.

## Step 3 — Configure secrets (`.env`)

```bash
cp .env.example .env
```

Edit `.env` and fill in (see [.env.example](.env.example) for the full annotated list):

- `OPENAI_API_KEY`, `LLM_BASE_URL`, `CHAT_MODEL` — OpenRouter / LLM config
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_CHALLENGES_OWNER` — GitHub App used to clone challenge repos
- `ADMIN_TOKEN` — **change from the default** before exposing the server
- `APP_PUBLIC_URL` — the public HTTPS URL of this server (used in invite emails)
- `SENDGRID_API_KEY` / `FROM_EMAIL` — leave blank to skip invite emails
- `S3_VIDEO_BUCKET` / `CLOUDFRONT_DOMAIN` — leave blank to disable post-submit video

The DB and challenge paths are already set for containers in `docker-compose.yml`
(`DB_PATH=/app/data/vibe.db`, `CHALLENGES_DIR=/app/challenges`) — leave those alone.

## Step 4 — Build and start

```bash
docker compose up --build -d
```

This builds both images and starts `backend` and `worker`. The SQLite schema is
bootstrapped automatically on first start (fresh `./data/vibe.db`). Both restart
`unless-stopped`.

The grader image installs `cmake`, `g++`, `make`, and Node 20 (needed to compile and run
candidate code) and runs under the custom `worker/seccomp.json` profile — this allows
`setarch -R` to disable ASLR for ThreadSanitizer. Keep that `security_opt` in place or
C++ TSan challenges will fail every test.

## Step 5 — Verify

```bash
docker compose ps                          # both services Up
curl -fI http://localhost:8080/            # backend serves the dashboard (static root)
curl -fI http://localhost:8080/jivahire-vibe-coding-interview.vsix   # extension download served
docker compose logs -f worker              # grader polling, no errors
```

## Step 6 — Put it behind HTTPS

The backend listens on plain HTTP `:8080`. Candidates' extensions and the recruiter
dashboard need HTTPS, so front it with a reverse proxy (nginx, Caddy, an ALB, etc.)
that terminates TLS for your public domain and proxies to `127.0.0.1:8080`. Set that
public `https://…` domain as `APP_PUBLIC_URL` in `.env`.

## Updating an existing deployment

```bash
git pull
# if you changed the extension, drop the new .vsix into extension/ (or rebuild it)
docker compose up --build -d
```

- Changing `server/` or `challenges/` code → needs `--build` (baked into the image).
- Replacing the `.vsix` or editing files under `./data` → takes effect without a rebuild
  (bind-mounted); restart the backend if it caches anything: `docker compose restart backend`.

## Backups

All persistent state is the SQLite DB and logs under `./data`. Back it up with the
container stopped (or via SQLite online backup) so you don't copy a half-written WAL:

```bash
docker compose stop
cp -a data/ /backup/vibe-data-$(date +%F)/
docker compose start
```
