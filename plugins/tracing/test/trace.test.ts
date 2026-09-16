import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { ObservationIdGenerator } from "../src/identity.js";
import { convertRollout } from "../src/trace.js";
import { PLUGIN_VERSION } from "../src/version.js";
import { runUploadWorker } from "../src/worker.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  pricing_mode: "standard",
  regional_processing: false,
  debug: false,
  fail_on_error: false,
  support_context_dir: path.join(os.tmpdir(), "missing-cctrace-support-context"),
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

/** Copy the fixture session tree to a fresh temp dir (isolates sidecar writes). */
function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-trace-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

/**
 * The derivation external systems use to precompute a seeded trace id —
 * intentionally independent of the Langfuse SDK helper the plugin calls.
 */
const seededTraceId = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

const attr = (span: ReadableSpan, key: string): string =>
  span.attributes[key] == null ? "" : String(span.attributes[key]);
const obsType = (span: ReadableSpan): string => attr(span, "langfuse.observation.type");
const startMs = (span: ReadableSpan): number => span.startTime[0] * 1000 + span.startTime[1] / 1e6;
const parentId = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;

beforeAll(() => {
  provider = new NodeTracerProvider({
    idGenerator: new ObservationIdGenerator(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe("convertRollout", () => {
  it("emits an agent → generation → tool tree with backdated timestamps", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "Codex Turn");
    expect(root, "expected a 'Codex Turn' root span").toBeDefined();
    expect(obsType(root!)).toBe("agent");
    expect(parentId(root!)).toBeUndefined();
    expect(attr(root!, "langfuse.observation.input")).toContain("List the files");
    expect(attr(root!, "langfuse.observation.output")).toContain("two files");

    // Backdated to the turn's task_started timestamp.
    expect(startMs(root!)).toBe(Date.parse("2026-06-03T10:00:01.000Z"));
    expect(attr(root!, "langfuse.observation.metadata.cctrace.plugin_version")).toBe(
      PLUGIN_VERSION,
    );
    expect(attr(root!, "langfuse.observation.metadata.cctrace.upload_schema")).toBe("2");

    // Two generations, both children of the root, named "LLM" (the model name
    // lives in the model attribute, not the observation name).
    const generations = spans.filter((s) => obsType(s) === "generation");
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(gen.name).toBe("LLM");
      expect(parentId(gen)).toBe(root!.spanContext().spanId);
      expect(attr(gen, "langfuse.observation.model.name")).toBe("gpt-5.4");
    }
    // First generation carries token usage.
    const usage = generations
      .map((g) => attr(g, "langfuse.observation.usage_details"))
      .find((u) => u.includes("120"));
    expect(usage, "expected usage details with 120 total tokens").toBeTruthy();

    // One tool span, nested under a generation, with the captured command output.
    const tools = spans.filter((s) => obsType(s) === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.metadata.codex.tool_name")).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.output")).toContain("file1.txt");
    expect(generations.map((g) => g.spanContext().spanId)).toContain(parentId(tools[0]));
  });

  it.each(["gpt-5.6-sol", "gpt-6-astra", "future-model-unknown-to-plugin"])(
    "exports %s usage for Langfuse pricing without a client price table",
    async (model) => {
      const dir = stageFixtures();
      const file = path.join(dir, "rollout-basic-main.jsonl");
      fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replaceAll("gpt-5.4", model));
      await convertRollout(file, { config: { ...baseConfig, pricing_mode: "fast" } });
      const generations = exporter
        .getFinishedSpans()
        .filter((span) => obsType(span) === "generation");
      expect(generations.length).toBeGreaterThan(0);
      for (const generation of generations) {
        expect(attr(generation, "langfuse.observation.model.name")).toBe(model);
        expect(generation.attributes).not.toHaveProperty("langfuse.observation.cost_details");
        expect(attr(generation, "langfuse.observation.metadata.cctrace.pricing_source")).toBe(
          "langfuse-model-definition",
        );
        expect(attr(generation, "langfuse.observation.metadata.cctrace.cost_calculation")).toBe(
          "langfuse",
        );
        expect(JSON.parse(attr(generation, "langfuse.observation.model.parameters"))).toEqual({
          service_tier: "fast",
        });
      }
      const usage = generations
        .map((g) => JSON.parse(attr(g, "langfuse.observation.usage_details")))
        .find((u) => u.total === 120);
      expect(usage).toEqual({
        input: 100,
        input_cached: 0,
        output: 15,
        output_reasoning: 5,
        total: 120,
      });
    },
  );

  it("nests subagent turns under the spawning turn and marks errors/interruptions", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const child = spans.find((s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parentId(parent!)).toBeUndefined();
    expect(parentId(child!)).toBeDefined();

    // The subagent turn is nested somewhere under the parent's trace.
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child!, "langfuse.observation.input")).toContain("tell a joke");

    // Subagent generations are distinguishable from main-thread ones.
    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child!.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");

    // Aborted turn is flagged on the parent root.
    expect(attr(parent!, "langfuse.observation.level")).toBe("WARNING");

    // The failing exec is recorded as an ERROR-level tool span.
    const failedTool = spans.find(
      (s) => obsType(s) === "tool" && attr(s, "langfuse.observation.level") === "ERROR",
    );
    expect(failedTool, "expected a failed tool span").toBeDefined();
    expect(attr(failedTool!, "langfuse.observation.status_message")).toContain("command failed");
  });

  it("captures web search, local shell, and MCP tool calls with specific names", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-tools-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const toolNames = spans
      .filter((s) => obsType(s) === "tool")
      .map((s) => s.name)
      .sort();
    // Call arguments (command, query) stay out of the name — they are the input.
    expect(toolNames).toEqual(["linear.create_issue", "local_shell", "web_search"]);

    const webSearch = spans.find((s) => s.name === "web_search")!;
    expect(attr(webSearch, "langfuse.observation.input")).toContain("langfuse codex plugin");

    const shell = spans.find((s) => s.name === "local_shell")!;
    expect(attr(shell, "langfuse.observation.output")).toContain("clean");
  });

  it("skips turns already recorded in the sidecar (dedup)", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    await convertRollout(file, { config: baseConfig });
    const firstCount = exporter.getFinishedSpans().length;
    expect(firstCount).toBeGreaterThan(0);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("defers ledger and offset commits until the caller confirms exporter flush", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    const conversion = await convertRollout(file, {
      config: baseConfig,
      deferCommit: true,
    });
    expect(conversion.emittedTurns).toBe(1);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(false);
    expect(fs.existsSync(`${file}.langfuse.state.json`)).toBe(false);

    await conversion.commit();
    await conversion.commit(); // idempotent within one worker attempt
    expect(fs.readFileSync(`${file}.langfuse`, "utf-8")).toBe("turn-1\n");
    const state = JSON.parse(fs.readFileSync(`${file}.langfuse.state.json`, "utf-8"));
    expect(state).toMatchObject({
      version: 2,
      committedOffset: fs.statSync(file).size,
      turnNumber: 1,
    });
  });

  it("reuses the same trace id when an uncommitted upload is retried", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    const seededConfig = { ...baseConfig, trace_seed: "retry-seed" };
    await convertRollout(file, { config: seededConfig, deferCommit: true });
    const firstTraceId = exporter
      .getFinishedSpans()
      .find((span) => span.name === "Codex Turn")!
      .spanContext().traceId;
    exporter.reset();

    await convertRollout(file, { config: seededConfig, deferCommit: true });
    const retryTraceId = exporter
      .getFinishedSpans()
      .find((span) => span.name === "Codex Turn")!
      .spanContext().traceId;
    expect(retryTraceId).toBe(firstTraceId);
  });

  // Codex fires `Stop` before the just-ended turn's `task_complete` reaches the
  // rollout, so every Stop sees that turn as in-progress. Uploading such a turn
  // without recording it re-uploads it as a *new* trace on the next Stop.
  it("traces a turn exactly once when Stop fires before task_complete lands", async () => {
    const dir = stageFixtures();
    const lines = fs
      .readFileSync(path.join(dir, "rollout-basic-main.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(JSON.parse(lines[lines.length - 1]).payload.type).toBe("task_complete");

    const file = path.join(dir, "rollout-inflight-main.jsonl");
    const turnRoots = () => exporter.getFinishedSpans().filter((s) => s.name === "Codex Turn");

    // Stop #1: the turn has ended but `task_complete` is not flushed yet.
    fs.writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
    await convertRollout(file, { config: baseConfig });
    expect(turnRoots()).toHaveLength(1);

    // Stop #2: `task_complete` has landed. The same turn must not be traced again.
    exporter.reset();
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    await convertRollout(file, { config: baseConfig });
    expect(turnRoots()).toHaveLength(0);
  });

  // A turn that recorded nothing carries no information, and Codex 0.144 gives
  // its post-turn lifecycle events a turn id — so contentless turns are no
  // longer always anonymous and cannot be recognised by a missing id alone.
  it("does not trace a turn that has no content, even with a turn id", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-aborted-empty-main.jsonl");
    fs.writeFileSync(
      file,
      [
        '{"timestamp":"2026-06-03T10:00:00.000Z","type":"session_meta","payload":{"id":"sess-empty-abort","cli_version":"0.144.0","model_provider":"openai"}}',
        '{"timestamp":"2026-06-03T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
        '{"timestamp":"2026-06-03T10:00:01.500Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1"}}',
      ].join("\n") + "\n",
    );

    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  // Guard the other side of the emptiness filter: an aborted turn that DID
  // record something (here: reasoning, so steps.length > 0) is real work and
  // must still be traced. Interruption alone must never suppress a turn.
  it("still traces an aborted turn that recorded reasoning", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-aborted-with-reasoning-main.jsonl");
    fs.writeFileSync(
      file,
      [
        '{"timestamp":"2026-06-03T10:00:00.000Z","type":"session_meta","payload":{"id":"sess-abort-reasoning","cli_version":"0.144.0","model_provider":"openai"}}',
        '{"timestamp":"2026-06-03T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
        '{"timestamp":"2026-06-03T10:00:02.000Z","type":"response_item","payload":{"type":"reasoning","content":"Thinking about the request."}}',
        '{"timestamp":"2026-06-03T10:00:03.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1"}}',
      ].join("\n") + "\n",
    );

    await convertRollout(file, { config: baseConfig });
    const root = exporter.getFinishedSpans().find((s) => s.name === "Codex Turn");
    expect(root, "an aborted turn with reasoning must still be traced").toBeDefined();
    expect(attr(root!, "langfuse.observation.level")).toBe("WARNING"); // marked interrupted
  });
});

