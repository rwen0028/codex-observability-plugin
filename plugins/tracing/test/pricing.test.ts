import { describe, expect, it } from "vitest";

import {
  calculateGpt56Cost,
  normalizeUsage,
  reasoningEffort,
  type NormalizedUsage,
  type PricingMode,
} from "../src/pricing.js";
import type { TokenUsage, Turn } from "../src/types.js";

function makeTurn(invocationParams: Record<string, unknown> = {}): Turn {
  return {
    startTime: 0,
    endTime: 1,
    invocationParams,
    steps: [],
    subagentThreadIds: [],
    completed: true,
    aborted: false,
  };
}

function calculate(
  model: string,
  usage: NormalizedUsage,
  mode: PricingMode = "standard",
  turn = makeTurn(),
  regionalProcessing = false,
) {
  return calculateGpt56Cost(model, usage, turn, { mode, regionalProcessing });
}

function totalCost(costDetails: Record<string, number>): number {
  return costDetails.total;
}

describe("normalizeUsage", () => {
  it("splits inclusive Codex totals into mutually exclusive Langfuse buckets", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000,
      cached_input_tokens: 400,
      cache_creation_input_tokens: 100,
      output_tokens: 300,
      reasoning_output_tokens: 200,
      total_tokens: 1_300,
    };

    expect(normalizeUsage(usage)).toEqual({
      input: 500,
      input_cached: 400,
      input_cache_write: 100,
      output: 100,
      output_reasoning: 200,
      total: 1_300,
    });
  });

  it("clamps inconsistent subsets instead of creating negative billed units", () => {
    expect(normalizeUsage({ input_tokens: 10, cached_input_tokens: 20, output_tokens: 0 })).toEqual(
      { input: 0, input_cached: 20, output: 0 },
    );
  });
});

describe("GPT-5.6 official pricing", () => {
  it("matches the live GPT-5.6 Sol LiteLLM spend sample exactly", () => {
    const usage = normalizeUsage({
      input_tokens: 14_487,
      cached_input_tokens: 3_456,
      output_tokens: 47,
    })!;
    const result = calculate("openai/gpt-5.6-sol", usage)!;

    expect(result.contextTier).toBe("short");
    expect(result.costDetails.input).toBeCloseTo(0.055155, 12);
    expect(result.costDetails.input_cached).toBeCloseTo(0.001728, 12);
    expect(result.costDetails.output).toBeCloseTo(0.00141, 12);
    expect(totalCost(result.costDetails)).toBeCloseTo(0.058293, 12);
  });

  it("matches the live GPT-5.6 Terra LiteLLM spend sample exactly", () => {
    const usage = normalizeUsage({
      input_tokens: 52_987,
      cached_input_tokens: 51_712,
      output_tokens: 417,
    })!;
    const result = calculate("gpt-5.6-terra", usage)!;

    expect(result.costDetails.input).toBeCloseTo(0.0031875, 12);
    expect(result.costDetails.input_cached).toBeCloseTo(0.012928, 12);
    expect(result.costDetails.output).toBeCloseTo(0.006255, 12);
    expect(totalCost(result.costDetails)).toBeCloseTo(0.0223705, 12);
  });

  it("uses Luna rates and prices reasoning output as output tokens", () => {
    const result = calculate("gpt-5.6-luna", {
      input: 50_000,
      input_cached: 50_000,
      input_cache_write: 50_000,
      output: 1_000_000,
      output_reasoning: 1_000_000,
    })!;

    expect(result.costDetails).toEqual({
      input: 0.05,
      input_cached: 0.005,
      input_cache_write: 0.0625,
      output: 6,
      output_reasoning: 6,
      total: 12.1175,
    });
  });

  it("switches to long-context rates only above 272K input tokens", () => {
    const threshold = calculate("gpt-5.6-sol", { input: 272_000, output: 1_000_000 })!;
    const long = calculate("gpt-5.6-sol", { input: 272_001, output: 1_000_000 })!;

    expect(threshold.contextTier).toBe("short");
    expect(threshold.costDetails.input).toBeCloseTo(1.36, 12);
    expect(threshold.costDetails.output).toBe(30);
    expect(long.contextTier).toBe("long");
    expect(long.costDetails.input).toBeCloseTo(2.72001, 12);
    expect(long.costDetails.output).toBe(45);
  });

  it.each([
    ["batch", 0.5],
    ["flex", 0.5],
    ["standard", 1],
    ["priority", 2],
  ] as const)("applies the %s service-mode multiplier", (mode, expected) => {
    const result = calculate("gpt-5.6-sol", { input: 200_000 }, mode)!;
    expect(result.costDetails.input).toBeCloseTo(expected, 12);
  });

  it("prefers an observed service tier over the configured default", () => {
    const turn = makeTurn({ service_tier: "flex" });
    const result = calculate("gpt-5.6-sol", { input: 200_000 }, "priority", turn)!;

    expect(result.mode).toBe("flex");
    expect(result.costDetails.input).toBeCloseTo(0.5, 12);
  });

  it("adds the official 10% regional-processing surcharge", () => {
    const result = calculate("gpt-5.6-sol", { input: 200_000 }, "standard", makeTurn(), true)!;
    expect(result.costDetails.input).toBeCloseTo(1.1, 12);
  });

  it("omits invented pricing for unsupported priority long context and unknown models", () => {
    expect(calculate("gpt-5.6-sol", { input: 272_001 }, "priority")).toBeUndefined();
    expect(calculate("gpt-4.1", { input: 1_000 })).toBeUndefined();
  });
});

describe("reasoning effort metadata", () => {
  it("reads both direct and collaboration-mode effort fields", () => {
    expect(reasoningEffort(makeTurn({ effort: "high" }))).toBe("high");
    expect(
      reasoningEffort(
        makeTurn({ collaboration_mode: { settings: { reasoning_effort: "medium" } } }),
      ),
    ).toBe("medium");
  });
});
