/**
 * Verb dispatch: parse arguments, call core, print formatted results. All I/O
 * goes through injected deps so tests can drive full two-session flows
 * in-process. Interactive selection degrades in non-TTY sessions (prompt =
 * null): candidates are still printed, then a direct-argument re-run is
 * suggested — AI agents piping commands never hang on a prompt.
 */

import {
  answer,
  ask,
  attach,
  attachCandidates,
  close,
  create,
  detach,
  link,
  linkCandidates,
  list,
  log,
  read,
  recap,
  reopen,
  scope,
  status,
  VERSION,
} from "../core/index.js";
import type { Ctx, GoriError, Result, Side } from "../core/index.js";
import {
  formatAnswer,
  formatAsk,
  formatAttach,
  formatAttachCandidates,
  formatClose,
  formatCreate,
  formatDetach,
  formatError,
  formatLink,
  formatLinkCandidates,
  formatList,
  formatLog,
  formatRead,
  formatRecap,
  formatReopen,
  formatScope,
  formatStatus,
} from "./format.js";
import { renderHelpOverview, renderVerbHelp, suggestVerbs, VERBS } from "./help.js";
import type { Verb } from "./help.js";

export type CliDeps = {
  ctx: Ctx;
  out: (text: string) => void;
  errOut: (text: string) => void;
  /** Ask the user one question; null when stdin is not interactive. */
  prompt: ((question: string) => Promise<string>) | null;
};

const isVerb = (value: string): value is Verb => (VERBS as readonly string[]).includes(value);

// The only real flags. Any other dashed token is treated as positional text, so
// a message, scope body, question, or answer may itself start with "--".
const KNOWN_FLAGS = new Set(["--force", "--append", "--replace", "--section"]);
const isFlag = (arg: string): boolean => KNOWN_FLAGS.has(arg);

const asIndex = (arg: string): number | null => (/^\d+$/.test(arg) ? Number(arg) : null);

const isSide = (value: string): value is Side => value === "pair-A" || value === "pair-B";

/** Pull a `--name value` pair out of args, returning the value and the rest. */
const takeFlagValue = (
  args: string[],
  name: string,
): { value: string | undefined; rest: string[] } => {
  const i = args.indexOf(name);
  if (i === -1) return { value: undefined, rest: args };
  return { value: args[i + 1], rest: [...args.slice(0, i), ...args.slice(i + 2)] };
};

