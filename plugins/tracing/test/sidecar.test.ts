import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireRolloutLock,
  loadUploadedTurnIds,
  loadUploadState,
  markTurnsUploaded,
  queueRollout,
  rolloutIdentity,
  writeUploadState,
  writeUploadStatus,
} from "../src/sidecar.js";

const tmpDirs: string[] = [];

function makeRollout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-sidecar-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, "{}\n");
  return file;
}

function expectSidecarPermissions(file: string): void {
  const mode = fs.statSync(file).mode;
  expect(mode & 0o200).toBe(0o200);
  // Windows uses ACLs; Node chmod cannot enforce POSIX owner/group mode bits.
  if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("v2 upload sidecars", () => {
  it("appends turn acknowledgements durably with private permissions", async () => {
    const file = makeRollout();
    await markTurnsUploaded(file, ["turn-1", "turn-2"]);

    expect(await loadUploadedTurnIds(file)).toEqual(new Set(["turn-1", "turn-2"]));
    expectSidecarPermissions(`${file}.langfuse`);
  });

  it("loads state only for the same rollout inode and a valid offset", async () => {
    const file = makeRollout();
    const stat = fs.statSync(file);
    const state = {
      version: 2 as const,
      identity: rolloutIdentity(stat),
      committedOffset: stat.size,
      turnNumber: 3,
      sessionMeta: { sessionId: "session-1", cliVersion: "0.144.0" },
      updatedAt: new Date().toISOString(),
    };
    await writeUploadState(file, state);

    expect(await loadUploadState(file, stat)).toEqual(state);
    expectSidecarPermissions(`${file}.langfuse.state.json`);
    expect(await loadUploadState(file, { ...stat, ino: Number(stat.ino) + 1 })).toBeUndefined();
    expect(await loadUploadState(file, { ...stat, size: stat.size - 1 })).toBeUndefined();
  });

  it("writes bounded redacted status and a durable pending watermark", async () => {
    const file = makeRollout();
    await queueRollout(file, 1234);
    const pending = JSON.parse(fs.readFileSync(`${file}.langfuse.pending.json`, "utf-8"));
    expect(pending).toMatchObject({ version: 1, snapshotBytes: 1234 });

    await writeUploadStatus(file, {
      status: "error",
      error: `token=do-not-log password:also-secret ${"x".repeat(1000)}`,
    });
    const raw = fs.readFileSync(`${file}.langfuse.status.json`, "utf-8");
    expect(raw).not.toContain("do-not-log");
    expect(raw).not.toContain("also-secret");
    expect(raw.length).toBeLessThan(700);
    expectSidecarPermissions(`${file}.langfuse.status.json`);
  });

  it("serializes workers and recovers a lock left by a dead pid", async () => {
    const file = makeRollout();
    const first = await acquireRolloutLock(file);
    expect(first).toBeDefined();
    expect(await acquireRolloutLock(file)).toBeUndefined();
    await first!.release();

    fs.writeFileSync(`${file}.langfuse.lock`, "999999999\n", { mode: 0o600 });
    const recovered = await acquireRolloutLock(file);
    expect(recovered).toBeDefined();
    await recovered!.release();
  });
});
