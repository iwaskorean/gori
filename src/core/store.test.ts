import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskDir } from "./env.js";
import {
  buildTaskId,
  ensureUniqueTaskId,
  formatStamp,
  metaFromYaml,
  metaToYaml,
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
