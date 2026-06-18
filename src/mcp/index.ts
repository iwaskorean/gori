/**
 * MCP server (stdio): exposes the core verbs as tools. One server process is
 * one session (SPEC §2.3) — the key is minted once at startup, so two agent
 * sessions can never collide on a shared environment value, which is what
 * broke CLI-mode pairing during dogfooding. Tool responses reuse the CLI
 * formatters so output wording has a single source; errors carry the core
 * error code so agents can branch on it. stdout is reserved for JSON-RPC —
 * diagnostics go to stderr.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
  reopen,
  resolveGoriHome,
  scope,
  status,
} from "../core/index.js";
import type { Ctx, GoriError, Result } from "../core/index.js";
import {
  formatAnswer,
  formatAsk,
  formatAttach,
  formatAttachCandidates,
  formatClose,
  formatCreate,
  formatDetach,
  formatLink,
  formatLinkCandidates,
  formatList,
  formatLog,
  formatRead,
  formatReopen,
  formatScope,
  formatStatus,
} from "../cli/format.js";

const INSTRUCTIONS = [
  "gori pairs this session with a partner session working in a separate repo",
  "or directory, sharing one task with a timeline (log) and a structured spec",
  "(scope / questions / answers).",
  "",
  "- Start or resume work with gori_status; when it shows 🆕, call gori_read",
  "  to catch up on the partner's changes.",
  "- One side starts a task with gori_create (keyword + your scope in one",
  "  call); the partner joins it with gori_link.",
  "- Record meaningful progress, decisions, and blockers with gori_log.",
  "- Ask questions about the partner's territory with gori_ask; answer the",
  "  questions waiting on you with gori_answer.",
  "- Close the task with gori_close when both sides agree it is done.",
].join("\n");

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const errorResult = (error: GoriError): ToolResult => ({
  content: [{ type: "text", text: `${error.code}: ${error.message}` }],
  isError: true,
});

const emit = <T>(result: Result<T>, format: (data: T) => string): ToolResult =>
  result.ok ? textResult(format(result.data)) : errorResult(result.error);

/** Build the server around an injected Ctx so tests can run it in-process. */
export const buildMcpServer = (ctx: Ctx): McpServer => {
  const server = new McpServer(
    { name: "gori", version: "0.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "gori_create",
    {
      description:
        "Start a new shared task and bind this session as pair-A. " +
        "Check gori_status / gori_link candidates first — only create when no open task exists for this work.",
      inputSchema: {
        keyword: z
          .string()
          .describe("Short human-readable name for the task (shown to both sides)"),
        scope: z
          .string()
          .optional()
          .describe("This side's work scope, recorded in the same step"),
        force: z
          .boolean()
          .optional()
          .describe("Start another task even if this directory already has an open one"),
      },
    },
    async (args) => emit(await create(ctx, args), formatCreate),
  );

  server.registerTool(
    "gori_link",
    {
      description:
        "Join the partner's task as pair-B. Call without task_id to see the " +
        "open candidates, then call again with the chosen task_id.",
      inputSchema: {
        task_id: z.string().optional().describe("Task id from the candidate list"),
      },
    },
    async ({ task_id }) => {
      if (task_id !== undefined) {
        return emit(await link(ctx, { taskId: task_id }), formatLink);
      }
      const found = await linkCandidates(ctx);
      if (!found.ok) return errorResult(found.error);
      const { candidates } = found.data;
      if (candidates.length === 0) {
        return errorResult({
          code: "NO_PAIRABLE_TASK",
          message:
            "no task is open for pairing — your partner starts one with gori_create",
        });
      }
      return textResult(
        `${formatLinkCandidates(candidates)}\ncall gori_link again with the chosen task_id`,
      );
    },
  );

  server.registerTool(
    "gori_attach",
    {
      description:
        "Reconnect this session to an existing task (after a restart or to " +
        "switch tasks). Call without task_id to see tasks matching this directory.",
      inputSchema: {
        task_id: z.string().optional().describe("Task id to attach to"),
        side: z
          .enum(["pair-A", "pair-B"])
          .optional()
          .describe("Explicit side, needed only when the directory matches both sides"),
      },
    },
    async ({ task_id, side }) => {
      if (task_id === undefined) {
        const found = await attachCandidates(ctx);
        if (!found.ok) return errorResult(found.error);
        const { candidates } = found.data;
        if (candidates.length === 0) {
          return errorResult({
            code: "TASK_NOT_FOUND",
            message: "no in-progress task matches this directory",
          });
        }
        return textResult(
          `${formatAttachCandidates(candidates)}\ncall gori_attach again with the chosen task_id`,
        );
      }
      return emit(
        await attach(ctx, { taskId: task_id, ...(side && { side }) }),
        formatAttach,
      );
    },
  );

  server.registerTool(
    "gori_detach",
    {
      description: "Unbind this session from its active task (the task stays open).",
      inputSchema: {},
    },
    async () => emit(await detach(ctx), formatDetach),
  );

  server.registerTool(
    "gori_list",
    {
      description: "List all tasks with pairing state and open question counts.",
      inputSchema: {},
    },
    async () => emit(await list(ctx), ({ tasks }) => formatList(tasks)),
  );

  server.registerTool(
    "gori_status",
    {
      description:
        "Show the active task: your side, pairing state, and open question " +
        "counts. Call this when starting or resuming work; 🆕 means the " +
        "partner changed something — follow up with gori_read.",
      inputSchema: {},
    },
    async () =>
      emit(await status(ctx), ({ active }) => formatStatus(active, ctx.sessionKey)),
  );

  server.registerTool(
    "gori_close",
    {
      description: "Close the active task when the work is done.",
      inputSchema: {},
    },
    async () => emit(await close(ctx), formatClose),
  );

  server.registerTool(
    "gori_reopen",
    {
      description:
        "Reopen a closed task. Without task_id, reopens the session's last task.",
      inputSchema: {
        task_id: z.string().optional().describe("Task id to reopen"),
      },
    },
    async ({ task_id }) =>
      emit(
        await reopen(ctx, task_id !== undefined ? { taskId: task_id } : {}),
        formatReopen,
      ),
  );

  server.registerTool(
    "gori_log",
    {
      description:
        "Append a timeline note to the active task. Use for meaningful " +
        "progress, decisions, and blockers — one or two sentences.",
      inputSchema: {
        message: z.string().describe("What happened, in one or two sentences"),
      },
    },
    async (args) => emit(await log(ctx, args), formatLog),
  );

  server.registerTool(
    "gori_scope",
    {
      description:
        "Set or update this side's scope in the shared spec. If a scope " +
        "already exists, re-call with mode append or replace. To change one " +
        "part of a large scope, target a `### ` sub-section with section " +
        "instead of resending the whole scope.",
      inputSchema: {
        text: z
          .string()
          .describe("This side's work scope, or the new body of the targeted section"),
        mode: z
          .enum(["append", "replace"])
          .optional()
          .describe("How to combine with an existing scope or section"),
        section: z
          .string()
          .optional()
          .describe(
            "A `### ` sub-section heading to edit (exact, else substring); requires mode",
          ),
      },
    },
    async ({ text, mode, section }) =>
      emit(
        await scope(ctx, {
          text,
          ...(mode && { mode }),
          ...(section !== undefined && { section }),
        }),
        formatScope,
      ),
  );

  server.registerTool(
    "gori_ask",
    {
      description:
        "Ask the partner side a question about their territory. It lands in " +
        "their queue with a stable #id.",
      inputSchema: {
        question: z.string().describe("The question for the partner side"),
      },
    },
    async (args) => emit(await ask(ctx, args), formatAsk),
  );

  server.registerTool(
    "gori_answer",
    {
      description:
        "Answer a question waiting on this side (see gori_read for the queue).",
      inputSchema: {
        ref: z
          .string()
          .describe("Question id like '#1', or a text fragment of the question"),
        answer: z.string().describe("The answer"),
      },
    },
    async (args) => emit(await answer(ctx, args), formatAnswer),
  );

  server.registerTool(
    "gori_read",
    {
      description:
        "Read the active task: spec (scopes, open questions, answers) and the " +
        "note timeline. Questions waiting on this side are highlighted with #ids.",
      inputSchema: {
        which: z
          .enum(["log", "spec"])
          .optional()
          .describe("Limit to one channel; omit for both"),
      },
    },
    async ({ which }) =>
      emit(await read(ctx, which ? { which } : {}), (view) => formatRead(view, which)),
  );

  return server;
};

export const startMcpServer = async (): Promise<void> => {
  const ctx: Ctx = {
    goriHome: resolveGoriHome(),
    cwd: process.cwd(),
    sessionKey: `mcp-${randomUUID()}`,
  };
  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  console.error(`[gori] MCP server ready (session ${ctx.sessionKey})`);
};
