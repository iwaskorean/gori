import { readMeta, readNote, readSpec } from "../store.js";
import { renderForRead } from "../spec.js";
import type { Question, SpecDoc } from "../spec.js";
import { readSession, touchSession } from "../session.js";
import { err, ok } from "../types.js";
import type { Ctx, Result, Side, TaskStatus } from "../types.js";
import { attachCandidates } from "./pairing.js";
import type { AttachCandidate } from "./pairing.js";
import { readAllMeta, runGc } from "./shared.js";

// ---------- list ----------

/** Per-side unanswered question counts, read from the task's spec. */
export type OpenQuestionCounts = { pairA: number; pairB: number };

const countOpenQuestions = (doc: SpecDoc): OpenQuestionCounts => ({
  pairA: doc.openA.length,
  pairB: doc.openB.length,
});

export type TaskSummary = {
  taskId: string;
  keyword: string;
  status: TaskStatus;
  paired: boolean;
  lastModifiedBy: Side;
  lastModifiedAt: string;
  isActive: boolean;
  openQuestionCounts: OpenQuestionCounts;
};

const statusRank = (s: TaskStatus): number => (s === "in-progress" ? 0 : 1);

// in-progress first, then closed; within each group most recently modified first.
const byStatusThenRecency = (a: TaskSummary, b: TaskSummary): number =>
  statusRank(a.status) - statusRank(b.status) || b.lastModifiedAt.localeCompare(a.lastModifiedAt);

export const list = async (
  ctx: Ctx,
  now: Date = new Date(),
): Promise<Result<{ tasks: TaskSummary[] }>> => {
  await touchSession(ctx.goriHome, ctx.sessionKey);
  await runGc(ctx.goriHome, now);
  const active = await readSession(ctx.goriHome, ctx.sessionKey);
  const summaries = await Promise.all(
    (await readAllMeta(ctx.goriHome)).map(async (m) => ({
      taskId: m.taskId,
      keyword: m.keyword,
      status: m.status,
      paired: m.pairB.dir !== null,
      lastModifiedBy: m.lastModifiedBy,
      lastModifiedAt: m.lastModifiedAt,
      isActive: active?.taskId === m.taskId,
      openQuestionCounts: countOpenQuestions(await readSpec(ctx.goriHome, m.taskId)),
    })),
  );
  return ok({ tasks: summaries.sort(byStatusThenRecency) });
};

// ---------- status ----------

export type ActiveStatus = {
  taskId: string;
  keyword: string;
  status: TaskStatus;
  side: Side;
  paired: boolean;
  partnerModified: boolean;
  openQuestionCounts: OpenQuestionCounts;
};

export const status = async (
  ctx: Ctx,
  now: Date = new Date(),
): Promise<Result<{ active: ActiveStatus | null; unattachedMatches: AttachCandidate[] }>> => {
  await touchSession(ctx.goriHome, ctx.sessionKey);
  await runGc(ctx.goriHome, now);
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  const meta = binding ? await readMeta(ctx.goriHome, binding.taskId) : null;
  if (!binding || !meta) {
    // Unattached (or the bound task vanished): surface the in-progress tasks whose
    // directory matches this cwd, so the session reconnects rather than mistaking
    // "not attached" for "no task" and creating a duplicate. attachCandidates is a
    // read that does not error in practice; degrade to no matches if it ever does.
    const found = await attachCandidates(ctx);
    return ok({ active: null, unattachedMatches: found.ok ? found.data.candidates : [] });
  }
  const doc = await readSpec(ctx.goriHome, binding.taskId);
  return ok({
    active: {
      taskId: meta.taskId,
      keyword: meta.keyword,
      status: meta.status,
      side: binding.side,
      paired: meta.pairB.dir !== null,
      partnerModified: meta.lastModifiedBy !== binding.side,
      openQuestionCounts: countOpenQuestions(doc),
    },
    unattachedMatches: [],
  });
};

// ---------- read ----------

export type ReadView = {
  summary: ActiveStatus;
  /** Rendered spec view; null when there is nothing to show or which === "log". */
  spec: string | null;
  /** Raw note timeline; null when no note exists yet or which === "spec". */
  note: string | null;
  /** Open questions waiting on this session's side, for the wrapper to emphasize. */
  openForMe: Question[];
};

/** Assemble the active task's reading view: summary, spec, note, and my open queue. */
export const read = async (
  ctx: Ctx,
  input: { which?: "log" | "spec" } = {},
): Promise<Result<ReadView>> => {
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return err("NO_ACTIVE_TASK", "no active task to read");
  await touchSession(ctx.goriHome, ctx.sessionKey);

  const meta = await readMeta(ctx.goriHome, binding.taskId);
  if (!meta) return err("NO_ACTIVE_TASK", "active task no longer exists");

  // The spec is read regardless of the filter: the summary's question counts
  // come from it. `which` only gates what is rendered back.
  const doc = await readSpec(ctx.goriHome, binding.taskId);
  const summary: ActiveStatus = {
    taskId: meta.taskId,
    keyword: meta.keyword,
    status: meta.status,
    side: binding.side,
    paired: meta.pairB.dir !== null,
    partnerModified: meta.lastModifiedBy !== binding.side,
    openQuestionCounts: countOpenQuestions(doc),
  };

  const includeSpec = input.which !== "log";
  const spec = includeSpec ? renderForRead(doc) || null : null;
  const openForMe = includeSpec ? (binding.side === "pair-A" ? doc.openA : doc.openB) : [];
  const note = input.which !== "spec" ? await readNote(ctx.goriHome, binding.taskId) : null;

  return ok({ summary, spec, note, openForMe });
};
