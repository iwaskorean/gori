import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMeta, readSpec } from "../store.js";
import { readSession } from "../session.js";
import { block, close, create, link, log, reopen, unblock } from "./index.js";
import type { Ctx } from "../types.js";
import { errorOf, freshTaskEnv, unwrap, T1, T2, T3 } from "./test-helpers.js";

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

describe("create", () => {
  it("creates a task and binds the session as pair-A", async () => {
    const { taskId, previousActive } = unwrap(await create(A, { keyword: "billing webhook" }, T1));
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
    expect(errorOf(await create(A, { keyword: "   " }, T1)).code).toBe("INVALID_INPUT");
  });

  it("reports the previously active task when re-creating in the same session", async () => {
    const first = unwrap(await create(A, { keyword: "one" }, T1));
    const second = unwrap(await create(A, { keyword: "two", force: true }, T2));
    expect(second.previousActive).toBe(first.taskId);
  });

  it("rejects creating where an in-progress task already registered this directory", async () => {
    const first = unwrap(await create(A, { keyword: "one" }, T1));
    const error = errorOf(await create(A, { keyword: "two" }, T2));
    expect(error.code).toBe("CWD_IN_USE");
    expect(error.message).toContain(first.taskId);
  });

  it("rejects creating from a directory registered as the partner side", async () => {
    // The wrong-side create observed in dogfooding: the session that should
    // have linked as pair-B started a second task instead.
    const { taskId } = unwrap(await create(A, { keyword: "one" }, T1));
    unwrap(await link(B, { taskId }, T2));
    expect(errorOf(await create(B, { keyword: "dup" }, T3)).code).toBe("CWD_IN_USE");
  });

  it("allows creating again once the directory's task is closed", async () => {
    unwrap(await create(A, { keyword: "one" }, T1));
    unwrap(await close(A, T2));
    expect((await create(A, { keyword: "two" }, T3)).ok).toBe(true);
  });

  it("rejects creating where a blocked task already registered this directory", async () => {
    // A blocked task still occupies the directory, so create must not slip a
    // duplicate past the guard the way it would if only in-progress counted.
    const first = unwrap(await create(A, { keyword: "one" }, T1));
    unwrap(await block(A, { reason: "needs a call" }, T2));
    const error = errorOf(await create(A, { keyword: "two" }, T3));
    expect(error.code).toBe("CWD_IN_USE");
    expect(error.message).toContain(first.taskId);
  });

  it("records an initial pair-A scope in the same step", async () => {
    const { taskId, scopeRecorded } = unwrap(
      await create(A, { keyword: "one", scope: "FE: settings UI" }, T1),
    );
    expect(scopeRecorded).toBe(true);
    expect((await readSpec(home, taskId)).scopeA).toBe("FE: settings UI");
  });

  it("rejects a scope with a reserved heading before creating anything", async () => {
    const result = await create(A, { keyword: "one", scope: "## Answered\nsneaky" }, T1);
    const error = errorOf(result);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("## Answered"); // names the offending heading
    expect(await readSession(home, "keyA")).toBeNull(); // no task was created
  });
});

describe("close / reopen (lifecycle)", () => {
  it("closes the active task but leaves the session pointer for GC", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    expect(unwrap(await close(A, T2)).taskId).toBe(taskId);

    const meta = await readMeta(home, taskId);
    expect(meta?.status).toBe("closed");
    expect(meta?.lastModifiedBy).toBe("pair-A");
    expect(meta?.lastModifiedAt).toBe("2026-01-01 10:00:05");
    // the pointer is not cleared here; idle GC drops it on the next list/status
    expect(await readSession(home, "keyA")).toEqual({ taskId, side: "pair-A" });
  });

  it("rejects close when there is no active task", async () => {
    expect(errorOf(await close(C, T1)).code).toBe("NO_ACTIVE_TASK");
  });

  it("rejects closing an already-closed task", async () => {
    await create(A, { keyword: "x" }, T1);
    await close(A, T2);
    expect(errorOf(await close(A, T3)).code).toBe("ALREADY_CLOSED");
  });

  it("reopens a closed task by id", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await close(A, T2);
    const result = unwrap(await reopen(A, { taskId }, T3));
    expect(result.taskId).toBe(taskId);
    expect(result.reattach).toBe(false); // A still points to it
    expect((await readMeta(home, taskId))?.status).toBe("in-progress");
  });

  it("reopens using the session pointer when no id is given", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await close(A, T2);
    const result = unwrap(await reopen(A, {}, T3));
    expect(result.taskId).toBe(taskId);
    expect(result.reattach).toBe(false);
  });

  it("flags reattach when reopening a task this session is not bound to", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await close(A, T2);
    const result = unwrap(await reopen(C, { taskId }, T3));
    expect(result.reattach).toBe(true);
    // an unbound reopener does not overwrite the last-modified side
    expect((await readMeta(home, taskId))?.lastModifiedBy).toBe("pair-A");
  });

  it("rejects reopening a task that is already in progress", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    expect(errorOf(await reopen(A, { taskId }, T2)).code).toBe("ALREADY_OPEN");
  });

  it("rejects reopening a non-existent task", async () => {
    expect(errorOf(await reopen(A, { taskId: "ghost_20260101-000000" }, T1)).code).toBe(
      "TASK_NOT_FOUND",
    );
  });

  it("rejects reopen with neither an id nor a session pointer", async () => {
    expect(errorOf(await reopen(C, {}, T1)).code).toBe("NO_ACTIVE_TASK");
  });
});

