import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createTraceId,
  propagateAttributes,
  startObservation,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import { parseSession } from "./parse.js";
import { calculateGpt56Cost, normalizeUsage, reasoningEffort } from "./pricing.js";
import { loadUploadedTurnIds, markTurnUploaded } from "./sidecar.js";
import type { ModelStep, RolloutLine, SessionMeta, TokenUsage, ToolCall, Turn } from "./types.js";
import { debugLog, toText, truncate } from "./utils.js";

/**
 * Stamped into every emitted trace so uploads self-identify which build
 * produced them: a trace without this field came from a plugin build that
 * still traces each turn more than once.
 */
const TRACE_PATCH_VERSION = "2.2.2";

async function loadSession(file: string): Promise<RolloutLine[]> {
  const data = await fs.readFile(file, "utf-8");
  const lines: RolloutLine[] = [];
  for (const raw of data.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      // skip malformed lines rather than aborting the whole upload
    }
  }
  return lines;
}

/**
 * Resolve a subagent's rollout file from its thread id.
 *
 * Rollouts live at `<sessionsRoot>/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`.
 * Starting from the parent rollout, we walk up to the sessions root and search
 * for a file whose name ends with the subagent's thread id.
 */
async function findSubagentRollout(
  parentFile: string,
  threadId: string,
): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`;
  const root = path.resolve(path.dirname(parentFile), "../../..");

  async function walk(dir: string): Promise<string | undefined> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return full;
      }
    }
    return undefined;
  }

  return walk(root);
}

/**
 * Placeholder parent span id used to pin a deterministic trace id on a root
 * span (the pattern the Langfuse SDK documents for custom trace ids). The id
 * never exists as a real span, so Langfuse still renders the turn as the
 * trace root.
 */
const SEED_PARENT_SPAN_ID = "0123456789abcdef";

/**
 * Derive the deterministic trace id for a turn from `config.trace_seed`.
 *
 * Main-thread turn N (1-based, rollout order):  createTraceId(`${seed}:${N}`)
 * Subagent-thread turn N:                       createTraceId(`${seed}:${threadId}:${N}`)
 *
 * The main-thread form deliberately excludes the thread id so external systems
 * can precompute trace ids (hex(sha256(seed)).slice(0, 32)) before the Codex
 * thread exists. Returns `undefined` (auto-generated ids) when no seed is set
 * or derivation fails — the hook must never block an upload.
 */
async function seededTraceParent(
  config: Config,
  sessionMeta: SessionMeta,
  turnNumber: number,
): Promise<SpanContext | undefined> {
  if (!config.trace_seed) return undefined;
  try {
    const seed = sessionMeta.isSubagentThread
      ? `${config.trace_seed}:${sessionMeta.sessionId}:${turnNumber}`
      : `${config.trace_seed}:${turnNumber}`;
    return {
      traceId: await createTraceId(seed),
      spanId: SEED_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  } catch (error) {
    debugLog("failed to derive seeded trace id; falling back to auto-generated:", error);
    if (config.fail_on_error) throw error;
    return undefined;
  }
}

function toUsageDetails(usage: TokenUsage | undefined): Record<string, number> | undefined {
  return normalizeUsage(usage);
}

type Clip = {
  (value: string): string;
  (value: unknown): unknown;
};

/** Build a clip() that truncates long strings to `maxChars`. */
function makeClip(maxChars: number): Clip {
  function clip(value: string): string;
  function clip(value: unknown): unknown;
  function clip(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const { text, meta } = truncate(value, maxChars);
    return meta ? `${text}\n…[truncated ${meta.originalLength - text.length} chars]` : text;
  }
  return clip;
}

function buildGenerationOutput(step: ModelStep, clip: Clip): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (step.text) output.content = clip(step.text);
  if (step.reasoning) output.reasoning = clip(step.reasoning);
  if (step.toolCalls.length > 0) {
    output.tool_calls = step.toolCalls.map((tc) => ({
      id: tc.callId,
      name: tc.name,
      arguments: tc.args,
    }));
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Observation name for a tool call. MCP calls use the clean `server.tool`
 * split from the mcp_tool_call_* events instead of the mangled function name;
 * everything else uses the plain tool name. Call arguments (shell command,
 * search query, …) stay out of the name — they belong to the observation
 * input.
 */
function toolObservationName(tc: ToolCall): string {
  if (tc.mcp) return `${tc.mcp.server}.${tc.mcp.tool}`;
  return tc.name || "tool";
}

/** Emit a single turn (and its subagents) as a Langfuse observation tree. */
async function emitTurn(
  turn: Turn,
  sessionMeta: SessionMeta,
  ctx: {
    config: Config;
    rolloutFile: string;
    parentObservation?: LangfuseObservation;
    /** Pre-derived trace id for top-level turns (see seededTraceParent). */
    seededParent?: SpanContext;
  },
): Promise<void> {
  const clip = makeClip(ctx.config.max_chars);

  // A turn belongs to a subagent when its rollout is marked as a subagent
  // thread or when it is being nested under a spawning turn.
  const isSubagent = sessionMeta.isSubagentThread === true || ctx.parentObservation != null;

  const root = startObservation(
    isSubagent ? "Codex Subagent Turn" : "Codex Turn",
    {
      input: turn.userInput != null ? clip(turn.userInput) : undefined,
      output: turn.finalOutput != null ? clip(turn.finalOutput) : undefined,
      level: turn.aborted ? "WARNING" : undefined,
      statusMessage: turn.aborted ? "Turn interrupted by user" : undefined,
      metadata: {
        "codex.turn_id": turn.turnId,
        "codex.thread_id": sessionMeta.sessionId,
        "codex.model": turn.model,
        "codex.model_provider": sessionMeta.modelProvider,
        "codex.cli_version": sessionMeta.cliVersion,
        "codex.aborted": turn.aborted,
        "codex.tool_call_count": turn.steps.reduce((n, s) => n + s.toolCalls.length, 0),
        "cctrace.patch": TRACE_PATCH_VERSION,
      },
    },
    {
      asType: "agent",
      startTime: new Date(turn.startTime),
      parentSpanContext: ctx.parentObservation?.otelSpan.spanContext() ?? ctx.seededParent,
    },
  );

  let previousToolResults: unknown = undefined;

  for (let i = 0; i < turn.steps.length; i++) {
    const step = turn.steps[i];
    const usageDetails = toUsageDetails(step.usage);
    const pricing = calculateGpt56Cost(turn.model, usageDetails, turn, {
      mode: ctx.config.pricing_mode,
      regionalProcessing: ctx.config.regional_processing,
    });
    const effort = reasoningEffort(turn);
    const generation = startObservation(
      isSubagent ? "LLM Subagent" : "LLM",
      {
        input:
          i === 0
            ? turn.userInput != null
              ? clip(turn.userInput)
              : undefined
            : previousToolResults,
        output: buildGenerationOutput(step, clip),
        model: turn.model,
        usageDetails,
        costDetails: pricing?.costDetails,
        metadata: {
          "codex.step_index": i,
          ...(effort ? { "codex.reasoning_effort": effort } : {}),
          ...(pricing
            ? {
                "cctrace.pricing_source": "openai-official-2026-07-09",
                "cctrace.pricing_mode": pricing.mode,
                "cctrace.pricing_context": pricing.contextTier,
                "cctrace.pricing_regional": pricing.regionalProcessing,
              }
            : {}),
        },
      },
      {
        asType: "generation",
        startTime: new Date(step.startTime),
        parentSpanContext: root.otelSpan.spanContext(),
      },
    );

    for (const tc of step.toolCalls) {
      emitToolCall(tc, generation, clip, step.endTime);
    }

    generation.end(new Date(step.endTime));

    previousToolResults =
      step.toolCalls.length > 0
        ? step.toolCalls.map((tc) => ({
            name: tc.name,
            output: tc.output != null ? clip(toText(tc.output)) : undefined,
            ...(tc.error ? { error: clip(tc.error) } : {}),
          }))
        : undefined;
  }

  // Subagent threads spawned by this turn are nested under the turn root.
  for (const threadId of turn.subagentThreadIds) {
    const subFile = await findSubagentRollout(ctx.rolloutFile, threadId);
    if (!subFile) {
      debugLog(`subagent rollout not found for thread ${threadId}`);
      continue;
    }
    await convertRollout(subFile, { config: ctx.config, parentObservation: root });
  }

  root.end(new Date(turn.endTime));
}

function emitToolCall(
  tc: ToolCall,
  parent: LangfuseObservation,
  clip: Clip,
  fallbackEnd: number,
): void {
  const tool = startObservation(
    toolObservationName(tc),
    {
      input: tc.args,
      output: tc.output != null ? clip(toText(tc.output)) : undefined,
      level: tc.error ? "ERROR" : undefined,
      statusMessage: tc.error ? clip(tc.error) : undefined,
      metadata: { "codex.call_id": tc.callId, "codex.tool_name": tc.name || "tool" },
    },
    {
      asType: "tool",
      startTime: new Date(tc.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );
  tool.end(new Date(tc.endTime ?? fallbackEnd));
}

/**
 * Convert a Codex rollout file into Langfuse traces.
 *
 * Top-level turns each become their own trace (grouped into a Langfuse session
 * via the Codex thread id). Subagent rollouts are nested under the spawning
 * turn via `parentObservation`.
 */
export async function convertRollout(
  rolloutFile: string,
  options: { config: Config; parentObservation?: LangfuseObservation },
): Promise<void> {
  const { sessionMeta, turns } = parseSession(await loadSession(rolloutFile));
  debugLog(`parsed ${turns.length} turn(s) from ${path.basename(rolloutFile)}`);

  // Subagent rollout: nest everything under the parent turn, no dedup/session wrapping.
  if (options.parentObservation) {
    for (const turn of turns) {
      await emitTurn(turn, sessionMeta, {
        config: options.config,
        rolloutFile,
        parentObservation: options.parentObservation,
      });
    }
    return;
  }

  const uploaded = await loadUploadedTurnIds(rolloutFile);

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    if (turn.turnId && uploaded.has(turn.turnId)) {
      continue; // already uploaded in a previous hook invocation
    }

    // A turn with nothing in it carries no information: lifecycle events written
    // after `task_complete` / `turn_aborted` parse into one, as does a turn
    // aborted before it recorded anything. Codex 0.144 gives those events a turn
    // id, so a missing id no longer identifies them. Skip before uploading AND
    // before recording, so a turn that only looks empty because its content has
    // not been flushed yet is still traced in full on a later Stop.
    if (
      turn.userInput == null &&
      turn.finalOutput == null &&
      turn.steps.length === 0 &&
      turn.subagentThreadIds.length === 0
    ) {
      continue;
    }

    // Turn numbering stays 1-based over the full rollout (including turns
    // skipped by dedup above) so the derived id is stable across hook runs.
    const seededParent = await seededTraceParent(options.config, sessionMeta, turnIndex + 1);

    await propagateAttributes(
      {
        sessionId: sessionMeta.sessionId,
        traceName: sessionMeta.isSubagentThread ? "Codex Subagent Turn" : "Codex Turn",
        ...(options.config.user_id ? { userId: options.config.user_id } : {}),
        ...(options.config.tags ? { tags: options.config.tags } : {}),
        ...(options.config.metadata ? { metadata: options.config.metadata } : {}),
      },
      async () => {
        await emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          seededParent,
        });
      },
    );

    // Record every turn we upload, completed or not. Codex fires `Stop` before
    // the just-ended turn's `task_complete` reaches the rollout, so waiting for
    // `completed` before recording means the next Stop sees an unrecorded turn
    // and uploads it again — as a new trace, not an update.
    if (turn.turnId) {
      uploaded.add(turn.turnId);
      await markTurnUploaded(rolloutFile, turn.turnId);
    }
  }
}
