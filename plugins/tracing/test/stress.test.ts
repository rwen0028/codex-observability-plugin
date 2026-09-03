import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanRollout } from "../src/stream.js";
import type { RolloutLine } from "../src/types.js";

const requestedMiB = Number.parseInt(process.env.CCTRACE_STRESS_MIB ?? "0", 10);
const stress = requestedMiB > 0 ? describe : describe.skip;
const tmpDirs: string[] = [];

const jsonLine = (line: RolloutLine) => `${JSON.stringify(line)}\n`;

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

stress("large rollout stress", () => {
  it(`streams ${requestedMiB} MiB with bounded RSS and finds the pending turn`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-stress-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "rollout.jsonl");
    const descriptor = fs.openSync(file, "w");
    const timestamp = "2026-09-03T00:00:00.000Z";
    const session: RolloutLine = {
      timestamp,
      type: "session_meta",
      payload: { id: "stress-session", cli_version: "0.144.0" },
    };
    const uploadedStart: RolloutLine = {
      timestamp,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "already-uploaded" },
    };
    const oversized: RolloutLine = {
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "old-call",
        output: "x".repeat(2 * 1024 * 1024),
      },
    };
    const oversizedLine = jsonLine(oversized);
    let written = 0;
    const write = (value: string) => {
      fs.writeSync(descriptor, value);
      written += Buffer.byteLength(value);
    };

    write(jsonLine(session));
    write(jsonLine(uploadedStart));
    const targetBytes = requestedMiB * 1024 * 1024;
    while (written + Buffer.byteLength(oversizedLine) < targetBytes) write(oversizedLine);
    write(
      jsonLine({
        timestamp,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "already-uploaded" },
      }),
    );
    for (const line of [
      { type: "task_started", turn_id: "pending-turn" },
      { type: "user_message", message: "pending question" },
      { type: "agent_message", message: "pending answer" },
      { type: "task_complete", turn_id: "pending-turn" },
    ]) {
      write(jsonLine({ timestamp, type: "event_msg", payload: line }));
    }
    fs.closeSync(descriptor);

    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 2);
    const turns: string[] = [];
    try {
      const result = await scanRollout(file, {
        uploadedTurnIds: new Set(["already-uploaded"]),
        maxChars: 100,
        onTurn: async ({ turn }) => {
          turns.push(turn.turnId!);
        },
      });
      expect(result.skippedTurns).toBe(1);
      expect(result.state.committedOffset).toBe(fs.statSync(file).size);
    } finally {
      clearInterval(sample);
    }

    expect(turns).toEqual(["pending-turn"]);
    expect(peakRss - baselineRss).toBeLessThan(128 * 1024 * 1024);
  }, 120_000);
});
