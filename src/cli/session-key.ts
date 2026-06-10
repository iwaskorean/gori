import { createHash } from "node:crypto";
import { resolveGoriHome } from "../core/index.js";
import type { Ctx } from "../core/index.js";

// Terminal-session identifying environment variables, in priority order.
const PRIORITY = [
  "TERM_SESSION_ID",
  "ITERM_SESSION_ID",
  "TMUX_PANE",
  "STY",
  "SSH_TTY",
] as const;

const toSafeKey = (raw: string): string =>
  raw
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "session";

const hash16 = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex").slice(0, 16);

/**
 * Derive the CLI session key. Prefer a terminal-identifying env var; otherwise
 * fall back to a hash of the parent shell PID, which is stable within one terminal.
 * (The controlling tty path isn't portably available in Node, so the parent shell
 * PID is used as a stable per-terminal proxy.)
 */
export const deriveCliSessionKey = (
  env: NodeJS.ProcessEnv = process.env,
  fallbackSource: () => string = () => String(process.ppid),
): string => {
  for (const name of PRIORITY) {
    const value = env[name]?.trim();
    if (value) return toSafeKey(value);
  }
  return `ppid-${hash16(fallbackSource())}`;
};

/** Assemble the CLI-mode execution context injected into core. */
export const buildCliCtx = (): Ctx => ({
  goriHome: resolveGoriHome(),
  cwd: process.cwd(),
  sessionKey: deriveCliSessionKey(),
});
