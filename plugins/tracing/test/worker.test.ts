import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { rolloutIdentity } from "../src/sidecar.js";
import { queueAndLaunchUpload, runUploadWorker, type WorkerDependencies } from "../src/worker.js";

const tmpDirs: string[] = [];

function makeRollout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-worker-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, "{}\n");
  return file;
}

const config: Config = {
  enabled: true,
  public_key: "pk-test",
  secret_key: "sk-test",
  base_url: "https://langfuse.invalid",
  support_context_dir: path.join(os.tmpdir(), "missing-support-context"),
  pricing_mode: "standard",
  regional_processing: false,
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

function dependenciesFor(
  file: string,
  order: string[],
  options?: { flushError?: Error },
): WorkerDependencies {
  const stat = fs.statSync(file);
  return {
    getConfig: async () => config,
    setupInstrumentation: () => ({
      flush: async () => {
        order.push("flush-turn");
      },
      shutdown: async () => {
        order.push("flush");
        if (options?.flushError) throw options.flushError;
      },
    }),
    convertRollout: async () => {
      order.push("convert");
      return {
        emittedTurns: 1,
        scan: {
          state: {
            version: 2,
            identity: rolloutIdentity(stat),
            committedOffset: stat.size,
            turnNumber: 1,
            sessionMeta: { sessionId: "session-worker" },
            updatedAt: new Date().toISOString(),
          },
          snapshotBytes: stat.size,
          scannedBytes: stat.size,
          skippedTurns: 0,
          oversizedLines: 0,
        },
        commit: async () => {
          order.push("commit");
        },
      };
    },
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("background uploader", () => {
  it("writes the pending watermark before launching a worker", async () => {
    const file = makeRollout();
    const calls: string[] = [];

    await queueAndLaunchUpload("/plugin/index.mjs", file, (script, rollout) => {
      expect(fs.existsSync(`${file}.langfuse.pending.json`)).toBe(true);
      expect(fs.existsSync(`${file}.langfuse.status.json`)).toBe(true);
      calls.push(script, rollout);
    });

    expect(calls).toEqual(["/plugin/index.mjs", file]);
    const status = JSON.parse(fs.readFileSync(`${file}.langfuse.status.json`, "utf-8"));
    expect(status).toMatchObject({ status: "queued", snapshotBytes: fs.statSync(file).size });
  });

  it("commits acknowledgements strictly after exporter shutdown succeeds", async () => {
    const file = makeRollout();
    const order: string[] = [];

    const snapshot = await runUploadWorker(file, dependenciesFor(file, order));

    expect(snapshot).toBe(fs.statSync(file).size);
    expect(order).toEqual(["convert", "flush", "commit"]);
    const status = JSON.parse(fs.readFileSync(`${file}.langfuse.status.json`, "utf-8"));
    expect(status).toMatchObject({ status: "ok", uploadedTurns: 1 });
    expect(fs.existsSync(`${file}.langfuse.lock`)).toBe(false);
  });

  it("does not commit when exporter shutdown fails", async () => {
    const file = makeRollout();
    const order: string[] = [];

    await expect(
      runUploadWorker(
        file,
        dependenciesFor(file, order, { flushError: new Error("network timeout") }),
      ),
    ).rejects.toThrow("network timeout");

    expect(order).toEqual(["convert", "flush"]);
    const status = JSON.parse(fs.readFileSync(`${file}.langfuse.status.json`, "utf-8"));
    expect(status).toMatchObject({ status: "error", error: "Error: network timeout" });
    expect(fs.existsSync(`${file}.langfuse.lock`)).toBe(false);
  });
});
