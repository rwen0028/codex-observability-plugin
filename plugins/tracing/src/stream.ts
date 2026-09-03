import * as fs from "node:fs/promises";

import { parseSession } from "./parse.js";
import { rolloutIdentity, type UploadState } from "./sidecar.js";
import type { RolloutLine, SessionMeta, Turn } from "./types.js";

const READ_BUFFER_BYTES = 64 * 1024;
export const MIN_MAX_LINE_BYTES = 1024 * 1024;
export const MAX_MAX_LINE_BYTES = 16 * 1024 * 1024;

export type StreamedTurn = {
  turn: Turn;
  turnNumber: number;
  sessionMeta: SessionMeta;
};

export type RolloutScanResult = {
  state: UploadState;
  snapshotBytes: number;
  scannedBytes: number;
  skippedTurns: number;
  oversizedLines: number;
};

type ActiveTurn = {
  turnId?: string;
  turnNumber: number;
  skipped: boolean;
  completed: boolean;
  finalOutputSeen: boolean;
  lines: RolloutLine[];
  lastTimestamp: string;
  startOffset: number;
};

function maxLineBytes(maxChars: number): number {
  return Math.max(MIN_MAX_LINE_BYTES, Math.min(MAX_MAX_LINE_BYTES, maxChars * 8));
}

/** Truncate strings before parsed events are retained in a turn-sized buffer. */
function truncateStrings(value: unknown, maxChars: number): void {
  if (value == null || typeof value !== "object") return;
  const stack: unknown[] = [value];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        const item = current[index];
        if (typeof item === "string" && item.length > maxChars) {
          current[index] =
            `${item.slice(0, maxChars)}\n…[truncated ${item.length - maxChars} chars]`;
        } else if (item != null && typeof item === "object") {
          stack.push(item);
        }
      }
      continue;
    }

    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (typeof item === "string" && item.length > maxChars) {
        (current as Record<string, unknown>)[key] =
          `${item.slice(0, maxChars)}\n…[truncated ${item.length - maxChars} chars]`;
      } else if (item != null && typeof item === "object") {
        stack.push(item);
      }
    }
  }
}

function parseLine(raw: string, maxChars: number): RolloutLine | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const line = JSON.parse(trimmed) as RolloutLine;
    if (line == null || typeof line !== "object") return undefined;
    truncateStrings(line, maxChars);
    return line;
  } catch {
    return undefined;
  }
}

function isTaskStarted(line: RolloutLine): boolean {
  return line.type === "event_msg" && (line.payload as { type?: string }).type === "task_started";
}
function isTaskComplete(line: RolloutLine): boolean {
  return line.type === "event_msg" && (line.payload as { type?: string }).type === "task_complete";
}

function isFinalOutputLine(line: RolloutLine): boolean {
  const payload = line.payload as { type?: string; role?: string };
  return (
    (line.type === "event_msg" && payload.type === "agent_message") ||
    (line.type === "response_item" && payload.type === "message" && payload.role === "assistant")
  );
}

function updateSessionMeta(current: SessionMeta, line: RolloutLine): SessionMeta {
  if (line.type !== "session_meta") return current;
  const payload = line.payload as RolloutLine["payload"] & {
    id?: string;
    cli_version?: string;
    model_provider?: string | null;
    parent_thread_id?: string | null;
    thread_source?: string | null;
  };
  return {
    sessionId: typeof payload.id === "string" ? payload.id : current.sessionId,
    cliVersion: payload.cli_version,
    modelProvider: payload.model_provider ?? undefined,
    isSubagentThread:
      typeof payload.parent_thread_id === "string" || payload.thread_source === "subagent",
  };
}

