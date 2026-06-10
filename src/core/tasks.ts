import { readdir, rm, stat } from "node:fs/promises";
import { sessionsDir, tasksDir } from "./env.js";
import {
  buildTaskId,
  ensureUniqueTaskId,
  formatDisplay,
  readMeta,
  withTaskLock,
  writeMeta,
} from "./store.js";
import {
  clearSession,
  readSession,
  sessionFilePath,
  touchSession,
  writeSession,
} from "./session.js";
import { err, ok } from "./types.js";
import type { Ctx, Meta, Result, Side, TaskStatus } from "./types.js";

const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TXT = ".txt";

// ---------- shared helpers ----------

const listTaskIds = async (goriHome: string): Promise<string[]> => {
  try {
    return await readdir(tasksDir(goriHome));
  } catch {
    return [];
  }
};

const readAllMeta = async (goriHome: string): Promise<Meta[]> => {
  const ids = await listTaskIds(goriHome);
  const metas = await Promise.all(ids.map((id) => readMeta(goriHome, id)));
  return metas.filter((m): m is Meta => m !== null);
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

const runGc = async (goriHome: string, now: Date): Promise<void> => {
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

// ---------- create ----------

export const create = async (
  ctx: Ctx,
  input: { keyword: string },
  now: Date = new Date(),
): Promise<Result<{ taskId: string; previousActive: string | null }>> => {
  const keyword = input.keyword.trim();
  if (!keyword) return err("INVALID_INPUT", "keyword is required");

  const previous = await readSession(ctx.goriHome, ctx.sessionKey);
  const taskId = await ensureUniqueTaskId(ctx.goriHome, buildTaskId(keyword, now));
  const at = formatDisplay(now);
  const meta: Meta = {
    taskId,
    keyword,
    createdAt: at,
    pairA: { dir: ctx.cwd, joinedAt: at },
    pairB: { dir: null, joinedAt: null },
    status: "in-progress",
    lastModifiedBy: "pair-A",
    lastModifiedAt: at,
  };
  await writeMeta(ctx.goriHome, meta);
  await writeSession(ctx.goriHome, ctx.sessionKey, { taskId, side: "pair-A" });
  return ok({ taskId, previousActive: previous?.taskId ?? null });
};

// ---------- link (pairing) ----------

export type LinkCandidate = {
  taskId: string;
  keyword: string;
  pairADir: string;
  lastModifiedAt: string;
  sameDir: boolean;
};

/** Tasks open for pairing: in-progress, not yet paired, and not started by this session. */
export const linkCandidates = async (
  ctx: Ctx,
): Promise<Result<{ candidates: LinkCandidate[] }>> => {
  const session = await readSession(ctx.goriHome, ctx.sessionKey);
  const startedByThisSession = (m: Meta): boolean =>
    session?.taskId === m.taskId && session.side === "pair-A";

  const candidates = (await readAllMeta(ctx.goriHome))
    .filter((m) => m.status === "in-progress" && m.pairB.dir === null)
    .filter((m) => !startedByThisSession(m))
    .map((m) => ({
      taskId: m.taskId,
      keyword: m.keyword,
      pairADir: m.pairA.dir ?? "",
      lastModifiedAt: m.lastModifiedAt,
      sameDir: m.pairA.dir === ctx.cwd,
    }))
    .sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  return ok({ candidates });
};

export const link = async (
  ctx: Ctx,
  input: { taskId: string },
  now: Date = new Date(),
): Promise<Result<{ taskId: string }>> => {
  // Pre-check existence so the task directory (and thus its lockfile) exists.
  if (!(await readMeta(ctx.goriHome, input.taskId))) {
    return err("TASK_NOT_FOUND", `no such task: ${input.taskId}`);
  }
  return withTaskLock(ctx.goriHome, input.taskId, async () => {
    const session = await readSession(ctx.goriHome, ctx.sessionKey);
    const meta = await readMeta(ctx.goriHome, input.taskId);
    if (!meta) return err("TASK_NOT_FOUND", `no such task: ${input.taskId}`);
    if (meta.pairB.dir !== null) {
      return err("NO_PAIRABLE_TASK", "task is already paired");
    }
    if (session?.taskId === meta.taskId && session.side === "pair-A") {
      return err("NO_PAIRABLE_TASK", "cannot pair with a task this session started");
    }
    const at = formatDisplay(now);
    await writeMeta(ctx.goriHome, {
      ...meta,
      pairB: { dir: ctx.cwd, joinedAt: at },
      lastModifiedBy: "pair-B",
      lastModifiedAt: at,
    });
    await writeSession(ctx.goriHome, ctx.sessionKey, {
      taskId: meta.taskId,
      side: "pair-B",
    });
    return ok({ taskId: meta.taskId });
  });
};

// ---------- detach ----------

export const detach = async (
  ctx: Ctx,
): Promise<Result<{ taskId: string | null }>> => {
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  await clearSession(ctx.goriHome, ctx.sessionKey);
  return ok({ taskId: binding?.taskId ?? null });
};

// ---------- list ----------

export type TaskSummary = {
  taskId: string;
  keyword: string;
  status: TaskStatus;
  paired: boolean;
  lastModifiedBy: Side;
  lastModifiedAt: string;
  isActive: boolean;
};

const statusRank = (s: TaskStatus): number => (s === "in-progress" ? 0 : 1);

// in-progress first, then closed; within each group most recently modified first.
const byStatusThenRecency = (a: TaskSummary, b: TaskSummary): number =>
  statusRank(a.status) - statusRank(b.status) ||
  b.lastModifiedAt.localeCompare(a.lastModifiedAt);

export const list = async (
  ctx: Ctx,
  now: Date = new Date(),
): Promise<Result<{ tasks: TaskSummary[] }>> => {
  await touchSession(ctx.goriHome, ctx.sessionKey);
  await runGc(ctx.goriHome, now);
  const active = await readSession(ctx.goriHome, ctx.sessionKey);
  const tasks = (await readAllMeta(ctx.goriHome))
    .map((m) => ({
      taskId: m.taskId,
      keyword: m.keyword,
      status: m.status,
      paired: m.pairB.dir !== null,
      lastModifiedBy: m.lastModifiedBy,
      lastModifiedAt: m.lastModifiedAt,
      isActive: active?.taskId === m.taskId,
    }))
    .sort(byStatusThenRecency);
  return ok({ tasks });
};

// ---------- status ----------

export type ActiveStatus = {
  taskId: string;
  keyword: string;
  status: TaskStatus;
  side: Side;
  paired: boolean;
  partnerModified: boolean;
};

export const status = async (
  ctx: Ctx,
  now: Date = new Date(),
): Promise<Result<{ active: ActiveStatus | null }>> => {
  await touchSession(ctx.goriHome, ctx.sessionKey);
  await runGc(ctx.goriHome, now);
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return ok({ active: null });
  const meta = await readMeta(ctx.goriHome, binding.taskId);
  if (!meta) return ok({ active: null });
  return ok({
    active: {
      taskId: meta.taskId,
      keyword: meta.keyword,
      status: meta.status,
      side: binding.side,
      paired: meta.pairB.dir !== null,
      partnerModified: meta.lastModifiedBy !== binding.side,
    },
  });
};
