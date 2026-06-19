import { describe, expect, it } from "vitest";
import {
  formatAnswer,
  formatAttachCandidates,
  formatClose,
  formatCreate,
  formatError,
  formatLink,
  formatLinkCandidates,
  formatList,
  formatRead,
  formatReopen,
  formatStatus,
} from "./format.js";
import type { ActiveStatus, ReadView, TaskSummary } from "../core/index.js";

const activeOf = (overrides: Partial<ActiveStatus> = {}): ActiveStatus => ({
  taskId: "shared_20260101-100000",
  keyword: "shared",
  status: "in-progress",
  side: "pair-A",
  paired: true,
  partnerModified: false,
  openQuestionCounts: { pairA: 0, pairB: 0 },
  ...overrides,
});

describe("formatError", () => {
  it("marks the message with a failure glyph", () => {
    expect(formatError({ code: "TASK_NOT_FOUND", message: "no such task: x" })).toBe(
      "✗ no such task: x",
    );
  });
});

describe("formatCreate", () => {
  it("leads with the keyword, names the side, and prompts the partner to link", () => {
    const text = formatCreate({
      taskId: "x_20260101-100000",
      keyword: "billing",
      previousActive: null,
      scopeRecorded: false,
    });
    expect(text).toContain("created  billing");
    expect(text).toContain("pair-A");
    expect(text).toContain("links to this task");
    expect(text).not.toContain("switched");
    expect(text).not.toContain("scope recorded");
  });

  it("mentions the task the session switched away from", () => {
    expect(
      formatCreate({
        taskId: "b_2",
        keyword: "b",
        previousActive: "a_1",
        scopeRecorded: false,
      }),
    ).toContain("switched from a_1");
  });

  it("confirms an initial scope was recorded", () => {
    expect(
      formatCreate({
        taskId: "b_2",
        keyword: "b",
        previousActive: null,
        scopeRecorded: true,
      }),
    ).toContain("scope recorded");
  });
});

describe("formatLinkCandidates", () => {
  it("numbers candidates, demotes the id, and marks notes and same-directory", () => {
    const text = formatLinkCandidates([
      {
        taskId: "x_1",
        keyword: "x",
        pairADir: "/work/api",
        createdAt: "2026-01-01 10:00:00",
        lastModifiedAt: "2026-01-01 10:00:00",
        hasNote: true,
        sameDir: true,
      },
    ]);
    expect(text).toContain("1. x");
    expect(text).toContain("x_1");
    expect(text).toContain("has notes");
    expect(text).toContain("⚠ same directory");
  });
});

describe("formatAttachCandidates", () => {
  it("spells out an ambiguous side and shows the id", () => {
    const text = formatAttachCandidates([
      { taskId: "x_1", keyword: "x", side: "ambiguous", lastModifiedAt: "t" },
    ]);
    expect(text).toContain("1. x");
    expect(text).toContain("x_1");
    expect(text).toContain("side ambiguous");
  });
});

describe("formatLink", () => {
  it("leads with the partner's keyword and names the side", () => {
    const text = formatLink({ taskId: "x_1", keyword: "billing" });
    expect(text).toContain("paired with billing");
    expect(text).toContain("pair-B");
    expect(text).toContain("x_1");
  });
});

describe("formatList", () => {
  const summaryOf = (overrides: Partial<TaskSummary>): TaskSummary => ({
    taskId: "x_1",
    keyword: "x",
    status: "in-progress",
    paired: false,
    lastModifiedBy: "pair-A",
    lastModifiedAt: "2026-01-01 10:00:00",
    isActive: false,
    openQuestionCounts: { pairA: 0, pairB: 0 },
    ...overrides,
  });

  it("guides creation when there are no tasks", () => {
    expect(formatList([])).toContain("create a task");
  });

  it("marks the active task with a glyph and shows open counts only when present", () => {
    const text = formatList([
      summaryOf({
        keyword: "alpha",
        isActive: true,
        openQuestionCounts: { pairA: 1, pairB: 0 },
      }),
      summaryOf({ keyword: "beta", taskId: "y_2" }),
    ]);
    expect(text).toContain("● alpha");
    expect(text).toContain("(active)");
    expect(text).toContain("pair-A 1");
    expect(text).toContain("x_1");

    const betaLine =
      text.split("\n").find((line) => line.includes("2. beta")) ?? "";
    expect(betaLine).not.toContain("(active)");
    expect(betaLine).not.toContain("●");
  });
});

describe("formatStatus", () => {
  it("guides attach/create when nothing is active", () => {
    const text = formatStatus(null, "agent-f50cf907");
    expect(text).toContain("attach");
    expect(text).toContain("create a task");
  });

  it("shows the turn alert and per-side counts from my perspective", () => {
    const text = formatStatus(
      activeOf({
        side: "pair-B",
        partnerModified: true,
        openQuestionCounts: { pairA: 2, pairB: 1 },
      }),
      "agent-f50cf907",
    );
    expect(text).toContain("🆕");
    expect(text).toContain("you 1");
    expect(text).toContain("partner 2");
  });

  it("always exposes the session key for pairing diagnostics", () => {
    // Two sessions sharing one key broke pairing and was undiagnosable from
    // CLI output; the key line lets a W0-style check compare sessions directly.
    const text = formatStatus(null, "agent-f50cf907");
    expect(text).toContain("session");
    expect(text).toContain("agent-f50cf907");
    expect(formatStatus(activeOf(), "tmux-3")).toContain("tmux-3");
  });
});

describe("formatClose", () => {
  it("leads with the keyword and shows the id", () => {
    const text = formatClose({ taskId: "x_1", keyword: "billing" });
    expect(text).toContain("closed billing");
    expect(text).toContain("x_1");
  });
});

describe("formatReopen", () => {
  it("tells an unbound session to attach, and stays quiet when bound", () => {
    expect(
      formatReopen({ taskId: "x_1", keyword: "x", reattach: true }),
    ).toContain("attach");
    expect(
      formatReopen({ taskId: "x_1", keyword: "x", reattach: false }),
    ).not.toContain("attach");
  });
});

describe("formatAnswer", () => {
  it("suggests close only when the queue is drained", () => {
    expect(formatAnswer({ id: 1, queueEmpty: true })).toContain("close");
    expect(formatAnswer({ id: 1, queueEmpty: false })).not.toContain("close");
  });
});

describe("formatRead", () => {
  const viewOf = (overrides: Partial<ReadView>): ReadView => ({
    summary: activeOf(),
    spec: null,
    note: null,
    openForMe: [],
    ...overrides,
  });

  it("shows spec before note with placeholders for missing bodies", () => {
    const text = formatRead(viewOf({ note: "## entry\n\nhello" }));
    expect(text.indexOf("── spec ──")).toBeLessThan(text.indexOf("── note ──"));
    expect(text).toContain("(no spec yet)");
    expect(text).toContain("hello");
  });

  it("hides the sections excluded by the filter", () => {
    expect(formatRead(viewOf({}), "log")).not.toContain("── spec ──");
    expect(formatRead(viewOf({}), "spec")).not.toContain("── note ──");
  });

  it("lists questions waiting on me with an answer hint", () => {
    const text = formatRead(
      viewOf({ openForMe: [{ id: 3, asker: "pair-B", text: "retry?" }] }),
    );
    expect(text).toContain("[#3] (pair-B) retry?");
    expect(text).toContain("answer each by its #id");
  });
});
