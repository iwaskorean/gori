/**
 * `gori setup --<agent>`: idempotent installers that register gori's MCP server
 * with an agent. `--claude` also installs the `/gori` skill (a Claude Code–only
 * enhancement) and is the verified path; `--cursor` and `--codex` register the
 * server into that agent's config and are experimental (implemented, not yet
 * verified end-to-end). All side effects (process spawning, filesystem) go
 * through injected deps so the flow is unit-testable without touching a real
 * home directory or agent CLI.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../core/index.js";
import { DONE, FAIL, NEXT } from "./glyphs.js";

// The MCP server's launch command, in one place so every agent registers the
// same `gori mcp` and the three install paths cannot drift.
const MCP_COMMAND = "gori";
const MCP_ARGS = ["mcp"];

// Claude Code registers via its own CLI; the spawned args and the manual
// fallback we print are derived from the same source so they cannot drift.
const CLAUDE_ADD_ARGS = [
  "mcp",
  "add",
  "--scope",
  "user",
  "gori",
  "--",
  MCP_COMMAND,
  ...MCP_ARGS,
];
const CLAUDE_MANUAL_ADD = ["claude", ...CLAUDE_ADD_ARGS].join(" ");

/** A spawned command either ran (carrying its exit code) or could not start. */
export type ExecOutcome = { code: number } | { error: "not-found" };

export type SetupDeps = {
  exec: (command: string, args: string[]) => ExecOutcome;
  /** Copy a directory tree, overwriting whatever is at the destination. */
  copyDir: (source: string, dest: string) => void;
  /** Read a file as UTF-8, or null when it does not exist. */
  readText: (path: string) => string | null;
  /** Write a file as UTF-8, creating parent directories. */
  writeText: (path: string, text: string) => void;
  homeDir: string;
  /** Absolute path to the bundled skills/gori directory. */
  skillSource: string;
  out: (text: string) => void;
  errOut: (text: string) => void;
};

// ---------- Claude Code (verified): MCP via the claude CLI + the /gori skill ----------

