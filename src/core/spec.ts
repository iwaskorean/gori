/**
 * Pure grammar for spec.md. No filesystem access: the store layer owns reading
 * and writing; this module only parses, serializes, and computes ids. spec.md is
 * a verb-owned artifact, not a hand-edited file, so the six headings are a fixed
 * structure the parser recognizes by exact string — anything else is body text.
 */

import type { Side } from "./types.js";

export type Question = {
  id: number;
  asker: Side;
  text: string;
};

export type Answered = {
  id: number;
  asker: Side;
  answerer: Side;
  date: string;
  question: string;
  answer: string;
};

export type SpecDoc = {
  summary: string;
  scopeA: string;
  scopeB: string;
  openA: Question[];
  openB: Question[];
  answered: Answered[];
};

/** The six section headings, in document order. Recognized only as exact lines. */
export const SPEC_HEADINGS = [
  "## Task Summary",
  "## pair-A Scope",
  "## pair-B Scope",
  "## Open Questions for pair-A",
  "## Open Questions for pair-B",
  "## Answered",
] as const;

/**
 * True when any line exactly equals a section heading. Verbs use this to reject
 * free-text input that would otherwise be mistaken for a section boundary on the
 * next parse. We guard rather than escape, mirroring the note channel's policy of
 * never transforming user content.
 */
export const hasReservedHeading = (text: string): boolean =>
  text.split("\n").some((line) => (SPEC_HEADINGS as readonly string[]).includes(line));

export const emptySpec = (): SpecDoc => ({
  summary: "",
  scopeA: "",
  scopeB: "",
  openA: [],
  openB: [],
  answered: [],
});

/** Next stable id: max across both open queues and answered, +1 (answered kept to avoid reuse). */
export const nextId = (doc: SpecDoc): number => {
  const ids = [
    ...doc.openA.map((q) => q.id),
    ...doc.openB.map((q) => q.id),
    ...doc.answered.map((a) => a.id),
  ];
  return ids.length ? Math.max(...ids) + 1 : 1;
};

// ---------- parse ----------

type SectionKey = "summary" | "scopeA" | "scopeB" | "openA" | "openB" | "answered";

const HEADING_TO_SECTION: Record<string, SectionKey> = {
  "## Task Summary": "summary",
  "## pair-A Scope": "scopeA",
  "## pair-B Scope": "scopeB",
  "## Open Questions for pair-A": "openA",
  "## Open Questions for pair-B": "openB",
  "## Answered": "answered",
};

const QUESTION_RE = /^- \[ \] \[#(\d+)\] \((pair-A|pair-B)\) (.*)$/;
// The date is fixed-width "YYYY-MM-DD HH:mm:ss", so ") Q: " unambiguously closes
// the metadata even when the question or answer text contains parentheses.
const ANSWERED_RE =
  /^- \[#(\d+)\] \((pair-A|pair-B)→(pair-A|pair-B) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\) Q: (.*) \/ A: (.*)$/;

const isSide = (value: string | undefined): value is Side =>
  value === "pair-A" || value === "pair-B";

/** Drop leading and trailing blank lines, join the rest verbatim. */
const trimBlank = (lines: string[]): string => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
};

const parseQuestions = (lines: string[]): Question[] => {
  const questions: Question[] = [];
  for (const line of lines) {
    const match = QUESTION_RE.exec(line);
    if (match) {
      const [, id = "", asker, text = ""] = match;
      if (isSide(asker)) questions.push({ id: Number(id), asker, text });
      continue;
    }
    // Two-space continuation lines extend the previous question's text.
    if (line.startsWith("  ") && questions.length > 0) {
      const last = questions[questions.length - 1];
      if (last) last.text += `\n${line.slice(2)}`;
    }
  }
  return questions;
};

const parseAnswered = (lines: string[]): Answered[] => {
  const answered: Answered[] = [];
  for (const line of lines) {
    const match = ANSWERED_RE.exec(line);
    if (!match) continue;
    const [, id = "", asker, answerer, date = "", question = "", answer = ""] = match;
    if (isSide(asker) && isSide(answerer)) {
      answered.push({ id: Number(id), asker, answerer, date, question, answer });
    }
  }
  return answered;
};

export const parseSpec = (text: string): SpecDoc => {
  const bodies: Record<SectionKey, string[]> = {
    summary: [],
    scopeA: [],
    scopeB: [],
    openA: [],
    openB: [],
    answered: [],
  };
  let current: SectionKey | null = null;
  for (const line of text.split("\n")) {
    const section = HEADING_TO_SECTION[line];
    if (section) {
      current = section;
      continue;
    }
    if (current) bodies[current].push(line);
  }
  return {
    summary: trimBlank(bodies.summary),
    scopeA: trimBlank(bodies.scopeA),
    scopeB: trimBlank(bodies.scopeB),
    openA: parseQuestions(bodies.openA),
    openB: parseQuestions(bodies.openB),
    answered: parseAnswered(bodies.answered),
  };
};

// ---------- serialize ----------

const serializeQuestion = (q: Question): string => {
  const [first = "", ...rest] = q.text.split("\n");
  const head = `- [ ] [#${q.id}] (${q.asker}) ${first}`;
  return [head, ...rest.map((line) => `  ${line}`)].join("\n");
};

const serializeAnswered = (a: Answered): string =>
  `- [#${a.id}] (${a.asker}→${a.answerer} ${a.date}) Q: ${a.question} / A: ${a.answer}`;

const textSection = (heading: string, body: string): string =>
  body ? `${heading}\n\n${body}` : heading;

const itemsSection = (heading: string, items: string[]): string =>
  items.length ? `${heading}\n\n${items.join("\n")}` : heading;

export const serializeSpec = (doc: SpecDoc): string => {
  const sections = [
    textSection("## Task Summary", doc.summary),
    textSection("## pair-A Scope", doc.scopeA),
    textSection("## pair-B Scope", doc.scopeB),
    itemsSection("## Open Questions for pair-A", doc.openA.map(serializeQuestion)),
    itemsSection("## Open Questions for pair-B", doc.openB.map(serializeQuestion)),
    itemsSection("## Answered", doc.answered.map(serializeAnswered)),
  ];
  return `${sections.join("\n\n")}\n`;
};
