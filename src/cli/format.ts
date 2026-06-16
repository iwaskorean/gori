/**
 * Pure formatters: core Result data in, human-readable text out. No I/O and no
 * state, so the wiring layer stays a thin shell and all presentation is testable.
 * Candidate lists are numbered 1-based; the same order is used to resolve a
 * number argument (gori link 2), so formatting and resolution cannot drift.
 */

import type {
  ActiveStatus,
  AttachCandidate,
  GoriError,
  LinkCandidate,
  ReadView,
  TaskSummary,
} from "../core/index.js";

export const formatError = (error: GoriError): string => `gori: ${error.message}`;

// Listings lead with the human-readable keyword: a slugged task id alone
// (especially from a terse keyword like a ticket number) doesn't tell the
// reader what the work is.
const taskLabel = (keyword: string, taskId: string, badge = ""): string =>
  `"${keyword}"${badge} — ${taskId}`;

// ---------- session / task ----------

export const formatCreate = (data: {
  taskId: string;
  previousActive: string | null;
  scopeRecorded: boolean;
}): string => {
  const lines = [`created ${data.taskId} — this session is pair-A`];
  if (data.scopeRecorded) lines.push("scope recorded for pair-A");
  lines.push("next: your partner links to this task from their session");
  if (data.previousActive) {
    lines.push(`note: this session switched from ${data.previousActive}`);
  }
  return lines.join("\n");
};

export const formatLinkCandidates = (candidates: LinkCandidate[]): string => {
  const rows = candidates.map((c, i) => {
    const extras = [
      `started in ${c.pairADir}`,
      `created ${c.createdAt}`,
      ...(c.hasNote ? ["has notes"] : []),
      ...(c.sameDir ? ["⚠ same directory as this session"] : []),
    ];
    return `  ${i + 1}. ${taskLabel(c.keyword, c.taskId)} · ${extras.join(" · ")}`;
  });
  return ["tasks open for pairing:", ...rows].join("\n");
};

export const formatLink = (data: { taskId: string }): string =>
  [
    `paired with ${data.taskId} — this session is pair-B`,
    "tip: read the task to see your partner's scope and open questions",
  ].join("\n");

export const formatAttachCandidates = (candidates: AttachCandidate[]): string => {
  const rows = candidates.map((c, i) => {
    const side = c.side === "ambiguous" ? "side ambiguous (both match)" : c.side;
    return `  ${i + 1}. ${taskLabel(c.keyword, c.taskId)} · ${side} · last modified ${c.lastModifiedAt}`;
  });
  return ["tasks matching this directory:", ...rows].join("\n");
};

export const formatAttach = (data: {
  taskId: string;
  side: string;
  previousActive: string | null;
}): string => {
  const lines = [`attached to ${data.taskId} as ${data.side}`];
  if (data.previousActive && data.previousActive !== data.taskId) {
    lines.push(`note: this session switched from ${data.previousActive}`);
  }
  return lines.join("\n");
};

export const formatDetach = (data: { taskId: string | null }): string =>
  data.taskId ? `detached from ${data.taskId}` : "no active task to detach";

export const formatList = (tasks: TaskSummary[]): string => {
  if (tasks.length === 0) {
    return "no tasks yet — create a task to start one";
  }
  const rows = tasks.map((t, i) => {
    const { pairA, pairB } = t.openQuestionCounts;
    const open =
      pairA + pairB > 0 ? ` · open: pair-A ${pairA} · pair-B ${pairB}` : "";
    const active = t.isActive ? " (active)" : "";
    return (
      `${i + 1}. ${taskLabel(t.keyword, t.taskId, active)} · ${t.status} · ` +
      `${t.paired ? "paired" : "unpaired"} · ` +
      `last: ${t.lastModifiedBy} ${t.lastModifiedAt}${open}`
    );
  });
  return rows.join("\n");
};

const summaryLine = (a: ActiveStatus): string =>
  `${taskLabel(a.keyword, a.taskId)} · ${a.status} · you are ${a.side} · ` +
  (a.paired ? "paired" : "waiting for the partner session to link");

const TURN_ALERT = "🆕 your partner made the last change";

export const formatStatus = (
  active: ActiveStatus | null,
  sessionKey: string,
): string => {
  // The key matches this session's pointer filename in sessions/, so pairing
  // problems are diagnosable from CLI output alone (two sessions sharing one
  // key was invisible without inspecting the data directory).
  const sessionLine = `session: ${sessionKey}`;
  if (!active) {
    return (
      "no active task — attach to reconnect " +
      "or create a task to start one" +
      `\n${sessionLine}`
    );
  }
  const lines = [summaryLine(active)];
  if (active.partnerModified) lines.push(`${TURN_ALERT} — read to catch up`);
  const mine =
    active.side === "pair-A"
      ? active.openQuestionCounts.pairA
      : active.openQuestionCounts.pairB;
  const partners =
    active.side === "pair-A"
      ? active.openQuestionCounts.pairB
      : active.openQuestionCounts.pairA;
  lines.push(`open questions — for you: ${mine} · for partner: ${partners}`);
  lines.push(sessionLine);
  return lines.join("\n");
};

// ---------- lifecycle ----------

export const formatClose = (data: { taskId: string }): string =>
  `closed ${data.taskId}`;

export const formatReopen = (data: { taskId: string; reattach: boolean }): string => {
  const lines = [`reopened ${data.taskId}`];
  if (data.reattach) {
    lines.push(
      `this session is not bound to it — attach to ${data.taskId} to work on it`,
    );
  }
  return lines.join("\n");
};

// ---------- channels ----------

export const formatLog = (data: {
  taskId: string;
  suggestPromotion: boolean;
}): string => {
  const lines = [`logged to ${data.taskId}`];
  if (data.suggestPromotion) {
    lines.push(
      "note: the timeline is getting long — consider scope or ask to structure decisions",
    );
  }
  return lines.join("\n");
};

export const formatScope = (data: { taskId: string }): string =>
  `scope updated on ${data.taskId}`;

export const formatAsk = (data: { id: number }): string =>
  `asked #${data.id} — your partner will see it in their open questions`;

export const formatAnswer = (data: { id: number; queueEmpty: boolean }): string => {
  const lines = [`answered #${data.id}`];
  if (data.queueEmpty) {
    lines.push("your queue is empty — close when the task is done");
  }
  return lines.join("\n");
};

// ---------- read ----------

const indentContinuation = (text: string): string => {
  const [first = "", ...rest] = text.split("\n");
  return [first, ...rest.map((line) => `       ${line}`)].join("\n");
};

/** Assemble the reading view: summary, turn alert, spec before note, answer hints. */
export const formatRead = (
  view: ReadView,
  which?: "log" | "spec",
): string => {
  const lines = [summaryLine(view.summary)];
  if (view.summary.partnerModified) lines.push(TURN_ALERT);

  if (which !== "log") {
    lines.push("", "── spec ──", view.spec ?? "(no spec yet)");
  }
  if (which !== "spec") {
    lines.push("", "── note ──", view.note ?? "(no note yet)");
  }

  if (view.openForMe.length > 0) {
    lines.push("", "questions waiting on you:");
    for (const q of view.openForMe) {
      lines.push(`  [#${q.id}] (${q.asker}) ${indentContinuation(q.text)}`);
    }
    lines.push("answer each by its #id");
  }
  return lines.join("\n");
};