describe("CloseClaw support context", () => {
  it("maps per-turn sidecar identifiers to Langfuse trace attributes", async () => {
    const dir = stageFixtures();
    const supportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-support-"));
    const contextDir = path.join(supportRoot, "sess-basic");
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(
      path.join(contextDir, "turn-1.json"),
      JSON.stringify({
        version: 1,
        thread_id: "sess-basic",
        turn_id: "turn-1",
        session_id: "support-session-1",
        user_id: "support-user-1",
        run_id: "support-run-1",
        environment: "test",
        channel: "portal",
        trace_seed: "support-seed-1",
        prompt_version: "v1",
        created_at: "2026-08-14T09:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), {
      config: {
        ...baseConfig,
        support_context_dir: supportRoot,
        user_id: "fallback-user",
        trace_seed: "fallback-seed",
        tags: ["configured"],
        metadata: { configured: "true" },
      },
    });

    const root = exporter.getFinishedSpans().find((span) => span.name === "Codex Turn")!;
    expect(root.spanContext().traceId).toBe(seededTraceId("support-seed-1:1"));
    expect(attr(root, "session.id")).toBe("support-session-1");
    expect(attr(root, "user.id")).toBe("support-user-1");
    expect(root.attributes["langfuse.trace.tags"]).toEqual([
      "configured",
      "closeclaw-support",
      "environment:test",
      "channel:portal",
    ]);
    const traceMetadata = (key: string): string => attr(root, `langfuse.trace.metadata.${key}`);
    expect(traceMetadata("configured")).toBe("true");
    expect(traceMetadata("cctrace.context_source")).toBe("closeclaw-support-v1");
    expect(traceMetadata("closeclaw.run_id")).toBe("support-run-1");
    expect(traceMetadata("closeclaw.environment")).toBe("test");
    expect(traceMetadata("closeclaw.channel")).toBe("portal");
    expect(traceMetadata("closeclaw.prompt_version")).toBe("v1");
    expect(traceMetadata("codex.thread_id")).toBe("sess-basic");
    expect(traceMetadata("codex.turn_id")).toBe("turn-1");
  });
});

describe("deterministic trace ids (trace_seed)", () => {
  const seed = "ci-run-42";
  const seededConfig: Config = { ...baseConfig, trace_seed: seed };

  const turnRoots = () =>
    exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn")
      .sort((a, b) => startMs(a) - startMs(b));

  it("derives the N-th main-thread turn's trace id from `${seed}:${N}`", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:1`));
    expect(roots[1].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));

    // Every span (generations included) lands in one of the two seeded traces.
    const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect([...traceIds].sort()).toEqual(
      [seededTraceId(`${seed}:1`), seededTraceId(`${seed}:2`)].sort(),
    );
  });

  it("keeps generations and tool spans in the seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: seededConfig });

    const spans = exporter.getFinishedSpans();
    const expected = seededTraceId(`${seed}:1`);
    expect(spans.length).toBeGreaterThan(2); // root + generations + tool
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(expected);
    }
    // Structure is unchanged: root agent span with its generations beneath it.
    const root = spans.find((s) => s.name === "Codex Turn")!;
    expect(obsType(root)).toBe("agent");
    const generations = spans.filter((s) => obsType(s) === "generation");
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(parentId(gen)).toBe(root.spanContext().spanId);
    }
  });

  it("scopes subagent-thread rollouts by thread id so they don't collide", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-child-thread-child.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:thread-child:1`));
    expect(roots[0].spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
  });

  it("nests subagent turns inside the parent's seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2); // parent turn + nested subagent turn
    const expected = seededTraceId(`${seed}:1`);
    for (const root of roots) {
      expect(root.spanContext().traceId).toBe(expected);
    }
  });

  it("uses ordinary root spans when no seed is configured", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), { config: baseConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    expect(parentId(roots[0])).toBeUndefined();
    expect(parentId(roots[1])).toBeUndefined();
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
  });

  it("keeps sidecar dedup working when a seed is set", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    await convertRollout(file, { config: seededConfig });
    expect(turnRoots()).toHaveLength(2);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: seededConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("numbers turns over the full rollout even when earlier turns are deduped", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    // Pretend turn 1 was uploaded by a previous hook invocation.
    fs.writeFileSync(`${file}.langfuse`, "turn-a\n");
    await convertRollout(file, { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));
  });
});