describe("block / unblock (lifecycle)", () => {
  it("blocks the active task, recording the reason and flipping status", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    expect(unwrap(await block(A, { reason: "needs a schema decision" }, T2)).taskId).toBe(taskId);

    const meta = await readMeta(home, taskId);
    expect(meta?.status).toBe("blocked");
    expect(meta?.blockedReason).toBe("needs a schema decision");
    expect(meta?.lastModifiedBy).toBe("pair-A");
    expect(meta?.lastModifiedAt).toBe("2026-01-01 10:00:05");
  });

  it("requires a reason", async () => {
    await create(A, { keyword: "x" }, T1);
    expect(errorOf(await block(A, { reason: "   " }, T2)).code).toBe("INVALID_INPUT");
  });

  it("flattens a multi-line reason to a single line", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    unwrap(await block(A, { reason: "line one\n\n  line two" }, T2));
    expect((await readMeta(home, taskId))?.blockedReason).toBe("line one line two");
  });

  it("rejects blocking with no active task", async () => {
    expect(errorOf(await block(C, { reason: "r" }, T1)).code).toBe("NO_ACTIVE_TASK");
  });

  it("rejects blocking an already-blocked task", async () => {
    await create(A, { keyword: "x" }, T1);
    await block(A, { reason: "r" }, T2);
    expect(errorOf(await block(A, { reason: "again" }, T3)).code).toBe("ALREADY_BLOCKED");
  });

  it("rejects blocking a closed task", async () => {
    await create(A, { keyword: "x" }, T1);
    await close(A, T2);
    expect(errorOf(await block(A, { reason: "r" }, T3)).code).toBe("ALREADY_CLOSED");
  });

  it("unblocks a blocked task, clearing the reason", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await block(A, { reason: "r" }, T2);
    expect(unwrap(await unblock(A, T3)).taskId).toBe(taskId);

    const meta = await readMeta(home, taskId);
    expect(meta?.status).toBe("in-progress");
    expect(meta?.blockedReason).toBeNull();
  });

  it("rejects unblocking a task that is not blocked", async () => {
    await create(A, { keyword: "x" }, T1);
    expect(errorOf(await unblock(A, T2)).code).toBe("NOT_BLOCKED");
  });

  it("rejects unblocking with no active task", async () => {
    expect(errorOf(await unblock(C, T1)).code).toBe("NO_ACTIVE_TASK");
  });

  it("keeps a blocked task mutable, and working on it does not auto-clear the block", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await block(A, { reason: "r" }, T2);
    expect((await log(A, { message: "still investigating" }, T3)).ok).toBe(true);
    expect((await readMeta(home, taskId))?.status).toBe("blocked");
  });

  it("clears the block reason when a blocked task is closed", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await block(A, { reason: "r" }, T2);
    unwrap(await close(A, T3));

    const meta = await readMeta(home, taskId);
    expect(meta?.status).toBe("closed");
    expect(meta?.blockedReason).toBeNull();
  });

  it("directs reopen to unblock when the task is blocked, not closed", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await block(A, { reason: "r" }, T2);
    const error = errorOf(await reopen(A, { taskId }, T3));
    expect(error.code).toBe("ALREADY_BLOCKED");
    expect(error.message).toContain("unblock");
    expect((await readMeta(home, taskId))?.status).toBe("blocked"); // reopen left it untouched
  });
});
