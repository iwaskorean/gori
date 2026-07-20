import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMeta, writeMeta } from "../store.js";
import { readSession } from "../session.js";
import {
  attach,
  attachCandidates,
  block,
  close,
  create,
  detach,
  link,
  linkCandidates,
  log,
  reopen,
} from "./index.js";
import type { Ctx } from "../types.js";
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

describe("link (pairing)", () => {
  it("lists a partner's unpaired task, excluding one this session started", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));

    const forB = unwrap(await linkCandidates(B));
    expect(forB.candidates.map((c) => c.taskId)).toEqual([taskId]);
    expect(forB.candidates[0]?.sameDir).toBe(false);
    expect(forB.candidates[0]?.createdAt).toBe("2026-01-01 10:00:00");

    const forA = unwrap(await linkCandidates(A));
    expect(forA.candidates).toEqual([]); // A started it, so it's not a candidate for A
  });

  it("flags whether a candidate has a note timeline yet", async () => {
    unwrap(await create(A, { keyword: "shared" }, T1));
    expect(unwrap(await linkCandidates(B)).candidates[0]?.hasNote).toBe(false);
    await log(A, { message: "context for whoever joins" }, T2);
    expect(unwrap(await linkCandidates(B)).candidates[0]?.hasNote).toBe(true);
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
    expect(errorOf(await link(B, { taskId: "ghost_20260101-000000" })).code).toBe("TASK_NOT_FOUND");
  });

  it("rejects pairing into a closed task", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    unwrap(await close(A, T2));
    expect(errorOf(await link(B, { taskId }, T3)).code).toBe("ALREADY_CLOSED");
  });

  it("excludes a blocked task from pairing candidates", async () => {
    unwrap(await create(A, { keyword: "blocked-one" }, T1));
    unwrap(await block(A, { reason: "needs a call" }, T2));
    const open = unwrap(await create(A, { keyword: "open-one", force: true }, T3));
    const ids = unwrap(await linkCandidates(C)).candidates.map((c) => c.taskId);
    expect(ids).toEqual([open.taskId]); // the blocked task is not offered for pairing
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

describe("attach (reconnect / switch tasks)", () => {
  it("infers the side from cwd and binds a fresh session", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);

    // a new session sharing pair-B's directory, with no prior binding
    const B2 = ctxOf(home, "/work/web", "keyB2");
    const result = unwrap(await attach(B2, { taskId }));
    expect(result.side).toBe("pair-B");
    expect(result.previousActive).toBeNull();
    expect(await readSession(home, "keyB2")).toEqual({ taskId, side: "pair-B" });
  });

  it("reports the previously active task when switching", async () => {
    const one = unwrap(await create(A, { keyword: "one" }, T1));
    const two = unwrap(await create(A, { keyword: "two", force: true }, T2)); // A now bound to two
    const result = unwrap(await attach(A, { taskId: one.taskId }));
    expect(result.previousActive).toBe(two.taskId);
    expect(await readSession(home, "keyA")).toEqual({
      taskId: one.taskId,
      side: "pair-A",
    });
  });

  it("returns SIDE_AMBIGUOUS when both sides share the cwd and no side is given", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    // a different session pairs in from the same directory as pair-A
    const Bsame = ctxOf(home, "/work/api", "keyBsame");
    await link(Bsame, { taskId }, T2);

    const X = ctxOf(home, "/work/api", "keyX");
    expect(errorOf(await attach(X, { taskId })).code).toBe("SIDE_AMBIGUOUS");
  });

  it("accepts an explicit side to disambiguate a shared directory", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    const Bsame = ctxOf(home, "/work/api", "keyBsame");
    await link(Bsame, { taskId }, T2);

    const X = ctxOf(home, "/work/api", "keyX");
    expect(unwrap(await attach(X, { taskId, side: "pair-B" })).side).toBe("pair-B");
  });

  it("rejects a cwd that matches neither side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    expect(errorOf(await attach(C, { taskId })).code).toBe("NOT_REGISTERED");
  });

  it("rejects an explicit side that has not joined the task", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "solo" }, T1));
    // pair-B never linked, so its directory is unregistered
    expect(errorOf(await attach(C, { taskId, side: "pair-B" })).code).toBe("NOT_REGISTERED");
  });

  it("rejects a non-existent task", async () => {
    expect(errorOf(await attach(A, { taskId: "ghost_20260101-000000" })).code).toBe(
      "TASK_NOT_FOUND",
    );
  });

  it("refuses to attach a closed task", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    const meta = await readMeta(home, taskId);
    if (meta) await writeMeta(home, { ...meta, status: "closed" });
    expect(errorOf(await attach(A, { taskId })).code).toBe("ALREADY_CLOSED");
  });

  it("lists matching in-progress tasks with their side, most recent first", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);

    const forApiDir = ctxOf(home, "/work/api", "keyProbe");
    const { candidates } = unwrap(await attachCandidates(forApiDir));
    expect(candidates).toEqual([
      { taskId, keyword: "shared", side: "pair-A", lastModifiedAt: "2026-01-01 10:00:05" },
    ]);

    // a directory registered to neither side sees nothing
    expect(unwrap(await attachCandidates(C)).candidates).toEqual([]);
  });

  it("surfaces a blocked task as an attach candidate and attaches to it", async () => {
    // A blocked task is reattachable — a side reconnects to resolve it — so it
    // must appear here and attach must accept it (only closed is rejected).
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    unwrap(await block(A, { reason: "needs a call" }, T2));
    const probe = ctxOf(home, "/work/api", "keyProbe");
    expect(unwrap(await attachCandidates(probe)).candidates.map((c) => c.taskId)).toEqual([taskId]);
    expect(unwrap(await attach(probe, { taskId })).side).toBe("pair-A");
  });

  it("marks a candidate ambiguous when both sides share the cwd", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    const Bsame = ctxOf(home, "/work/api", "keyBsame");
    await link(Bsame, { taskId }, T2);

    const probe = ctxOf(home, "/work/api", "keyProbe");
    expect(unwrap(await attachCandidates(probe)).candidates[0]?.side).toBe("ambiguous");
  });
});

describe("path-traversal guard", () => {
  const ESCAPE = "../../escape";

  it("rejects link with a path-unsafe id before any lookup", async () => {
    expect(errorOf(await link(B, { taskId: ESCAPE }, T2)).code).toBe("INVALID_TASK_ID");
  });
  it("rejects attach with a path-unsafe id", async () => {
    expect(errorOf(await attach(A, { taskId: ESCAPE })).code).toBe("INVALID_TASK_ID");
  });
  it("rejects reopen with a path-unsafe id", async () => {
    expect(errorOf(await reopen(A, { taskId: ESCAPE }, T2)).code).toBe("INVALID_TASK_ID");
  });

  it("treats a safe id naming a stray file as not-found, not a crash", async () => {
    // .DS_Store passes the safety guard (no separators, not "." or ".."), so
    // the lookup proceeds and hits ENOTDIR on the stray file. readMeta maps
    // that to null, so the verb reports TASK_NOT_FOUND instead of throwing.
    unwrap(await create(A, { keyword: "real" }, T1)); // ensure tasks/ exists
    await writeFile(join(home, "tasks", ".DS_Store"), "finder junk");
    expect(errorOf(await link(B, { taskId: ".DS_Store" }, T2)).code).toBe("TASK_NOT_FOUND");
  });
});