describe("reasoning archives", () => {
  it("exports unclipped structured reasoning through the SDK and uploads it only once", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const payload = {
      type: "reasoning",
      id: "rs-archive",
      content: [],
      summary: [{ type: "summary_text", text: "思考".repeat(20_001) }],
      encrypted_content: "opaque-test-archive".repeat(2_000),
    };
    const lines = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((raw) => JSON.parse(raw));
    const reasoning = lines.find((line) => line.payload.type === "reasoning");
    reasoning.payload = payload;
    const index = lines.indexOf(reasoning);
    const event = {
      timestamp: reasoning.timestamp,
      type: "event_msg",
      payload: {
        type: "agent_reasoning",
        text: payload.summary[0].text,
      },
    };
    lines.splice(index, 0, event);
    fs.writeFileSync(
      file,
      lines
        .map((line) => JSON.stringify(line))
        .join("\n")
        .replaceAll("gpt-5.4", "gpt-5.6-sol") + "\n",
    );
    const config = { ...baseConfig, max_chars: 100 };
    await convertRollout(file, { config });
    const generations = exporter
      .getFinishedSpans()
      .filter((span) => obsType(span) === "generation");
    expect(generations).toHaveLength(2);
    const generation = generations.find((span) =>
      attr(span, "langfuse.observation.usage_details").includes("120"),
    )!;
    const output = JSON.parse(attr(generation, "langfuse.observation.output"));
    expect(output.reasoning).toContain("[truncated");
    expect(output.reasoning_items).toEqual([
      { source: "event_msg", timestamp: event.timestamp, payload: event.payload },
      { source: "response_item", timestamp: reasoning.timestamp, payload },
    ]);
    expect(output.tool_calls).toEqual([
      { id: "call-1", name: "exec_command", arguments: { command: ["ls"] } },
    ]);
    expect(attr(generation, "langfuse.observation.metadata.cctrace.reasoning_schema")).toBe("1");
    expect(generation.attributes).not.toHaveProperty("langfuse.observation.cost_details");
    exporter.reset();
    await convertRollout(file, { config });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("rejects an oversized pending turn before any earlier turn is exported or acknowledged", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const timestamp = "2026-09-13T00:00:00.000Z";
    const pending = [
      {
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "oversized-turn" },
      },
      {
        timestamp,
        type: "response_item",
        payload: { type: "reasoning", encrypted_content: "x".repeat(16 * 1024 * 1024) },
      },
      { timestamp, type: "event_msg", payload: { type: "task_complete" } },
    ];
    fs.appendFileSync(file, pending.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await expect(convertRollout(file, { config: baseConfig })).rejects.toThrow(
      "Rollout event exceeds safety limit",
    );
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(fs.existsSync(file + ".langfuse")).toBe(false);
    expect(fs.existsSync(file + ".langfuse.state.json")).toBe(false);
  });
});

