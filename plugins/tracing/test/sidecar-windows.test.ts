import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadUploadedTurnIds,
  loadUploadState,
  markTurnsUploaded,
  queueRollout,
  rolloutIdentity,
  writeUploadState,
  writeUploadStatus,
} from "../src/sidecar.js";
import { queueAndLaunchUpload } from "../src/worker.js";

const fault = vi.hoisted(() => ({ stage: "" }));

// Exercise real files, while enforcing Windows' rejection of fsync on read-only handles.
// These regressions run on Linux too; CI also runs the suite on native Windows.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (code: string) =>
    Object.assign(new Error(code + ": injected filesystem failure"), { code });
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fault.stage === "open") throw fail("EIO");
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (args[1] === "r" || args[1] === "rs") throw fail("EPERM");
        if (fault.stage === "sync") throw fail("EIO");
        return sync();
      });
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fault.stage === "rename") throw fail("EIO");
      return actual.rename(...args);
    },
  };
});

const tmpDirs: string[] = [];
function makeRollout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-windows-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, "{}\n");
  return file;
}

afterEach(() => {
  fault.stage = "";
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("Windows-compatible durable sidecars", () => {
  it("persists the pending watermark and starts the worker with Windows fsync semantics", async () => {
    const file = makeRollout();
    const launch = vi.fn(() => {
      expect(JSON.parse(fs.readFileSync(file + ".langfuse.pending.json", "utf8"))).toMatchObject({
        snapshotBytes: 3,
      });
      expect(JSON.parse(fs.readFileSync(file + ".langfuse.status.json", "utf8"))).toMatchObject({
        status: "queued",
      });
    });
    await queueAndLaunchUpload("plugin.mjs", file, launch);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("updates checkpoints, status and acknowledgements with Windows fsync semantics", async () => {
    const file = makeRollout();
    const stat = fs.statSync(file);
    const state = {
      version: 2 as const,
      identity: rolloutIdentity(stat),
      committedOffset: stat.size,
      turnNumber: 1,
      sessionMeta: { sessionId: "windows-test" },
      updatedAt: new Date().toISOString(),
    };
    await writeUploadState(file, state);
    expect(await loadUploadState(file, stat)).toEqual(state);
    await writeUploadStatus(file, { status: "uploading" });
    await writeUploadStatus(file, { status: "ok", uploadedTurns: 1 });
    expect(JSON.parse(fs.readFileSync(file + ".langfuse.status.json", "utf8"))).toMatchObject({
      status: "ok",
      uploadedTurns: 1,
    });
    await markTurnsUploaded(file, ["turn-1"]);
    expect(await loadUploadedTurnIds(file)).toEqual(new Set(["turn-1"]));
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".tmp."))).toBe(false);
  });

  it.each(["open", "sync", "rename"])(
    "preserves the previous queue on %s failure, cleans the temporary file, and permits retry",
    async (stage) => {
      const file = makeRollout();
      await queueRollout(file, 1);
      const previous = fs.readFileSync(file + ".langfuse.pending.json", "utf8");
      const launch = vi.fn();
      fault.stage = stage;
      await expect(queueAndLaunchUpload("plugin.mjs", file, launch)).rejects.toThrow("EIO");
      expect(launch).not.toHaveBeenCalled();
      expect(fs.readFileSync(file + ".langfuse.pending.json", "utf8")).toBe(previous);
      expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".tmp."))).toBe(false);
      fault.stage = "";
      await queueAndLaunchUpload("plugin.mjs", file, launch);
      expect(launch).toHaveBeenCalledOnce();
    },
  );
});
