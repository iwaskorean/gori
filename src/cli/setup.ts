/**
 * `gori setup --claude`: an idempotent installer that wires gori into Claude
 * Code. Re-running it is the supported update path — registration is skipped
 * when already present, and the skill is overwritten with the bundled copy.
 * All side effects (process spawning, filesystem) go through injected deps so
 * the flow is unit-testable without touching a real ~/.claude or `claude` CLI.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../core/index.js";
import { DONE, FAIL, NEXT } from "./glyphs.js";

// The registration command in one place: the args we spawn and the manual
// fallback we print to the user are derived from the same source so they
// cannot drift.
const ADD_ARGS = ["mcp", "add", "--scope", "user", "gori", "--", "gori", "mcp"];
const MANUAL_ADD = ["claude", ...ADD_ARGS].join(" ");

/** A spawned command either ran (carrying its exit code) or could not start. */
export type ExecOutcome = { code: number } | { error: "not-found" };

export type SetupDeps = {
  exec: (command: string, args: string[]) => ExecOutcome;
  /** Copy a directory tree, overwriting whatever is at the destination. */
  copyDir: (source: string, dest: string) => void;
  homeDir: string;
  /** Absolute path to the bundled skills/gori directory. */
  skillSource: string;
  out: (text: string) => void;
  errOut: (text: string) => void;
};

/** Register the user-scoped MCP server, but only when it is not already there. */
const registerMcp = (deps: SetupDeps): boolean => {
  const probe = deps.exec("claude", ["mcp", "get", "gori"]);
  if ("error" in probe) {
    deps.errOut(`${FAIL} MCP server — \`claude\` CLI not found on PATH`);
    deps.errOut(`    once it is installed, register manually: ${MANUAL_ADD}`);
    return false;
  }
  // `claude mcp get` exits 0 when the server exists, non-zero when it does not.
  if (probe.code === 0) {
    deps.out(`${DONE} MCP server already registered (user scope) — skipped`);
    return true;
  }
  const add = deps.exec("claude", ADD_ARGS);
  if ("error" in add || add.code !== 0) {
    deps.errOut(`${FAIL} MCP server registration failed`);
    deps.errOut(`    register manually: ${MANUAL_ADD}`);
    return false;
  }
  deps.out(`${DONE} MCP server registered (user scope)`);
  return true;
};

/** Install the bundled skill, overwriting any previous copy (re-run = update). */
const installSkill = (deps: SetupDeps): boolean => {
  const dest = join(deps.homeDir, ".claude", "skills", "gori");
  try {
    deps.copyDir(deps.skillSource, dest);
    deps.out(`${DONE} /gori skill installed → ${dest}`);
    return true;
  } catch (reason: unknown) {
    deps.errOut(`${FAIL} /gori skill copy failed — ${String(reason)}`);
    return false;
  }
};

/** Run the installer for the given target. Returns the process exit code. */
export const runSetup = (target: string | undefined, deps: SetupDeps): number => {
  if (target !== "--claude") {
    deps.errOut(
      target === undefined
        ? "usage: gori setup --claude"
        : `unsupported setup target '${target}' — only --claude is available`,
    );
    return 1;
  }

  const mcpOk = registerMcp(deps);
  const skillOk = installSkill(deps);

  deps.out("");
  if (!mcpOk || !skillOk) {
    deps.out(`gori ${VERSION} — setup finished with warnings (see above)`);
    return 1;
  }
  deps.out(`gori ${VERSION} — setup complete`);
  deps.out(
    `${NEXT} restart your Claude Code session (or reconnect the MCP server) to load the changes`,
  );
  return 0;
};

/** Real side-effecting bindings; tests inject their own. */
export const createSetupDeps = (io: {
  out: (text: string) => void;
  errOut: (text: string) => void;
}): SetupDeps => ({
  exec: (command, args) => {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.error && "code" in result.error && result.error.code === "ENOENT") {
      return { error: "not-found" };
    }
    return { code: result.status ?? 1 };
  },
  copyDir: (source, dest) => {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, { recursive: true, force: true });
  },
  homeDir: homedir(),
  skillSource: fileURLToPath(new URL("../../skills/gori", import.meta.url)),
  ...io,
});
