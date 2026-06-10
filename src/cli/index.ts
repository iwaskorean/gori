#!/usr/bin/env node
import { resolveGoriHome } from "../core/index.js";

// Entry point. For now it wires the structure (argument parsing, mcp dispatch,
// verb table) while the actual verb logic is filled in later.

const VERBS = [
  "create", "link", "attach", "detach", "list", "status",
  "close", "reopen", "log", "scope", "ask", "answer", "read", "help",
] as const;

type Verb = (typeof VERBS)[number];

const isVerb = (value: string): value is Verb =>
  (VERBS as readonly string[]).includes(value);

const printHelp = (): void => {
  console.log("gori — a live pairing bridge between two AI coding sessions");
  console.log("");
  console.log("Usage: gori <verb> [args]   ·   gori mcp  (start the stdio MCP server)");
  console.log(`verbs: ${VERBS.join(" | ")}`);
};

const main = (): void => {
  const verb = process.argv[2];

  if (verb === "mcp") {
    void import("../mcp/index.js")
      .then(({ startMcpServer }) => startMcpServer())
      .catch((reason: unknown) => {
        console.error("[gori] failed to start MCP server:", reason);
        process.exitCode = 1;
      });
    return;
  }

  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    printHelp();
    return;
  }

  if (!isVerb(verb)) {
    console.error(`Unknown verb: '${verb}'`);
    console.error(`Available verbs: ${VERBS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Stub: the context is assembled and verbs are dispatched to core later.
  console.log(`[gori] verb '${verb}' is not implemented yet.`);
  console.log(`[gori] GORI_HOME=${resolveGoriHome()}`);
};

main();
