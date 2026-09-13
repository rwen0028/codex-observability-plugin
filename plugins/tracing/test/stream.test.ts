import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_MAX_LINE_BYTES, MAX_RETAINED_TURN_BYTES, scanRollout } from "../src/stream.js";
import type { RolloutLine, Turn } from "../src/types.js";

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

  it("preserves long reasoning records independently of the display limit", async () => {
    const file = makeRollout();
    const [start, user, , complete] = turnLines(1);
    const payload = {
      type: "reasoning",
      id: "long-reasoning",
      content: [],
      summary: [{ type: "summary_text", text: "思考".repeat(20_001) }],
      encrypted_content: "opaque".repeat(30_000),
    };
    fs.writeFileSync(
      file,
      encode([
        sessionLine(),
        start,
        user,
        {
          timestamp: start.timestamp,
          type: "response_item",
          payload,
        },
        complete,
      ]),
    );
    const turns: Turn[] = [];
    await scanRollout(file, {
      uploadedTurnIds: new Set(),
      maxChars: 100,
      onTurn: async ({ turn }) => {
        turns.push(turn);
      },
    });
    expect(turns[0].steps[0].reasoning).toBe(payload.summary[0].text);
    expect(turns[0].steps[0].reasoningItems?.[0].payload).toEqual(payload);
  });

  it("does not mistake a trailing analysis message for the final answer", async () => {
    const file = makeRollout();
    const [start, user, , complete] = turnLines(1);
    fs.writeFileSync(
      file,
      encode([
        sessionLine(),
        start,
        user,
        {
          timestamp: start.timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            channel: "analysis",
            content: [{ type: "output_text", text: "still thinking" }],
          },
        },
      ]),
    );
    const turns: Turn[] = [];
    const first = await scanRollout(file, {
      uploadedTurnIds: new Set(),
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        turns.push(turn);
      },
    });
    expect(turns).toEqual([]);
    expect(first.state.committedOffset).toBe(Buffer.byteLength(encode([sessionLine()])));
    fs.appendFileSync(file, encode([complete]));
    await scanRollout(file, {
      uploadedTurnIds: new Set(),
      previousState: first.state,
      maxChars: 20_000,
      onTurn: async ({ turn }) => {
        turns.push(turn);
      },
    });
    expect(turns[0].steps[0].reasoning).toBe("still thinking");
    expect(turns[0].finalOutput).toBeUndefined();
  });

  it("fails explicitly on oversized unuploaded records instead of claiming a complete archive", async () => {
    const file = makeRollout();
    const [start, user, , complete] = turnLines(1);
    const large = {
      timestamp: start.timestamp,
      type: "response_item",
      payload: {
        type: "reasoning",
        encrypted_content: "x".repeat(MAX_MAX_LINE_BYTES),
      },
    };
    fs.writeFileSync(file, encode([sessionLine(), start, user, large, complete]));
    const turns: Turn[] = [];
    const options = {
      uploadedTurnIds: new Set<string>(),
      maxChars: 100,
      onTurn: async ({ turn }: { turn: Turn }) => {
        turns.push(turn);
      },
    };
    await expect(scanRollout(file, options)).rejects.toThrow("Rollout event exceeds safety limit");
    expect(turns).toEqual([]);
    const skipped = await scanRollout(file, { ...options, uploadedTurnIds: new Set(["turn-1"]) });
    expect(skipped.skippedTurns).toBe(1);
    expect(skipped.state.committedOffset).toBe(fs.statSync(file).size);
  });

  it("bounds retained data across many reasoning records in one turn", async () => {
    const file = makeRollout();
    const [start, , , complete] = turnLines(1);
    const item: RolloutLine = {
      timestamp: start.timestamp,
      type: "response_item",
      payload: {
        type: "reasoning",
        encrypted_content: "x".repeat(MAX_RETAINED_TURN_BYTES / 4),
      },
    };
    fs.writeFileSync(file, encode([sessionLine(), start, item, item, item, item, complete]));
    await expect(
      scanRollout(file, {
        uploadedTurnIds: new Set(),
        maxChars: 100,
        onTurn: async () => {},
      }),
    ).rejects.toThrow("Retained rollout turn exceeds safety limit");
  });
});
