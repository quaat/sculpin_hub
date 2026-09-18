# Sculpin Integration Surface (for the Hub proxy)

Milestone-0 discovery. This documents the **OpenAI-API-v1-compatible HTTP
surface** that Sculpin Hub will reverse-proxy to. **Source-reading only** — no
Sculpin service was run.

**Upstream repo:** `/home/thomas/project/semanticmatter/sculpin`
**Git remote:** `git@github.com:SemanticMatter/sculpin.git` (origin)
**Current branch:** `pydantic_ai_harness_adoption`

The OpenAI-compatible surface is served by the **`agent-api`** FastAPI service
(`apps/agent-api`). It listens on **port 8001**. Each Sculpin **agent** is
exposed as an OpenAI "model" (by slug and by UUID). There is **no**
`/v1/completions` and **no** `/v1/embeddings` on this surface — only chat
completions, model listing, and API-key management.

---

## Route Inventory (the OpenAI-compat `/v1` surface — what the Hub must allow)

The Hub should allow **only** the `/v1/*` routes below and DENY everything else.
All routes require `Authorization: Bearer <key>` (see Authentication).

| Method | Path | Streaming? | Purpose | Source file:line |
|--------|------|-----------|---------|------------------|
| GET | `/v1/models` | No | List agents as OpenAI "models" (slug + UUID) | `apps/agent-api/app/api/openai_compat.py:277` |
| POST | `/v1/chat/completions` | Optional (SSE when `stream:true`) | Run an agent as a chat completion | `apps/agent-api/app/api/openai_compat.py:301` |
| GET | `/v1/api-keys` | No | List the tenant's API keys (mgmt, non-OpenAI-standard) | `apps/agent-api/app/api/openai_compat.py:814` |
| POST | `/v1/api-keys` | No | Issue a new API key (returns plaintext once) | `apps/agent-api/app/api/openai_compat.py:836` |
| DELETE | `/v1/api-keys/{key_id}` | No | Revoke an API key | `apps/agent-api/app/api/openai_compat.py:858` |

Router prefix `/v1` is declared at `apps/agent-api/app/api/openai_compat.py:97`
and mounted at `apps/agent-api/app/main.py:124`.

> The Hub's OpenAI passthrough almost certainly needs only `GET /v1/models` and
> `POST /v1/chat/completions`. The `/v1/api-keys` routes are Sculpin's own
> key-management endpoints; the Hub likely should NOT expose them to end callers
> (it manages its own credential to the upstream). Decide per Hub policy.

### Adjacent (NON-`/v1`) surface — for context, NOT for the OpenAI proxy

The same service also mounts a large native management API under **`/api/v1`**
(`apps/agent-api/app/api/v1/__init__.py:20`) — agents CRUD, model-connections,
runs, conversations, skills, structured-outputs, diagrams, a2a, mcp catalog,
plus `/health` and `/ready`. These are the console/back-office API, **not** the
OpenAI-compatible surface, and the Hub's OpenAI proxy should not expose them.
Note the two-namespace split: OpenAI-compat lives at `/v1/...`; native API lives
at `/api/v1/...`. `/api/v1/models` (`models_catalog.py:38`) is a *different*
endpoint from the OpenAI `/v1/models` — do not confuse them.

---

## 1. The v1 API routes (detail)

### `GET /v1/models`
- Auth required (`api_key_context_dep`). Lists all non-deleted agents for the
  caller's tenant. Each agent is emitted **twice**: once keyed by `slug`, once
  by `id` (UUID). `owned_by` is the literal string `"exodus"`.
- Response (`ModelList`, `apps/agent-api/app/schemas/openai.py:39-48`):
  ```json
  { "object": "list",
    "data": [ { "id": "support", "object": "model", "created": 1720000000, "owned_by": "exodus" } ] }
  ```
- Source: `openai_compat.py:277-295`.

