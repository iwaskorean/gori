#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { buildCliCtx } from "./session-key.js";
import { runCli } from "./run.js";
import type { CliDeps } from "./run.js";

const terminalPrompt = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);

  if (argv[0] === "mcp") {
    try {
      const { startMcpServer } = await import("../mcp/index.js");
      await startMcpServer();
    } catch (reason: unknown) {
      console.error("[gori] failed to start MCP server:", reason);
      process.exitCode = 1;
    }
    return;
  }

  const deps: CliDeps = {
    ctx: buildCliCtx(),
    out: (text) => console.log(text),
    errOut: (text) => console.error(text),
    prompt: process.stdin.isTTY ? terminalPrompt : null,
  };
  process.exitCode = await runCli(argv, deps);
};

void main();
