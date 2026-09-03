import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanRollout } from "../src/stream.js";
import type { RolloutLine } from "../src/types.js";

const tmpDirs: string[] = [];

function makeRollout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-stream-"));
  tmpDirs.push(dir);
  return path.join(dir, "rollout.jsonl");
}

const encode = (lines: RolloutLine[]): string =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

function sessionLine(id = "session-stream"): RolloutLine {
  return {
    timestamp: "2026-09-03T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cli_version: "0.144.0", model_provider: "openai" },
  };
}

function turnLines(index: number): RolloutLine[] {
  const turnId = `turn-${index}`;
  const timestamp = new Date(Date.UTC(2026, 8, 3, 0, 0, index)).toISOString();
  return [
    {
      timestamp,
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: `question ${index}` },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", message: `answer ${index}` },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId },
    },
  ];
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("scanRollout", () => {
  it("migrates a legacy 331-uploaded / 76-pending rollout without retaining old turns", async () => {
    const file = makeRollout();
    const lines: RolloutLine[] = [sessionLine()];
    for (let index = 1; index <= 407; index++) lines.push(...turnLines(index));
    fs.writeFileSync(file, encode(lines));

    const uploaded = new Set(Array.from({ length: 331 }, (_, index) => `turn-${index + 1}`));
    const pending: string[] = [];
    const result = await scanRollout(file, {
      uploadedTurnIds: uploaded,
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        pending.push(turn.turnId!);
      },
    });

    expect(result.skippedTurns).toBe(331);
    expect(pending).toHaveLength(76);
    expect(pending[0]).toBe("turn-332");
    expect(pending.at(-1)).toBe("turn-407");
    expect(result.state.turnNumber).toBe(407);
    expect(result.state.committedOffset).toBe(fs.statSync(file).size);
  });

  it("reads only bytes appended after the committed v2 offset", async () => {
    const file = makeRollout();
    fs.writeFileSync(file, encode([sessionLine(), ...turnLines(1)]));
    const firstIds: string[] = [];
    const first = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        firstIds.push(turn.turnId!);
      },
    });
    expect(firstIds).toEqual(["turn-1"]);

    const appended = encode(turnLines(2));
    fs.appendFileSync(file, appended);
    const secondIds: string[] = [];
    const second = await scanRollout(file, {
      uploadedTurnIds: new Set(["turn-1"]),
      previousState: first.state,
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        secondIds.push(turn.turnId!);
      },
    });

    expect(secondIds).toEqual(["turn-2"]);
    expect(second.scannedBytes).toBe(Buffer.byteLength(appended));
    expect(second.state.turnNumber).toBe(2);
  });

  it("revisits a trailing empty turn and a partial JSON line on the next scan", async () => {
    const file = makeRollout();
    const start = turnLines(1)[0];
    const user = turnLines(1)[1];
    const complete = turnLines(1)[3];
    const prefix = encode([sessionLine(), start]);
    const userJson = JSON.stringify(user);
    fs.writeFileSync(file, `${prefix}${userJson.slice(0, 25)}`);

    const firstIds: string[] = [];
    const first = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        firstIds.push(turn.turnId!);
      },
    });
    expect(firstIds).toEqual([]);
    expect(first.state.turnNumber).toBe(0);
    expect(first.state.committedOffset).toBe(Buffer.byteLength(encode([sessionLine()])));

    fs.appendFileSync(file, `${userJson.slice(25)}\n${JSON.stringify(complete)}\n`);
    const secondIds: string[] = [];
    const second = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      previousState: first.state,
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        secondIds.push(turn.turnId!);
      },
    });
    expect(secondIds).toEqual(["turn-1"]);
    expect(second.state.turnNumber).toBe(1);
    expect(second.state.committedOffset).toBe(fs.statSync(file).size);
  });

  it("does not checkpoint a trailing turn before its final output is written", async () => {
    const file = makeRollout();
    const [start, user, agent, complete] = turnLines(1);
    const prefix = encode([sessionLine(), start, user]);
    fs.writeFileSync(file, prefix);

    const firstIds: string[] = [];
    const first = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        firstIds.push(turn.turnId!);
      },
    });
    expect(firstIds).toEqual([]);
    expect(first.state.turnNumber).toBe(0);
    expect(first.state.committedOffset).toBe(Buffer.byteLength(encode([sessionLine()])));

    fs.appendFileSync(file, encode([agent, complete]));
    const secondIds: string[] = [];
    const second = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      previousState: first.state,
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        secondIds.push(turn.turnId!);
      },
    });

    expect(secondIds).toEqual(["turn-1"]);
    expect(second.state.turnNumber).toBe(1);
    expect(second.state.committedOffset).toBe(fs.statSync(file).size);
  });

  it("bounds a pathological event and revisits it until the turn completes", async () => {
    const file = makeRollout();
    const [start, user, , complete] = turnLines(1);
    const hugeOutput: RolloutLine = {
      timestamp: "2026-09-03T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-huge",
        output: "x".repeat(2 * 1024 * 1024),
      },
    };
    fs.writeFileSync(file, encode([sessionLine(), start, user, hugeOutput]));

    const turns: string[] = [];
    const result = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      maxChars: 100,
      onTurn: async ({ turn }) => {
        turns.push(turn.turnId!);
      },
    });

    expect(turns).toEqual([]);
    expect(result.oversizedLines).toBe(1);
    expect(result.state.committedOffset).toBe(Buffer.byteLength(encode([sessionLine()])));

    fs.appendFileSync(file, encode([complete]));
    const retried: string[] = [];
    const second = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      previousState: result.state,
      maxChars: 100,
      onTurn: async ({ turn }) => {
        retried.push(turn.turnId!);
      },
    });

    expect(retried).toEqual(["turn-1"]);
    expect(second.oversizedLines).toBe(1);
    expect(second.state.committedOffset).toBe(fs.statSync(file).size);
  });
});