### `POST /v1/chat/completions`
- Auth required. Not streaming by default; streams SSE when `stream: true`.
- Request body `ChatCompletionRequest` (`schemas/openai.py:20-33`), `extra="ignore"`:
  - `model` (str, **required**) — an agent slug OR UUID. Resolved via
    `_resolve_agent` (`openai_compat.py:400-420`); unknown model → **404**
    `model_not_found` in OpenAI error shape.
  - `messages` (list, **required**, min 1). Each `ChatMessage`
    (`schemas/openai.py:13-17`): `role` in
    `system|user|assistant|tool|function`; `content` is `str` OR OpenAI
    multi-part `list[dict]` OR null; `name`, `tool_call_id` optional.
    `tool`/`function` role messages are dropped (`openai_compat.py:492`). Multi-part
    content (`text`, `image_url`, `input_file`/`file`, `input_audio`) is parsed at
    `_to_llm_messages` (`openai_compat.py:423-507`); unknown part types dropped.
  - Sampling fields (`temperature`, `top_p`, `n`, `stop`, `max_tokens`,
    `presence_penalty`, `frequency_penalty`) are **accepted but ignored**.
  - `stream` (bool, default false).
  - `user` (str, optional) — persisted into conversation settings (PII; hashed
    in logs). Sticky-reuse keyed on it is a documented stub, currently inert.
  - A request with no `user`-role message → **400** `invalid_messages`
    (`openai_compat.py:311-314`).
- Non-streaming response `ChatCompletionResponse` (`schemas/openai.py:68-76`):
  ```json
  { "id": "chatcmpl-<run_id>", "object": "chat.completion", "created": 1720000000,
    "model": "support",
    "choices": [ { "index": 0, "message": {"role":"assistant","content":"..."}, "finish_reason": "stop" } ],
    "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 } }
  ```
  `finish_reason` is always `"stop"`. `usage` is a heuristic (`len/4`), not real
  token counts. Serialized via `JSONResponse` so headers ride along
  (`openai_compat.py:391-394`).
- Optional non-standard top-level `exodus` metadata object is included **only**
  when the request sends header `X-Agent-Platform-Include-Metadata: true`
  (`openai_compat.py:304,372`). Hidden by default.
- Source: `openai_compat.py:301-394`; streaming generator `602-779`.

### `/v1/api-keys` (GET/POST/DELETE)
- Sculpin's own key management. `POST` returns `plaintext_key` once
  (`sk-exodus-<token>`). Models at `openai_compat.py:795-811`; handlers
  `814-867`.

---

## 2. Authentication expected by Sculpin

- **Header:** `Authorization: Bearer <key>` (the only accepted scheme). A bare
  `sk-...` value with no `Bearer` prefix is also accepted as a fallback
  (`_extract_bearer`, `services/api_keys.py:93-100`).
- **Enforcement:** auth **is** enforced on every `/v1` route via
  `api_key_context_dep` (`services/api_keys.py:103-142`). Missing/invalid/expired
  → **401** with `WWW-Authenticate: Bearer` and an OpenAI-shaped error body.
- **Resolution order** (`services/api_keys.py:114-142`):
  1. If env var `OPENAI_COMPAT_DEV_API_KEY` is set and the bearer matches it
     exactly (constant-time compare), the request is accepted as the default
     tenant/user. **Dev-only** — intended to be unset in production.
  2. Otherwise the bearer is SHA-256 hashed and looked up in the `api_keys`
     table (tenant-scoped, checks `revoked_at`/`expires_at`).
- **Env var holding the accepted key:** `OPENAI_COMPAT_DEV_API_KEY`
  (`apps/agent-api/app/settings.py:50`, read via `os.getenv` at
  `services/api_keys.py:118`). **Note:** `OPENAI_API_KEY` / `OPENAI_BASE_URL` in
  Sculpin's env are the credentials Sculpin uses to call its *own upstream LLM
  gateway* (outbound) — they are NOT the inbound auth the Hub must satisfy.
- **Hub implication:** the Hub terminates the caller's token and must inject its
  own valid Sculpin credential — either the value of `OPENAI_COMPAT_DEV_API_KEY`
  (dev) or a real DB-issued `sk-exodus-...` key (prod) — as
  `Authorization: Bearer <hub-upstream-key>`.

---

## 3. Base URL / host / port

- The `agent-api` service runs `uvicorn app.main:app --host 0.0.0.0 --port 8001`
  (`docker-compose.yml:165-167`) and publishes host port `8001:8001`
  (`docker-compose.yml:163-164`).
- On the compose network the service name is `agent-api`, so the internal proxy
  target is **`http://agent-api:8001`**; from the host it is
  **`http://localhost:8001`**.
- OpenAI base URL to point clients/Hub at: **`http://<host>:8001/v1`** (README
  cites `http://localhost:8001/v1/models`, `README.md:52-53`).

---

## 4. Model / agent identity

