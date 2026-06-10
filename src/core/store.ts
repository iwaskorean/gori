import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { taskDir } from "./env.js";
import { withLock } from "./lock.js";
import type { Meta, Side, TaskStatus } from "./types.js";

// ---------- task id ----------

// Filesystem-unsafe characters to drop. Spaces (later hyphenated), hyphens and
// non-ASCII letters are preserved.
const UNSAFE = /[/\\:*?"<>|]/g;

export const slugify = (keyword: string): string => {
  const slug = keyword
    .trim()
    .toLowerCase()
    .replace(UNSAFE, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "task";
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** "YYYYMMDD-HHmmss" in local time (no timezone suffix). Used as the task id suffix. */
export const formatStamp = (now: Date): string =>
  `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
  `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

export const buildTaskId = (keyword: string, now: Date): string =>
  `${slugify(keyword)}_${formatStamp(now)}`;

/** "YYYY-MM-DD HH:mm:ss" — human-facing timestamp fields (seconds for ordering). */
export const formatDisplay = (now: Date): string =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
  ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

// ---------- fs helpers ----------

const pathExists = (p: string): Promise<boolean> =>
  access(p).then(() => true).catch(() => false);

let tmpCounter = 0;

/** Write to a temp file then rename (atomic replace). Assumes the same filesystem. */
export const writeFileAtomic = async (
  path: string,
  content: string,
): Promise<void> => {
  const tmp = `${path}.${process.pid}.${(tmpCounter += 1)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
};

// ---------- task paths / uniqueness ----------

export const metaPath = (goriHome: string, taskId: string): string =>
  join(taskDir(goriHome, taskId), "meta.yml");

/** If baseId already exists, append -2, -3, ... to guarantee a unique id. */
export const ensureUniqueTaskId = async (
  goriHome: string,
  baseId: string,
): Promise<string> => {
  if (!(await pathExists(taskDir(goriHome, baseId)))) return baseId;
  for (let n = 2; ; n += 1) {
    const candidate = `${baseId}-${n}`;
    if (!(await pathExists(taskDir(goriHome, candidate)))) return candidate;
  }
};

// ---------- meta <-> YAML (on-disk keys are kebab-case) ----------

type MetaYaml = {
  "task-id": string;
  keyword: string;
  "created-at": string;
  "pair-A": { dir: string | null; "joined-at": string | null };
  "pair-B": { dir: string | null; "joined-at": string | null };
  status: TaskStatus;
  "last-modified-by": Side;
  "last-modified-at": string;
};

export const metaToYaml = (m: Meta): string =>
  stringify({
    "task-id": m.taskId,
    keyword: m.keyword,
    "created-at": m.createdAt,
    "pair-A": { dir: m.pairA.dir, "joined-at": m.pairA.joinedAt },
    "pair-B": { dir: m.pairB.dir, "joined-at": m.pairB.joinedAt },
    status: m.status,
    "last-modified-by": m.lastModifiedBy,
    "last-modified-at": m.lastModifiedAt,
  } satisfies MetaYaml);

export const metaFromYaml = (text: string): Meta => {
  const y = parse(text) as MetaYaml;
  return {
    taskId: y["task-id"],
    keyword: y.keyword,
    createdAt: y["created-at"],
    pairA: { dir: y["pair-A"].dir, joinedAt: y["pair-A"]["joined-at"] },
    pairB: { dir: y["pair-B"].dir, joinedAt: y["pair-B"]["joined-at"] },
    status: y.status,
    lastModifiedBy: y["last-modified-by"],
    lastModifiedAt: y["last-modified-at"],
  };
};

// ---------- meta read/write ----------

export const readMeta = async (
  goriHome: string,
  taskId: string,
): Promise<Meta | null> => {
  try {
    return metaFromYaml(await readFile(metaPath(goriHome, taskId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const writeMeta = async (goriHome: string, meta: Meta): Promise<void> => {
  await mkdir(taskDir(goriHome, meta.taskId), { recursive: true });
  await writeFileAtomic(metaPath(goriHome, meta.taskId), metaToYaml(meta));
};

/** Serialize read-modify-write of an existing task's meta/spec across processes. */
export const withTaskLock = <T>(
  goriHome: string,
  taskId: string,
  fn: () => Promise<T> | T,
): Promise<T> => withLock(join(taskDir(goriHome, taskId), ".meta.lock"), fn);
