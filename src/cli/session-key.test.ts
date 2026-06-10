import { describe, expect, it } from "vitest";
import { deriveCliSessionKey } from "./session-key.js";

describe("deriveCliSessionKey", () => {
  it("prefers TERM_SESSION_ID over ITERM_SESSION_ID", () => {
    expect(
      deriveCliSessionKey({ TERM_SESSION_ID: "w0t0p0", ITERM_SESSION_ID: "zzz" }),
    ).toBe("w0t0p0");
  });

  it("falls through to the next var and sanitizes unsafe characters", () => {
    expect(deriveCliSessionKey({ ITERM_SESSION_ID: "w1t2p3:ABC" })).toBe(
      "w1t2p3-ABC",
    );
  });

  it("sanitizes TMUX_PANE", () => {
    expect(deriveCliSessionKey({ TMUX_PANE: "%3" })).toBe("3");
  });

  it("falls back to a hashed parent PID when no env var is set", () => {
    expect(deriveCliSessionKey({}, () => "12345")).toMatch(
      /^ppid-[0-9a-f]{16}$/,
    );
  });

  it("is deterministic for the same fallback source", () => {
    expect(deriveCliSessionKey({}, () => "777")).toBe(
      deriveCliSessionKey({}, () => "777"),
    );
  });
});
