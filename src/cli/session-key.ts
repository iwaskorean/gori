import { createHash } from "node:crypto";
import { resolveGoriHome } from "../core/index.js";
import type { Ctx } from "../core/index.js";

// Session-identifying environment variables, innermost context first. Outer
// terminal ids (TERM_SESSION_ID etc.) are inherited by every process spawned
// below them — two agent sessions under one tmux server or IDE would share the
// same terminal id and collide on one key — so an agent session or tmux pane
// must outrank the terminal tab it happens to run in. Each source carries a
// prefix so short values (e.g. tmux pane "%0") stay distinct across sources
// and the key's origin is readable in diagnostics.
const PRIORITY: ReadonlyArray<readonly [name: string, prefix: string]> = [
  ["CLAUDE_CODE_SESSION_ID", "agent"],
  ["TMUX_PANE", "tmux"],
  ["STY", "screen"],
  ["TERM_SESSION_ID", "term"],
  ["ITERM_SESSION_ID", "term"],
  ["SSH_TTY", "tty"],
];

const toSafeKey = (raw: string): string =>
  raw
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "session";

const hash16 = (raw: string): string => createHash("sha256").update(raw).digest("hex").slice(0, 16);

/**
 * Derive the CLI session key. Prefer the innermost session-identifying env var;
 * otherwise fall back to a hash of the parent shell PID, which is stable within
 * one terminal. (The controlling tty path isn't portably available in Node, so
 * the parent shell PID is used as a per-terminal proxy. Agent harnesses spawn a
 * fresh shell per command, making ppid volatile there — but they also export a
 * session id, so the fallback is only reached in bare terminals.)
 */
export const deriveCliSessionKey = (
  env: NodeJS.ProcessEnv = process.env,
  fallbackSource: () => string = () => String(process.ppid),
): string => {
  for (const [name, prefix] of PRIORITY) {
    const value = env[name]?.trim();
    if (value) return `${prefix}-${toSafeKey(value)}`;
  }
  return `ppid-${hash16(fallbackSource())}`;
};

/** Assemble the CLI-mode execution context injected into core. */
export const buildCliCtx = (): Ctx => ({
  goriHome: resolveGoriHome(),
  cwd: process.cwd(),
  sessionKey: deriveCliSessionKey(),
});
