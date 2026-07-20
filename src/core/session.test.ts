import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionsDir } from "./env.js";
import {
  clearSession,
  readSession,
  resolveSideByCwd,
  sessionFilePath,
  touchSession,
  writeSession,
} from "./session.js";
import type { Meta } from "./types.js";

const meta = (a: string | null, b: string | null): Meta => ({
  taskId: "t",
  keyword: "k",
  createdAt: "",
  pairA: { dir: a, joinedAt: null },
  pairB: { dir: b, joinedAt: null },
  status: "in-progress",
  blockedReason: null,
  lastModifiedBy: "pair-A",
  lastModifiedAt: "",
});

describe("resolveSideByCwd", () => {
  it("returns the matching side when only one matches", () => {
    expect(resolveSideByCwd(meta("/a", "/b"), "/a")).toBe("pair-A");
    expect(resolveSideByCwd(meta("/a", "/b"), "/b")).toBe("pair-B");
  });
  it("returns 'ambiguous' when both sides share the directory", () => {
    expect(resolveSideByCwd(meta("/same", "/same"), "/same")).toBe("ambiguous");
  });
  it("matches only pair-A before pairing (pair-B null)", () => {
    expect(resolveSideByCwd(meta("/a", null), "/a")).toBe("pair-A");
  });
  it("returns null when nothing matches", () => {
    expect(resolveSideByCwd(meta("/a", "/b"), "/c")).toBeNull();
  });
});

describe("session file I/O (isolated)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "gori-sess-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes then reads back the binding", async () => {
    await writeSession(home, "key1", { taskId: "t_1", side: "pair-B" });
    expect(await readSession(home, "key1")).toEqual({
      taskId: "t_1",
      side: "pair-B",
    });
  });

  it("returns null for a missing session", async () => {
    expect(await readSession(home, "missing")).toBeNull();
  });

  it("leaves no temp file behind and round-trips the binding", async () => {
    await writeSession(home, "k", { taskId: "t_1", side: "pair-A" });
    // temp+rename leaves only the final file — a crash mid-write can't surface
    // a half-written session line to a concurrent reader.
    expect(await readdir(sessionsDir(home))).toEqual(["k.txt"]);
    expect(await readSession(home, "k")).toEqual({ taskId: "t_1", side: "pair-A" });
  });

  it("returns null after clearSession (detach)", async () => {
    await writeSession(home, "k", { taskId: "t", side: "pair-A" });
    await clearSession(home, "k");
    expect(await readSession(home, "k")).toBeNull();
  });

  it("returns null for a malformed line", async () => {
    await writeSession(home, "bad", { taskId: "t", side: "pair-A" });
    await writeFile(sessionFilePath(home, "bad"), "garbage-no-tab", "utf8");
    expect(await readSession(home, "bad")).toBeNull();
  });

  it("touchSession bumps mtime (activity)", async () => {
    await writeSession(home, "k", { taskId: "t", side: "pair-A" });
    const before = (await stat(sessionFilePath(home, "k"))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await touchSession(home, "k");
    const after = (await stat(sessionFilePath(home, "k"))).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it("touchSession is a no-op for a missing session", async () => {
    await expect(touchSession(home, "ghost")).resolves.toBeUndefined();
  });
});
