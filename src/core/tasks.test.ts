import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notePath, readMeta, readSpec, writeMeta } from "./store.js";
import { readSession, sessionFilePath, writeSession } from "./session.js";
import {
  answer,
  ask,
  attach,
  attachCandidates,
  close,
  create,
  detach,
  link,
  linkCandidates,
  list,
  log,
  read,
  reopen,
  scope,
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
    const two = unwrap(await create(A, { keyword: "two" }, T2)); // A now bound to two
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
    expect(unwrap(await attach(X, { taskId, side: "pair-B" })).side).toBe(
      "pair-B",
    );
  });

  it("rejects a cwd that matches neither side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    expect(errorOf(await attach(C, { taskId })).code).toBe("NOT_REGISTERED");
  });

  it("rejects an explicit side that has not joined the task", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "solo" }, T1));
    // pair-B never linked, so its directory is unregistered
    expect(errorOf(await attach(C, { taskId, side: "pair-B" })).code).toBe(
      "NOT_REGISTERED",
    );
  });

  it("rejects a non-existent task", async () => {
    expect(
      errorOf(await attach(A, { taskId: "ghost_20260101-000000" })).code,
    ).toBe("TASK_NOT_FOUND");
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

  it("marks a candidate ambiguous when both sides share the cwd", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    const Bsame = ctxOf(home, "/work/api", "keyBsame");
    await link(Bsame, { taskId }, T2);

    const probe = ctxOf(home, "/work/api", "keyProbe");
    expect(unwrap(await attachCandidates(probe)).candidates[0]?.side).toBe(
      "ambiguous",
    );
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
    expect(
      errorOf(await reopen(A, { taskId: "ghost_20260101-000000" }, T1)).code,
    ).toBe("TASK_NOT_FOUND");
  });

  it("rejects reopen with neither an id nor a session pointer", async () => {
    expect(errorOf(await reopen(C, {}, T1)).code).toBe("NO_ACTIVE_TASK");
  });
});

describe("log (note channel)", () => {
  const readNote = (taskId: string): Promise<string> =>
    readFile(notePath(home, taskId), "utf8");

  it("creates note.md with a timestamped header and body on first log", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    const result = unwrap(await log(A, { message: "first entry" }, T2));
    expect(result.taskId).toBe(taskId);
    expect(result.suggestPromotion).toBe(false);
    expect(await readNote(taskId)).toBe(
      "## 2026-01-01 10:00:05 [pair-A]\n\nfirst entry\n",
    );
  });

  it("preserves a multi-line message", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await log(A, { message: "line one\nline two" }, T2);
    expect(await readNote(taskId)).toContain("line one\nline two");
  });

  it("appends a second block separated by a blank line", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await link(B, { taskId }, T2);
    await log(A, { message: "from A" }, T2);
    await log(B, { message: "from B" }, T3);

    const note = await readNote(taskId);
    expect(note).toBe(
      "## 2026-01-01 10:00:05 [pair-A]\n\nfrom A\n" +
        "\n## 2026-01-01 10:01:00 [pair-B]\n\nfrom B\n",
    );
    expect(note.match(/^## /gm)).toHaveLength(2);
  });

  it("updates meta last-modified to the logging side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await link(B, { taskId }, T2); // last modified by B
    await log(A, { message: "hi" }, T3); // now A
    const meta = await readMeta(home, taskId);
    expect(meta?.lastModifiedBy).toBe("pair-A");
    expect(meta?.lastModifiedAt).toBe("2026-01-01 10:01:00");
  });

  it("touches the session to mark activity", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    const old = new Date(T1.getTime() - 60_000);
    await utimes(sessionFilePath(home, "keyA"), old, old);
    const before = (await stat(sessionFilePath(home, "keyA"))).mtimeMs;
    await log(A, { message: "hi" }, T2);
    const after = (await stat(sessionFilePath(home, "keyA"))).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it("rejects a blank message", async () => {
    await create(A, { keyword: "x" }, T1);
    expect(errorOf(await log(A, { message: "   " }, T2)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects logging with no active task", async () => {
    expect(errorOf(await log(C, { message: "hi" }, T1)).code).toBe(
      "NO_ACTIVE_TASK",
    );
  });

  it("flags suggestPromotion once the note exceeds the line threshold", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    expect(unwrap(await log(A, { message: "short" }, T2)).suggestPromotion).toBe(
      false,
    );

    const long = Array.from({ length: 31 }, (_, i) => `line ${i}`).join("\n");
    expect(unwrap(await log(A, { message: long }, T3)).suggestPromotion).toBe(
      true,
    );
  });
});

