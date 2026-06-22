/**
 * Static help content. CLI-only: help never touches core, sessions, or storage.
 * This module owns the verb catalog; the entry point imports VERBS from here so
 * the dispatch table and the help text cannot drift apart.
 */

export const VERBS = [
  "create", "link", "attach", "detach", "list", "status",
  "close", "reopen", "log", "scope", "ask", "answer", "read", "help",
] as const;

export type Verb = (typeof VERBS)[number];

type VerbHelp = {
  signature: string;
  summary: string;
  example: string;
};

/** Categories in display order, matching the verb index in SPEC §3. */
const CATEGORIES: ReadonlyArray<{ title: string; verbs: readonly Verb[] }> = [
  { title: "session / task", verbs: ["create", "link", "attach", "detach", "list", "status"] },
  { title: "lifecycle", verbs: ["close", "reopen"] },
  { title: "note channel", verbs: ["log"] },
  { title: "spec channel", verbs: ["scope", "ask", "answer"] },
  { title: "reading / help", verbs: ["read", "help"] },
];

const HELP: Record<Verb, VerbHelp> = {
  create: {
    signature: 'gori create "<keyword>" ["<scope>"] [--force]',
    summary:
      "start a new task and bind this session as pair-A; an optional second " +
      "argument records your scope in the same step " +
      "(--force: even if this directory already has an open task)",
    example: 'gori create "billing webhook" "FE: webhook settings UI"',
  },
  link: {
    signature: "gori link",
    summary: "pair with a task your partner started (you become pair-B)",
    example: "gori link",
  },
  attach: {
    signature: "gori attach [<task-id|number>]",
    summary: "set an existing task as this session's active task",
    example: "gori attach billing-webhook_20260518-143052",
  },
  detach: {
    signature: "gori detach",
    summary: "clear this session's active task (the task itself is untouched)",
    example: "gori detach",
  },
  list: {
    signature: "gori list",
    summary: "list tasks: in-progress first, then closed; your active task is tagged (active)",
    example: "gori list",
  },
  status: {
    signature: "gori status",
    summary: "one-line summary of your active task, with a turn alert",
    example: "gori status",
  },
  close: {
    signature: "gori close",
    summary: "close the active task (notes and spec are kept)",
    example: "gori close",
  },
  reopen: {
    signature: "gori reopen [<task-id|number>]",
    summary: "put a closed task back in progress",
    example: "gori reopen billing-webhook_20260518-143052",
  },
  log: {
    signature: 'gori log "<message>"',
    summary: "append a timestamped entry to the task's note timeline",
    example: 'gori log "webhook endpoint deployed to staging"',
  },
  scope: {
    signature: 'gori scope "<text>" [--append|--replace] [--section "<heading>"]',
    summary: "set your side's Scope, or edit one ### sub-section with --section",
    example: 'gori scope "renders the spec" --section "Rendering" --replace',
  },
  ask: {
    signature: 'gori ask "<question>"',
    summary: "add a question to your partner's open queue",
    example: 'gori ask "Which signing secret do we use in staging?"',
  },
  answer: {
    signature: 'gori answer <#id|text> "<answer>"',
    summary: "answer a question waiting on you; it moves to Answered",
    example: 'gori answer #1 "STRIPE_WEBHOOK_SECRET from 1Password"',
  },
  read: {
    signature: "gori read [log|spec]",
    summary: "show the active task: spec first, then the note timeline",
    example: "gori read spec",
  },
  help: {
    signature: "gori help [<verb>]",
    summary: "show this overview, or details for one verb",
    example: "gori help answer",
  },
};

// Non-verb help topics: subcommands that have no core verb but are still valid
// `gori help <topic>` subjects. The overview's setup/server block renders from
// this same source, so the two cannot drift.
const TOPIC_NAMES = ["setup", "mcp"] as const;
type TopicName = (typeof TOPIC_NAMES)[number];

const TOPICS: Record<TopicName, VerbHelp> = {
  setup: {
    signature: "gori setup --claude",
    summary:
      "register the MCP server (user scope) and install the /gori skill; " +
      "re-run to update",
    example: "gori setup --claude",
  },
  mcp: {
    signature: "gori mcp",
    summary:
      "start the stdio MCP server (one process = one session); " +
      "register it with `gori setup --claude`",
    example: "gori mcp",
  },
};

const isTopic = (name: string): name is TopicName =>
  (TOPIC_NAMES as readonly string[]).includes(name);

export const renderHelpOverview = (): string => {
  const lines = [
    "gori — a live pairing bridge between two AI sessions",
    "",
    "Usage: gori <verb> [args]",
  ];
  for (const { title, verbs } of CATEGORIES) {
    lines.push("", `${title}:`);
    for (const verb of verbs) {
      lines.push(`  ${verb.padEnd(8)} ${HELP[verb].summary}`);
    }
  }
  lines.push("", "setup / server:");
  for (const topic of TOPIC_NAMES) {
    const { signature, summary } = TOPICS[topic];
    lines.push(`  ${signature.padEnd(21)} ${summary}`);
  }
  return lines.join("\n");
};

/** Detailed help for one verb or topic, or null when the name is neither. */
export const renderVerbHelp = (name: string): string | null => {
  const entry = (VERBS as readonly string[]).includes(name)
    ? HELP[name as Verb]
    : isTopic(name)
      ? TOPICS[name]
      : undefined;
  if (!entry) return null;
  return [entry.signature, `  ${entry.summary}`, `  e.g. ${entry.example}`].join("\n");
};

// ---------- nearest-verb suggestions ----------

const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0; // distance(a[0..i-1], b[0..j-1]) from the prior row
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const insertOrDelete = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1);
      const substitute = previous + (a[i - 1] === b[j - 1] ? 0 : 1);
      previous = row[j] ?? 0;
      row[j] = Math.min(insertOrDelete, substitute);
    }
  }
  return row[b.length] ?? 0;
};

const SUGGESTION_MAX_DISTANCE = 2;
const SUGGESTION_LIMIT = 3;

/** Up to three verbs near the input: prefix matches, or within edit distance 2. */
export const suggestVerbs = (input: string): string[] => {
  const needle = input.toLowerCase();
  if (!needle) return [];
  return VERBS.map((verb) => ({ verb, distance: editDistance(needle, verb) }))
    .filter(
      ({ verb, distance }) =>
        verb.startsWith(needle) || distance <= SUGGESTION_MAX_DISTANCE,
    )
    .sort((a, b) => a.distance - b.distance)
    .slice(0, SUGGESTION_LIMIT)
    .map(({ verb }) => verb);
};
