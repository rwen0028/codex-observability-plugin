import { describe, expect, it } from "vitest";
import { parseSession } from "../src/parse.js";
import type { RolloutLine } from "../src/types.js";

const line = (type: string, payload: Record<string, unknown>): RolloutLine => ({
  timestamp: "2026-09-16T00:00:00.000Z",
  type,
  payload,
});
const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 };
const begin = [
  line("session_meta", { id: "s" }),
  line("event_msg", { type: "task_started", turn_id: "t" }),
  line("turn_context", { model: "gpt-6-astra" }),
];
const message = line("response_item", {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "OK" }],
});
const native = line("token_usage_record", {
  thread_id: "s",
  turn_id: "t",
  response_id: "resp-1",
  usage,
  thread_token_usage: { total_tokens: 9000 },
  turn_token_usage: { total_tokens: 5000 },
});
const count = line("event_msg", {
  type: "token_count",
  info: { last_token_usage: usage, total_token_usage: { total_tokens: 9000 } },
});
const end = line("event_msg", { type: "task_complete", turn_id: "t" });

describe("native per-response usage", () => {
  it("uses exact native response usage when token_count is absent", () => {
    const [turn] = parseSession([...begin, message, native, end]).turns;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]).toMatchObject({ responseId: "resp-1", usage, text: "OK" });
  });
  it("does not count native and token_count records as two calls", () => {
    const [turn] = parseSession([...begin, message, native, count, native, end]).turns;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].usage?.total_tokens).toBe(120);
    expect(turn.totalUsage?.total_tokens).toBe(9000);
  });
  it("does not let a rate limit token_count split one native response", () => {
    const [turn] = parseSession([...begin, message, count, message, native, count, end]).turns;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].text).toBe("OK\nOK");
    expect(turn.steps[0].responseId).toBe("resp-1");
  });
  it("keeps each response identity and per-response tokens distinct", () => {
    const second = line("token_usage_record", {
      ...native.payload,
      response_id: "resp-2",
      usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230 },
    });
    const [turn] = parseSession([
      ...begin,
      message,
      native,
      count,
      message,
      second,
      count,
      end,
    ]).turns;
    expect(turn.steps.map((step) => step.responseId)).toEqual(["resp-1", "resp-2"]);
    expect(turn.steps.map((step) => step.usage?.total_tokens)).toEqual([120, 230]);
  });
  it.each([
    { ...native.payload, thread_id: "other" },
    { ...native.payload, turn_id: "other" },
    { ...native.payload, response_id: "" },
    { ...native.payload, usage: [] },
    { ...native.payload, usage: null },
    { ...native.payload, usage: {} },
    { ...native.payload, usage: { ...usage, input_tokens: -1 } },
  ])("does not bind foreign or malformed native records to this call", (payload) => {
    const [turn] = parseSession([
      ...begin,
      message,
      line("token_usage_record", payload),
      count,
      end,
    ]).turns;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].responseId).toBeUndefined();
    expect(turn.steps[0].usage).toEqual(usage);
  });
});