/** Run one verb invocation and return the process exit code. */
export const runCli = async (argv: string[], deps: CliDeps): Promise<number> => {
  const [verb = "", ...rest] = argv;
  const positionals = rest.filter((arg) => !isFlag(arg));
  const flags = new Set(rest.filter(isFlag));

  const fail = (error: GoriError): number => {
    deps.errOut(formatError(error));
    return 1;
  };

  const failMsg = (message: string): number => {
    deps.errOut(`gori: ${message}`);
    return 1;
  };

  const emit = <T>(result: Result<T>, format: (data: T) => string): number => {
    if (!result.ok) return fail(result.error);
    deps.out(format(result.data));
    return 0;
  };

  const reportUnknownVerb = (name: string): number => {
    deps.errOut(`Unknown verb: '${name}'`);
    const nearby = suggestVerbs(name);
    if (nearby.length > 0) deps.errOut(`Did you mean: ${nearby.join(", ")}?`);
    return 1;
  };

  /** Number reply → item from a printed candidate list (same 1-based order). */
  const pickByNumber = async <T>(items: T[]): Promise<T | null> => {
    if (!deps.prompt) return null;
    const reply = (await deps.prompt("select a number: ")).trim();
    const n = Number(reply);
    if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
    return items[n - 1] ?? null;
  };

  const runCreate = async (): Promise<number> => {
    const keyword = positionals[0] ?? "";
    const scopeArg = positionals[1];
    let result = await create(deps.ctx, {
      keyword,
      ...(scopeArg !== undefined && { scope: scopeArg }),
      ...(flags.has("--force") && { force: true }),
    });
    if (!result.ok && result.error.code === "CWD_IN_USE") {
      deps.errOut(formatError(result.error));
      if (!deps.prompt) {
        return failMsg("reconnect with `gori attach`, or re-run create with --force");
      }
      const reply = (await deps.prompt("start another task here anyway? [y/N]: "))
        .trim()
        .toLowerCase();
      if (reply !== "y" && reply !== "yes") {
        deps.out("cancelled — no task created");
        return 0;
      }
      result = await create(deps.ctx, {
        keyword,
        ...(scopeArg !== undefined && { scope: scopeArg }),
        force: true,
      });
    }
    return emit(result, formatCreate);
  };

  const runLink = async (): Promise<number> => {
    const found = await linkCandidates(deps.ctx);
    if (!found.ok) return fail(found.error);
    const { candidates } = found.data;

    let taskId = positionals[0] ?? null;
    const index = taskId === null ? null : asIndex(taskId);
    if (index !== null) {
      const chosen = candidates[index - 1];
      if (!chosen)
        return failMsg(`no pairing candidate ${index} — run \`gori link\` to see the list`);
      taskId = chosen.taskId;
    }
    if (taskId === null) {
      if (candidates.length === 0) {
        return failMsg("no task is open for pairing — your partner starts one with `gori create`");
      }
      deps.out(formatLinkCandidates(candidates));
      if (!deps.prompt) {
        return failMsg("non-interactive session — run `gori link <number|task-id>`");
      }
      const chosen = await pickByNumber(candidates);
      if (!chosen) return failMsg("invalid selection");
      taskId = chosen.taskId;
    }
    return emit(await link(deps.ctx, { taskId }), formatLink);
  };

  const runAttach = async (): Promise<number> => {
    const sideArg = positionals[1];
    if (sideArg !== undefined && !isSide(sideArg)) {
      return failMsg("side must be pair-A or pair-B");
    }

    let taskId = positionals[0] ?? null;
    const index = taskId === null ? null : asIndex(taskId);
    if (taskId === null || index !== null) {
      const found = await attachCandidates(deps.ctx);
      if (!found.ok) return fail(found.error);
      const { candidates } = found.data;
      if (index !== null) {
        const chosen = candidates[index - 1];
        if (!chosen)
          return failMsg(`no attach candidate ${index} — run \`gori attach\` to see the list`);
        taskId = chosen.taskId;
      } else {
        if (candidates.length === 0) {
          return failMsg("no in-progress task matches this directory");
        }
        deps.out(formatAttachCandidates(candidates));
        if (!deps.prompt) {
          return failMsg(
            "non-interactive session — run `gori attach <number|task-id> [pair-A|pair-B]`",
          );
        }
        const chosen = await pickByNumber(candidates);
        if (!chosen) return failMsg("invalid selection");
        taskId = chosen.taskId;
      }
    }

    let result = await attach(deps.ctx, {
      taskId,
      ...(sideArg !== undefined && { side: sideArg }),
    });
    if (!result.ok && result.error.code === "SIDE_AMBIGUOUS") {
      if (!deps.prompt) {
        deps.errOut(formatError(result.error));
        return failMsg(`run \`gori attach ${taskId} pair-A\` or \`gori attach ${taskId} pair-B\``);
      }
      const reply = (await deps.prompt("select a side (pair-A / pair-B): ")).trim();
      if (!isSide(reply)) return failMsg("invalid side");
      result = await attach(deps.ctx, { taskId, side: reply });
    }
    return emit(result, formatAttach);
  };

  const runReopen = async (): Promise<number> => {
    const arg = positionals[0];
    if (arg === undefined) return emit(await reopen(deps.ctx, {}), formatReopen);
    const index = asIndex(arg);
    if (index === null) {
      return emit(await reopen(deps.ctx, { taskId: arg }), formatReopen);
    }
    // A number refers to the most recent `gori list` ordering, so re-derive it.
    const listed = await list(deps.ctx);
    if (!listed.ok) return fail(listed.error);
    const chosen = listed.data.tasks[index - 1];
    if (!chosen) return failMsg(`no task ${index} — run \`gori list\` to see the numbering`);
    return emit(await reopen(deps.ctx, { taskId: chosen.taskId }), formatReopen);
  };

  const runScope = async (): Promise<number> => {
    const { value: section, rest: scopeArgs } = takeFlagValue(rest, "--section");
    const text = scopeArgs.find((arg) => !isFlag(arg)) ?? "";
    const mode = flags.has("--append")
      ? ("append" as const)
      : flags.has("--replace")
        ? ("replace" as const)
        : undefined;
    const input = {
      text,
      ...(mode && { mode }),
      ...(section !== undefined && { section }),
    };
    let result = await scope(deps.ctx, input);
    // SCOPE_EXISTS only fires on a whole-scope write, so the prompt re-runs the
    // same input with the chosen mode.
    if (!result.ok && result.error.code === "SCOPE_EXISTS") {
      if (!deps.prompt) {
        deps.errOut(formatError(result.error));
        return failMsg("re-run with --append or --replace");
      }
      const reply = (await deps.prompt("scope already set — [a]ppend, [r]eplace, or [c]ancel: "))
        .trim()
        .toLowerCase();
      if (reply === "a") result = await scope(deps.ctx, { ...input, mode: "append" });
      else if (reply === "r") result = await scope(deps.ctx, { ...input, mode: "replace" });
      else {
        deps.out("cancelled — scope unchanged");
        return 0;
      }
    }
    return emit(result, formatScope);
  };

  const runRead = async (): Promise<number> => {
    const which = positionals[0];
    if (which !== undefined && which !== "log" && which !== "spec") {
      return failMsg("expected `gori read [log|spec]`");
    }
    return emit(await read(deps.ctx, which ? { which } : {}), (view) => formatRead(view, which));
  };

  // ---------- dispatch ----------

  if (!verb || verb === "--help" || verb === "-h") {
    deps.out(renderHelpOverview());
    return 0;
  }
  if (verb === "--version" || verb === "-v") {
    deps.out(VERSION);
    return 0;
  }
  if (verb === "help") {
    const topic = positionals[0];
    if (!topic) {
      deps.out(renderHelpOverview());
      return 0;
    }
    const detail = renderVerbHelp(topic);
    if (!detail) return reportUnknownVerb(topic);
    deps.out(detail);
    return 0;
  }
  if (!isVerb(verb)) return reportUnknownVerb(verb);

  switch (verb) {
    case "create":
      return runCreate();
    case "link":
      return runLink();
    case "attach":
      return runAttach();
    case "detach":
      return emit(await detach(deps.ctx), formatDetach);
    case "list":
      return emit(await list(deps.ctx), ({ tasks }) => formatList(tasks));
    case "status":
      return emit(await status(deps.ctx), ({ active, unattachedMatches }) =>
        formatStatus(active, deps.ctx.sessionKey, unattachedMatches),
      );
    case "close":
      return emit(await close(deps.ctx), formatClose);
    case "reopen":
      return runReopen();
    case "log":
      return emit(await log(deps.ctx, { message: positionals[0] ?? "" }), formatLog);
    case "recap":
      return emit(await recap(deps.ctx, { summary: positionals[0] ?? "" }), formatRecap);
    case "scope":
      return runScope();
    case "ask":
      return emit(await ask(deps.ctx, { question: positionals[0] ?? "" }), formatAsk);
    case "answer":
      return emit(
        await answer(deps.ctx, {
          ref: positionals[0] ?? "",
          answer: positionals[1] ?? "",
        }),
        formatAnswer,
      );
    case "read":
      return runRead();
    case "help":
      return 0; // handled above; keeps the switch exhaustive
  }
};
