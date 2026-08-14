import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { debugLog } from "./utils.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONTEXT_BYTES = 16 * 1024;

const IdentifierSchema = z.string().regex(IDENTIFIER);

export const SupportTraceContextSchema = z
  .object({
    version: z.literal(1),
    thread_id: IdentifierSchema,
    turn_id: IdentifierSchema,
    session_id: IdentifierSchema,
    user_id: IdentifierSchema,
    run_id: IdentifierSchema,
    environment: IdentifierSchema,
    channel: IdentifierSchema,
    trace_seed: IdentifierSchema,
    prompt_version: IdentifierSchema.optional(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type SupportTraceContext = z.infer<typeof SupportTraceContextSchema>;

function safeIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

/**
 * Read CloseClaw's per-turn tracing context without ever blocking an upload.
 *
 * The Adapter writes `<root>/<threadId>/<turnId>.json` atomically with mode
 * 0600. Both path components and the document are validated again here so a
 * malformed rollout or sidecar cannot escape the configured directory or add
 * arbitrary Langfuse attributes.
 */
export async function loadSupportTraceContext(
  root: string,
  threadId: string,
  turnId: string,
): Promise<SupportTraceContext | undefined> {
  if (!path.isAbsolute(root) || !safeIdentifier(threadId) || !safeIdentifier(turnId)) {
    debugLog("ignored support context with an unsafe root, thread id, or turn id");
    return undefined;
  }

  const file = path.join(root, threadId, `${turnId}.json`);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > MAX_CONTEXT_BYTES) {
      debugLog(`ignored invalid support context for ${threadId}/${turnId}`);
      return undefined;
    }
    const parsed = SupportTraceContextSchema.safeParse(
      JSON.parse(await fs.readFile(file, "utf-8")) as unknown,
    );
    if (!parsed.success || parsed.data.thread_id !== threadId || parsed.data.turn_id !== turnId) {
      debugLog(`ignored mismatched support context for ${threadId}/${turnId}`);
      return undefined;
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      debugLog(`could not read support context for ${threadId}/${turnId}`);
    }
    return undefined;
  }
}
