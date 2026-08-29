# librechat-mnemonic

Automatic, project-scoped long-term memory for [LibreChat](https://www.librechat.ai), backed by a local [mnemonic](https://github.com/danielmarbach/mnemonic) MCP server.

Chats inside a LibreChat project recall that project's memories and write new ones back to it. Chats outside a project use the global pool. It is on by default and can be turned off per chat, per user, or entirely.

Nothing is forked or patched. This runs as one container alongside LibreChat.

## What it does

- **Recalls before every turn.** Relevant memories are retrieved and injected as context before the model is called. This does not depend on the model deciding to call a tool.
- **Writes after every turn.** Durable facts are extracted from the exchange and stored, with duplicates detected and skipped.
- **Scopes by LibreChat project.** A chat in the "Home Network" project reads and writes memories stamped with that project. Memories live in one global vault, partitioned by project, so nothing is siloed unless you want it to be.
- **Stays out of the way.** `/memory off` in any chat, and that conversation stops recalling and storing.
- **Caches aggressively.** Note bodies, recall results, and memory settings are cached with configurable TTLs to keep latency low. Cache stats are exposed via `/healthz` and Langfuse span metadata.
- **Traces and monitors usage for every turn that calls a model.** When Langfuse credentials are set, every chat-completions/messages turn that reaches the upstream provider is traced — memory on or off, with or without a conversation id — with an `upstream` generation carrying model and token usage, plus spans for resolve-context, recall, and memory-write when memory is enabled. `/memory` commands are answered locally and never call a model, so they produce no trace.
- **Exposes tools too.** An MCP endpoint lets agents search, correct, and forget memories explicitly when the automatic path is not enough.

## How it works

```text
browser  →  LibreChat  →  librechat-mnemonic  →  your model provider
                 │               │
                 │               ├── stdio ──→  mnemonic  ──→  vault (markdown + git)
                 │               │
                 └──── mongo ────┘   (read-only: conversation → project)
```

LibreChat has no server-side plugin API, so the integration hangs off two supported extension points:

1. **Custom endpoints with header placeholders.** LibreChat resolves `{{LIBRECHAT_USER_ID}}` and `{{LIBRECHAT_BODY_CONVERSATIONID}}` into request headers. That is how the proxy knows who is asking and in which conversation.
2. **MCP servers over streamable HTTP**, for the explicit tool surface.

The project is not in the request. LibreChat's `ALLOWED_BODY_FIELDS` is `conversationId`, `parentMessageId`, `messageId` and nothing else, so the proxy resolves it itself: `conversations.chatProjectId` → `chatprojects.name`, read from the same MongoDB LibreChat already uses. Its own collections are never written to.

### Why a proxy and not just MCP tools

Because "automatic" and "the model decides" are different things.

LibreChat's own memory feature can be driven externally: with `memory.agent.enabled` unset, every run loads memories from the `MemoryEntry` collection and injects them with no tool call involved. But that lookup is keyed by user id alone. There is no conversation or project dimension in the schema, and the load happens inside LibreChat before anything external runs. So that channel gives automatic but user-global.

The only place that can see the project is the request path. Hence a proxy.

The MCP tools are still worth having, they just do a different job: correcting a memory the extractor got wrong, or searching for something the recall query missed.

## Requirements

- LibreChat v0.8.7 or later (projects landed in 0.8.7; header placeholders are older)
- Access to LibreChat's MongoDB
- An embedding provider for mnemonic: a local Ollama, or an OpenAI or Gemini key

## Quick start

Add the service to your LibreChat compose file. See [`docker-compose.example.yml`](./docker-compose.example.yml) for the annotated version.

```yaml
services:
  librechat-mnemonic:
    image: ghcr.io/claudedowling/librechat-mnemonic:latest
    restart: unless-stopped
    environment:
      LIBRECHAT_MONGO_URI: mongodb://mongo:27017/LibreChat
      UPSTREAMS: >-
        [{"name":"openai","baseUrl":"https://api.openai.com","api":"openai"}]
      OLLAMA_URL: http://ollama:11434
    volumes:
      - mnemonic-vault:/vault
      - mnemonic-projects:/projects
    networks: [librechat-network]
```

Then point LibreChat at it in `librechat.yaml`:

```yaml
endpoints:
  custom:
    - name: 'OpenAI'
      apiKey: '${OPENAI_API_KEY}'
      baseURL: 'http://librechat-mnemonic:8710/openai/v1'
      models:
        default: ['gpt-4o']
      headers:
        x-librechat-user-id: '{{LIBRECHAT_USER_ID}}'
        x-librechat-conversation-id: '{{LIBRECHAT_BODY_CONVERSATIONID}}'
```

Restart LibreChat. Send a message. Type `/memory status` to confirm it is wired up.

The full example, including Anthropic and the MCP server, is in [`examples/librechat.yaml`](./examples/librechat.yaml).

## In-chat commands

The proxy answers these itself. The model is never called and no tokens are spent.

| Command | Effect |
| --- | --- |
| `/memory` | List the commands |
| `/memory on` / `/memory off` | Enable or disable memory for this chat |
| `/memory status` | Show the current setting, its source, and the project |
| `/memory default on\|off` | Set your personal default for new chats |
| `/memory reset` | Drop this chat's override and follow your default |
| `/memory save <text>` | Store a memory now |
| `/memory search <query>` | Search memory without involving the model |
| `/memory forget <id>` | Delete a memory by id |

Precedence is per-chat, then per-user, then `MEMORY_DEFAULT_ENABLED`.

## How project scoping works

mnemonic derives project identity from a working directory. Its detection order is the git remote of the enclosing repo, then the git root folder name, then the plain basename of the directory. This uses the third branch: each LibreChat project gets a directory under `MNEMONIC_PROJECT_ROOT`, and its name becomes the mnemonic project.

A LibreChat project called `Home Network` becomes `/projects/Home Network`, which mnemonic resolves to `{ id: "home-network", name: "Home Network", source: "folder" }`.

Writes use `scope: global` with that directory as `cwd`. mnemonic stores the note in the main vault while stamping it with the detected project. The note's frontmatter carries `project: home-network` and `projectName: Home Network`. That is what "one global vault, partitioned by project" means in practice.

### What each recall scope actually returns

Verified against mnemonic 0.42, because the tool descriptions are misleading on this point:

| `MNEMONIC_RECALL_SCOPE` | A chat in project "Home Network" sees |
| --- | --- |
| `project` | Only notes stamped `home-network`. Hard isolation. |
| `all` (default) | Everything in the vault, with `home-network` notes boosted. |
| `global` | Everything in the main vault, unboosted. |

Note that `global` does **not** mean "notes with no project". mnemonic's tool description still says it returns only unscoped memories; the implementation returns every note in the main vault regardless of project stamp. If you need memories from one project kept out of another, use `project`.

Three more things to know:

- **The project directory must exist**, and must exist on the filesystem of whichever process runs mnemonic. mnemonic calls `simpleGit(cwd)` outside its error guard, so a missing path fails the whole call. In the default spawn mode this is handled for you. With `MNEMONIC_MODE=remote` it is your job.
- **`MNEMONIC_PROJECT_ROOT` must not be inside a git repository.** If it is, mnemonic will attribute every memory to that repo instead of to the project.
- **Project names collide.** Two LibreChat users with a project of the same name share one mnemonic project. This service is designed for single-user and small-trusted-team installs; see Limitations.

## Configuration

Everything is environment driven. Only `LIBRECHAT_MONGO_URI` and `UPSTREAMS` have no useful default.

### LibreChat

| Variable | Default | Description |
| --- | --- | --- |
| `LIBRECHAT_MONGO_URI` | _required_ | Connection string for LibreChat's MongoDB |
| `LIBRECHAT_MONGO_DB` | from the URI | Override the database name |
| `LIBRECHAT_USER_HEADER` | `x-librechat-user-id` | Header carrying `{{LIBRECHAT_USER_ID}}` |
| `LIBRECHAT_CONVERSATION_HEADER` | `x-librechat-conversation-id` | Header carrying `{{LIBRECHAT_BODY_CONVERSATIONID}}` |

### Upstreams

`UPSTREAMS` is a JSON array. Each entry mounts a provider at `/<name>/...`, and everything after the name is forwarded verbatim.

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Path segment, e.g. `openai` → `/openai/v1/chat/completions` |
| `baseUrl` | yes | Provider root, such that `<baseUrl>/v1/chat/completions` is valid |
| `api` | no | `openai` (default) or `anthropic` |
| `apiKey` | no | Static credential replacing whatever LibreChat sends |
| `forceIncludeUsage` | no | `true` (default). Forces `stream_options.include_usage: true` on OpenAI-format streaming requests so token usage is always reported. Set `false` for an upstream that rejects unknown request params. |

### mnemonic

| Variable | Default | Description |
| --- | --- | --- |
| `MNEMONIC_MODE` | `spawn` | `spawn` runs the bundled mnemonic over stdio; `remote` connects to a streamable-http instance |
| `MNEMONIC_COMMAND` | bundled | Executable used in spawn mode |
| `MNEMONIC_URL` | none | Required when `MNEMONIC_MODE=remote` |
| `MNEMONIC_HEADERS` | `{}` | JSON headers for the remote instance, e.g. auth |
| `MNEMONIC_VAULT_PATH` | `/vault` | Vault directory, passed through as `VAULT_PATH` |
| `MNEMONIC_PROJECT_ROOT` | `/projects` | Where per-project directories live |
| `MNEMONIC_WRITE_SCOPE` | `global` | `global` stores in the main vault stamped with the project; `project` writes a project vault |
| `MNEMONIC_RECALL_SCOPE` | `all` | `project` isolates, `all` boosts the current project, `global` returns the whole main vault. See the table above. |
| `MNEMONIC_RECALL_LIMIT` | `6` | Memories retrieved per turn |
| `MNEMONIC_MIN_SIMILARITY` | `0.3` | Similarity floor passed to recall |
| `MNEMONIC_TIMEOUT_MS` | `20000` | Per-call timeout |
| `MNEMONIC_TAG` | `librechat` | Tag added to everything this service writes |

mnemonic's own variables (`EMBED_PROVIDER`, `OLLAMA_URL`, `EMBED_MODEL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DISABLE_GIT`, …) are passed through to the spawned process. See [mnemonic's configuration](https://github.com/danielmarbach/mnemonic#configuration).

### Behaviour

| Variable | Default | Description |
| --- | --- | --- |
| `MEMORY_DEFAULT_ENABLED` | `true` | Whether memory is on for chats with no explicit setting |
| `MEMORY_RECALL_ENABLED` | `true` | Set false to write memories without injecting them |
| `MEMORY_WRITE_MODE` | `llm` | `llm` extracts automatically, `explicit` only on "remember that …", `off` disables writing |
| `MEMORY_MAX_CONTEXT_CHARS` | `4000` | Budget for the injected block |
| `MEMORY_QUERY_MESSAGE_COUNT` | `3` | User turns used to build the recall query |
| `MEMORY_MAX_PER_TURN` | `3` | Cap on memories written per exchange |
| `MEMORY_DEDUPE_THRESHOLD` | `0.82` | Recall score above which a candidate is treated as already known |
| `MEMORY_COMMAND_PREFIX` | `/memory` | Change if it clashes with something |
| `MEMORY_PROJECTLESS` | `global` | `off` disables memory entirely in chats not assigned to a project |

### Extraction model

Leave unset to reuse the chat's own model and credentials. Setting a small dedicated model is cheaper.

| Variable | Default | Description |
| --- | --- | --- |
| `EXTRACT_BASE_URL` | none | OpenAI-compatible base URL, including `/v1` |
| `EXTRACT_MODEL` | none | Model name |
| `EXTRACT_API_KEY` | none | Bearer token |
| `EXTRACT_TIMEOUT_MS` | `30000` | Extraction is detached; a timeout drops the write, never the reply |

### Caching

Three independent caches keep latency low. All TTLs are configurable so you can trade freshness for speed. Cache hit/miss stats are reported on the `/healthz` endpoint and in Langfuse span metadata.

| Variable | Default | Description |
| --- | --- | --- |
| `CACHE_NOTE_BODY_TTL_MS` | `300000` (5 min) | How long note bodies fetched via `get` are cached by ID. Eliminates the second mnemonic round-trip on repeated recalls. |
| `CACHE_RECALL_TTL_MS` | `120000` (2 min) | How long recall results are cached per (conversation, query). Retries and message edits hit the cache. Invalidated on save/forget/update. |
| `CACHE_SETTINGS_TTL_MS` | `30000` (30 s) | How long memory on/off settings are cached per (user, conversation). Eliminates most MongoDB round-trips. Invalidated immediately on `/memory on\|off`. |
| `CACHE_MAX_ENTRIES` | `5000` | Shared entry cap for all three caches. Oldest entry is evicted once a cache reaches this size, bounding memory use in a long-running process. |

### Telemetry

When Langfuse credentials are set, the proxy creates its own Langfuse tracer and traces **every** chat-completions/messages turn that calls a model, whether or not memory is enabled and whether or not LibreChat sent a conversation id (side calls such as title generation are traced too). `/memory` commands are handled locally and never reach the model, so they produce no trace. Traces use `sessionId = conversationId` when one is present, so they correlate with LibreChat's own Langfuse traces. The `upstream` observation is a **generation** carrying the model name and token usage (prompt/completion/total), extracted from the upstream response for both OpenAI and Anthropic wire formats, streaming or not. `resolve-context`, `recall`, and `memory-write` spans are only added when memory is enabled for that turn.

Telemetry uses the Langfuse v5 SDK (`@langfuse/tracing` + `@langfuse/otel`), the same OpenTelemetry-based stack LibreChat uses. A trace is an OTel span, so `chat-turn` and `mcp-tool` traces carry real start **and** end times and render identically to LibreChat's. The OTel tracer provider is isolated to Langfuse's own tracer — it is never registered globally, so nothing else in the process is instrumented.

Share the same `LANGFUSE_*` credentials with LibreChat's own config (e.g. via Docker Compose env vars from 1Password or your secret manager) so traces from both services appear under the same session.

| Variable | Default | Description |
| --- | --- | --- |
| `LANGFUSE_PUBLIC_KEY` | none | Langfuse public key. When set with the secret key, telemetry is enabled. |
| `LANGFUSE_SECRET_KEY` | none | Langfuse secret key. |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Langfuse API URL. Point at your self-hosted instance if needed. |

When either key is missing, telemetry is a no-op with zero overhead.

### Service

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8710` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | pino level |
| `MCP_ENABLED` | `true` | Serve the MCP endpoint |
| `MCP_PATH` | `/mcp` | Where to serve it |

## Monitoring

### `/healthz`

Returns JSON with service status, upstream names, telemetry status, and cache stats for all three caches:

```json
{
  "ok": true,
  "upstreams": ["openai", "anthropic"],
  "telemetry": "on",
  "cache": {
    "noteBody": { "hits": 42, "misses": 3, "size": 12, "hitRate": 0.93 },
    "recall": { "hits": 8, "misses": 15, "size": 5, "hitRate": 0.35 },
    "settings": { "hits": 120, "misses": 6, "size": 9, "hitRate": 0.95 }
  }
}
```

### Langfuse

When enabled, each chat turn that calls a model produces a trace with three spans and one generation:

| Observation | What it measures |
| --- | --- |
| `resolve-context` (span) | MongoDB project lookup + project directory resolution |
| `recall` (span) | Semantic search + note body hydration (includes cache hit/miss in metadata) |
| `upstream` (generation) | Model + token usage for the upstream call |
| `memory-write` (span) | Extraction + dedupe + write (detached, ends after the response is sent) |

The trace itself is the root `chat-turn` span, ended as soon as the response is sent. `memory-write` outlives it and is exported on its own end, so a detached write never holds the trace open.

Filter by `sessionId` in Langfuse to see all turns for a conversation.

## MCP tools

Available at `/mcp` for LibreChat agents.

| Tool | Purpose |
| --- | --- |
| `search_memory` | Semantic search, project-scoped |
| `save_memory` | Store a note deliberately |
| `update_memory` | Correct an existing note |
| `forget_memory` | Delete a note |
| `memory_status` | Report the setting and project for this chat |
| `set_memory_enabled` | Toggle automatic memory for this conversation |

The server ships `serverInstructions` telling the agent that recall is already automatic, so it should reach for these only when the automatic path falls short.

## Limitations

Worth knowing before you rely on it.

- **The first turn of a brand new chat may miss its project.** The conversation document may not be written when the first request arrives. The proxy retries once, and the post-turn write re-resolves the project, so writes are correct from turn one. The very first recall can fall back to global.
- **Only traffic routed through the proxy is augmented.** Endpoints configured to talk to a provider directly get no memory. That is deliberate: the proxy cannot see what it does not carry.
- **Project names are the identity.** Renaming a LibreChat project starts a new mnemonic project; the old memories stay under the old name. Directories under `MNEMONIC_PROJECT_ROOT` can be renamed to match, but nothing does it for you.
- **Multi-user installs share memory by project name.** There is no per-user partition in the vault. Fine for a personal or small-team instance, wrong for a multi-tenant one.
- **Automatic extraction is a judgement call made by a model.** It will sometimes store something you would not have, and miss something you would. `MEMORY_WRITE_MODE=explicit` trades recall for precision.
- **Tool-calling turns are passed through untouched.** Memory is injected on the request and extracted from the final text, so intermediate tool rounds are not analysed separately.
- **Cache TTLs trade freshness for latency.** If you change a memory via the MCP tools or another mnemonic client, the proxy may serve stale cached results for up to the TTL. The defaults are conservative; lower them if you need faster consistency.

## Images and releases

Published to the GitHub Container Registry:

```text
ghcr.io/claudedowling/librechat-mnemonic:latest    # newest release
ghcr.io/claudedowling/librechat-mnemonic:0.1       # newest 0.1.x
ghcr.io/claudedowling/librechat-mnemonic:0.1.0     # exact version
ghcr.io/claudedowling/librechat-mnemonic:main      # tip of main, unreleased
```

Built for `linux/amd64` and `linux/arm64`, with SBOM and signed build provenance. Verify a pull with:

```bash
gh attestation verify oci://ghcr.io/claudedowling/librechat-mnemonic:latest \
  --repo claudedowling/librechat-mnemonic
```

Pin to a minor tag such as `:0.1` in production. `latest` moves across breaking changes while the project is pre-1.0.

To cut a release, bump `version` in `package.json`, then tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## Development

```bash
npm install
npm test          # unit tests
npm run typecheck
npm run dev       # watch mode
```

Requires Node 22 or later.

The pieces worth understanding first: `src/memory/service.ts` holds the scoping rules that both entrypoints share, `src/proxy/handler.ts` is the request path, and `src/mnemonic/projects.ts` explains the directory trick and the constraints that come with it.

## Licence

MIT