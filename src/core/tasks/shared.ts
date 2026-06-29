import { readdir, rm, stat } from "node:fs/promises";
import { sessionsDir, tasksDir } from "../env.js";
import { isSafeTaskId, readMeta, withTaskLock } from "../store.js";
import { readSession, sessionFilePath } from "../session.js";
import { err } from "../types.js";
import type { GoriError, Meta, Result, Side } from "../types.js";

// Idle window for session pointers (sessions/*.txt), dropped on the next
// list/status. Task data under tasks/ is never GC'd — only routing pointers.
const GC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TXT = ".txt";

// ---------- shared helpers ----------

export const listTaskIds = async (goriHome: string): Promise<string[]> => {
  try {
    return await readdir(tasksDir(goriHome));
  } catch {
    return [];
  }
};

export const readAllMeta = async (goriHome: string): Promise<Meta[]> => {
  const ids = await listTaskIds(goriHome);
  // A single corrupt meta.yml must not poison list/status — skip it, the same
  // way readMeta already tolerates ENOENT/ENOTDIR junk under tasks/.
  const metas = await Promise.all(ids.map((id) => readMeta(goriHome, id).catch(() => null)));
  return metas.filter((m): m is Meta => m !== null);
};

/** Stamp the modifying side and time — the shared touch in every existing-task RMW verb. */
export const markModified = (meta: Meta, by: Side, at: string): Meta => ({
  ...meta,
  lastModifiedBy: by,
  lastModifiedAt: at,
});

/** Reject an externally-supplied task id that could escape the store via path traversal. */
export const guardTaskId = (id: string): Result<never> | null =>
  isSafeTaskId(id) ? null : err("INVALID_TASK_ID", `invalid task id: ${id}`);

/** Reject a mutation or link targeting a closed task — the caller must reopen it first. */
export const rejectIfClosed = (meta: Meta): Result<never> | null =>
  meta.status === "closed" ? err("ALREADY_CLOSED", "task is closed; reopen it first") : null;

/** Shared notFound for the existing-task RMW verbs: the bound task vanished before the verb ran. */
export const ACTIVE_TASK_GONE: GoriError = {
  code: "NO_ACTIVE_TASK",
  message: "active task no longer exists",
};

/**
 * Read-modify-write an existing task under its lock. Pre-checks existence so the
 * task directory (and thus its lockfile) exists, re-checks inside the lock, and
 * yields `notFound` when the task is missing. Shared by link, close, and reopen.
 */
export const withExistingTask = async <T>(
  goriHome: string,
  taskId: string,
  notFound: GoriError,
  fn: (meta: Meta) => Promise<Result<T>>,
): Promise<Result<T>> => {
  if (!(await readMeta(goriHome, taskId))) return { ok: false, error: notFound };
  return withTaskLock(goriHome, taskId, async () => {
    const meta = await readMeta(goriHome, taskId);
    if (!meta) return { ok: false, error: notFound };
    return fn(meta);
  });
};

// ---------- idle GC: drop stale, closed, or dangling session pointers ----------

const isCollectable = async (
  goriHome: string,
  filePath: string,
  binding: { taskId: string } | null,
  now: Date,
): Promise<boolean> => {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    return false; // vanished underneath us
  }
  if (now.getTime() - mtimeMs > GC_MAX_AGE_MS) return true;
  if (!binding) return true; // malformed line
  const meta = await readMeta(goriHome, binding.taskId);
  if (!meta) return true; // points to a task that no longer exists
  return meta.status === "closed";
};

export const runGc = async (goriHome: string, now: Date): Promise<void> => {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir(goriHome));
  } catch {
    return; // no sessions directory yet
  }
  for (const entry of entries) {
    if (!entry.endsWith(TXT)) continue;
    const key = entry.slice(0, -TXT.length);
    const filePath = sessionFilePath(goriHome, key);
    const binding = await readSession(goriHome, key);
    if (await isCollectable(goriHome, filePath, binding, now)) {
      await rm(filePath, { force: true });
    }
  }
};
