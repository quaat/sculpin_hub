# Live end-to-end runbook — Hub ⇄ real Sculpin ⇄ OpenAI client / Open WebUI

How to run the Sculpin Hub (web + proxy + worker) against a **real** Sculpin
`agent-api` and drive it from a stock OpenAI client and Open WebUI. This is the
manual, human-in-the-loop counterpart to the deterministic suites — it uses live
OAuth and a live upstream, so it is **not** part of CI.

> **No secrets in this document.** Every credential below is a variable NAME with
> guidance on how to obtain it. Never paste real client secrets, API keys, or
> `PAT_HASH_SECRET` values into this file, into IaC, or into commits. Local values
> live only in your git-ignored `.env`; production values come from Azure Key
> Vault + managed identity (see `docs/DEPLOYMENT.md`).

---

## 0. Prerequisites

- Node `22.22.2` (`.nvmrc`) and pnpm `10.28.1` via Corepack.
- Docker (for the Hub's Postgres + Redis via `compose.yaml`).
- A running **Sculpin** `agent-api` you control (OpenAI-compat surface on
  `:8001`). Bring it up from its own repo per `docs/SCULPIN_INTEGRATION.md §9`
  (`make up`); the Hub repo never runs or modifies Sculpin.
- At least one **agent** published in that Sculpin tenant (its slug/UUID is what
  the Hub maps a public alias onto).
- Google and/or GitHub OAuth apps you own, with the redirect URIs below
  registered.

---

## 1. Start the Hub's datastores

```bash
docker compose up -d postgres redis   # compose.yaml: Postgres 127.0.0.1:5432, Redis 127.0.0.1:6379
```

Postgres comes up as db `sculpin_hub`, user `sculpin`. The default local password
is a non-secret dev placeholder; override with `POSTGRES_PASSWORD` if you like.

---

## 2. Configure the Hub environment (`.env`)

Copy the template and fill in values. `.env` is git-ignored; `.env.example`
carries names/docs only.

```bash
cp .env.example .env
```

Required for a live run (see `.env.example` for the full annotated list):

| Variable | What to set it to |
|----------|-------------------|
| `DATABASE_URL` | `postgresql://sculpin:<password>@localhost:5432/sculpin_hub` (matches step 1) |
| `HUB_PUBLIC_URL` | The public origin that serves the OpenAI `/v1/*` data plane — i.e. the **proxy**, e.g. `http://localhost:3001` locally. The Connect page derives the client base URL as `${HUB_PUBLIC_URL}/v1`. Distinct from `BETTER_AUTH_URL` (the web app, `:3002`). |
| `PORT` / `PROXY_PORT` | Web `3002`, proxy `3001` (defaults). |
| `SCULPIN_UPSTREAM_URL` | Internal Sculpin base URL the **proxy** dials, e.g. `http://localhost:8001`. NEVER exposed to clients. |
| `SCULPIN_UPSTREAM_API_KEY` | The Hub's single upstream credential (Sculpin's `OPENAI_COMPAT_DEV_API_KEY` in dev, or a real `sk-exodus-…` DB key in prod). Used ONLY by the proxy; never sent to browsers/logs. |
| `SCULPIN_DISCOVERY_API_KEY` | Least-privilege Sculpin key used ONLY by admin-side catalogue discovery in the web app. Keep distinct from the proxy's request-serving key. |
| `PAT_HASH_SECRET` | A high-entropy random string (≥32 bytes). Generate locally, e.g. `openssl rand -base64 48`. Lives OUTSIDE the DB; a DB leak must not yield usable PATs. |
| `PAT_HASH_KEY_VERSION` | `1` for a fresh setup. |
| `BETTER_AUTH_SECRET` | Random ≥32-byte string (`openssl rand -base64 48`). |
| `BETTER_AUTH_URL` | Same origin as the web app, e.g. `http://localhost:3002`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From your Google OAuth app (optional if using GitHub only). |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | From your GitHub OAuth app (optional if using Google only). |
| `BOOTSTRAP_ADMIN_EMAILS` | Comma-separated list of **verified** provider emails that should receive the platform `admin` role on first sign-in. |

Leave `E2E_TEST_AUTH` and `E2E_SESSION_SEED_KEY` **empty** — those enable the
test-only session seam and MUST NOT be set for a live run (the seam refuses to
load and startup fails under `NODE_ENV=production`).

### OAuth redirect URIs to register

Point each provider callback at the web app's Better Auth handler:

- Google: `${BETTER_AUTH_URL}/api/auth/callback/google`
- GitHub: `${BETTER_AUTH_URL}/api/auth/callback/github`

Cross-provider account linking is **off** by design (D-012): the same email on a
second provider yields a separate isolated account.

Validate the environment before starting:

```bash
pnpm env:smoke   # fails fast with a clear message on missing/invalid vars
```

---

## 3. Apply database migrations

```bash
pnpm db:migrate:deploy   # prisma migrate deploy against DATABASE_URL
```

`packages/db` is the single migration authority. On a fresh DB this creates
users/identities/orgs, catalogue, plans/subscriptions, PATs, usage events, and
the transactional outbox.

---

## 4. Start web + proxy + worker

