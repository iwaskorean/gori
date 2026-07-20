/**
 * Core contract types shared by the CLI and MCP wrappers.
 * Verbs never print; they return a Result and receive a Ctx, so each wrapper
 * formats the outcome its own way (human text vs tool response).
 */

export type Side = "pair-A" | "pair-B";

// blocked sits between the two: the task is not done, but it cannot proceed
// without a decision neither side can make. It is "active but flagged" -- still
// mutable, attachable, and not GC'd -- so a human can pick it up and resolve it.
export type TaskStatus = "in-progress" | "blocked" | "closed";

/** One side's persisted info. Before pairing, pair-B's fields are null. */
export type SideMeta = {
  dir: string | null;
  joinedAt: string | null;
};

/** A task's persisted source of truth. Session/side binding lives elsewhere. */
export type Meta = {
  taskId: string;
  keyword: string;
  createdAt: string;
  pairA: SideMeta;
  pairB: SideMeta;
  status: TaskStatus;
  /** Why the task is blocked. Invariant: non-null iff status is "blocked". */
  blockedReason: string | null;
  lastModifiedBy: Side;
  lastModifiedAt: string;
};

/** Execution context injected into core. sessionKey is derived per run mode. */
export type Ctx = {
  goriHome: string;
  cwd: string;
  sessionKey: string;
};

export type GoriErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TASK_ID"
  | "NO_ACTIVE_TASK"
  | "TASK_NOT_FOUND"
  | "NO_PAIRABLE_TASK"
  | "SIDE_AMBIGUOUS"
  | "NOT_REGISTERED"
  | "ALREADY_CLOSED"
  | "ALREADY_OPEN"
  | "ALREADY_BLOCKED"
  | "NOT_BLOCKED"
  | "SCOPE_EXISTS"
  | "SECTION_NOT_FOUND"
  | "SECTION_AMBIGUOUS"
  | "NOTHING_TO_RECAP"
  | "CWD_IN_USE";

/** Structured error; the CLI and MCP wrappers decide how to present it. */
export type GoriError = {
  code: GoriErrorCode;
  message: string;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: GoriError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const err = (code: GoriErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});
