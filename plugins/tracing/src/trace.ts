import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createTraceId,
  propagateAttributes,
  startObservation,
  type LangfuseObservation,
  type PropagateAttributesParams,
} from "@langfuse/tracing";
import {
  context as otelContext,
  trace as otelTrace,
  TraceFlags,
  type SpanContext,
} from "@opentelemetry/api";

import type { Config } from "./config.js";
import { normalizeUsage, pricingMode, reasoningEffort } from "./pricing.js";
import {
  loadUploadedTurnIds,
  loadUploadState,
  markTurnsUploaded,
  writeUploadState,
} from "./sidecar.js";
import { scanRollout, type RolloutScanResult } from "./stream.js";
import { loadSupportTraceContext } from "./support-context.js";
import type { ModelStep, SessionMeta, TokenUsage, ToolCall, Turn } from "./types.js";
import { debugLog, toText, truncate } from "./utils.js";
import { PLUGIN_VERSION } from "./version.js";

/**
 * Stamped into every emitted trace so uploads self-identify which build
 * produced them: a trace without this field came from a plugin build that
 * still traces each turn more than once.
 */
const TRACE_PATCH_VERSION = "2.5.0";

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
 * Derive a deterministic trace id for every turn.
 *
 * Main-thread turn N (1-based, rollout order):  createTraceId(`${seed}:${N}`)
 * Subagent-thread turn N:                       createTraceId(`${seed}:${threadId}:${N}`)
 *
 * The main-thread form deliberately excludes the thread id so external systems
 * can precompute trace ids (hex(sha256(seed)).slice(0, 32)) before the Codex
 * thread exists. Without an explicit seed, use an ordinary root span: a
 * synthetic parent span id is not a real Langfuse observation and makes some
 * Langfuse versions render the trace-level input/output as empty.
 */
