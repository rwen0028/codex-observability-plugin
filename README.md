# Langfuse Tracing Plugin for OpenAI Codex

A [Codex](https://developers.openai.com/codex) plugin that traces agent turns, model calls, tool executions, token usage, and subagent threads to [Langfuse](https://langfuse.com).

Once enabled, every Codex turn shows up in Langfuse as a trace you can inspect, debug, evaluate, and monitor for cost — turning Codex from a black box into an observable agent.

## What gets traced

After each Codex turn, the Stop hook durably queues the rollout path and returns; a detached,
per-rollout worker incrementally uploads new transcript bytes to Langfuse as a
[trace](https://langfuse.com/docs/observability/data-model). The structure mirrors how Codex actually works:

- **Turn** (`Codex Turn`, an [agent observation](https://langfuse.com/docs/observability/features/observation-types)) — one trace per turn, from your prompt to the final answer.
- **Generations** — one per model response within the turn, named `LLM` (or `LLM Subagent` inside subagent threads), with the model recorded on the observation plus reasoning, assistant text, the tool calls it requested, and token usage.
- **Tool calls** — shell commands, `apply_patch`, `spawn_agent`, MCP tools, web searches, etc., each with its input, output, and error status. MCP calls are named `server.tool`, and failed commands are flagged as errors.
- **Subagents** — subagent threads are resolved from their own rollout files and nested under the spawning turn as `Codex Subagent Turn`.
- **Sessions** — turns are grouped by Codex thread id by default; a validated CloseClaw support context can instead supply a stable business session id.

Interrupted turns (where you cancel mid-response) are still uploaded and flagged as interrupted.

## Prerequisites

- Node.js >= 22
- Codex >= 0.128
- A [Langfuse Cloud](https://cloud.langfuse.com) account (or a [self-hosted](https://langfuse.com/self-hosting) instance) and API keys

## Installation

### 1. Add the plugin marketplace

```bash
codex plugin marketplace add langfuse/codex-observability-plugin
```

### 2. Enable the plugin

Enable plugin hooks and the tracing plugin globally in `~/.codex/config.toml`, or only for a specific project in `<project>/.codex/config.toml`:

```toml
[features]
plugin_hooks = true

[plugins."tracing@codex-observability-plugin"]
enabled = true
```

### 3. Set your Langfuse credentials

Tracing stays off until `TRACE_TO_LANGFUSE` is `true`, so you opt in explicitly.

**Option 1: Shell environment (recommended)**

Add to your `~/.zshrc`, `~/.bashrc`, or `~/.bash_profile`:

```bash
export TRACE_TO_LANGFUSE="true"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com" # 🇪🇺 EU (default)
```

**Option 2: JSON config file**

Create `~/.codex/langfuse.json` (global) or `<project>/.codex/langfuse.json` (per-project):

```json
{
  "enabled": true,
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "base_url": "https://cloud.langfuse.com",
  "pricing_mode": "standard",
  "regional_processing": false
}
```

Config is resolved as **defaults → `~/.codex/langfuse.json` → `<project>/.codex/langfuse.json` → environment variables** (environment wins). `LANGFUSE_CODEX_*` variables take precedence over the matching standard `LANGFUSE_*` variables, so you can scope credentials to Codex without disturbing other Langfuse tooling.

### 4. Get your Langfuse API keys

1. Go to [cloud.langfuse.com](https://cloud.langfuse.com) (or your self-hosted instance).
2. Create a project (or open an existing one).
3. Go to **Settings → API Keys → Create new API keys**.
4. Copy the **public** key (`pk-lf-...`) and **secret** key (`sk-lf-...`).

Run a Codex turn, then open your Langfuse project to see the trace.

## Environment variables

| Variable                                                      | Required | Default                               | Description                                                                     |
| ------------------------------------------------------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `TRACE_TO_LANGFUSE`                                           | Yes      | `false`                               | Set to `"true"` to enable tracing                                               |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_CODEX_PUBLIC_KEY`           | Yes      | —                                     | Langfuse public key (`pk-lf-...`)                                               |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_CODEX_SECRET_KEY`           | Yes      | —                                     | Langfuse secret key (`sk-lf-...`)                                               |
| `LANGFUSE_BASE_URL` / `LANGFUSE_CODEX_BASE_URL`               | No       | `https://cloud.langfuse.com`          | Langfuse host / data region                                                     |
| `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_CODEX_ENVIRONMENT` | No       | —                                     | Environment label for the traces (e.g. `production`)                            |
| `LANGFUSE_CODEX_USER_ID`                                      | No       | Codex auth email, if found            | Attach a user id to all traces                                                  |
| `LANGFUSE_CODEX_TAGS`                                         | No       | —                                     | Tags for all traces (JSON array or comma-separated)                             |
| `LANGFUSE_CODEX_METADATA`                                     | No       | —                                     | JSON object of metadata to attach to all traces                                 |
| `LANGFUSE_CODEX_TRACE_SEED`                                   | No       | —                                     | Derive deterministic trace ids ([details](#deterministic-trace-ids))            |
| `LANGFUSE_CODEX_SUPPORT_CONTEXT_DIR`                          | No       | `$CODEX_HOME/cctrace/support-context` | Per-thread/turn CloseClaw context root ([details](#closeclaw-per-turn-context)) |
| `LANGFUSE_CODEX_PRICING_MODE`                                 | No       | `standard`                            | OpenAI service mode: `standard`, `batch`, `flex`, or `priority`                 |
| `LANGFUSE_CODEX_REGIONAL_PROCESSING`                          | No       | `false`                               | Add OpenAI's 10% regional-processing surcharge                                  |
| `LANGFUSE_CODEX_MAX_CHARS`                                    | No       | `20000`                               | Truncate inputs/outputs longer than this many characters                        |
| `LANGFUSE_CODEX_DEBUG`                                        | No       | `false`                               | Set to `"true"` for verbose logging to stderr                                   |
| `LANGFUSE_CODEX_FAIL_ON_ERROR`                                | No       | `false`                               | Set to `"true"` to make hook upload errors fail the hook                        |

### Data regions

| Region   | `LANGFUSE_BASE_URL`                |
| -------- | ---------------------------------- |
| 🇪🇺 EU    | `https://cloud.langfuse.com`       |
| 🇺🇸 US    | `https://us.cloud.langfuse.com`    |
| 🇯🇵 Japan | `https://jp.cloud.langfuse.com`    |
| ⚕️ HIPAA | `https://hipaa.cloud.langfuse.com` |

## GPT-5.6 cost calculation

For `gpt-5.6`/`gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, the plugin sends explicit, mutually exclusive `usageDetails` and `costDetails` to Langfuse. Prices are OpenAI's official USD list prices per 1M tokens published on 2026-07-09.

| Standard, input ≤272K | Input | Cached input | Cache write | Output/reasoning |
| --------------------- | ----: | -----------: | ----------: | ---------------: |
| Sol                   | $5.00 |        $0.50 |       $6.25 |           $30.00 |
| Terra                 | $2.50 |        $0.25 |      $3.125 |           $15.00 |
| Luna                  | $1.00 |        $0.10 |       $1.25 |            $6.00 |

| Standard, input >272K |  Input | Cached input | Cache write | Output/reasoning |
| --------------------- | -----: | -----------: | ----------: | ---------------: |
| Sol                   | $10.00 |        $1.00 |      $12.50 |           $45.00 |
| Terra                 |  $5.00 |        $0.50 |       $6.25 |           $22.50 |
| Luna                  |  $2.00 |        $0.20 |       $2.50 |            $9.00 |

Service-mode and location adjustments are applied after selecting the model/context row:

| Mode/location       | Multiplier | Notes                                 |
| ------------------- | ---------: | ------------------------------------- |
| Standard            |       1.0× | Default                               |
| Batch               |       0.5× | Short and long context                |
| Flex                |       0.5× | Short and long context                |
| Priority            |       2.0× | Short context only                    |
| Regional processing |       1.1× | Applied in addition to the mode above |

If Codex records `service_tier` in the rollout, that observed value overrides `pricing_mode`; otherwise set `LANGFUSE_CODEX_PRICING_MODE` (or `pricing_mode` in JSON) to match the API route. Enable `regional_processing` only when that OpenAI option is actually used. Unsupported combinations such as Priority with >272K input omit explicit cost instead of inventing a price.

Reasoning effort (`low`, `medium`, `high`, and so on) does not change the per-token rate. Reasoning tokens are a subset of output tokens and are charged at the selected model's output rate. Cached input and cache-write tokens are subtracted from the inclusive input total before costs are calculated, preventing double billing.

Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

## Deterministic trace ids

By default, trace ids are deterministically derived from the Codex session and turn ids. This makes
an upload retry target the same top-level trace instead of creating another trace, without making
ids predictable outside that session. An external system
(a CI harness, benchmark runner, or dataset-experiment service) can set
`LANGFUSE_CODEX_TRACE_SEED` (or `trace_seed` in `langfuse.json`) to precompute ids instead:

- **Turn N of the main thread** (1-based, in rollout order) gets the trace id `hex(sha256("<seed>:<N>")).slice(0, 32)`.
- **Turn N of a subagent thread** gets `hex(sha256("<seed>:<childThreadId>:<N>")).slice(0, 32)`, scoped by the subagent's thread id so it cannot collide with main-thread ids. (Subagent turns spawned _within_ a main-thread turn are nested inside that turn's trace as usual and don't get their own trace id.)

The main-thread formula deliberately excludes the Codex thread id, so you can compute the trace id **before** the run starts — no thread id, no polling. The derivation matches the Langfuse SDKs' `createTraceId(seed)` helper and always yields a valid W3C trace id.

**Use a unique seed per session** (e.g. a UUID or your job/run id). Reusing a seed across sessions produces colliding trace ids, and the second upload would merge into (and overwrite parts of) the first trace.

If derivation ever fails, the hook falls back to auto-generated ids and still uploads — it never blocks the session (set `LANGFUSE_CODEX_FAIL_ON_ERROR=true` while testing to surface such errors).

### Example: link a Codex run to a dataset run item

A harness can compute the trace id up front and register it with a [dataset run](https://langfuse.com/docs/evaluation/dataset-runs/native-run) — without ever fetching traces:

```bash
SEED="$(uuidgen)" # unique per codex exec invocation

# Trace id of the first main-thread turn: hex(sha256("<seed>:1")).slice(0, 32)
TRACE_ID=$(printf '%s:1' "$SEED" | shasum -a 256 | cut -c1-32)

# Link the precomputed trace id to a dataset run item before (or after) the run.
curl -s -X POST "$LANGFUSE_BASE_URL/api/public/dataset-run-items" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"runName\": \"codex-benchmark-2026-07-13\",
    \"datasetItemId\": \"$DATASET_ITEM_ID\",
    \"traceId\": \"$TRACE_ID\"
  }"

# Run Codex; the Stop hook uploads the turn with exactly $TRACE_ID.
LANGFUSE_CODEX_TRACE_SEED="$SEED" codex exec "your prompt"
```

The same works from JavaScript with the Langfuse SDK: `await createTraceId(`${seed}:1`)` (from `@langfuse/tracing`) returns the identical id.

## CloseClaw per-turn context

A shared Codex App Server cannot use process-wide `user_id`, `tags`, `metadata`, or
`trace_seed` values to distinguish multiple support customers. CloseClaw can write a
strict per-turn context file before the Codex `Stop` hook runs:

```text
<support_context_dir>/<codex-thread-id>/<codex-turn-id>.json
```

```json
{
  "version": 1,
  "thread_id": "codex-thread-id",
  "turn_id": "codex-turn-id",
  "session_id": "public-support-session-id",
  "user_id": "anonymous-public-user-id",
  "run_id": "public-support-run-id",
  "environment": "test",
  "channel": "portal",
  "trace_seed": "stable-trace-seed",
  "prompt_version": "v1",
  "created_at": "2026-08-14T09:00:00.000Z"
}
```

The reader accepts only version 1, identifier-only values, a matching thread/turn path,
regular files no larger than 16 KiB, and no extra fields. Valid context overrides the
Langfuse `sessionId`, `userId`, and trace seed for that turn; it adds the run id,
environment, channel, prompt version, and Codex identifiers as trace metadata. It also
adds `closeclaw-support`, `environment:<value>`, and `channel:<value>` tags.

Missing or invalid files fail open and leave normal Codex tracing unchanged. Sidecars
must not contain names, email addresses, messages, balances, credentials, or API keys.
The default root is `$CODEX_HOME/cctrace/support-context` (or
`~/.codex/cctrace/support-context`); override it with
`LANGFUSE_CODEX_SUPPORT_CONTEXT_DIR` or `support_context_dir` in JSON config.

## JSON config reference

| Config key            | Environment variable                                          | Default                               | Description                       |
| --------------------- | ------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| `enabled`             | `TRACE_TO_LANGFUSE`                                           | `false`                               | Enable tracing                    |
| `public_key`          | `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_CODEX_PUBLIC_KEY`           | —                                     | Langfuse public key               |
| `secret_key`          | `LANGFUSE_SECRET_KEY` / `LANGFUSE_CODEX_SECRET_KEY`           | —                                     | Langfuse secret key               |
| `base_url`            | `LANGFUSE_BASE_URL` / `LANGFUSE_CODEX_BASE_URL`               | `https://cloud.langfuse.com`          | Langfuse host                     |
| `environment`         | `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_CODEX_ENVIRONMENT` | —                                     | Environment label                 |
| `user_id`             | `LANGFUSE_CODEX_USER_ID`                                      | Codex auth email, if found            | User id for all traces            |
| `tags`                | `LANGFUSE_CODEX_TAGS`                                         | —                                     | Tags for all traces               |
| `metadata`            | `LANGFUSE_CODEX_METADATA`                                     | —                                     | Metadata object for all traces    |
| `trace_seed`          | `LANGFUSE_CODEX_TRACE_SEED`                                   | —                                     | Deterministic trace-id seed       |
| `support_context_dir` | `LANGFUSE_CODEX_SUPPORT_CONTEXT_DIR`                          | `$CODEX_HOME/cctrace/support-context` | CloseClaw per-turn context root   |
| `pricing_mode`        | `LANGFUSE_CODEX_PRICING_MODE`                                 | `standard`                            | OpenAI service pricing mode       |
| `regional_processing` | `LANGFUSE_CODEX_REGIONAL_PROCESSING`                          | `false`                               | Add regional-processing surcharge |
| `max_chars`           | `LANGFUSE_CODEX_MAX_CHARS`                                    | `20000`                               | Input/output truncation threshold |
| `debug`               | `LANGFUSE_CODEX_DEBUG`                                        | `false`                               | Verbose logging                   |
| `fail_on_error`       | `LANGFUSE_CODEX_FAIL_ON_ERROR`                                | `false`                               | Fail the hook on upload errors    |

## Troubleshooting

- **No traces appear** — confirm `plugin_hooks = true`, the plugin is enabled in `config.toml`, and `TRACE_TO_LANGFUSE=true` is visible to the Codex process. Run with `LANGFUSE_CODEX_DEBUG=true` to log to stderr.
- **Authentication fails** — check that the public/secret keys are valid and that `LANGFUSE_BASE_URL` matches the region the keys belong to.
- **Traces land in the wrong project** — API keys are project-scoped in Langfuse; use the keys for the project you want.
- **Testing hook failures** — set `LANGFUSE_CODEX_FAIL_ON_ERROR=true` together with `LANGFUSE_CODEX_DEBUG=true` to make Codex report upload or flush errors instead of failing open.
- **Checking uploader status** — `<rollout>.jsonl.langfuse.status.json` reports `queued`, `uploading`, `ok`, or `error` plus byte offsets and turn counts. It is bounded metadata only and never contains transcript content or credentials.
- **Checking dedup sidecars** — successfully flushed turn ids remain in the backwards-compatible `<rollout>.jsonl.langfuse` ledger. `<rollout>.jsonl.langfuse.state.json` stores the v2 inode/byte-offset checkpoint. Both are updated only after the Langfuse exporter flush succeeds.
- **Long or resumed sessions** — the first v2 worker streams a legacy rollout once, skipping JSON parsing for turn ids already in the legacy ledger. Later workers start at the committed byte offset instead of rereading the file.
- **Verifying in Langfuse** — use `npx langfuse-cli api traces list --from-timestamp <recent ISO> --limit 10 --order-by timestamp.desc --fields core,metrics,observations --json` with credentials for the same project.
- **Sandboxed/network-restricted runs** — Codex sandbox or network policy can prevent exports from reaching Langfuse. Debug logging and fail-on-error mode are the quickest way to distinguish hook execution from network failure.
- **Self-hosting** — the TypeScript SDK requires Langfuse platform version >= 3.95.0.

## Data sent to Langfuse

When enabled, the plugin uploads completed Codex transcript data to Langfuse: prompts, assistant messages, reasoning summaries, tool-call inputs and outputs, model metadata, and token usage. Do not enable tracing for sessions containing data you do not want stored in Langfuse. `LANGFUSE_CODEX_MAX_CHARS` truncates strings while each JSONL event is ingested; a pathological single event larger than the bounded 1–16 MiB line limit is replaced by an omission marker.

## How it works

Codex emits a [`Stop` hook](https://developers.openai.com/codex) after each turn, passing the path to the session's rollout transcript on stdin. The plugin:

1. Atomically writes pending/status sidecars, starts a detached uploader, and lets Stop return without waiting for transcript parsing or network I/O.
2. Locks the rollout and streams complete JSONL lines from the last committed v2 byte offset, retaining at most one new turn and skipping already-uploaded legacy turns without parsing their payloads.
3. Converts new turns into Langfuse observations with original timestamps, using the [Langfuse TypeScript SDK](https://langfuse.com/docs/observability/sdk/overview) on top of OpenTelemetry.
4. Flushes the exporter, then durably appends turn ids to `<rollout>.langfuse` and atomically advances `<rollout>.langfuse.state.json`.

The Stop hook remains fail-open. Background failures are retried twice and recorded in the bounded status sidecar, so tracing never blocks the Codex session but is no longer silently unauditable.

## Development

```bash
pnpm install
pnpm test        # run the test suite
pnpm run lint    # prettier + tsc + verify the committed bundle is current
pnpm run build   # bundle the hook to plugins/tracing/dist/index.mjs
```

The hook ships as a single self-contained `plugins/tracing/dist/index.mjs` (no install step runs when Codex loads the plugin), so the bundle is committed to the repo. After changing anything under `src/`, run `pnpm run build` and commit the updated bundle — CI enforces this via `pnpm run lint`.

## License

[MIT](./LICENSE)
