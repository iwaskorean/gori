import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMeta, writeMeta } from "./store.js";
import { readSession, sessionFilePath, writeSession } from "./session.js";
import {
  create,
  detach,
  link,
  linkCandidates,
  list,
  status,
} from "./tasks.js";
import type { Ctx, Meta, Result } from "./types.js";

const ctxOf = (home: string, cwd: string, key: string): Ctx => ({
  goriHome: home,
  cwd,
  sessionKey: key,
});

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
};

const errorOf = <T>(r: Result<T>) => {
  if (r.ok) throw new Error("expected an error");
  return r.error;
};

const T1 = new Date(2026, 0, 1, 10, 0, 0);
const T2 = new Date(2026, 0, 1, 10, 0, 5);
const T3 = new Date(2026, 0, 1, 10, 1, 0);

let home: string;
let A: Ctx; // a session that starts tasks (becomes pair-A)
let B: Ctx; // a different session/dir that pairs in (becomes pair-B)
let C: Ctx; // an unrelated session, used to trigger GC without touching A/B

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gori-tasks-"));
  A = ctxOf(home, "/work/api", "keyA");
  B = ctxOf(home, "/work/web", "keyB");
  C = ctxOf(home, "/work/none", "keyC");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("create", () => {
  it("creates a task and binds the session as pair-A", async () => {
    const { taskId, previousActive } = unwrap(
      await create(A, { keyword: "billing webhook" }, T1),
    );
    expect(taskId).toBe("billing-webhook_20260101-100000");
    expect(previousActive).toBeNull();

    const meta = await readMeta(home, taskId);
    expect(meta?.pairA.dir).toBe("/work/api");
    expect(meta?.pairB.dir).toBeNull();
    expect(meta?.status).toBe("in-progress");
    expect(meta?.lastModifiedBy).toBe("pair-A");
    expect(await readSession(home, "keyA")).toEqual({ taskId, side: "pair-A" });
  });

  it("rejects a blank keyword", async () => {
    expect(errorOf(await create(A, { keyword: "   " }, T1)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("reports the previously active task when re-creating in the same session", async () => {
    const first = unwrap(await create(A, { keyword: "one" }, T1));
    const second = unwrap(await create(A, { keyword: "two" }, T2));
    expect(second.previousActive).toBe(first.taskId);
  });
});

describe("link (pairing)", () => {
  it("lists a partner's unpaired task, excluding one this session started", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));

    const forB = unwrap(await linkCandidates(B));
    expect(forB.candidates.map((c) => c.taskId)).toEqual([taskId]);
    expect(forB.candidates[0]?.sameDir).toBe(false);

    const forA = unwrap(await linkCandidates(A));
    expect(forA.candidates).toEqual([]); // A started it, so it's not a candidate for A
  });

  it("pairs the partner in and binds them as pair-B", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    expect(unwrap(await link(B, { taskId }, T2)).taskId).toBe(taskId);

    const meta = await readMeta(home, taskId);
    expect(meta?.pairB.dir).toBe("/work/web");
    expect(meta?.lastModifiedBy).toBe("pair-B");
    expect(await readSession(home, "keyB")).toEqual({ taskId, side: "pair-B" });

    // once paired, it's no longer a candidate
    expect(unwrap(await linkCandidates(C)).candidates).toEqual([]);
  });

  it("rejects pairing an already-paired task", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    expect(errorOf(await link(C, { taskId }, T3)).code).toBe("NO_PAIRABLE_TASK");
  });

  it("rejects a non-existent task", async () => {
    expect(errorOf(await link(B, { taskId: "ghost_20260101-000000" })).code).toBe(
      "TASK_NOT_FOUND",
    );
  });

  it("rejects pairing with a task this session started", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    expect(errorOf(await link(A, { taskId }, T2)).code).toBe("NO_PAIRABLE_TASK");
  });
});

describe("detach", () => {
  it("clears the active binding", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    expect(unwrap(await detach(A)).taskId).toBe(taskId);
    expect(await readSession(home, "keyA")).toBeNull();
  });
});

describe("list", () => {
  it("orders in-progress before closed, each most-recent first, and marks the active task", async () => {
    unwrap(await create(A, { keyword: "one" }, T1)); // A now bound to "two" after next call
    const two = unwrap(await create(A, { keyword: "two" }, T3));

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
    expect(tasks.map((t) => t.status)).toEqual([
      "in-progress",
      "in-progress",
      "closed",
    ]);
    expect(tasks[0]?.taskId).toBe(two.taskId); // most recent in-progress first
    expect(tasks[0]?.isActive).toBe(true); // A is bound to "two"
    expect(tasks[2]?.taskId).toBe("done_20260101-101000");
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
});

describe("idle GC (runs on list/status)", () => {
  it("keeps an active in-progress session that was just touched", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await status(A, T2); // touches keyA, then GC
    expect(await readSession(home, "keyA")).toEqual({ taskId, side: "pair-A" });
  });

  it("collects a session file older than the idle window", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    const old = new Date(T1.getTime() - 8 * 24 * 60 * 60 * 1000);
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