- The OpenAI `model` field maps to a Sculpin **agent**, matched by either the
  agent **slug** OR the agent **UUID** (`_resolve_agent`,
  `openai_compat.py:400-406`, `WHERE id == model OR slug == model`).
- Discovery: `GET /v1/models` lists every non-deleted agent for the tenant,
  each under both its slug and its UUID (`openai_compat.py:290-294`).
- Mapping the Hub needs: **public model alias → Sculpin agent slug (or UUID)**.
  Slugs are human-friendly but rename-able; UUIDs are stable. Because listing is
  tenant-scoped, the set of visible models depends on which credential/tenant the
  Hub authenticates as.

---

## 5. Streaming semantics (SSE) — must pass through byte-for-byte

- Enabled by `stream: true`. Response is `StreamingResponse` with
  `media_type="text/event-stream"` (`openai_compat.py:362-366`).
- Framing: each event is `data: <json>\n\n`
  (`openai_compat.py:668`); keepalive heartbeats are SSE comment frames
  `: keep-alive\n\n` (`_SSE_KEEPALIVE_BYTES`, `openai_compat.py:599`); terminal
  sentinel is `data: [DONE]\n\n` (`openai_compat.py:770`).
- Order (`openai_compat.py:703-770`, and `docs/openai-compatibility.md:131-161`):
  1. initial chunk with `delta.role = "assistant"`;
  2. zero+ tool-progress chunks (`delta.content` with emoji-prefixed markdown);
  3. zero+ keepalive comment frames while a tool polls;
  4. a `\n---\n` separator (only if progress fired) then final answer content
     chunks (sliced ~24 chars, `_chunk_text`, `openai_compat.py:590-593`);
  5. a final chunk with `finish_reason: "stop"`;
  6. `data: [DONE]`.
- Chunk shape is `ChatCompletionChunk` (`object:"chat.completion.chunk"`,
  `schemas/openai.py:93-98`). This is **per-tool-call progress streaming, not
  per-token**. Keepalive cadence set by
  `OPENAI_COMPAT_STREAM_KEEPALIVE_SECONDS` (default 15s).
- Client disconnect cancels the underlying run task (`openai_compat.py:771-779`).
  The Hub must NOT buffer the stream; forward bytes as they arrive and propagate
  client disconnects.

---

## 6. Headers

**Request headers Sculpin reads:**
- `Authorization: Bearer <key>` — required (see §2).
- `X-Agent-Platform-Include-Metadata: true|1|yes` — opt into the `exodus`
  metadata block on non-streaming responses (`openai_compat.py:304,372`).
- `X-Exodus-Conversation-Id: <uuid>` — optional; pins/continues a conversation
  workspace (`openai_compat.py:305`). Unknown/cross-agent/cross-tenant pins fall
  through to a fresh conversation rather than erroring.

**Response headers Sculpin emits on every successful chat completion**
(streaming and non-streaming) (`openai_compat.py:56-71,335-339`):
- `X-Exodus-Conversation-Id: <uuid>`
- `X-Exodus-Conversation-Reused: true|false`
- `X-Exodus-Conversation-Source: created|pinned_header`

**Hub guidance:** pass the three `X-Exodus-Conversation-*` request/response
headers through so multi-turn workspace continuity works. Strip standard
hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`,
`Trailer`, `Upgrade`, `Proxy-Authorization`, `Proxy-Authenticate`) per RFC 7230.
Replace the caller `Authorization` with the Hub's upstream credential. No custom
request-id or org header is required by Sculpin. CORS is configured on the
service (`main.py:99-106`) keyed to `APP_PUBLIC_URL`.

---

## 7. Config / env surface (names + purpose; values redacted)

From `apps/agent-api/app/settings.py` and `.env.example` (relevant to the API
server + auth only):
- `OPENAI_COMPAT_DEV_API_KEY` — dev bearer accepted by `/v1` (unset in prod).
  `settings.py:50`; `.env.example:214`.
- `OPENAI_COMPAT_STREAM_KEEPALIVE_SECONDS` — SSE keepalive cadence (default
  15.0). `settings.py:173`.
- `OPENAI_COMPAT_STICKY_CONVERSATIONS`,
  `OPENAI_COMPAT_STICKY_CONVERSATION_TTL_SECONDS` — forward-declared, currently
  inert. `settings.py:162-163`.
- `AGENT_DATABASE_URL` / `DATABASE_URL` — Postgres for agent-api
  (`docker-compose.yml:150`; `.env.example:16`).
- `SCULPIN_DEV_MODE` — dev escape hatch that disables the boot-time weak-secret
  check (`settings.py:28-31,294-324`; `.env.example:398`).
- `AUTH_MODE`, `APP_PUBLIC_URL`, `SESSION_SECRET` — console/OIDC auth + CORS for
  the *native* `/api/v1` surface (`settings.py:252-283`). Not part of `/v1` bearer
  auth.
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_LLM_MODEL`,
  `OPENAI_EMBEDDING_MODEL` — Sculpin's **outbound** LLM-gateway credentials
  (`.env.example:87-93`; `main.py:60`). NOT inbound auth. Do not copy values.

