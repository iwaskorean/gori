import {
  appendNote,
  formatDisplay,
  readSpec,
  writeMeta,
  writeSpec,
} from "../store.js";
import {
  findReservedHeadings,
  matchScopeSections,
  nextId,
  parseScopeSections,
  serializeScopeSections,
} from "../spec.js";
import type { Answered, Question, SpecDoc } from "../spec.js";
import { readSession, touchSession } from "../session.js";
import { err, ok } from "../types.js";
import type { Ctx, Result, Side } from "../types.js";
import {
  ACTIVE_TASK_GONE,
  markModified,
  rejectIfClosed,
  withExistingTask,
} from "./shared.js";

const NOTE_PROMOTION_LINE_THRESHOLD = 30;

const partnerOf = (side: Side): Side => (side === "pair-A" ? "pair-B" : "pair-A");

/** Collapse newlines and runs of whitespace to single spaces; answered is single-line. */
const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Match by stable id (`#<id>`) or, failing that, a case-insensitive text substring. */
const matchQuestions = (questions: Question[], ref: string): Question[] => {
  const byId = /^#(\d+)$/.exec(ref);
  if (byId) {
    const id = Number(byId[1]);
    return questions.filter((q) => q.id === id);
  }
  const needle = ref.toLowerCase();
  return questions.filter((q) => q.text.toLowerCase().includes(needle));
};

// ---------- log (note channel) ----------

/** Append a timestamped block to the active task's note timeline. */
export const log = async (
  ctx: Ctx,
  input: { message: string },
  now: Date = new Date(),
): Promise<Result<{ taskId: string; suggestPromotion: boolean }>> => {
  if (!input.message.trim()) return err("INVALID_INPUT", "message is required");
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return err("NO_ACTIVE_TASK", "no active task to log to");
  await touchSession(ctx.goriHome, ctx.sessionKey);

  const at = formatDisplay(now);
  const block = `## ${at} [${binding.side}]\n\n${input.message}\n`;
  return withExistingTask(
    ctx.goriHome,
    binding.taskId,
    ACTIVE_TASK_GONE,
    async (meta) => {
      const rejection = rejectIfClosed(meta);
      if (rejection) return rejection;
      const lineCount = await appendNote(ctx.goriHome, binding.taskId, block);
      await writeMeta(ctx.goriHome, markModified(meta, binding.side, at));
      return ok({
        taskId: meta.taskId,
        suggestPromotion: lineCount > NOTE_PROMOTION_LINE_THRESHOLD,
      });
    },
  );
};

// ---------- scope (spec channel) ----------

/** Whole-scope write: replace, or append a block. Existing text + no mode is ambiguous. */
const editWholeScope = (
  existing: string,
  mode: "append" | "replace" | undefined,
  text: string,
): Result<string> => {
  if (existing && !mode) {
    return err("SCOPE_EXISTS", "scope already set; choose append or replace");
  }
  return ok(existing && mode === "append" ? `${existing}\n${text}` : text);
};

/**
 * Edit one `### ` sub-section so a side need not resend the whole scope.
 * Addressing mirrors answer's matchQuestions: not-found and ambiguous are
 * surfaced with the available headings so the caller can disambiguate.
 */
const editScopeSection = (
  existing: string,
  ref: string,
  mode: "append" | "replace" | undefined,
  text: string,
): Result<string> => {
  if (!mode) return err("INVALID_INPUT", "choose append or replace to edit a section");
  const parsed = parseScopeSections(existing);
  const [index, ...rest] = matchScopeSections(parsed.sections, ref);
  if (index === undefined) {
    const headings = parsed.sections.map((s) => `"${s.heading}"`).join(", ");
    const detail = headings ? `existing sections: ${headings}` : "the scope has no sections yet";
    return err("SECTION_NOT_FOUND", `no scope section matches "${ref}"; ${detail}`);
  }
  if (rest.length > 0) {
    const matched = [index, ...rest].map((i) => `"${parsed.sections[i]?.heading}"`).join(", ");
    return err("SECTION_AMBIGUOUS", `"${ref}" matches multiple sections: ${matched}`);
  }
  const section = parsed.sections[index];
  if (!section) return err("SECTION_NOT_FOUND", `no scope section matches "${ref}"`);
  const body = mode === "append" && section.body ? `${section.body}\n${text}` : text;
  parsed.sections[index] = { heading: section.heading, body };
  return ok(serializeScopeSections(parsed));
};

/**
 * Set the current side's Scope in spec.md (skeleton created on first write).
 * With `section`, edits one `### ` sub-section instead of the whole scope, so a
 * side can change one part without resending all of it. Whole-scope writes
 * return SCOPE_EXISTS when text already exists and no mode was chosen.
 */
