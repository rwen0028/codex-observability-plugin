import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

import { getConfig } from "./config.js";
import { setupInstrumentation } from "./instrumentation.js";
import { acquireRolloutLock, queueRollout, writeUploadStatus } from "./sidecar.js";
import { convertRollout } from "./trace.js";
import { debugLog, setDebug } from "./utils.js";

export const WORKER_ARGUMENT = "--cctrace-upload-worker";

export function launchUploadWorker(scriptFile: string, rolloutFile: string, attempt = 0): void {
  const child = spawn(
    process.execPath,
    [scriptFile, WORKER_ARGUMENT, rolloutFile, String(attempt)],
    {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: "ignore",
    },
  );
  child.once("error", (error) => {
    debugLog("failed to start background uploader:", error);
    void setStatusBestEffort(rolloutFile, {
      status: "error",
      error: "failed to start background uploader: " + String(error),
    });
  });
  child.unref();
}

/** Persist work before starting a detached uploader, then let Stop return. */
export async function queueAndLaunchUpload(
  scriptFile: string,
  rolloutFile: string,
  launch: typeof launchUploadWorker = launchUploadWorker,
): Promise<void> {
  const stat = await fs.stat(rolloutFile);
  await queueRollout(rolloutFile, stat.size);
  // Status is diagnostic only: failure to write it must not strand queued work.
  await setStatusBestEffort(rolloutFile, { status: "queued", snapshotBytes: stat.size });
  launch(scriptFile, rolloutFile);
}

export type WorkerDependencies = {
  getConfig: typeof getConfig;
  setupInstrumentation: typeof setupInstrumentation;
  convertRollout: typeof convertRollout;
};

const defaultDependencies: WorkerDependencies = { getConfig, setupInstrumentation, convertRollout };

async function setStatusBestEffort(
  rolloutFile: string,
  status: Parameters<typeof writeUploadStatus>[1],
): Promise<void> {
  try {
    await writeUploadStatus(rolloutFile, status);
  } catch (error) {
    debugLog("failed to write uploader status:", error);
  }
}

/**
 * Upload one stable file snapshot outside the Stop hook's timeout window.
 * Returns the processed snapshot size, or undefined when another worker owns
 * the rollout or tracing is not configured.
 */
export async function runUploadWorker(
  rolloutFile: string,
  dependencies: WorkerDependencies = defaultDependencies,
): Promise<number | undefined> {
  if (!rolloutFile) throw new Error("worker rollout path is empty");
  const lock = await acquireRolloutLock(rolloutFile);
  if (!lock) return undefined;

  try {
    const config = await dependencies.getConfig();
    setDebug(config.debug);
    if (!config.enabled || !config.public_key || !config.secret_key) {
      await setStatusBestEffort(rolloutFile, {
        status: "error",
        error: "tracing disabled or Langfuse credentials missing",
      });
      return undefined;
    }

    const stat = await fs.stat(rolloutFile);
    const snapshotBytes = stat.size;
    await setStatusBestEffort(rolloutFile, { status: "uploading", snapshotBytes });

    const instrumentation = dependencies.setupInstrumentation(config);
    try {
      const conversion = await dependencies.convertRollout(rolloutFile, {
        config,
        snapshotBytes,
        deferCommit: true,
        flush: instrumentation.flush,
      });
      // The legacy implementation wrote turn ids before this awaited flush.
      // A timeout/crash could therefore claim success for data never exported.
      await instrumentation.shutdown();
      await conversion.commit();
      await setStatusBestEffort(rolloutFile, {
        status: "ok",
        snapshotBytes,
        committedOffset: conversion.scan.state.committedOffset,
        uploadedTurns: conversion.emittedTurns,
        skippedTurns: conversion.scan.skippedTurns,
      });
      return snapshotBytes;
    } catch (error) {
      await setStatusBestEffort(rolloutFile, { status: "error", error: String(error) });
      throw error;
    }
  } finally {
    await lock.release();
  }
}

export async function runWorkerWithRetry(
  scriptFile: string,
  rolloutFile: string,
  attempt: number,
): Promise<void> {
  try {
    const snapshotBytes = await runUploadWorker(rolloutFile);
    if (snapshotBytes == null) return;

    // Recheck only after the first worker released its lock. A Stop racing
    // with this check either grows the file before the stat below or launches
    // its own worker after the lock is free, so no queued bytes are stranded.
    const latest = await fs.stat(rolloutFile);
    if (latest.size > snapshotBytes) {
      launchUploadWorker(scriptFile, rolloutFile);
    }
  } catch (error) {
    debugLog("background upload failed:", error);
    if (attempt >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1_000 : 5_000));
    launchUploadWorker(scriptFile, rolloutFile, attempt + 1);
  }
}