> `.env` (not `.env.example`) contains live secrets; it was NOT opened/quoted.

---

## 8. Tests that exercise the API (best source-of-truth for payloads)

- `apps/agent-api/tests/test_openai_compat.py` — canonical. Highlights:
  - `GET /v1/models` lists agents by slug + UUID; requires auth; rejects bad key
    (`:26-49`).
  - Non-streaming `POST /v1/chat/completions` request/response shape (`:52-80`):
    ```json
    { "model": "help",
      "messages": [{"role":"user","content":"What does the policy say?"}],
      "stream": false }
    ```
    → asserts `object=="chat.completion"`, `id` starts `chatcmpl-`,
    `choices[0].message.role=="assistant"`, `exodus` is null by default.
  - Metadata opt-in via `X-Agent-Platform-Include-Metadata` (`:83-105`).
  - Streaming: first `data:` chunk carries `delta.role=="assistant"`, last line
    is exactly `data: [DONE]`, middle chunks carry `delta.content` (`:108-134`).
  - `default_format=turtle` returned as `message.content` (`:137+`).
- `apps/agent-api/tests/test_multimodal_runs.py:101,139` — multi-part
  `image_url` content through `/v1/chat/completions`.
- `apps/agent-api/tests/test_model_connections_full.py:176` — the *native*
  `/api/v1/models` aggregation (different endpoint; for context).

---

## 9. Runnability (from docs/compose/Makefile — do NOT run in this task)

- Full stack: `make up` (== `docker compose up --build`) — `Makefile:18-19`,
  `README.md:63,254`. Brings up postgres, knowledge-api, agent-api (8001),
  mcp-collection, worker, web. `docker-compose.override.yml` auto-loads for dev
  bind-mounts.
- agent-api container runs `alembic upgrade head` then uvicorn on 8001
  (`docker-compose.yml:165-167`); healthcheck hits `/api/v1/ready`
  (`docker-compose.yml:168-172`).
- After `make up`, hit the OpenAI surface at `http://localhost:8001/v1/models`
  and `http://localhost:8001/v1/chat/completions` with
  `Authorization: Bearer <OPENAI_COMPAT_DEV_API_KEY>`. Interactive docs at
  `http://localhost:8001/docs` (`README.md:52-53`).
- `make migrate` runs alembic for both APIs (`Makefile:72-73`).

---

## Open Questions / Ambiguities

1. **No embeddings / legacy completions endpoint.** Only `/v1/models`,
   `/v1/chat/completions`, and `/v1/api-keys` exist. If the Hub must offer
   `/v1/embeddings` or `/v1/completions`, there is no upstream to proxy to —
   confirm whether the Hub should 404/deny these or synthesize them elsewhere.
2. **Tenant scoping of the upstream credential.** `/v1/models` and agent
   resolution are tenant-scoped to whatever credential the Hub authenticates as.
   It is unclear how the Hub maps its many end-user tenants onto Sculpin
   tenants/keys — single shared upstream key (one Sculpin tenant for all Hub
   users) vs. per-Hub-tenant Sculpin keys. This affects which agents/models are
   visible and needs a decision.
3. **Conversation-continuity header contract.** Multi-turn workspace continuity
   depends on the client echoing `X-Exodus-Conversation-Id`. Should the Hub pass
   these headers through transparently, rewrite/namespace them, or manage
   continuity itself? Also confirm the Hub should preserve the non-standard
   `exodus` metadata block / `X-Agent-Platform-Include-Metadata` opt-in.

Additional smaller unknowns: real token-usage plumbing is absent (usage is a
heuristic — billing must not rely on it); `finish_reason` is always `stop`;
client-supplied `tools`/`tool_choice`/`response_format` are ignored by upstream.