describe("scope (spec channel)", () => {
  it("sets the current side's scope and creates the spec skeleton", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    expect(unwrap(await scope(A, { text: "Own the API." }, T2)).taskId).toBe(
      taskId,
    );
    const doc = await readSpec(home, taskId);
    expect(doc.scopeA).toBe("Own the API.");
    expect(doc.scopeB).toBe("");
  });

  it("writes to the side bound to the calling session", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await scope(A, { text: "API side" }, T2);
    await scope(B, { text: "Worker side" }, T3);
    const doc = await readSpec(home, taskId);
    expect(doc.scopeA).toBe("API side");
    expect(doc.scopeB).toBe("Worker side");
  });

  it("returns SCOPE_EXISTS when a scope is already set and no mode is given", async () => {
    await create(A, { keyword: "x" }, T1);
    await scope(A, { text: "first" }, T2);
    expect(errorOf(await scope(A, { text: "second" }, T3)).code).toBe(
      "SCOPE_EXISTS",
    );
  });

  it("appends to the existing scope on mode append", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await scope(A, { text: "first" }, T2);
    await scope(A, { text: "second", mode: "append" }, T3);
    expect((await readSpec(home, taskId)).scopeA).toBe("first\nsecond");
  });

  it("replaces the existing scope on mode replace", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await scope(A, { text: "first" }, T2);
    await scope(A, { text: "second", mode: "replace" }, T3);
    expect((await readSpec(home, taskId)).scopeA).toBe("second");
  });

  it("rejects text containing a reserved heading", async () => {
    await create(A, { keyword: "x" }, T1);
    expect(
      errorOf(await scope(A, { text: "intro\n## Answered\nmore" }, T2)).code,
    ).toBe("INVALID_INPUT");
  });

  it("rejects a blank scope", async () => {
    await create(A, { keyword: "x" }, T1);
    expect(errorOf(await scope(A, { text: "   " }, T2)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects scoping with no active task", async () => {
    expect(errorOf(await scope(C, { text: "hi" }, T1)).code).toBe(
      "NO_ACTIVE_TASK",
    );
  });

  it("updates meta last-modified to the scoping side", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2); // last modified by B
    await scope(A, { text: "mine" }, T3); // now A
    const meta = await readMeta(home, taskId);
    expect(meta?.lastModifiedBy).toBe("pair-A");
    expect(meta?.lastModifiedAt).toBe("2026-01-01 10:01:00");
  });
});

describe("ask (spec channel)", () => {
  it("adds a question to the partner side's open queue, attributed to the asker", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    const { id } = unwrap(await ask(A, { question: "Retry policy?" }, T3));
    expect(id).toBe(1);

    const doc = await readSpec(home, taskId);
    expect(doc.openA).toEqual([]); // A's own queue stays empty
    expect(doc.openB).toEqual([{ id: 1, asker: "pair-A", text: "Retry policy?" }]);
  });

  it("hands out increasing ids across calls", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    expect(unwrap(await ask(A, { question: "first?" }, T3)).id).toBe(1);
    expect(unwrap(await ask(B, { question: "second?" }, T3)).id).toBe(2);
  });

  it("rejects a blank question", async () => {
    await create(A, { keyword: "x" }, T1);
    expect(errorOf(await ask(A, { question: "  " }, T2)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects asking with no active task", async () => {
    expect(errorOf(await ask(C, { question: "hi?" }, T1)).code).toBe(
      "NO_ACTIVE_TASK",
    );
  });
});

describe("answer (spec channel)", () => {
  it("resolves a question by stable id and moves it to Answered", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "Retry policy?" }, T3); // lands in B's queue as #1
    const { id, queueEmpty } = unwrap(
      await answer(B, { ref: "#1", answer: "Exponential." }, T3),
    );
    expect(id).toBe(1);
    expect(queueEmpty).toBe(true); // B's queue is drained

    const doc = await readSpec(home, taskId);
    expect(doc.openB).toEqual([]);
    expect(doc.answered).toEqual([
      {
        id: 1,
        asker: "pair-A",
        answerer: "pair-B",
        date: "2026-01-01 10:01:00",
        question: "Retry policy?",
        answer: "Exponential.",
      },
    ]);
  });

  it("resolves by case-insensitive text substring", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "Which signing secret?" }, T3);
    unwrap(await answer(B, { ref: "signing", answer: "STRIPE_KEY" }, T3));
    expect((await readSpec(home, taskId)).answered[0]?.answer).toBe("STRIPE_KEY");
  });

  it("flattens a multiline question and answer to single lines", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "Timeout budget?\nPer attempt or total?" }, T3);
    unwrap(await answer(B, { ref: "#1", answer: "30s\ntotal" }, T3));
    const entry = (await readSpec(home, taskId)).answered[0];
    expect(entry?.question).toBe("Timeout budget? Per attempt or total?");
    expect(entry?.answer).toBe("30s total");
  });

  it("rejects an ambiguous text reference", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "retry on 500?" }, T3);
    await ask(A, { question: "retry on 503?" }, T3);
    expect(errorOf(await answer(B, { ref: "retry", answer: "yes" }, T3)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects a reference matching no open question", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "only question?" }, T3);
    expect(errorOf(await answer(B, { ref: "#99", answer: "x" }, T3)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("only matches the answering side's own queue", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "for B?" }, T3); // sits in B's queue
    // A tries to answer its own (empty) queue
    expect(errorOf(await answer(A, { ref: "#1", answer: "x" }, T3)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects a blank answer", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "q?" }, T3);
    expect(errorOf(await answer(B, { ref: "#1", answer: "  " }, T3)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects answering with no active task", async () => {
    expect(errorOf(await answer(C, { ref: "#1", answer: "x" }, T1)).code).toBe(
      "NO_ACTIVE_TASK",
    );
  });

  it("reports a non-empty queue while questions remain", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "first?" }, T3);
    await ask(A, { question: "second?" }, T3);
    const first = unwrap(await answer(B, { ref: "#1", answer: "x" }, T3));
    expect(first.queueEmpty).toBe(false);
    const second = unwrap(await answer(B, { ref: "#2", answer: "y" }, T3));
    expect(second.queueEmpty).toBe(true);
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

  it("includes per-side open question counts", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "for B?" }, T3);
    await ask(A, { question: "also for B?" }, T3);
    await ask(B, { question: "for A?" }, T3);

    const { tasks } = unwrap(await list(A, T3));
    expect(tasks[0]?.openQuestionCounts).toEqual({ pairA: 1, pairB: 2 });
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
    expect(forB.openForMe).toEqual([
      { id: 1, asker: "pair-A", text: "Retry policy?" },
    ]);

    const forA = unwrap(await read(A));
    expect(forA.openForMe).toEqual([
      { id: 2, asker: "pair-B", text: "Which endpoint?" },
    ]);
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
