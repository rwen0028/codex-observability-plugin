import * as fs from "node:fs/promises";

import type { SessionMeta } from "./types.js";

const STATE_VERSION = 2 as const;
const STATUS_VERSION = 1 as const;

export type RolloutIdentity = {
  device: string;
  inode: string;
};

export type UploadState = {
  version: typeof STATE_VERSION;
  identity: RolloutIdentity;
  committedOffset: number;
  turnNumber: number;
  sessionMeta: SessionMeta;
  updatedAt: string;
};

export type UploadStatus = {
  version: typeof STATUS_VERSION;
  status: "queued" | "uploading" | "ok" | "error";
  updatedAt: string;
  snapshotBytes?: number;
  committedOffset?: number;
  uploadedTurns?: number;
  skippedTurns?: number;
  error?: string;
};

const ledgerPath = (rolloutFile: string) => `${rolloutFile}.langfuse`;
const statePath = (rolloutFile: string) => `${rolloutFile}.langfuse.state.json`;
const pendingPath = (rolloutFile: string) => `${rolloutFile}.langfuse.pending.json`;
const statusPath = (rolloutFile: string) => `${rolloutFile}.langfuse.status.json`;
const lockPath = (rolloutFile: string) => `${rolloutFile}.langfuse.lock`;

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    // Windows FlushFileBuffers requires a handle opened with write access.
    const handle = await fs.open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof (value as SessionMeta).sessionId === "string";
}

function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization|api[-_ ]?key|secret|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

/**
 * Per-rollout dedup ledger.
 *
 * The `Stop` hook fires after every Codex turn. We retain the legacy newline
 * ledger (`<rolloutFile>.langfuse`) for backwards compatibility and combine it
 * with a v2 byte-offset checkpoint. A turn id is appended only after the
 * exporter flush succeeds; in-progress but contentful turns are acknowledged
 * too because Codex may trigger Stop before task_complete reaches the file.
 */
export async function loadUploadedTurnIds(rolloutFile: string): Promise<Set<string>> {
  try {
    const data = await fs.readFile(ledgerPath(rolloutFile), "utf-8");
    return new Set(data.split("\n").filter(Boolean));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

/** Append acknowledgements durably after the exporter has flushed successfully. */
export async function markTurnsUploaded(rolloutFile: string, turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) return;
  const file = ledgerPath(rolloutFile);
  const handle = await fs.open(file, "a", 0o600);
  try {
    await handle.writeFile(`${turnIds.join("\n")}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600);
}

/** Backwards-compatible single-turn helper used by older callers/tests. */
export async function markTurnUploaded(rolloutFile: string, turnId: string): Promise<void> {
  await markTurnsUploaded(rolloutFile, [turnId]);
}

export function rolloutIdentity(stat: {
  dev: number | bigint;
  ino: number | bigint;
}): RolloutIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

export async function loadUploadState(
  rolloutFile: string,
  stat: { dev: number | bigint; ino: number | bigint; size: number },
): Promise<UploadState | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(statePath(rolloutFile), "utf-8"),
    ) as Partial<UploadState>;
    const identity = rolloutIdentity(stat);
    if (
      value.version !== STATE_VERSION ||
      value.identity?.device !== identity.device ||
      value.identity?.inode !== identity.inode ||
      !Number.isSafeInteger(value.committedOffset) ||
      value.committedOffset! < 0 ||
      value.committedOffset! > stat.size ||
      !Number.isSafeInteger(value.turnNumber) ||
      value.turnNumber! < 0 ||
      !isSessionMeta(value.sessionMeta)
    ) {
      return undefined;
    }
    return value as UploadState;
  } catch {
    return undefined;
  }
}

export async function writeUploadState(rolloutFile: string, state: UploadState): Promise<void> {
  await writeJsonAtomic(statePath(rolloutFile), state);
}

/** Leave a durable watermark before the Stop hook exits. */
export async function queueRollout(rolloutFile: string, snapshotBytes: number): Promise<void> {
  await writeJsonAtomic(pendingPath(rolloutFile), {
    version: 1,
    snapshotBytes,
    queuedAt: new Date().toISOString(),
  });
}

export async function writeUploadStatus(
  rolloutFile: string,
  status: Omit<UploadStatus, "version" | "updatedAt">,
): Promise<void> {
  await writeJsonAtomic(statusPath(rolloutFile), {
    version: STATUS_VERSION,
    updatedAt: new Date().toISOString(),
    ...status,
    ...(status.error ? { error: cleanError(status.error) } : {}),
  } satisfies UploadStatus);
}

export type RolloutLock = { release: () => Promise<void> };

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Acquire a per-rollout lock, recovering a lock left by a dead uploader. */
export async function acquireRolloutLock(rolloutFile: string): Promise<RolloutLock | undefined> {
  const file = lockPath(rolloutFile);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf-8");
      await handle.close();
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await fs.rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number.parseInt((await fs.readFile(file, "utf-8")).trim(), 10);
      } catch {
        // Treat an unreadable/incomplete lock as stale on the recovery attempt.
      }
      if (processIsAlive(owner)) return undefined;
      await fs.rm(file, { force: true });
    }
  }
  return undefined;
}
