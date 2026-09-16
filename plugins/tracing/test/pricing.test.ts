import { describe, expect, it } from "vitest";

import { pricingMode, normalizeUsage, reasoningEffort } from "../src/pricing.js";
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

describe("service-mode hints", () => {
  it.each(["priority", "fast", "flex", "batch"] as const)(
    "preserves observed %s for Langfuse without computing a price",
    (mode) => expect(pricingMode(makeTurn({ service_tier: mode }), "standard")).toBe(mode),
  );
  it("normalizes standard aliases and uses the configured fallback", () => {
    expect(pricingMode(makeTurn({ serviceTier: "auto" }), "priority")).toBe("standard");
    expect(pricingMode(makeTurn(), "flex")).toBe("flex");
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
