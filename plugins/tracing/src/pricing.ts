import type { TokenUsage, Turn } from "./types.js";

export type PricingMode = "standard" | "batch" | "flex" | "priority" | "fast";

export type NormalizedUsage = Record<string, number> & {
  input?: number;
  input_cached?: number;
  input_cache_write?: number;
  output?: number;
  output_reasoning?: number;
  total?: number;
};

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Codex reports inclusive input/output totals plus cached/reasoning subsets.
 * Langfuse requires arbitrary usage buckets to be mutually exclusive, so split
 * the inclusive totals before sending usage details for server-side cost inference.
 */
export function normalizeUsage(usage: TokenUsage | undefined): NormalizedUsage | undefined {
  if (!usage) return undefined;

  const inputTotal = nonNegative(usage.input_tokens);
  const inputCached = nonNegative(usage.cached_input_tokens);
  const inputCacheWrite = nonNegative(
    usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens,
  );
  const outputTotal = nonNegative(usage.output_tokens);
  const outputReasoning = nonNegative(usage.reasoning_output_tokens);

  const details: NormalizedUsage = {};
  if (typeof usage.input_tokens === "number") {
    details.input = Math.max(0, inputTotal - inputCached - inputCacheWrite);
  }
  if (typeof usage.cached_input_tokens === "number") details.input_cached = inputCached;
  if (
    typeof usage.cache_write_input_tokens === "number" ||
    typeof usage.cache_creation_input_tokens === "number"
  ) {
    details.input_cache_write = inputCacheWrite;
  }
  if (typeof usage.output_tokens === "number") {
    details.output = Math.max(0, outputTotal - outputReasoning);
  }
  if (typeof usage.reasoning_output_tokens === "number") {
    details.output_reasoning = outputReasoning;
  }
  if (typeof usage.total_tokens === "number") details.total = nonNegative(usage.total_tokens);

  return Object.keys(details).length > 0 ? details : undefined;
}

export function pricingMode(turn: Turn, configured: PricingMode): PricingMode {
  const raw = turn.invocationParams?.service_tier ?? turn.invocationParams?.serviceTier;
  if (typeof raw !== "string") return configured;
  const normalized = raw.toLowerCase();
  if (
    normalized === "priority" ||
    normalized === "fast" ||
    normalized === "flex" ||
    normalized === "batch"
  ) {
    return normalized;
  }
  if (normalized === "default" || normalized === "standard" || normalized === "auto") {
    return "standard";
  }
  return configured;
}

export function reasoningEffort(turn: Turn): string | undefined {
  const direct = turn.invocationParams?.effort ?? turn.invocationParams?.reasoning_effort;
  if (typeof direct === "string") return direct;
  const collaborationMode = turn.invocationParams?.collaboration_mode;
  if (collaborationMode && typeof collaborationMode === "object") {
    const settings = (collaborationMode as { settings?: unknown }).settings;
    if (settings && typeof settings === "object") {
      const value = (settings as { reasoning_effort?: unknown }).reasoning_effort;
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}