Run each in its own terminal (each reads the repo-root `.env`):

```bash
# terminal 1 — control plane (Next.js) on :3002
cd apps/web   && pnpm dev

# terminal 2 — data plane (Fastify proxy) on :3001
cd apps/proxy && pnpm dev

# terminal 3 — outbox/worker
cd apps/worker && pnpm dev
```

> Engine-mismatch note: if pnpm refuses with `ERR_PNPM_UNSUPPORTED_ENGINE`, run
> under the pinned Node (`nvm use`) or invoke the app's dev entrypoint directly
> (see each `apps/*/package.json` `dev` script).

Sanity checks:

- Web: open `http://localhost:3002` — the marketing/products pages render.
- Proxy fail-closed: an unregistered route must be denied, not forwarded:
  ```bash
  curl -s http://localhost:3001/v1/embeddings -H "Authorization: Bearer whatever" | head
  # → OpenAI-shaped error (unsupported/404), NEVER a pass-through
  ```

---

## 5. Sign in and become admin

1. Go to `http://localhost:3002` and sign in with Google or GitHub.
2. First sign-in atomically provisions your personal org/tenant (D-011).
3. If your verified email is in `BOOTSTRAP_ADMIN_EMAILS`, you get the platform
   `admin` role (recorded in `AuditEvent`); admin surfaces are server-gated.

---

## 6. Publish a catalogue entry (admin)

1. As admin, open the admin catalogue UI.
2. Run **Sculpin discovery** — the web app uses `SCULPIN_DISCOVERY_API_KEY` to
   list the upstream agents (their slug/UUID). The internal agent id stays
   server-side; only the public alias you choose is ever shown to clients.
3. Create a catalogue entry mapping a **public alias** (e.g. `assistant-v1`) to a
   discovered Sculpin agent, then **publish** it.

A published alias must resolve to a specific upstream agent; if that agent
disappears upstream, the Hub fails closed rather than silently substituting
another.

---

## 7. Create a plan and claim it (user)

1. As admin, create/publish a self-service-eligible plan with a request quota and
   attach the published catalogue entry.
2. As a normal user, go to `/account`, **Claim** the plan, and confirm the
   entitlement shows **Active**.

---

## 8. Mint a PAT

1. Go to `/account/tokens`, name a token (e.g. `live-cli`), and **Mint**.
2. Copy the revealed `sclp_pat_<public-id>_<secret>` **once** — it is never
   re-fetchable and only the public id/metadata remain afterward.

```bash
export SCULPIN_HUB_PAT='sclp_pat_…'   # paste the one-time value
```

---

## 9. Drive it from a stock OpenAI client

The `/connect/<alias>` page shows copy-paste snippets. The client base URL is
`${HUB_PUBLIC_URL}/v1` — **never** the internal Sculpin URL.

curl:

```bash
curl "$HUB_PUBLIC_URL/v1/chat/completions" \
  -H "Authorization: Bearer $SCULPIN_HUB_PAT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<your-public-alias>",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

Streaming — add `"stream": true` and confirm SSE framing (`data: <json>\n\n`,
`: keep-alive\n\n`, terminal `data: [DONE]`). The `model` field in responses is
the **public alias**, not the internal Sculpin id.

Python (OpenAI SDK):

```python
from openai import OpenAI
client = OpenAI(base_url="<HUB_PUBLIC_URL>/v1", api_key="<your PAT>")
resp = client.chat.completions.create(
    model="<your-public-alias>",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

### What to verify at the boundary

- The response never exposes `SCULPIN_UPSTREAM_URL`, the upstream key, or an
  internal agent id/UUID.
- Your PAT, cookies, and `Authorization` are **not** forwarded upstream; the
  proxy injects the Hub's upstream credential instead.
- Usage is metered (quota decrements atomically); a `usage_events` row is written
  with no prompt/response/PAT/upstream-key content.
- Once quota is exhausted, further requests are denied.

---

## 10. Point Open WebUI at the Hub

1. In Open WebUI: **Settings → Connections → OpenAI API**.
2. **API Base URL** = `${HUB_PUBLIC_URL}/v1`.
3. **API Key** = your `sclp_pat_…`.
4. Save, then pick your **public alias** from the model list and chat.

---

## 11. Revoke and confirm

1. On `/account/tokens`, **Revoke** the PAT — the UI reflects it immediately.
2. Re-run the curl from step 9; the request must now be rejected (revocation is
   effective at once; verification is constant-time).

---

## 12. Teardown

```bash
# stop web/proxy/worker (Ctrl-C in each terminal)
docker compose down            # keep volumes
# docker compose down -v       # also drop Postgres/Redis data
```

---

## Security invariants to keep in view during a live run

- Browser never calls Sculpin directly; all `/v1` traffic goes through the proxy.
- No Sculpin credential (upstream key, discovery key) reaches browser bundles,
  logs, usage events, error pages, or API responses.
- Default-DENY `/v1/*`: only `GET /v1/models` and `POST /v1/chat/completions` are
  registered; everything else is a fail-closed OpenAI-shaped error.
- Callers may never supply an arbitrary raw upstream conversation id; hop-by-hop
  headers are stripped.
