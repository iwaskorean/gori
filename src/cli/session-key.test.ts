import { describe, expect, it } from "vitest";
import { deriveCliSessionKey } from "./session-key.js";

describe("deriveCliSessionKey", () => {
  it("gives two agent sessions distinct keys despite a shared terminal id", () => {
    // Regression: two Claude Code sessions under one tmux server inherit the
    // same TERM_SESSION_ID; trusting it first made them share one session key,
    // which broke pairing (status/link saw both sessions as the creator).
    const sharedTerminal = { TERM_SESSION_ID: "w1t0p0:75284CEF" };
    const keyA = deriveCliSessionKey({
      ...sharedTerminal,
      CLAUDE_CODE_SESSION_ID: "f50cf907-aaaa",
    });
    const keyB = deriveCliSessionKey({
      ...sharedTerminal,
      CLAUDE_CODE_SESSION_ID: "0c2d11be-bbbb",
    });
    expect(keyA).not.toBe(keyB);
  });

  it("prefers the agent session id over every terminal id", () => {
    expect(
      deriveCliSessionKey({
        CLAUDE_CODE_SESSION_ID: "f50cf907-1a2d",
        TMUX_PANE: "%3",
        TERM_SESSION_ID: "w0t0p0",
        ITERM_SESSION_ID: "w0t0p0",
      }),
    ).toBe("agent-f50cf907-1a2d");
  });

  it("prefers the tmux pane over the inherited terminal id", () => {
    const pane3 = deriveCliSessionKey({
      TMUX_PANE: "%3",
      TERM_SESSION_ID: "w1t0p0:SHARED",
    });
    const pane4 = deriveCliSessionKey({
      TMUX_PANE: "%4",
      TERM_SESSION_ID: "w1t0p0:SHARED",
    });
    expect(pane3).toBe("tmux-3");
    expect(pane4).toBe("tmux-4");
  });

  it("prefers TERM_SESSION_ID over ITERM_SESSION_ID", () => {
    expect(deriveCliSessionKey({ TERM_SESSION_ID: "w0t0p0", ITERM_SESSION_ID: "zzz" })).toBe(
      "term-w0t0p0",
    );
  });

  it("falls through to the next var and sanitizes unsafe characters", () => {
    expect(deriveCliSessionKey({ ITERM_SESSION_ID: "w1t2p3:ABC" })).toBe("term-w1t2p3-ABC");
  });

  it("keeps short values distinct across sources via the prefix", () => {
    expect(deriveCliSessionKey({ TMUX_PANE: "%0" })).toBe("tmux-0");
    expect(deriveCliSessionKey({ STY: "0" })).toBe("screen-0");
  });

  it("falls back to a hashed parent PID when no env var is set", () => {
    expect(deriveCliSessionKey({}, () => "12345")).toMatch(/^ppid-[0-9a-f]{16}$/);
  });

  it("is deterministic for the same fallback source", () => {
    expect(deriveCliSessionKey({}, () => "777")).toBe(deriveCliSessionKey({}, () => "777"));
  });
});
