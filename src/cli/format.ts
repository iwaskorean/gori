/**
 * Pure formatters: core Result data in, human-readable text out. No I/O and no
 * state, so the wiring layer stays a thin shell and all presentation is testable.
 * Candidate lists are numbered 1-based; the same order is used to resolve a
 * number argument (gori link 2), so formatting and resolution cannot drift.
 *
 * Both the CLI and the MCP wrappers share these formatters, so the visual
 * vocabulary stays restrained: a small set of semantic glyphs (✓ done, → next,
 * ● active) and indentation, which read well in a terminal and parse cleanly as
 * MCP tool-response text. The leading keyword carries identity; the task id is
 * demoted to a quiet line for when a side needs to address the task by id.
 */

import type {
  ActiveStatus,
  AttachCandidate,
  GoriError,
  LinkCandidate,
  ReadView,
  TaskSummary,
} from "../core/index.js";
import { ACTIVE, ALERT, DONE, FAIL, NEXT, WARN } from "./glyphs.js";

/** The partner-changed alert, shared by status and read so the two can't drift. */
const PARTNER_CHANGED = `${ALERT} partner made the last change`;

/** Secondary facts sit indented under the primary result line. */
const detail = (text: string): string => `    ${text}`;
/** List and candidate rows nest their facts one level deeper, under the item. */
const subItem = (text: string): string => `        ${text}`;
/** Pad a label so its value lines up in a column; the longest label is "session". */
const LABEL_PAD = "session".length + 2;
const labeled = (label: string, value: string): string => `${label.padEnd(LABEL_PAD)}${value}`;

// formatError is CLI-only — the MCP wrapper builds its own `CODE: message`
// error text — so the glyph never reaches an agent's tool response.
export const formatError = (error: GoriError): string => `${FAIL} ${error.message}`;

// ---------- session / task ----------

export const formatCreate = (data: {
  taskId: string;
  keyword: string;
  previousActive: string | null;
  scopeRecorded: boolean;
}): string => {
  const first = data.scopeRecorded ? "you are pair-A · scope recorded" : "you are pair-A";
  const lines = [
    `${DONE} created  ${data.keyword}`,
    detail(first),
    detail(`${NEXT} partner links to this task next`),
  ];
  if (data.previousActive) {
    lines.push(detail(`switched from ${data.previousActive}`));
  }
  lines.push(detail(labeled("id", data.taskId)));
  return lines.join("\n");
};

export const formatLinkCandidates = (candidates: LinkCandidate[]): string => {
  const rows = candidates.flatMap((c, i) => {
    const facts = [
      `started in ${c.pairADir}`,
      `created ${c.createdAt}`,
      ...(c.hasNote ? ["has notes"] : []),
      ...(c.sameDir ? [`${WARN} same directory as this session`] : []),
    ];
    return [
      `  ${i + 1}. ${c.keyword}`,
      subItem(facts.join(" · ")),
      subItem(labeled("id", c.taskId)),
    ];
  });
  return ["tasks open for pairing", ...rows].join("\n");
};

export const formatLink = (data: { taskId: string; keyword: string }): string =>
  [
    `${DONE} paired with ${data.keyword} — you are pair-B`,
    detail(`${NEXT} read the task to see your partner's scope and open questions`),
    detail(labeled("id", data.taskId)),
  ].join("\n");

export const formatAttachCandidates = (candidates: AttachCandidate[]): string => {
  const rows = candidates.flatMap((c, i) => {
    const side = c.side === "ambiguous" ? "side ambiguous (both match)" : c.side;
    return [
      `  ${i + 1}. ${c.keyword}`,
      subItem(`${side} · last modified ${c.lastModifiedAt}`),
      subItem(labeled("id", c.taskId)),
    ];
  });
  return ["tasks matching this directory", ...rows].join("\n");
};

export const formatAttach = (data: {
  taskId: string;
  keyword: string;
  side: string;
  previousActive: string | null;
}): string => {
  const lines = [`${DONE} attached to ${data.keyword} as ${data.side}`];
  if (data.previousActive && data.previousActive !== data.taskId) {
    lines.push(detail(`switched from ${data.previousActive}`));
  }
  lines.push(detail(labeled("id", data.taskId)));
  return lines.join("\n");
};

export const formatDetach = (data: { taskId: string | null }): string =>
  data.taskId ? `${DONE} detached from ${data.taskId}` : "no active task to detach";

