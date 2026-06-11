#!/usr/bin/env node
import { resolveGoriHome } from "../core/index.js";
import {
  renderHelpOverview,
  renderVerbHelp,
  suggestVerbs,
  VERBS,
} from "./help.js";
import type { Verb } from "./help.js";

// Entry point. For now it wires the structure (argument parsing, mcp dispatch,
// verb table) while the actual verb logic is filled in later.

const isVerb = (value: string): value is Verb =>
  (VERBS as readonly string[]).includes(value);

const printHelp = (topic: string | undefined): void => {
  if (!topic) {
    console.log(renderHelpOverview());
    return;
  }
  const detail = renderVerbHelp(topic);
  if (detail) {
    console.log(detail);
    return;
  }
  console.error(`Unknown verb: '${topic}'`);
  const nearby = suggestVerbs(topic);
  if (nearby.length > 0) console.error(`Did you mean: ${nearby.join(", ")}?`);
  process.exitCode = 1;
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

  if (!verb || verb === "--help" || verb === "-h") {
    printHelp(undefined);
    return;
  }

  if (verb === "help") {
    printHelp(process.argv[3]);
    return;
  }

  if (!isVerb(verb)) {
    console.error(`Unknown verb: '${verb}'`);
    const nearby = suggestVerbs(verb);
    if (nearby.length > 0) console.error(`Did you mean: ${nearby.join(", ")}?`);
    process.exitCode = 1;
    return;
  }

  // Stub: the context is assembled and verbs are dispatched to core later.
  console.log(`[gori] verb '${verb}' is not implemented yet.`);
  console.log(`[gori] GORI_HOME=${resolveGoriHome()}`);
};

main();
