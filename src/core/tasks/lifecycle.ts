import {
  buildTaskId,
  ensureUniqueTaskId,
  formatDisplay,
  readSpec,
  writeMeta,
  writeSpec,
} from "../store.js";
import { findReservedHeadings } from "../spec.js";
import { readSession, resolveSideByCwd, writeSession } from "../session.js";
import { err, ok } from "../types.js";
import type { Ctx, Meta, Result, Side } from "../types.js";
import {
  ACTIVE_TASK_GONE,
  guardTaskId,
  markModified,
  readAllMeta,
  withExistingTask,
} from "./shared.js";

// ---------- create ----------

export const create = async (
  ctx: Ctx,
  input: { keyword: string; scope?: string; force?: boolean },
  now: Date = new Date(),
): Promise<
  Result<{
    taskId: string;
    keyword: string;
    previousActive: string | null;
    scopeRecorded: boolean;
  }>
> => {
  const keyword = input.keyword.trim();
  if (!keyword) return err("INVALID_INPUT", "keyword is required");
  // Validate the optional scope before any writes so a bad scope can't leave a
  // half-initialized task behind.
  const scopeText = input.scope?.trim() ?? "";
  const reserved = scopeText ? findReservedHeadings(scopeText) : [];
  if (reserved.length > 0) {
    const list = reserved.map((h) => `"${h}"`).join(", ");
    return err("INVALID_INPUT", `scope text must not contain reserved spec headings: ${list}`);
  }

  // Bootstrap guard: a directory already registered with an open task usually
  // means the caller meant link/attach, or lost track of an earlier create —
  // both produced stray duplicate tasks in pairing dogfooding. `force` starts
  // another task here deliberately.
  if (!input.force) {
    const openHere = (await readAllMeta(ctx.goriHome)).filter(
      (m) => m.status === "in-progress" && resolveSideByCwd(m, ctx.cwd) !== null,
    );
    if (openHere.length > 0) {
      const ids = openHere.map((m) => m.taskId).join(", ");
      return err(
        "CWD_IN_USE",
        `this directory already belongs to an in-progress task: ${ids} — ` +
          "attach to it instead, or force a new task to start another here",
      );
    }
  }

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
  if (scopeText) {
    const doc = await readSpec(ctx.goriHome, taskId);
    await writeSpec(ctx.goriHome, taskId, { ...doc, scopeA: scopeText });
  }
  return ok({
    taskId,
    keyword,
    previousActive: previous?.taskId ?? null,
    scopeRecorded: scopeText !== "",
  });
};

// ---------- close / reopen (lifecycle) ----------

/** Mark the active task closed. Leaves the session pointer for idle GC to drop. */
export const close = async (
  ctx: Ctx,
  now: Date = new Date(),
): Promise<Result<{ taskId: string; keyword: string }>> => {
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return err("NO_ACTIVE_TASK", "no active task to close");
  return withExistingTask(
    ctx.goriHome,
    binding.taskId,
    ACTIVE_TASK_GONE,
    async (meta) => {
      if (meta.status === "closed") {
        return err("ALREADY_CLOSED", "task is already closed");
      }
      await writeMeta(ctx.goriHome, {
        ...markModified(meta, binding.side, formatDisplay(now)),
        status: "closed",
      });
      return ok({ taskId: meta.taskId, keyword: meta.keyword });
    },
  );
};

/** Reopen a closed task by id, or the session's lingering pointer when none is given. */
export const reopen = async (
  ctx: Ctx,
  input: { taskId?: string },
  now: Date = new Date(),
): Promise<Result<{ taskId: string; keyword: string; reattach: boolean }>> => {
  if (input.taskId !== undefined) {
    const bad = guardTaskId(input.taskId);
    if (bad) return bad;
  }
  const session = await readSession(ctx.goriHome, ctx.sessionKey);
  const targetId = input.taskId ?? session?.taskId;
  if (!targetId) {
    return err("NO_ACTIVE_TASK", "no task to reopen; specify a task id");
  }
  return withExistingTask(
    ctx.goriHome,
    targetId,
    { code: "TASK_NOT_FOUND", message: `no such task: ${targetId}` },
    async (meta) => {
      if (meta.status === "in-progress") {
        return err("ALREADY_OPEN", "task is already in progress");
      }
      // Attribute the change to this session only when it is bound to the task;
      // an unbound reopener leaves the last-modified side untouched.
      const reopenerSide: Side | null =
        session && session.taskId === targetId ? session.side : null;
      await writeMeta(ctx.goriHome, {
        ...markModified(meta, reopenerSide ?? meta.lastModifiedBy, formatDisplay(now)),
        status: "in-progress",
      });
      return ok({
        taskId: targetId,
        keyword: meta.keyword,
        reattach: reopenerSide === null,
      });
    },
  );
};