export const formatList = (tasks: TaskSummary[]): string => {
  if (tasks.length === 0) {
    return "no tasks yet — create a task to start one";
  }
  const rows = tasks.flatMap((t, i) => {
    const { pairA, pairB } = t.openQuestionCounts;
    const marker = t.isActive ? `${ACTIVE} ` : "";
    const badge = t.isActive ? "  (active)" : "";
    const pairing = t.paired ? "paired" : "unpaired";
    const lines = [
      `  ${i + 1}. ${marker}${t.keyword}${badge}   ${t.status} · ${pairing}`,
      subItem(labeled("last", `${t.lastModifiedBy} ${t.lastModifiedAt}`)),
    ];
    if (pairA + pairB > 0) {
      lines.push(subItem(labeled("open", `pair-A ${pairA} · pair-B ${pairB}`)));
    }
    lines.push(subItem(labeled("id", t.taskId)));
    return lines;
  });
  return ["tasks", ...rows].join("\n");
};

const summaryLine = (a: ActiveStatus): string =>
  `${ACTIVE} ${a.keyword}   ${a.status} · you are ${a.side} · ` +
  (a.paired ? "paired" : "waiting for the partner session to link");

export const formatStatus = (active: ActiveStatus | null, sessionKey: string): string => {
  // The key matches this session's pointer filename in sessions/, so pairing
  // problems are diagnosable from CLI output alone (two sessions sharing one
  // key was invisible without inspecting the data directory).
  const sessionLine = detail(labeled("session", sessionKey));
  if (!active) {
    return [
      "no active task",
      detail(`${NEXT} attach to reconnect, or create a task to start one`),
      sessionLine,
    ].join("\n");
  }
  const lines = [summaryLine(active)];
  if (active.partnerModified) {
    lines.push(detail(`${PARTNER_CHANGED} · ${NEXT} read to catch up`));
  }
  const mine =
    active.side === "pair-A" ? active.openQuestionCounts.pairA : active.openQuestionCounts.pairB;
  const partners =
    active.side === "pair-A" ? active.openQuestionCounts.pairB : active.openQuestionCounts.pairA;
  lines.push(detail(labeled("open", `you ${mine} · partner ${partners}`)));
  lines.push(detail(labeled("id", active.taskId)));
  lines.push(sessionLine);
  return lines.join("\n");
};

// ---------- lifecycle ----------

export const formatClose = (data: { taskId: string; keyword: string }): string =>
  [`${DONE} closed ${data.keyword}`, detail(labeled("id", data.taskId))].join("\n");

export const formatReopen = (data: {
  taskId: string;
  keyword: string;
  reattach: boolean;
}): string => {
  const lines = [`${DONE} reopened ${data.keyword}`];
  if (data.reattach) {
    lines.push(detail(`${NEXT} not bound to this session — attach to work on it`));
  }
  lines.push(detail(labeled("id", data.taskId)));
  return lines.join("\n");
};

// ---------- channels ----------

export const formatLog = (data: { taskId: string; suggestPromotion: boolean }): string => {
  const lines = [`${DONE} logged`];
  if (data.suggestPromotion) {
    lines.push(
      detail(
        `${NEXT} this note is your running log — put durable decisions in scope and raise open questions with ask`,
      ),
    );
  }
  return lines.join("\n");
};

export const formatScope = (_data: { taskId: string }): string => `${DONE} scope updated`;

export const formatAsk = (data: { id: number }): string =>
  [
    `${DONE} asked #${data.id}`,
    detail(`${NEXT} your partner will see it in their open questions`),
  ].join("\n");

export const formatAnswer = (data: { id: number; queueEmpty: boolean }): string => {
  const lines = [`${DONE} answered #${data.id}`];
  if (data.queueEmpty) {
    lines.push(detail(`${NEXT} your queue is empty — close when the task is done`));
  }
  return lines.join("\n");
};

// ---------- read ----------

const indentContinuation = (text: string): string => {
  const [first = "", ...rest] = text.split("\n");
  return [first, ...rest.map((line) => `       ${line}`)].join("\n");
};

/** Assemble the reading view: summary, turn alert, spec before note, answer hints. */
export const formatRead = (view: ReadView, which?: "log" | "spec"): string => {
  const lines = [summaryLine(view.summary)];
  if (view.summary.partnerModified) lines.push(detail(PARTNER_CHANGED));

  if (which !== "log") {
    lines.push("", "── spec ──", view.spec ?? "(no spec yet)");
  }
  if (which !== "spec") {
    lines.push("", "── note ──", view.note ?? "(no note yet)");
  }

  if (view.openForMe.length > 0) {
    lines.push("", "questions waiting on you:");
    lines.push(
      ...view.openForMe.map((q) => `  [#${q.id}] (${q.asker}) ${indentContinuation(q.text)}`),
    );
    lines.push(`${NEXT} answer each by its #id`);
  }
  return lines.join("\n");
};