async function seededTraceParent(
  config: Config,
  sessionMeta: SessionMeta,
  turnNumber: number,
  supportTraceSeed?: string,
): Promise<SpanContext | undefined> {
  const traceSeed = supportTraceSeed ?? config.trace_seed;
  if (!traceSeed) return undefined;
  try {
    const seed = sessionMeta.isSubagentThread
      ? `${traceSeed}:${sessionMeta.sessionId}:${turnNumber}`
      : `${traceSeed}:${turnNumber}`;
    return {
      traceId: await createTraceId(seed),
      spanId: SEED_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  } catch (error) {
    debugLog("failed to derive deterministic trace id; falling back to auto-generated:", error);
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
  if (step.reasoningItems?.length) output.reasoning_items = step.reasoningItems;
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
    flush?: () => Promise<void>;
    parentObservation?: LangfuseObservation;
    /** Pre-derived trace id for top-level turns (see seededTraceParent). */
    seededParent?: SpanContext;
    /** Trace-level identity applied after the root observation exists. */
    traceAttributes?: PropagateAttributesParams;
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
        "cctrace.upload_schema": 2,
        "cctrace.plugin_version": PLUGIN_VERSION,
      },
    },
    {
      asType: "agent",
      startTime: new Date(turn.startTime),
      parentSpanContext: ctx.parentObservation?.otelSpan.spanContext() ?? ctx.seededParent,
    },
  );

  // The root observation must also carry the support/user attributes because
  // explicit trace seeds use a synthetic parent span. The outer call in
  // convertRollout supplies trace-level attributes; this updates the active
  // root observation as well.
  if (ctx.traceAttributes) {
    otelContext.with(otelTrace.setSpan(otelContext.active(), root.otelSpan), () =>
      propagateAttributes(ctx.traceAttributes!, () => undefined),
    );
  }

  let previousToolResults: unknown = undefined;

  for (let i = 0; i < turn.steps.length; i++) {
    const step = turn.steps[i];
    const usageDetails = toUsageDetails(step.usage);
    const mode = pricingMode(turn, ctx.config.pricing_mode);
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
        // Ingested amounts override Langfuse prices. Leave all models to Langfuse.
        modelParameters: { service_tier: mode },
        metadata: {
          "codex.step_index": i,
          "codex.response_id": step.responseId,
          "codex.thread_id": sessionMeta.sessionId,
          "codex.turn_id": turn.turnId,
          "cctrace.reasoning_schema": 1,
          ...(effort ? { "codex.reasoning_effort": effort } : {}),
          // Kept for verification by existing cctrace update scripts.
          "cctrace.pricing_source": "langfuse-model-definition",
          "cctrace.cost_calculation": "langfuse",
          "cctrace.pricing_mode": mode,
          "cctrace.pricing_regional": ctx.config.regional_processing,
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
    await convertRollout(subFile, {
      config: ctx.config,
      parentObservation: root,
      flush: ctx.flush,
    });
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
export type RolloutConversion = {
  emittedTurns: number;
  scan: RolloutScanResult;
  /** Persist acknowledgements only after the caller has flushed the exporter. */
  commit: () => Promise<void>;
};

export async function convertRollout(
  rolloutFile: string,
  options: {
    config: Config;
    parentObservation?: LangfuseObservation;
    snapshotBytes?: number;
    deferCommit?: boolean;
    flush?: () => Promise<void>;
  },
): Promise<RolloutConversion> {
  const uploaded = options.parentObservation
    ? new Set<string>()
    : await loadUploadedTurnIds(rolloutFile);
  const stat = await fs.stat(rolloutFile);
  const previousState = options.parentObservation
    ? undefined
    : await loadUploadState(rolloutFile, stat);
  const emittedTurnIds: string[] = [];
  let emittedTurns = 0;

  const snapshotBytes = Math.min(options.snapshotBytes ?? stat.size, stat.size);
  // Validate all pending turns before exporting any: deterministic size failures
  // must not cause earlier successful turns to be emitted again on each retry.
  await scanRollout(rolloutFile, {
    uploadedTurnIds: uploaded,
    previousState,
    snapshotBytes,
    maxChars: options.config.max_chars,
    onTurn: async () => {},
  });

  const scan = await scanRollout(rolloutFile, {
    uploadedTurnIds: uploaded,
    previousState,
    snapshotBytes,
    maxChars: options.config.max_chars,
    onTurn: async ({ turn, turnNumber, sessionMeta }) => {
      // Subagent rollout: nest everything under the parent turn, without a
      // separate ledger/session wrapper. Its parent turn is itself deduped.
      if (options.parentObservation) {
        await emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          parentObservation: options.parentObservation,
          flush: options.flush,
        });
        await options.flush?.();
        emittedTurns++;
        return;
      }

      const supportContext = turn.turnId
        ? await loadSupportTraceContext(
            options.config.support_context_dir,
            sessionMeta.sessionId,
            turn.turnId,
          )
        : undefined;
      const seededParent = await seededTraceParent(
        options.config,
        sessionMeta,
        turnNumber,
        supportContext?.trace_seed,
      );
      const userId = supportContext?.user_id ?? options.config.user_id;
      const tags = [
        ...(options.config.tags ?? []),
        ...(supportContext
          ? [
              "closeclaw-support",
              `environment:${supportContext.environment}`,
              `channel:${supportContext.channel}`,
            ]
          : []),
      ].filter((value, index, values) => values.indexOf(value) === index);
      const metadata: Record<string, string> = {
        ...(options.config.metadata ?? {}),
        ...(supportContext
          ? {
              "cctrace.context_source": "closeclaw-support-v1",
              "closeclaw.run_id": supportContext.run_id,
              "closeclaw.environment": supportContext.environment,
              "closeclaw.channel": supportContext.channel,
              "codex.thread_id": sessionMeta.sessionId,
              ...(turn.turnId ? { "codex.turn_id": turn.turnId } : {}),
              ...(supportContext.prompt_version
                ? { "closeclaw.prompt_version": supportContext.prompt_version }
                : {}),
            }
          : {}),
      };

      const traceAttributes: PropagateAttributesParams = {
        sessionId: supportContext?.session_id ?? sessionMeta.sessionId,
        traceName: sessionMeta.isSubagentThread ? "Codex Subagent Turn" : "Codex Turn",
        ...(userId ? { userId } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
      await propagateAttributes(traceAttributes, async () => {
        await emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          seededParent,
          traceAttributes,
          flush: options.flush,
        });
      });
      await options.flush?.();
      emittedTurns++;
      if (turn.turnId) {
        uploaded.add(turn.turnId);
        emittedTurnIds.push(turn.turnId);
      }
    },
  });

  debugLog(
    `scanned ${scan.scannedBytes} byte(s), emitted ${emittedTurns} turn(s) from ${path.basename(rolloutFile)}`,
  );

  let committed = false;
  const commit = async () => {
    if (committed || options.parentObservation) return;
    // Ledger first: if the following atomic state write fails, a retry rescans
    // from the old offset but still skips acknowledged turn ids.
    await markTurnsUploaded(rolloutFile, emittedTurnIds);
    await writeUploadState(rolloutFile, scan.state);
    committed = true;
  };

  if (!options.deferCommit) {
    await commit();
  }

  return { emittedTurns, scan, commit };
}