/** Register the user-scoped MCP server, but only when it is not already there. */
const registerClaude = (deps: SetupDeps): boolean => {
  const probe = deps.exec("claude", ["mcp", "get", "gori"]);
  if ("error" in probe) {
    deps.errOut(`${FAIL} MCP server — \`claude\` CLI not found on PATH`);
    deps.errOut(
      `    once it is installed, register manually: ${CLAUDE_MANUAL_ADD}`,
    );
    return false;
  }
  // `claude mcp get` exits 0 when the server exists, non-zero when it does not.
  if (probe.code === 0) {
    deps.out(`${DONE} MCP server already registered (user scope) — skipped`);
    return true;
  }
  const add = deps.exec("claude", CLAUDE_ADD_ARGS);
  if ("error" in add || add.code !== 0) {
    deps.errOut(`${FAIL} MCP server registration failed`);
    deps.errOut(`    register manually: ${CLAUDE_MANUAL_ADD}`);
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

// ---------- Cursor (experimental): merge ~/.cursor/mcp.json ----------

/** Parse text as a JSON object; throw if it is an array, primitive, or null. */
const parseJsonObject = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  return parsed as Record<string, unknown>;
};

/** The value as a plain object, or an empty object when it is anything else. */
const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Add gori to Cursor's mcpServers, preserving any other servers already there. */
const registerCursor = (deps: SetupDeps): boolean => {
  const path = join(deps.homeDir, ".cursor", "mcp.json");
  const server = { command: MCP_COMMAND, args: MCP_ARGS };
  try {
    const existing = deps.readText(path) ?? "";
    const config: Record<string, unknown> =
      existing.trim() === "" ? {} : parseJsonObject(existing);
    const servers = asObject(config.mcpServers);
    if (JSON.stringify(servers.gori) === JSON.stringify(server)) {
      deps.out(`${DONE} MCP server already in ${path} — skipped`);
      return true;
    }
    servers.gori = server;
    config.mcpServers = servers;
    deps.writeText(path, `${JSON.stringify(config, null, 2)}\n`);
    deps.out(`${DONE} MCP server registered → ${path}`);
    return true;
  } catch (reason: unknown) {
    deps.errOut(`${FAIL} Cursor — could not update ${path}: ${String(reason)}`);
    deps.errOut(
      `    add to "mcpServers" yourself: "gori": ${JSON.stringify(server)}`,
    );
    return false;
  }
};

// ---------- Codex (experimental): append a table to ~/.codex/config.toml ----------

/** Append the [mcp_servers.gori] table unless it is already present (no clobber). */
const registerCodex = (deps: SetupDeps): boolean => {
  const path = join(deps.homeDir, ".codex", "config.toml");
  const argList = MCP_ARGS.map((arg) => `"${arg}"`).join(", ");
  const table = `[mcp_servers.gori]\ncommand = "${MCP_COMMAND}"\nargs = [${argList}]\n`;
  try {
    const existing = deps.readText(path) ?? "";
    if (/^\[mcp_servers\.gori\]/m.test(existing)) {
      deps.out(`${DONE} MCP server already in ${path} — skipped`);
      return true;
    }
    const base = existing === "" ? "" : `${existing.replace(/\n*$/, "\n")}\n`;
    deps.writeText(path, `${base}${table}`);
    deps.out(`${DONE} MCP server registered → ${path}`);
    return true;
  } catch (reason: unknown) {
    deps.errOut(`${FAIL} Codex — could not update ${path}: ${String(reason)}`);
    return false;
  }
};

// ---------- dispatch ----------

const SETUP_TARGETS = ["--claude", "--cursor", "--codex"] as const;
type SetupTarget = (typeof SETUP_TARGETS)[number];

const isTarget = (value: string | undefined): value is SetupTarget =>
  (SETUP_TARGETS as readonly string[]).includes(value ?? "");

const AGENT_NAME: Record<SetupTarget, string> = {
  "--claude": "Claude Code",
  "--cursor": "Cursor",
  "--codex": "Codex",
};

// Each target's installer. --claude runs two steps and always runs both, so a
// skill-copy failure is still reported even when MCP registration succeeded.
const INSTALLERS: Record<SetupTarget, (deps: SetupDeps) => boolean> = {
  "--claude": (deps) => {
    const mcpOk = registerClaude(deps);
    const skillOk = installSkill(deps);
    return mcpOk && skillOk;
  },
  "--cursor": registerCursor,
  "--codex": registerCodex,
};

/** Print the post-install restart hint, with an experimental note off Claude. */
const printNextSteps = (target: SetupTarget, deps: SetupDeps): void => {
  if (target === "--claude") {
    deps.out(
      `${NEXT} restart your Claude Code session (or reconnect the MCP server) to load the changes`,
    );
    return;
  }
  const agent = AGENT_NAME[target];
  deps.out(`${NEXT} restart ${agent} to load the gori tools`);
  deps.out(
    `    note: ${agent} support is experimental — not yet verified end-to-end`,
  );
};

/** Run the installer for the given target. Returns the process exit code. */
export const runSetup = (
  target: string | undefined,
  deps: SetupDeps,
): number => {
  if (!isTarget(target)) {
    deps.errOut(
      target === undefined
        ? `usage: gori setup <${SETUP_TARGETS.join(" | ")}>`
        : `unsupported setup target '${target}' — expected one of ${SETUP_TARGETS.join(", ")}`,
    );
    return 1;
  }

  const ok = INSTALLERS[target](deps);

  deps.out("");
  if (!ok) {
    deps.out(`gori ${VERSION} — setup finished with warnings (see above)`);
    return 1;
  }
  deps.out(`gori ${VERSION} — setup complete`);
  printNextSteps(target, deps);
  return 0;
};

/** Real side-effecting bindings; tests inject their own. */
export const createSetupDeps = (io: {
  out: (text: string) => void;
  errOut: (text: string) => void;
}): SetupDeps => ({
  exec: (command, args) => {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (
      result.error &&
      "code" in result.error &&
      result.error.code === "ENOENT"
    ) {
      return { error: "not-found" };
    }
    return { code: result.status ?? 1 };
  },
  copyDir: (source, dest) => {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, { recursive: true, force: true });
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (reason: unknown) {
      if (
        reason &&
        typeof reason === "object" &&
        "code" in reason &&
        reason.code === "ENOENT"
      ) {
        return null;
      }
      throw reason;
    }
  },
  writeText: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  homeDir: homedir(),
  skillSource: fileURLToPath(new URL("../../skills/gori", import.meta.url)),
  ...io,
});
