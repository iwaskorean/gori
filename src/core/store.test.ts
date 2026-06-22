import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskDir } from "./env.js";
import {
  appendNote,
  buildTaskId,
  ensureUniqueTaskId,
  formatStamp,
  isSafeTaskId,
  metaFromYaml,
  metaToYaml,
  notePath,
  readMeta,
  slugify,
  writeMeta,
} from "./store.js";
import type { Meta } from "./types.js";

const baseMeta: Meta = {
  taskId: "billing_20260518-143052",
  keyword: "billing",
  createdAt: "2026-05-18 14:30:52",
  pairA: { dir: "/Users/x/api", joinedAt: "2026-05-18 14:30:52" },
  pairB: { dir: null, joinedAt: null },
  status: "in-progress",
  lastModifiedBy: "pair-A",
  lastModifiedAt: "2026-05-18 14:30:52",
};

describe("slugify", () => {
  it("lowercases and turns spaces into hyphens", () => {
    expect(slugify("Billing Webhook")).toBe("billing-webhook");
  });
  it("strips unsafe characters", () => {
    expect(slugify("Foo: Bar/Baz")).toBe("foo-barbaz");
  });
  it("preserves non-ASCII letters", () => {
    expect(slugify("Café Münster")).toBe("café-münster");
  });
  it("falls back to 'task' when empty", () => {
    expect(slugify("///")).toBe("task");
  });
  it("strips non-whitespace control characters", () => {
    expect(slugify("a\x07b")).toBe("ab");
  });
  it("still turns whitespace control chars into hyphens", () => {
    expect(slugify("a\tb")).toBe("a-b");
  });
  it("caps an unusually long keyword and leaves no trailing hyphen", () => {
    const slug = slugify(`${"a ".repeat(100)}tail`);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });
  it("caps by code point so an astral character is never split", () => {
    // The leading "a" shifts the cap boundary into the middle of an emoji's
    // surrogate pair; code-point capping must not leave a lone surrogate.
    const slug = slugify(`a${"🎯".repeat(60)}`);
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(slug)).toBe(false);
  });
});

describe("isSafeTaskId", () => {
  it("accepts ids buildTaskId can produce", () => {
    expect(isSafeTaskId("billing-webhook_20260518-143052")).toBe(true);
    expect(isSafeTaskId("billing_20260518-143052-2")).toBe(true); // -N suffix
    expect(isSafeTaskId("café-münster_20260518-143052")).toBe(true); // non-ASCII
    expect(isSafeTaskId(".env_20260518-143052")).toBe(true); // leading-dot slug
    expect(isSafeTaskId("foo..bar_20260518-143052")).toBe(true); // embedded dots, not a token
  });
  it("rejects path traversal and separators", () => {
    expect(isSafeTaskId("../../etc/passwd")).toBe(false);
    expect(isSafeTaskId("..\\..\\secret")).toBe(false);
    expect(isSafeTaskId("a/b")).toBe(false);
    expect(isSafeTaskId("..")).toBe(false);
    expect(isSafeTaskId(".")).toBe(false);
    expect(isSafeTaskId("")).toBe(false);
  });
  it("rejects control characters (null byte, tab) that fs would throw on", () => {
    expect(isSafeTaskId("foo\x00bar")).toBe(false);
    expect(isSafeTaskId("foo\tbar")).toBe(false);
  });
});

describe("formatStamp / buildTaskId", () => {
  const fixed = new Date(2026, 4, 18, 14, 30, 52); // 2026-05-18 14:30:52 local

  it("formats a second-precision stamp", () => {
    expect(formatStamp(fixed)).toBe("20260518-143052");
  });
  it("combines slug and stamp", () => {
    expect(buildTaskId("billing webhook", fixed)).toBe(
      "billing-webhook_20260518-143052",
    );
  });
  it("produces an id that passes isSafeTaskId even for a control-char keyword", () => {
    expect(isSafeTaskId(buildTaskId("a\x07b", fixed))).toBe(true);
  });
});

describe("meta YAML round-trip", () => {
  it("metaToYaml then metaFromYaml is identity", () => {
    expect(metaFromYaml(metaToYaml(baseMeta))).toEqual(baseMeta);
  });
  it("serializes with kebab-case keys on disk", () => {
    const y = metaToYaml(baseMeta);
    expect(y).toContain("task-id:");
    expect(y).toContain("pair-A:");
    expect(y).toContain("joined-at:");
  });
});

describe("writeMeta / readMeta (isolated GORI_HOME)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "gori-test-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes then reads back the same meta", async () => {
    await writeMeta(home, baseMeta);
    expect(await readMeta(home, baseMeta.taskId)).toEqual(baseMeta);
  });

  it("returns null for a missing task", async () => {
    expect(await readMeta(home, "nope_20260101-000000")).toBeNull();
  });

  it("ensureUniqueTaskId appends -2 on collision", async () => {
    const id = "dup_20260101-000000";
    await mkdir(taskDir(home, id), { recursive: true });
    expect(await ensureUniqueTaskId(home, id)).toBe(`${id}-2`);
  });

  it("ensureUniqueTaskId keeps the id when free", async () => {
    expect(await ensureUniqueTaskId(home, "fresh_20260101-000000")).toBe(
      "fresh_20260101-000000",
    );
  });
});

describe("appendNote", () => {
  let home: string;
  const id = "t_20260101-000000";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "gori-note-"));
    await mkdir(taskDir(home, id), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("creates the file and returns its line count", async () => {
    expect(await appendNote(home, id, "## h\n\nbody\n")).toBe(3);
    expect(await readFile(notePath(home, id), "utf8")).toBe("## h\n\nbody\n");
  });

  it("separates blocks with a blank line and accumulates the count", async () => {
    await appendNote(home, id, "## a\n\nfirst\n");
    expect(await appendNote(home, id, "## b\n\nsecond\n")).toBe(7);
    expect(await readFile(notePath(home, id), "utf8")).toBe(
      "## a\n\nfirst\n\n## b\n\nsecond\n",
    );
  });
});
