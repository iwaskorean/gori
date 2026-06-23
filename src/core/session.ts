import { mkdir, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { sessionsDir } from "./env.js";
import { isErrnoException } from "./errors.js";
import { writeFileAtomic } from "./store.js";
import type { Meta, Side } from "./types.js";

/** The task and side this session is bound to (sessions/<key>.txt). */
export type SessionBinding = { taskId: string; side: Side };

export const sessionFilePath = (goriHome: string, key: string): string =>
  join(sessionsDir(goriHome), `${key}.txt`);

/** Parse the single `<task-id>\t<side>` line. Returns null if missing or malformed. */
export const readSession = async (
  goriHome: string,
  key: string,
): Promise<SessionBinding | null> => {
  try {
    const text = await readFile(sessionFilePath(goriHome, key), "utf8");
    const [taskId, side] = text.trim().split("\t");
    if (!taskId || (side !== "pair-A" && side !== "pair-B")) return null;
    return { taskId, side };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
};

export const writeSession = async (
  goriHome: string,
  key: string,
  binding: SessionBinding,
): Promise<void> => {
  await mkdir(sessionsDir(goriHome), { recursive: true });
  await writeFileAtomic(sessionFilePath(goriHome, key), `${binding.taskId}\t${binding.side}`);
};

/** Clear the active binding (detach). No-op if it doesn't exist. */
export const clearSession = (goriHome: string, key: string): Promise<void> =>
  rm(sessionFilePath(goriHome, key), { force: true });

/**
 * Bump the session file's mtime to mark activity, so idle-based cleanup measures
 * time since the last command rather than since binding. No-op when no session.
 */
export const touchSession = async (goriHome: string, key: string): Promise<void> => {
  const now = new Date();
  try {
    await utimes(sessionFilePath(goriHome, key), now, now);
  } catch {
    // no session file — ignore
  }
};

export type SideMatch = Side | null | "ambiguous";

/**
 * Infer a side from the current directory at binding time. When both sides share
 * the same directory the result is "ambiguous" and the caller must ask explicitly.
 * At command time the session file is authoritative; this is only for binding/fallback.
 */
export const resolveSideByCwd = (meta: Meta, cwd: string): SideMatch => {
  const matchA = meta.pairA.dir === cwd;
  const matchB = meta.pairB.dir === cwd;
  if (matchA && matchB) return "ambiguous";
  if (matchA) return "pair-A";
  if (matchB) return "pair-B";
  return null;
};
