import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, Result } from "../types.js";

export const ctxOf = (home: string, cwd: string, key: string): Ctx => ({
  goriHome: home,
  cwd,
  sessionKey: key,
});

export const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
};

export const errorOf = <T>(r: Result<T>) => {
  if (r.ok) throw new Error("expected an error");
  return r.error;
};

export const T1 = new Date(2026, 0, 1, 10, 0, 0);
export const T2 = new Date(2026, 0, 1, 10, 0, 5);
export const T3 = new Date(2026, 0, 1, 10, 1, 0);

export type TaskEnv = { home: string; A: Ctx; B: Ctx; C: Ctx };

// A fresh temp home plus the three session contexts the verb tests share:
// A starts tasks (pair-A), B pairs in (pair-B), C is unrelated (drives GC).
export const freshTaskEnv = async (): Promise<TaskEnv> => {
  const home = await mkdtemp(join(tmpdir(), "gori-tasks-"));
  return {
    home,
    A: ctxOf(home, "/work/api", "keyA"),
    B: ctxOf(home, "/work/web", "keyB"),
    C: ctxOf(home, "/work/none", "keyC"),
  };
};
