import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSupportTraceContext } from "../src/support-context.js";

const tmpDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cctrace-support-context-"));
  tmpDirs.push(root);
  return root;
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    thread_id: "thread-1",
    turn_id: "turn-1",
    session_id: "support-session-1",
    user_id: "support-user-1",
    run_id: "support-run-1",
    environment: "test",
    channel: "portal",
    trace_seed: "support-seed-1",
    prompt_version: "v1",
    created_at: "2026-08-14T09:00:00.000Z",
    ...overrides,
  };
}

function writeContext(root: string, value: Record<string, unknown>): void {
  const dir = path.join(root, "thread-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "turn-1.json"), JSON.stringify(value), { mode: 0o600 });
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("loadSupportTraceContext", () => {
  it("loads a strict context whose path and document ids match", async () => {
    const root = makeRoot();
    writeContext(root, context());
    expect(await loadSupportTraceContext(root, "thread-1", "turn-1")).toEqual(context());
  });

  it("fails open for missing, mismatched, extra, oversized, and unsafe contexts", async () => {
    const missing = makeRoot();
    expect(await loadSupportTraceContext(missing, "thread-1", "turn-1")).toBeUndefined();

    const mismatched = makeRoot();
    writeContext(mismatched, context({ turn_id: "turn-2" }));
    expect(await loadSupportTraceContext(mismatched, "thread-1", "turn-1")).toBeUndefined();

    const extra = makeRoot();
    writeContext(extra, context({ email: "customer@example.com" }));
    expect(await loadSupportTraceContext(extra, "thread-1", "turn-1")).toBeUndefined();

    const oversized = makeRoot();
    writeContext(oversized, context({ padding: "x".repeat(20_000) }));
    expect(await loadSupportTraceContext(oversized, "thread-1", "turn-1")).toBeUndefined();

    expect(await loadSupportTraceContext(makeRoot(), "../escape", "turn-1")).toBeUndefined();
  });
});
