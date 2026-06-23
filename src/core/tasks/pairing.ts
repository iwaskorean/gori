import { formatDisplay, noteExists, readMeta, writeMeta } from "../store.js";
import { clearSession, readSession, resolveSideByCwd, writeSession } from "../session.js";
import { err, ok } from "../types.js";
import type { Ctx, Meta, Result, Side } from "../types.js";
import { guardTaskId, readAllMeta, rejectIfClosed, withExistingTask } from "./shared.js";

// ---------- link (pairing) ----------

export type LinkCandidate = {
  taskId: string;
  keyword: string;
  pairADir: string;
  createdAt: string;
  lastModifiedAt: string;
  hasNote: boolean;
  sameDir: boolean;
};

/** Tasks open for pairing: in-progress, not yet paired, and not started by this session. */
export const linkCandidates = async (
  ctx: Ctx,
): Promise<Result<{ candidates: LinkCandidate[] }>> => {
  const session = await readSession(ctx.goriHome, ctx.sessionKey);
  const startedByThisSession = (m: Meta): boolean =>
    session?.taskId === m.taskId && session.side === "pair-A";

  const open = (await readAllMeta(ctx.goriHome))
    .filter((m) => m.status === "in-progress" && m.pairB.dir === null)
    .filter((m) => !startedByThisSession(m));
  const candidates = (
    await Promise.all(
      open.map(async (m) => ({
        taskId: m.taskId,
        keyword: m.keyword,
        pairADir: m.pairA.dir ?? "",
        createdAt: m.createdAt,
        lastModifiedAt: m.lastModifiedAt,
        hasNote: await noteExists(ctx.goriHome, m.taskId),
        sameDir: m.pairA.dir === ctx.cwd,
      })),
    )
  ).sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  return ok({ candidates });
};

export const link = async (
  ctx: Ctx,
  input: { taskId: string },
  now: Date = new Date(),
): Promise<Result<{ taskId: string; keyword: string }>> => {
  const bad = guardTaskId(input.taskId);
  if (bad) return bad;
  return withExistingTask(
    ctx.goriHome,
    input.taskId,
    { code: "TASK_NOT_FOUND", message: `no such task: ${input.taskId}` },
    async (meta) => {
      const rejection = rejectIfClosed(meta);
      if (rejection) return rejection;
      const session = await readSession(ctx.goriHome, ctx.sessionKey);
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
      return ok({ taskId: meta.taskId, keyword: meta.keyword });
    },
  );
};

// ---------- attach (reconnect / switch tasks) ----------

export type AttachCandidate = {
  taskId: string;
  keyword: string;
  side: Side | "ambiguous";
  lastModifiedAt: string;
};

/** In-progress tasks whose pair-A or pair-B directory matches this cwd. */
export const attachCandidates = async (
  ctx: Ctx,
): Promise<Result<{ candidates: AttachCandidate[] }>> => {
  const candidates = (await readAllMeta(ctx.goriHome))
    .filter((m) => m.status === "in-progress")
    .map((m) => ({ meta: m, side: resolveSideByCwd(m, ctx.cwd) }))
    .filter((x): x is { meta: Meta; side: Side | "ambiguous" } => x.side !== null)
    .map(({ meta, side }) => ({
      taskId: meta.taskId,
      keyword: meta.keyword,
      side,
      lastModifiedAt: meta.lastModifiedAt,
    }))
    .sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  return ok({ candidates });
};

/**
 * Pick the side to bind. An explicit side wins (it lets you reconnect from a
 * different directory) but must already be registered; otherwise fall back to
 * inferring from cwd.
 */
const resolveAttachSide = (meta: Meta, cwd: string, explicit?: Side): Result<Side> => {
  if (explicit) {
    const dir = explicit === "pair-A" ? meta.pairA.dir : meta.pairB.dir;
    if (dir === null) {
      return err("NOT_REGISTERED", `${explicit} has not joined this task`);
    }
    return ok(explicit);
  }
  const inferred = resolveSideByCwd(meta, cwd);
  if (inferred === "ambiguous") {
    return err("SIDE_AMBIGUOUS", "both sides share this directory; specify a side");
  }
  if (inferred === null) {
    return err("NOT_REGISTERED", "this directory is not registered with the task");
  }
  return ok(inferred);
};

/** Bind this session to an existing in-progress task. Leaves meta untouched. */
export const attach = async (
  ctx: Ctx,
  input: { taskId: string; side?: Side },
): Promise<
  Result<{
    taskId: string;
    keyword: string;
    side: Side;
    previousActive: string | null;
  }>
> => {
  const bad = guardTaskId(input.taskId);
  if (bad) return bad;
  const meta = await readMeta(ctx.goriHome, input.taskId);
  if (!meta) return err("TASK_NOT_FOUND", `no such task: ${input.taskId}`);
  if (meta.status === "closed") {
    return err("ALREADY_CLOSED", "task is closed; reopen it before attaching");
  }

  const resolved = resolveAttachSide(meta, ctx.cwd, input.side);
  if (!resolved.ok) return resolved;
  const side = resolved.data;

  const previous = await readSession(ctx.goriHome, ctx.sessionKey);
  await writeSession(ctx.goriHome, ctx.sessionKey, { taskId: meta.taskId, side });
  return ok({
    taskId: meta.taskId,
    keyword: meta.keyword,
    side,
    previousActive: previous?.taskId ?? null,
  });
};

// ---------- detach ----------

export const detach = async (ctx: Ctx): Promise<Result<{ taskId: string | null }>> => {
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  await clearSession(ctx.goriHome, ctx.sessionKey);
  return ok({ taskId: binding?.taskId ?? null });
};
