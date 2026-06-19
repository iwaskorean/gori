import { readFile, rm, stat, utimes } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notePath, readMeta, readSpec } from "../store.js";
import { sessionFilePath } from "../session.js";
import { answer, ask, close, create, link, log, scope } from "./index.js";
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

  it("rejects logging on a closed task", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    unwrap(await close(A, T2));
    expect(errorOf(await log(A, { message: "hi" }, T3)).code).toBe(
      "ALREADY_CLOSED",
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

  it("replaces one ### sub-section, leaving the others intact", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await scope(A, { text: "### A\n\nalpha\n\n### B\n\nbeta" }, T2);
    unwrap(await scope(A, { text: "ALPHA2", section: "A", mode: "replace" }, T3));
    expect((await readSpec(home, taskId)).scopeA).toBe(
      "### A\n\nALPHA2\n\n### B\n\nbeta",
    );
  });

  it("appends to one ### sub-section", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "x" }, T1));
    await scope(A, { text: "### A\n\nalpha\n\n### B\n\nbeta" }, T2);
    unwrap(await scope(A, { text: "more", section: "B", mode: "append" }, T3));
    expect((await readSpec(home, taskId)).scopeA).toBe(
      "### A\n\nalpha\n\n### B\n\nbeta\nmore",
    );
  });

  it("returns SECTION_NOT_FOUND listing the available headings", async () => {
    await create(A, { keyword: "x" }, T1);
    await scope(A, { text: "### A\n\nalpha" }, T2);
    const error = errorOf(
      await scope(A, { text: "x", section: "Z", mode: "replace" }, T3),
    );
    expect(error.code).toBe("SECTION_NOT_FOUND");
    expect(error.message).toContain('"A"');
  });

  it("returns SECTION_AMBIGUOUS when the ref matches more than one section", async () => {
    await create(A, { keyword: "x" }, T1);
    await scope(A, { text: "### Render core\n\nx\n\n### Render edge\n\ny" }, T2);
    expect(
      errorOf(await scope(A, { text: "z", section: "Render", mode: "replace" }, T3)).code,
    ).toBe("SECTION_AMBIGUOUS");
  });

  it("requires an explicit mode when editing a section", async () => {
    await create(A, { keyword: "x" }, T1);
    await scope(A, { text: "### A\n\nalpha" }, T2);
    expect(errorOf(await scope(A, { text: "x", section: "A" }, T3)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects text containing reserved headings, naming each", async () => {
    await create(A, { keyword: "x" }, T1);
    const error = errorOf(
      await scope(A, { text: "## pair-A Scope\nintro\n## Answered\nmore" }, T2),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("## pair-A Scope");
    expect(error.message).toContain("## Answered"); // every offender is listed
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

  it("rejects scoping on a closed task", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    unwrap(await close(A, T2));
    expect(errorOf(await scope(A, { text: "hi" }, T3)).code).toBe(
      "ALREADY_CLOSED",
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

  it("rejects asking on a closed task", async () => {
    unwrap(await create(A, { keyword: "x" }, T1));
    unwrap(await close(A, T2));
    expect(errorOf(await ask(A, { question: "q?" }, T3)).code).toBe(
      "ALREADY_CLOSED",
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

  it("rejects answering on a closed task, even with a matching question", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "shared" }, T1));
    await link(B, { taskId }, T2);
    await ask(A, { question: "q?" }, T3); // lands in B's queue as #1
    unwrap(await close(A, T3));
    expect(errorOf(await answer(B, { ref: "#1", answer: "x" }, T3)).code).toBe(
      "ALREADY_CLOSED",
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