async function scanCompleteLines(
  file: string,
  startOffset: number,
  snapshotBytes: number,
  lineLimit: number,
  onLine: (line: { raw?: string; bytes: number; endOffset: number }) => Promise<void>,
): Promise<number> {
  if (snapshotBytes <= startOffset) return startOffset;

  const handle = await fs.open(file, "r");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let position = startOffset;
  let committedOffset = startOffset;
  let lineBytes = 0;
  let oversized = false;
  let chunks: Buffer[] = [];

  const addSegment = (segment: Buffer) => {
    lineBytes += segment.length;
    if (oversized || lineBytes > lineLimit) {
      oversized = true;
      chunks = [];
      return;
    }
    if (segment.length > 0) chunks.push(Buffer.from(segment));
  };

  try {
    while (position < snapshotBytes) {
      const wanted = Math.min(buffer.length, snapshotBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead === 0) break;

      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 0x0a) continue;
        addSegment(buffer.subarray(segmentStart, index));
        const endOffset = position + index + 1;
        await onLine({
          raw: oversized ? undefined : Buffer.concat(chunks).toString("utf-8"),
          bytes: lineBytes,
          endOffset,
        });
        committedOffset = endOffset;
        lineBytes = 0;
        oversized = false;
        chunks = [];
        segmentStart = index + 1;
      }
      addSegment(buffer.subarray(segmentStart, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }

  // A partial final JSON line may still be growing. Leave the checkpoint at
  // its start so the next worker sees the complete line rather than losing it.
  return committedOffset;
}

function hasContent(turn: Turn): boolean {
  return (
    turn.userInput != null ||
    turn.finalOutput != null ||
    turn.steps.length > 0 ||
    turn.subagentThreadIds.length > 0
  );
}

function selectTurn(active: ActiveTurn): Turn | undefined {
  const turns = parseSession(active.lines).turns;
  if (active.turnId) {
    const matched = turns.find((turn) => turn.turnId === active.turnId);
    if (matched && hasContent(matched)) return matched;
  }
  return turns.find(hasContent);
}

/**
 * Stream a rollout from its last committed byte offset.
 *
 * Uploaded legacy turns are detected from their task_started line and their
 * remaining bytes are read but not JSON-parsed. Unuploaded data is retained
 * for only one turn at a time. The returned state is not durable until the
 * caller has flushed the exporter and explicitly writes it.
 */
export async function scanRollout(
  rolloutFile: string,
  options: {
    uploadedTurnIds: Set<string>;
    previousState?: UploadState;
    snapshotBytes?: number;
    maxChars: number;
    onTurn: (value: StreamedTurn) => Promise<void>;
  },
): Promise<RolloutScanResult> {
  const stat = await fs.stat(rolloutFile);
  const snapshotBytes = Math.max(0, Math.min(options.snapshotBytes ?? stat.size, stat.size));
  const startOffset = options.previousState?.committedOffset ?? 0;
  let sessionMeta = options.previousState?.sessionMeta ?? { sessionId: "unknown" };
  let turnNumber = options.previousState?.turnNumber ?? 0;
  let active: ActiveTurn | undefined;
  let skippedTurns = 0;
  let oversizedLines = 0;
  let resumeOffset: number | undefined;
  let resumeTurnNumber: number | undefined;

  const finishActive = async (trailing: boolean) => {
    if (!active) return;
    const current = active;
    active = undefined;
    if (current.skipped) {
      skippedTurns++;
      return;
    }
    const turn = selectTurn(current);
    const ready =
      !trailing || current.completed || current.finalOutputSeen || turn?.aborted === true;
    if (turn && ready) {
      await options.onTurn({ turn, turnNumber: current.turnNumber, sessionMeta });
    } else if (trailing) {
      // Stop can run before the first content event is flushed. Revisit this
      // task_started line next time instead of checkpointing an empty turn.
      resumeOffset = current.startOffset;
      resumeTurnNumber = current.turnNumber - 1;
    }
  };

  const committedOffset = await scanCompleteLines(
    rolloutFile,
    startOffset,
    snapshotBytes,
    maxLineBytes(options.maxChars),
    async ({ raw, bytes, endOffset }) => {
      if (raw == null) {
        oversizedLines++;
        if (active && !active.skipped) {
          active.lines.push({
            timestamp: active.lastTimestamp,
            type: "event_msg",
            payload: {
              type: "agent_message",
              message: `[rollout event omitted: ${bytes} bytes exceeds safety limit]`,
            },
          });
        }
        return;
      }

      // While skipping an already-uploaded turn, nearly every line can avoid
      // JSON.parse entirely. Only possible boundaries/session metadata matter.
      if (active?.skipped && !raw.includes("task_started") && !raw.includes("session_meta")) {
        return;
      }
      if (!active && !raw.includes("task_started") && !raw.includes("session_meta")) return;

      const line = parseLine(raw, options.maxChars);
      if (!line) return;
      sessionMeta = updateSessionMeta(sessionMeta, line);
      if (line.type === "session_meta") return;

      if (isTaskStarted(line)) {
        await finishActive(false);
        turnNumber++;
        const payload = line.payload as { turn_id?: string | null };
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
        active = {
          turnId,
          turnNumber,
          skipped: turnId != null && options.uploadedTurnIds.has(turnId),
          lines: [],
          completed: false,
          finalOutputSeen: false,
          lastTimestamp: line.timestamp,
          startOffset: endOffset - bytes - 1,
        };
        if (!active.skipped) active.lines.push(line);
        return;
      }

      if (active && !active.skipped) {
        active.lastTimestamp = line.timestamp;
        if (isTaskComplete(line)) active.completed = true;
        if (isFinalOutputLine(line)) active.finalOutputSeen = true;
        active.lines.push(line);
      }
    },
  );

  await finishActive(true);

  return {
    state: {
      version: 2,
      identity: rolloutIdentity(stat),
      committedOffset: resumeOffset ?? committedOffset,
      turnNumber: resumeTurnNumber ?? turnNumber,
      sessionMeta,
      updatedAt: new Date().toISOString(),
    },
    snapshotBytes,
    scannedBytes: snapshotBytes - startOffset,
    skippedTurns,
    oversizedLines,
  };
}
