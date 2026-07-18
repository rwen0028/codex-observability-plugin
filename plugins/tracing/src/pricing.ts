import type { TokenUsage, Turn } from "./types.js";

export type PricingMode = "standard" | "batch" | "flex" | "priority";

export type NormalizedUsage = Record<string, number> & {
  input?: number;
  input_cached?: number;
  input_cache_write?: number;
  output?: number;
  output_reasoning?: number;
  total?: number;
};

type ModelRates = {
  input: number;
  input_cached: number;
  input_cache_write: number;
  output: number;
};

export type PricingResult = {
  costDetails: Record<string, number>;
  mode: PricingMode;
  contextTier: "short" | "long";
  regionalProcessing: boolean;
};

const PER_MILLION = 1_000_000;
const LONG_CONTEXT_THRESHOLD = 272_000;

/** Official OpenAI prices, USD per 1M tokens, published 2026-07-09. */
const GPT_56_STANDARD_SHORT: Record<"sol" | "terra" | "luna", ModelRates> = {
  sol: { input: 5, input_cached: 0.5, input_cache_write: 6.25, output: 30 },
  terra: { input: 2.5, input_cached: 0.25, input_cache_write: 3.125, output: 15 },
  luna: { input: 1, input_cached: 0.1, input_cache_write: 1.25, output: 6 },
};

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Codex reports inclusive input/output totals plus cached/reasoning subsets.
 * Langfuse requires arbitrary usage buckets to be mutually exclusive, so split
 * the inclusive totals before sending either usage or cost details.
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

function modelTier(model: string | undefined): "sol" | "terra" | "luna" | undefined {
  const normalized = model?.toLowerCase().replace(/^openai\//, "");
  if (normalized === "gpt-5.6" || normalized === "gpt-5.6-sol") return "sol";
  if (normalized === "gpt-5.6-terra") return "terra";
  if (normalized === "gpt-5.6-luna") return "luna";
  return undefined;
}

function pricingMode(turn: Turn, configured: PricingMode): PricingMode {
  const raw = turn.invocationParams?.service_tier ?? turn.invocationParams?.serviceTier;
  if (typeof raw !== "string") return configured;
  const normalized = raw.toLowerCase();
  if (normalized === "priority" || normalized === "flex" || normalized === "batch") {
    return normalized;
  }
  if (normalized === "default" || normalized === "standard" || normalized === "auto") {
    return "standard";
  }
  return configured;
}

function modeMultiplier(mode: PricingMode): number {
  if (mode === "batch" || mode === "flex") return 0.5;
  if (mode === "priority") return 2;
  return 1;
}

/**
 * Calculate official-list-price cost details for GPT-5.6 generations.
 *
 * Priority does not support >272K long-context requests. If such a combination
 * appears, omit explicit cost instead of silently inventing a price.
 */
export function calculateGpt56Cost(
  model: string | undefined,
  usage: NormalizedUsage | undefined,
  turn: Turn,
  options: { mode: PricingMode; regionalProcessing: boolean },
): PricingResult | undefined {
  const tier = modelTier(model);
  if (!tier || !usage) return undefined;

  const inputTokens =
    nonNegative(usage.input) +
    nonNegative(usage.input_cached) +
    nonNegative(usage.input_cache_write);
  const contextTier = inputTokens > LONG_CONTEXT_THRESHOLD ? "long" : "short";
  const mode = pricingMode(turn, options.mode);
  if (mode === "priority" && contextTier === "long") return undefined;

  const base = GPT_56_STANDARD_SHORT[tier];
  const processingMultiplier = modeMultiplier(mode);
  const regionalMultiplier = options.regionalProcessing ? 1.1 : 1;
  const inputContextMultiplier = contextTier === "long" ? 2 : 1;
  const outputContextMultiplier = contextTier === "long" ? 1.5 : 1;

  const prices: Record<string, number> = {
    input: base.input * inputContextMultiplier,
    input_cached: base.input_cached * inputContextMultiplier,
    input_cache_write: base.input_cache_write * inputContextMultiplier,
    output: base.output * outputContextMultiplier,
    output_reasoning: base.output * outputContextMultiplier,
  };

  const costDetails: Record<string, number> = {};
  for (const [usageType, units] of Object.entries(usage)) {
    if (usageType === "total" || prices[usageType] == null) continue;
    costDetails[usageType] =
      (units * prices[usageType] * processingMultiplier * regionalMultiplier) / PER_MILLION;
  }

  return {
    costDetails,
    mode,
    contextTier,
    regionalProcessing: options.regionalProcessing,
  };
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
