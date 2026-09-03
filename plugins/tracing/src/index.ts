import { fileURLToPath } from "node:url";

import { getConfig } from "./config.js";
import type { HookInput } from "./types.js";
import { debugLog, readStdin, setDebug } from "./utils.js";
import { queueAndLaunchUpload, runWorkerWithRetry, WORKER_ARGUMENT } from "./worker.js";

let failOnError = process.env.LANGFUSE_CODEX_FAIL_ON_ERROR === "true";
const scriptFile = fileURLToPath(import.meta.url);

/**
 * Entry point for the Codex `Stop` hook.
 *
 * Codex pipes a JSON payload to stdin after every turn. We resolve config,
 * bail out unless tracing is explicitly enabled, durably queue the rollout,
 * and launch a detached uploader. Parsing and network I/O happen outside the
 * Stop hook's timeout window.
 *
 * The hook fails open: any error is logged (in debug mode) and swallowed so a
 * tracing problem never blocks the Codex session. Set
 * `LANGFUSE_CODEX_FAIL_ON_ERROR=true` while testing if you want Codex to report
 * hook failures instead.
 */
export async function runHook(): Promise<void> {
  let hookInput: HookInput;
  try {
    hookInput = await readStdin<HookInput>();
  } catch {
    // No usable payload — nothing we can do.
    return;
  }

  const config = await getConfig();
  setDebug(config.debug);
  failOnError = config.fail_on_error;

  if (!config.enabled) {
    debugLog("tracing disabled (set TRACE_TO_LANGFUSE=true to enable)");
    return;
  }
  if (!config.public_key || !config.secret_key) {
    debugLog("missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY; skipping");
    return;
  }
  if (!hookInput.transcript_path) {
    debugLog("hook payload missing transcript_path; skipping");
    return;
  }

  try {
    await queueAndLaunchUpload(scriptFile, hookInput.transcript_path);
  } catch (error) {
    debugLog("failed to queue rollout upload:", error);
    if (config.fail_on_error) throw error;
  }
}

const workerArgumentIndex = process.argv.indexOf(WORKER_ARGUMENT);
const entrypoint =
  workerArgumentIndex >= 0
    ? runWorkerWithRetry(
        scriptFile,
        process.argv[workerArgumentIndex + 1] ?? "",
        Number.parseInt(process.argv[workerArgumentIndex + 2] ?? "0", 10) || 0,
      )
    : runHook();

entrypoint.catch((error) => {
  // Last-resort guard: fail open unless explicitly requested for testing.
  if (process.env.LANGFUSE_CODEX_DEBUG === "true") {
    // eslint-disable-next-line no-console
    console.error("[langfuse-codex] fatal:", error);
  }
  if (failOnError) {
    process.exitCode = 1;
  }
});
