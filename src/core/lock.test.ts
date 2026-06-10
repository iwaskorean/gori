import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withLock } from "./lock.js";

describe("withLock", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gori-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes concurrent calls (no interleaving)", async () => {
    const lockPath = join(dir, "x.lock");
    const log: string[] = [];
    const run = (id: string): Promise<void> =>
      withLock(lockPath, async () => {
        log.push(`${id}-start`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        log.push(`${id}-end`);
      });

    await Promise.all([run("A"), run("B")]);

    const actor = (s: string | undefined): string | undefined => s?.[0];
    expect(log).toHaveLength(4);
    expect(actor(log[0])).toBe(actor(log[1])); // whoever wins runs start->end back to back
    expect(actor(log[2])).toBe(actor(log[3]));
    expect(actor(log[0])).not.toBe(actor(log[2])); // the two actors don't overlap
  });

  it("returns the function result and releases the lock", async () => {
    const lockPath = join(dir, "y.lock");
    expect(await withLock(lockPath, () => 42)).toBe(42);
    expect(await withLock(lockPath, () => "again")).toBe("again");
  });
});
