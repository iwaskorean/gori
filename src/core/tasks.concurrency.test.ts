import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMeta, readNote, readSpec } from "./store.js";
import { ask, create, link, log } from "./tasks/index.js";
import type { Ctx, Result } from "./types.js";

// These tests race verbs against each other in-process via Promise.all. The
// O_EXCL lockfile serializes even same-process contenders, so this exercises the
// real per-task lock without spawning processes. Assertions check invariants
// (nothing lost, single winner), never ordering — ordering under a race is
// undefined by design.

const ctxOf = (home: string, cwd: string, key: string): Ctx => ({
  goriHome: home,
  cwd,
  sessionKey: key,
});

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
};

// A single fixed instant: timestamps render at second precision, so the per-entry
// payloads (not the clock) are what make blocks/questions distinguishable.
const T = new Date(2026, 0, 1, 10, 0, 0);

let home: string;
let A: Ctx; // session that starts the task (pair-A)
let B: Ctx; // session that pairs in (pair-B)

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gori-concurrency-"));
  A = ctxOf(home, "/work/api", "keyA");
  B = ctxOf(home, "/work/web", "keyB");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const pairedTask = async (): Promise<string> => {
  const { taskId } = unwrap(await create(A, { keyword: "billing" }, T));
  unwrap(await link(B, { taskId }, T));
  return taskId;
};

describe("concurrent writes on one task are serialized by the per-task lock", () => {
  it("keeps every block when both sides log at once (no lost update)", async () => {
    const taskId = await pairedTask();
    const count = 8;

    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        log(i % 2 === 0 ? A : B, { message: `entry-${i}` }, T),
      ),
    );
    results.forEach((r) => unwrap(r));

    const note = await readNote(home, taskId);
    for (let i = 0; i < count; i += 1) {
      expect(note).toContain(`entry-${i}`);
    }
    // one `## <ts> [side]` header per block — count must equal the logs fired
    expect(note?.match(/^## /gm)?.length).toBe(count);
  });

  it("assigns a unique id to every question under concurrent ask", async () => {
    const taskId = await pairedTask();
    const count = 8;

    const ids = (
      await Promise.all(
        Array.from({ length: count }, (_, i) => ask(A, { question: `q-${i}` }, T)),
      )
    ).map((r) => unwrap(r).id);

    expect(new Set(ids).size).toBe(count); // nextId never collided
    const spec = await readSpec(home, taskId);
    expect(spec.openB).toHaveLength(count); // pair-A's asks land in pair-B's queue
    expect(new Set(spec.openB.map((q) => q.id)).size).toBe(count);
  });

  it("admits exactly one pair-B when two sessions link at once", async () => {
    const { taskId } = unwrap(await create(A, { keyword: "billing" }, T));
    const b2 = ctxOf(home, "/work/web2", "keyB2");

    const results = await Promise.all([
      link(B, { taskId }, T),
      link(b2, { taskId }, T),
    ]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (!loser || loser.ok) throw new Error("expected exactly one failed link");
    expect(loser.error.code).toBe("NO_PAIRABLE_TASK");

    const meta = await readMeta(home, taskId);
    expect(["/work/web", "/work/web2"]).toContain(meta?.pairB.dir);
  });
});

describe("same-cwd concurrent create is advisory, not strictly serialized", () => {
  it("keeps every successful create a valid, distinct task", async () => {
    // create's cwd guard (readAllMeta) and writeMeta are not under a shared lock,
    // so two sessions in the same directory can both pass the guard and create two
    // tasks. Accepted as advisory: a hard guarantee would serialize every create
    // through a home-level lock — too heavy for a duplicate-create hint. The
    // invariant we hold is weaker: at least one succeeds and no result is corrupt.
    const a2 = ctxOf(home, "/work/api", "keyA2"); // same cwd as A, distinct session

    const results = await Promise.all([
      create(A, { keyword: "one" }, T),
      create(a2, { keyword: "two" }, T),
    ]);

    const ids = results.flatMap((r) => (r.ok ? [r.data.taskId] : []));
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids).size).toBe(ids.length); // any successes are distinct tasks
    for (const id of ids) {
      expect(await readMeta(home, id)).not.toBeNull(); // each success is a real task
    }
  });
});
