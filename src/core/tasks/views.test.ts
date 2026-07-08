import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMeta, writeMeta } from "../store.js";
import { readSession, sessionFilePath, writeSession } from "../session.js";
import { ask, create, link, list, log, read, scope, status } from "./index.js";
import type { Ctx, Meta } from "../types.js";
import { ctxOf, errorOf, freshTaskEnv, unwrap, T1, T2, T3 } from "./test-helpers.js";

let home: string;
let A: Ctx;
let B: Ctx;
let C: Ctx;

beforeEach(async () => {
  ({ home, A, B, C } = await freshTaskEnv());
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("list", () => {
  it("orders in-progress before closed, each most-recent first, and marks the active task", async () => {
    unwrap(await create(A, { keyword: "one" }, T1)); // A now bound to "two" after next call
    const two = unwrap(await create(A, { keyword: "two", force: true }, T3));

    // a closed task that is more recent than the in-progress ones
    const closed: Meta = {
      taskId: "done_20260101-101000",
      keyword: "done",
      createdAt: "2026-01-01 10:10:00",
      pairA: { dir: "/work/api", joinedAt: "2026-01-01 10:10:00" },
      pairB: { dir: null, joinedAt: null },
      status: "closed",
      lastModifiedBy: "pair-A",
      lastModifiedAt: "2026-01-01 10:10:00",
    };
    await writeMeta(home, closed);

    const { tasks } = unwrap(await list(A, T3));
    expect(tasks.map((t) => t.status)).toEqual(["in-progress", "in-progress", "closed"]);
    expect(tasks[0]?.taskId).toBe(two.taskId); // most recent in-progress first
    expect(tasks[0]?.isActive).toBe(true); // A is bound to "two"
    expect(tasks[2]?.taskId).toBe("done_20260101-101000");
  });

  it("includes per-side open question counts", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "for B?" }, T3);
    await ask(A, { question: "also for B?" }, T3);
    await ask(B, { question: "for A?" }, T3);

    const { tasks } = unwrap(await list(A, T3));
    expect(tasks[0]?.openQuestionCounts).toEqual({ pairA: 1, pairB: 2 });
  });

  it("ignores a non-task entry in the tasks directory (e.g. a macOS .DS_Store file)", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "real" }, T1));

    // macOS Finder drops a .DS_Store *file* into any folder it views. A file
    // is not a task directory, so reading tasks/.DS_Store/meta.yml fails with
    // ENOTDIR — list must skip it, not crash. The assertion guards the class
    // (any stray file), not this name in particular.
    await writeFile(join(home, "tasks", ".DS_Store"), "\x00\x00finder junk");

    const { tasks } = unwrap(await list(A, T1));
    expect(tasks.map((t) => t.taskId)).toEqual([taskId]);
  });

  it("skips a task whose meta.yml is corrupt instead of failing the whole list", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "real" }, T1));

    // A real task directory whose meta.yml is unparseable (truncated or
    // hand-corrupted). readMeta throws on it (not ENOENT/ENOTDIR), so
    // readAllMeta must skip it — one bad task can't take down list/status.
    await mkdir(join(home, "tasks", "corrupt_20260101-000000"), { recursive: true });
    await writeFile(join(home, "tasks", "corrupt_20260101-000000", "meta.yml"), "not a real meta");

    const { tasks } = unwrap(await list(A, T1));
    expect(tasks.map((t) => t.taskId)).toEqual([taskId]);
  });
});

describe("status", () => {
  it("returns null when there is no active task", async () => {
    expect(unwrap(await status(A, T1)).active).toBeNull();
  });

  it("flags partner activity by comparing last-modified side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);

    const forB = unwrap(await status(B, T3)).active;
    expect(forB?.side).toBe("pair-B");
    expect(forB?.partnerModified).toBe(false); // B just modified it

    const forA = unwrap(await status(A, T3)).active;
    expect(forA?.side).toBe("pair-A");
    expect(forA?.partnerModified).toBe(true); // B modified it last
    expect(forA?.paired).toBe(true);
  });

  it("counts open questions per side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "for B?" }, T3);

    const active = unwrap(await status(A, T3)).active;
    expect(active?.openQuestionCounts).toEqual({ pairA: 0, pairB: 1 });
  });

  it("returns no directory matches while this session is attached", async () => {
    unwrap(await create(A, { keyword: "bound" }, T1));
    const { active, unattachedMatches } = unwrap(await status(A, T2));
    expect(active).not.toBeNull();
    expect(unattachedMatches).toEqual([]);
  });

  it("surfaces a directory-matching task when this session is unattached", async () => {
    // A starts a task in /work/api; a new session (e.g. after /clear) then opens
    // in the same directory with a fresh key and was never attached.
    const { taskId } = unwrap(await create(A, { keyword: "tags" }, T1));
    const reopened = ctxOf(home, "/work/api", "keyA2");

    const { active, unattachedMatches } = unwrap(await status(reopened, T2));
    expect(active).toBeNull();
    expect(unattachedMatches).toEqual([
      expect.objectContaining({ taskId, keyword: "tags", side: "pair-A" }),
    ]);
  });

  it("lists every in-progress task matching the directory, most recent first", async () => {
    unwrap(await create(A, { keyword: "one" }, T1));
    unwrap(await create(A, { keyword: "two", force: true }, T2));
    const reopened = ctxOf(home, "/work/api", "keyA2");

    const { unattachedMatches } = unwrap(await status(reopened, T3));
    expect(unattachedMatches.map((m) => m.keyword)).toEqual(["two", "one"]);
  });

  it("reports no matches when nothing is bound to this directory", async () => {
    unwrap(await create(A, { keyword: "elsewhere" }, T1)); // lives in /work/api
    const { active, unattachedMatches } = unwrap(await status(C, T2)); // C is /work/none
    expect(active).toBeNull();
    expect(unattachedMatches).toEqual([]);
  });

  it("marks the side ambiguous when the directory matches both sides", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    const sameDirB = ctxOf(home, "/work/api", "keyB2"); // B pairs in from A's directory
    await link(sameDirB, { taskId }, T2);
    const reopened = ctxOf(home, "/work/api", "keyFresh");

    const { unattachedMatches } = unwrap(await status(reopened, T3));
    expect(unattachedMatches).toHaveLength(1);
    expect(unattachedMatches[0]?.side).toBe("ambiguous");
  });
});

