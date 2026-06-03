import { getConfig } from "./config.js";
import { setupInstrumentation } from "./instrumentation.js";
import { convertRollout } from "./trace.js";
import type { HookInput } from "./types.js";
import { debugLog, readStdin, setDebug } from "./utils.js";

/**
 * Entry point for the Codex `Stop` hook.
 *
 * Codex pipes a JSON payload to stdin after every turn. We resolve config,
 * bail out unless tracing is explicitly enabled, then convert the rollout
 * transcript into Langfuse traces.
 *
 * The hook fails open: any error is logged (in debug mode) and swallowed so a
 * tracing problem never blocks the Codex session.
 */
export async function runHook(): Promise<void> {
  let hookInput: HookInput;
  try {
    hookInput = await readStdin<HookInput>();
  } catch (error) {
    // No usable payload — nothing we can do.
    return;
  }

  const config = await getConfig();
  setDebug(config.debug);

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

  const instrumentation = setupInstrumentation(config);
  try {
    await convertRollout(hookInput.transcript_path, { config });
  } catch (error) {
    debugLog("failed to convert rollout:", error);
  } finally {
    try {
      await instrumentation.shutdown();
    } catch (error) {
      debugLog("error during flush/shutdown:", error);
    }
  }
}

runHook().catch((error) => {
  // Last-resort guard: never throw out of the hook.
  if (process.env.LANGFUSE_CODEX_DEBUG === "true") {
    // eslint-disable-next-line no-console
    console.error("[langfuse-codex] fatal:", error);
  }
});