export const scope = async (
  ctx: Ctx,
  input: { text: string; mode?: "append" | "replace"; section?: string },
  now: Date = new Date(),
): Promise<Result<{ taskId: string }>> => {
  const text = input.text.trim();
  if (!text) return err("INVALID_INPUT", "scope text is required");
  const reserved = findReservedHeadings(text);
  if (reserved.length > 0) {
    const list = reserved.map((h) => `"${h}"`).join(", ");
    return err("INVALID_INPUT", `scope text must not contain reserved spec headings: ${list}`);
  }
  const sectionRef = input.section?.trim();
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return err("NO_ACTIVE_TASK", "no active task to scope");
  await touchSession(ctx.goriHome, ctx.sessionKey);

  const at = formatDisplay(now);
  return withExistingTask(
    ctx.goriHome,
    binding.taskId,
    ACTIVE_TASK_GONE,
    async (meta) => {
      const rejection = rejectIfClosed(meta);
      if (rejection) return rejection;
      const doc = await readSpec(ctx.goriHome, binding.taskId);
      const existing = binding.side === "pair-A" ? doc.scopeA : doc.scopeB;
      const next = sectionRef
        ? editScopeSection(existing, sectionRef, input.mode, text)
        : editWholeScope(existing, input.mode, text);
      if (!next.ok) return next;
      const updated: SpecDoc =
        binding.side === "pair-A"
          ? { ...doc, scopeA: next.data }
          : { ...doc, scopeB: next.data };
      await writeSpec(ctx.goriHome, binding.taskId, updated);
      await writeMeta(ctx.goriHome, markModified(meta, binding.side, at));
      return ok({ taskId: meta.taskId });
    },
  );
};

// ---------- ask / answer (spec channel) ----------
// Unlike scope, ask/answer need no reserved-heading guard: their text is stored
// line-prefixed (`- [ ] [#id] ...`) with 2-space continuation, so it can never
// be parsed as a `## ` section boundary on the next read.

/** Add a question to the partner side's Open Questions with a fresh stable id. */
export const ask = async (
  ctx: Ctx,
  input: { question: string },
  now: Date = new Date(),
): Promise<Result<{ id: number }>> => {
  const question = input.question.trim();
  if (!question) return err("INVALID_INPUT", "question is required");
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return err("NO_ACTIVE_TASK", "no active task to ask in");
  await touchSession(ctx.goriHome, ctx.sessionKey);

  const at = formatDisplay(now);
  return withExistingTask(
    ctx.goriHome,
    binding.taskId,
    ACTIVE_TASK_GONE,
    async (meta) => {
      const rejection = rejectIfClosed(meta);
      if (rejection) return rejection;
      const doc = await readSpec(ctx.goriHome, binding.taskId);
      const entry: Question = { id: nextId(doc), asker: binding.side, text: question };
      const updated: SpecDoc =
        partnerOf(binding.side) === "pair-A"
          ? { ...doc, openA: [...doc.openA, entry] }
          : { ...doc, openB: [...doc.openB, entry] };
      await writeSpec(ctx.goriHome, binding.taskId, updated);
      await writeMeta(ctx.goriHome, markModified(meta, binding.side, at));
      return ok({ id: entry.id });
    },
  );
};

/**
 * Resolve a question in the current side's Open Questions, moving it to Answered.
 * queueEmpty signals the caller to suggest closing (never auto-close) once this
 * side's queue is drained — the same advisory pattern as log's suggestPromotion.
 */
export const answer = async (
  ctx: Ctx,
  input: { ref: string; answer: string },
  now: Date = new Date(),
): Promise<Result<{ id: number; queueEmpty: boolean }>> => {
  const ref = input.ref.trim();
  const answerText = input.answer.trim();
  if (!ref) return err("INVALID_INPUT", "question reference is required");
  if (!answerText) return err("INVALID_INPUT", "answer is required");
  const binding = await readSession(ctx.goriHome, ctx.sessionKey);
  if (!binding) return err("NO_ACTIVE_TASK", "no active task to answer in");
  await touchSession(ctx.goriHome, ctx.sessionKey);

  const at = formatDisplay(now);
  return withExistingTask(
    ctx.goriHome,
    binding.taskId,
    ACTIVE_TASK_GONE,
    async (meta) => {
      const rejection = rejectIfClosed(meta);
      if (rejection) return rejection;
      const doc = await readSpec(ctx.goriHome, binding.taskId);
      const mine = binding.side === "pair-A" ? doc.openA : doc.openB;
      const [target, ...rest] = matchQuestions(mine, ref);
      if (!target) {
        return err("INVALID_INPUT", `no open question matches: ${ref}`);
      }
      if (rest.length > 0) {
        return err("INVALID_INPUT", `ambiguous question reference: ${ref}`);
      }
      const resolved: Answered = {
        id: target.id,
        asker: target.asker,
        answerer: binding.side,
        date: at,
        question: flatten(target.text),
        answer: flatten(answerText),
      };
      const remaining = mine.filter((q) => q.id !== target.id);
      const withoutQuestion: SpecDoc =
        binding.side === "pair-A"
          ? { ...doc, openA: remaining }
          : { ...doc, openB: remaining };
      await writeSpec(ctx.goriHome, binding.taskId, {
        ...withoutQuestion,
        answered: [...doc.answered, resolved],
      });
      await writeMeta(ctx.goriHome, markModified(meta, binding.side, at));
      return ok({ id: target.id, queueEmpty: remaining.length === 0 });
    },
  );
};