describe("read", () => {
  it("returns the summary with both bodies null before anything is written", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    const view = unwrap(await read(A));
    expect(view.summary.taskId).toBe(taskId);
    expect(view.summary.side).toBe("pair-A");
    expect(view.spec).toBeNull();
    expect(view.note).toBeNull();
    expect(view.openForMe).toEqual([]);
  });

  it("returns the rendered spec and the raw note once they exist", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await scope(A, { text: "Own the API." }, T2);
    await log(B, { message: "starting on the worker" }, T3);

    const view = unwrap(await read(A));
    expect(view.spec).toContain("## pair-A Scope");
    expect(view.spec).not.toContain("## pair-B Scope"); // empty section omitted
    expect(view.note).toContain("starting on the worker");
    expect(view.summary.partnerModified).toBe(true); // B logged last
  });

  it("separates the questions waiting on the reading side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "Retry policy?" }, T3); // waits on B
    await ask(B, { question: "Which endpoint?" }, T3); // waits on A

    const forB = unwrap(await read(B));
    expect(forB.openForMe).toEqual([{ id: 1, asker: "pair-A", text: "Retry policy?" }]);

    const forA = unwrap(await read(A));
    expect(forA.openForMe).toEqual([{ id: 2, asker: "pair-B", text: "Which endpoint?" }]);
  });

  it("fills summary question counts even when reading the log only", async () => {
    // `which` gates only what is rendered; the spec is still read for the counts.
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(B, { question: "waits on A?" }, T3);

    const view = unwrap(await read(A, { which: "log" }));
    expect(view.summary.openQuestionCounts).toEqual({ pairA: 1, pairB: 0 });
    expect(view.spec).toBeNull();
  });

  it("omits the spec view and my open queue when reading the log only", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(B, { question: "Which endpoint?" }, T3); // waits on A
    await log(A, { message: "note entry" }, T3);

    const view = unwrap(await read(A, { which: "log" }));
    expect(view.spec).toBeNull();
    expect(view.openForMe).toEqual([]);
    expect(view.note).toContain("note entry");
  });

  it("omits the note when reading the spec only", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await scope(A, { text: "Own the API." }, T2);
    await log(A, { message: "note entry" }, T3);

    const view = unwrap(await read(A, { which: "spec" }));
    expect(view.spec).toContain("Own the API.");
    expect(view.note).toBeNull();
  });

  it("touches the session to mark activity", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    const old = new Date(T1.getTime() - 60_000);
    await utimes(sessionFilePath(home, "keyA"), old, old);
    const before = (await stat(sessionFilePath(home, "keyA"))).mtimeMs;
    await read(A);
    const after = (await stat(sessionFilePath(home, "keyA"))).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it("rejects reading with no active task", async () => {
    expect(errorOf(await read(C)).code).toBe("NO_ACTIVE_TASK");
  });

  it("rejects reading when the active task no longer exists", async () => {
    await writeSession(home, "keyC", {
      taskId: "ghost_20260101-000000",
      side: "pair-A",
    });
    expect(errorOf(await read(C)).code).toBe("NO_ACTIVE_TASK");
  });
});

describe("idle GC (runs on list/status)", () => {
  it("keeps an active in-progress session that was just touched", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await status(A, T2); // touches keyA, then GC
    expect(await readSession(home, "keyA")).toEqual({ taskId, side: "pair-A" });
  });

  it("collects a session file older than the idle window", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    const old = new Date(T1.getTime() - 15 * 24 * 60 * 60 * 1000);
    await utimes(sessionFilePath(home, "keyA"), old, old);
    await list(C, T1); // C triggers GC without touching keyA
    expect(await readSession(home, "keyA")).toBeNull();
  });

  it("collects a session pointing to a closed task", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    const meta = await readMeta(home, taskId);
    if (meta) await writeMeta(home, { ...meta, status: "closed" });
    await list(C, T1);
    expect(await readSession(home, "keyA")).toBeNull();
  });

  it("collects a dangling session pointing to a missing task", async () => {
    await writeSession(home, "keyD", {
      taskId: "ghost_20260101-000000",
      side: "pair-A",
    });
    await list(C, T1);
    expect(await readSession(home, "keyD")).toBeNull();
  });
});