describe("per-turn export backpressure", () => {
  it("flushes completed turns one at a time before acknowledging the snapshot", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");
    const counts: number[] = [];
    const conversion = await convertRollout(file, {
      config: baseConfig,
      deferCommit: true,
      flush: async () => {
        counts.push(
          exporter.getFinishedSpans().filter((span) => span.name === "Codex Turn").length,
        );
        exporter.reset();
        expect(fs.existsSync(file + ".langfuse")).toBe(false);
      },
    });
    expect(counts).toEqual([1, 1]);
    await conversion.commit();
    expect(fs.existsSync(file + ".langfuse")).toBe(true);
  });

  it("does not acknowledge a turn when its flush fails", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    await expect(
      convertRollout(file, {
        config: baseConfig,
        flush: async () => {
          throw new Error("synthetic flush failure");
        },
      }),
    ).rejects.toThrow("synthetic flush failure");
    expect(fs.existsSync(file + ".langfuse")).toBe(false);
    expect(fs.existsSync(file + ".langfuse.state.json")).toBe(false);
  });
});

it("carries native response identity through streaming conversion to Langfuse", async () => {
  const dir = stageFixtures();
  const file = path.join(dir, "rollout-basic-main.jsonl");
  let responseNumber = 0;
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .flatMap((raw) => {
      const entry = JSON.parse(raw);
      if (entry.type !== "event_msg" || entry.payload.type !== "token_count") return [entry];
      return [
        {
          timestamp: entry.timestamp,
          type: "token_usage_record",
          payload: {
            thread_id: "sess-basic",
            turn_id: "turn-1",
            response_id: `resp-${++responseNumber}`,
            usage: entry.payload.info.last_token_usage,
          },
        },
        entry,
      ];
    });
  fs.writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await convertRollout(file, { config: baseConfig });
  const generations = exporter.getFinishedSpans().filter((span) => obsType(span) === "generation");
  expect(generations).toHaveLength(2);
  expect(
    generations.map((span) => attr(span, "langfuse.observation.metadata.codex.response_id")),
  ).toEqual(["resp-1", "resp-2"]);
  for (const generation of generations) {
    expect(attr(generation, "langfuse.observation.metadata.codex.thread_id")).toBe("sess-basic");
    expect(attr(generation, "langfuse.observation.metadata.codex.turn_id")).toBe("turn-1");
  }
});

describe("ambiguous delivery retry", () => {
  it.each([undefined, "explicit-retry-seed"])(
    "reuses every observation identity after the server accepts but shutdown fails (seed %s)",
    async (seed) => {
      const dir = stageFixtures();
      const file = path.join(dir, "rollout-basic-main.jsonl");
      const config = { ...baseConfig, trace_seed: seed };
      let loseAcknowledgement = true;
      const dependencies = {
        getConfig: async () => config,
        setupInstrumentation: () => ({
          flush: async () => {
            await provider.forceFlush();
          },
          shutdown: async () => {
            await provider.forceFlush();
            if (loseAcknowledgement) throw new Error("accepted by server; acknowledgement lost");
          },
        }),
        convertRollout,
      };

      await expect(runUploadWorker(file, dependencies)).rejects.toThrow("acknowledgement lost");
      const accepted = exporter.getFinishedSpans().slice();
      expect(accepted.filter((span) => obsType(span) === "generation")).toHaveLength(2);
      expect(fs.existsSync(file + ".langfuse")).toBe(false);

      exporter.reset();
      loseAcknowledgement = false;
      await runUploadWorker(file, dependencies);
      const retried = exporter.getFinishedSpans();
      const identities = (spans: ReadableSpan[]) =>
        spans
          .map((span) => [span.name, span.spanContext().traceId, span.spanContext().spanId])
          .sort();
      expect(identities(retried)).toEqual(identities(accepted));

      // Langfuse must receive updates to the same generation IDs, not a second billable set.
      const generations = new Map<string, ReadableSpan>();
      for (const span of [...accepted, ...retried]) {
        if (obsType(span) === "generation") generations.set(span.spanContext().spanId, span);
      }
      expect(generations.size).toBe(2);
      const root = retried.find((span) => span.name === "Codex Turn")!;
      expect(parentId(root)).toBeUndefined();
      expect(attr(root, "langfuse.observation.input")).toContain("List the files");
      expect(attr(root, "langfuse.observation.output")).toContain("two files");
      expect(fs.readFileSync(file + ".langfuse", "utf8")).toBe("turn-1\n");

      exporter.reset();
      await runUploadWorker(file, dependencies);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    },
  );

  it("keeps all 17 native responses unique across uncommitted replays", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "native-retry.jsonl");
    const rows: unknown[] = [];
    const line = (second: number, type: string, payload: Record<string, unknown>) => ({
      timestamp: new Date(Date.UTC(2026, 8, 16, 0, 0, second)).toISOString(),
      type,
      payload,
    });
    rows.push(line(0, "session_meta", { id: "native-retry-thread" }));
    rows.push(line(1, "event_msg", { type: "task_started", turn_id: "native-retry-turn" }));
    rows.push(line(1, "turn_context", { model: "gpt-6-astra" }));
    for (let i = 0; i < 17; i++) {
      rows.push(
        line(2 + 2 * i, "response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
        }),
      );
      rows.push(
        line(3 + 2 * i, "token_usage_record", {
          thread_id: "native-retry-thread",
          turn_id: "native-retry-turn",
          response_id: "resp-" + i,
          usage: {
            input_tokens: 100 + i,
            cached_input_tokens: 40,
            output_tokens: 20,
            total_tokens: 120 + i,
          },
        }),
      );
    }
    rows.push(line(40, "event_msg", { type: "task_complete", turn_id: "native-retry-turn" }));
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    await convertRollout(file, { config: baseConfig, deferCommit: true });
    const first = exporter.getFinishedSpans().filter((span) => obsType(span) === "generation");
    expect(first).toHaveLength(17);
    const byResponse = (spans: ReadableSpan[]) =>
      Object.fromEntries(
        spans.map((span) => [
          attr(span, "langfuse.observation.metadata.codex.response_id"),
          span.spanContext().spanId,
        ]),
      );
    exporter.reset();
    await convertRollout(file, { config: baseConfig, deferCommit: true });
    const second = exporter.getFinishedSpans().filter((span) => obsType(span) === "generation");
    expect(byResponse(second)).toEqual(byResponse(first));
    expect(new Set([...first, ...second].map((span) => span.spanContext().spanId)).size).toBe(17);
    expect(new Set(first.map((span) => span.spanContext().spanId)).size).toBe(17);
  });

  it("keeps copied rollouts and nested subagent observations stable on retry", async () => {
    const firstDir = stageFixtures();
    const secondDir = stageFixtures();
    await convertRollout(path.join(firstDir, "rollout-parent.jsonl"), {
      config: baseConfig,
      deferCommit: true,
    });
    const first = exporter
      .getFinishedSpans()
      .map((span) => span.spanContext())
      .sort((a, b) => a.spanId.localeCompare(b.spanId));
    exporter.reset();
    await convertRollout(path.join(secondDir, "rollout-parent.jsonl"), {
      config: baseConfig,
      deferCommit: true,
    });
    const second = exporter
      .getFinishedSpans()
      .map((span) => span.spanContext())
      .sort((a, b) => a.spanId.localeCompare(b.spanId));
    expect(second).toEqual(first);
  });
});

describe("concurrent session identity isolation", () => {
  it("keeps equal turn IDs in different sessions distinct during concurrent uploads", async () => {
    const a = path.join(stageFixtures(), "rollout-basic-main.jsonl");
    const b = path.join(stageFixtures(), "rollout-basic-main.jsonl");
    fs.writeFileSync(b, fs.readFileSync(b, "utf8").replaceAll("sess-basic", "other-session"));
    await Promise.all([
      convertRollout(a, { config: baseConfig, deferCommit: true }),
      convertRollout(b, { config: baseConfig, deferCommit: true }),
    ]);
    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((span) => obsType(span) === "agent");
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(2);
    expect(new Set(spans.map((span) => span.spanContext().spanId)).size).toBe(spans.length);
    for (const root of roots) {
      expect(parentId(root)).toBeUndefined();
      expect(spans.filter((span) => parentId(span) === root.spanContext().spanId)).toHaveLength(2);
    }
  });
});
