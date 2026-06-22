import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run.js";
import type { CliDeps } from "./run.js";
import { VERSION } from "../core/index.js";

/**
 * An in-process CLI session: captured output, scripted prompt replies, and a
 * fixed Ctx. `interactive: false` models a piped (non-TTY) invocation.
 */
const makeSession = (
  home: string,
  cwd: string,
  key: string,
  interactive = true,
) => {
  const out: string[] = [];
  const err: string[] = [];
  let replies: string[] = [];
  const deps: CliDeps = {
    ctx: { goriHome: home, cwd, sessionKey: key },
    out: (text) => out.push(text),
    errOut: (text) => err.push(text),
    prompt: interactive ? async () => replies.shift() ?? "" : null,
  };
  const run = (argv: string[], promptReplies: string[] = []): Promise<number> => {
    replies = promptReplies;
    return runCli(argv, deps);
  };
  const lastOut = (): string => out[out.length - 1] ?? "";
  return { run, out, err, lastOut };
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gori-cli-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("two-session end-to-end flow", () => {
  it("runs create → link → scope/ask/answer → read → close → reopen", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    const b = makeSession(home, "/work/web", "keyB");

    expect(await a.run(["create", "billing webhook"])).toBe(0);
    expect(a.lastOut()).toContain("pair-A");

    // B picks candidate 1 interactively.
    expect(await b.run(["link"], ["1"])).toBe(0);
    expect(b.lastOut()).toContain("pair-B");

    expect(await a.run(["scope", "Own the API."])).toBe(0);
    expect(await b.run(["scope", "Own the worker."])).toBe(0);
    expect(await a.run(["ask", "Retry policy?"])).toBe(0);

    expect(await b.run(["answer", "#1", "Exponential backoff."])).toBe(0);
    expect(b.lastOut()).toContain("close"); // queue drained → close hint

    expect(await a.run(["log", "deployed to staging"])).toBe(0);

    // B reads: spec before note, partner's content visible, turn alert set.
    expect(await b.run(["read"])).toBe(0);
    const view = b.lastOut();
    expect(view).toContain("🆕");
    expect(view).toContain("Own the API.");
    expect(view).toContain("deployed to staging");
    expect(view.indexOf("── spec ──")).toBeLessThan(view.indexOf("── note ──"));

    expect(await a.run(["close"])).toBe(0);
    expect(await a.run(["reopen"])).toBe(0);
    expect(a.lastOut()).toContain("reopened");
  });
});

describe("interactive selection", () => {
  it("links by explicit number without a prompt", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    const b = makeSession(home, "/work/web", "keyB");
    await a.run(["create", "x"]);
    expect(await b.run(["link", "1"])).toBe(0);
    expect(b.lastOut()).toContain("pair-B");
  });

  it("rejects an out-of-range selection", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    const b = makeSession(home, "/work/web", "keyB");
    await a.run(["create", "x"]);
    expect(await b.run(["link"], ["9"])).toBe(1);
    expect(b.err.join("\n")).toContain("invalid selection");
  });

  it("prompts for a side when both sides share the directory", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    const bSame = makeSession(home, "/work/api", "keyBsame");
    await a.run(["create", "shared"]);
    await bSame.run(["link", "1"]);

    const probe = makeSession(home, "/work/api", "keyProbe");
    expect(await probe.run(["attach", "1"], ["pair-B"])).toBe(0);
    expect(probe.lastOut()).toContain("as pair-B");
  });

  it("offers append/replace/cancel when a scope already exists", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    await a.run(["create", "x"]);
    await a.run(["scope", "first"]);

    expect(await a.run(["scope", "second"], ["c"])).toBe(0);
    expect(a.lastOut()).toContain("cancelled");

    expect(await a.run(["scope", "second"], ["a"])).toBe(0);
    expect(a.lastOut()).toContain("scope updated");
  });

  it("accepts --replace without prompting", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    await a.run(["create", "x"]);
    await a.run(["scope", "first"]);
    expect(await a.run(["scope", "second", "--replace"])).toBe(0);
  });
});

describe("scope sub-sections", () => {
  it("edits one ### section by heading via --section", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    await a.run(["create", "x"]);
    await a.run(["scope", "### A\n\nalpha\n\n### B\n\nbeta"]);
    expect(await a.run(["scope", "ALPHA2", "--section", "A", "--replace"])).toBe(0);
    await a.run(["read", "spec"]);
    expect(a.lastOut()).toContain("ALPHA2");
    expect(a.lastOut()).toContain("beta");
  });

  it("exits 1 and names the available sections when the ref is unknown", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    await a.run(["create", "x"]);
    await a.run(["scope", "### A\n\nalpha"]);
    expect(await a.run(["scope", "x", "--section", "Z", "--replace"])).toBe(1);
    expect(a.err.join("\n")).toContain("A");
  });
});

describe("non-interactive (piped) sessions", () => {
  it("prints link candidates and exits 1 instead of hanging", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    const b = makeSession(home, "/work/web", "keyB", false);
    await a.run(["create", "x"]);

    expect(await b.run(["link"])).toBe(1);
    expect(b.out.join("\n")).toContain("1. x"); // candidates were shown
    expect(b.err.join("\n")).toContain("gori link <number|task-id>");
  });

  it("suggests explicit-side re-run on an ambiguous attach", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    const bSame = makeSession(home, "/work/api", "keyBsame");
    await a.run(["create", "shared"]);
    await bSame.run(["link", "1"]);

    const probe = makeSession(home, "/work/api", "keyProbe", false);
    expect(await probe.run(["attach", "1"])).toBe(1);
    expect(probe.err.join("\n")).toContain("pair-A");
  });
});

describe("argument validation and errors", () => {
  it("reports an unknown verb with a suggestion and exit 1", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(await a.run(["lnik"])).toBe(1);
    expect(a.err.join("\n")).toContain("Did you mean: link");
  });

  it("routes core errors to stderr with exit 1", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(await a.run(["log", "no active task yet"])).toBe(1);
    expect(a.err.join("\n")).toContain("✗");
  });

  it("rejects an invalid read filter", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(await a.run(["read", "notes"])).toBe(1);
    expect(a.err.join("\n")).toContain("read [log|spec]");
  });

  it("prints the overview for bare invocation and help", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(await a.run([])).toBe(0);
    expect(a.lastOut()).toContain("session / task:");
    expect(await a.run(["help", "answer"])).toBe(0);
    expect(a.lastOut()).toContain("gori answer");
  });

  it("prints the package version for --version and -v", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(await a.run(["--version"])).toBe(0);
    expect(a.lastOut()).toBe(VERSION);
    expect(await a.run(["-v"])).toBe(0);
    expect(a.lastOut()).toBe(VERSION);
  });
});

describe("create bootstrap guard", () => {
  it("blocks a non-interactive duplicate create and hints --force", async () => {
    const a = makeSession(home, "/work/api", "keyA", false);
    expect(await a.run(["create", "one"])).toBe(0);
    expect(await a.run(["create", "two"])).toBe(1);
    expect(a.err.join("\n")).toContain("--force");
  });

  it("creates after an interactive confirmation", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    await a.run(["create", "one"]);
    expect(await a.run(["create", "two"], ["y"])).toBe(0);
    expect(a.lastOut()).toContain("pair-A");
  });

  it("cancels cleanly when the confirmation is declined", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    await a.run(["create", "one"]);
    expect(await a.run(["create", "two"], [""])).toBe(0);
    expect(a.lastOut()).toContain("cancelled");
  });

  it("honors --force without prompting", async () => {
    const a = makeSession(home, "/work/api", "keyA", false);
    await a.run(["create", "one"]);
    expect(await a.run(["create", "two", "--force"])).toBe(0);
  });
});

describe("create with an initial scope", () => {
  it("records the second argument as this side's scope", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(await a.run(["create", "billing", "BE: webhook endpoint"])).toBe(0);
    expect(a.lastOut()).toContain("scope recorded");

    expect(await a.run(["read", "spec"])).toBe(0);
    expect(a.lastOut()).toContain("BE: webhook endpoint");
  });
});

describe("dashed text arguments", () => {
  it("records a message starting with -- as text, not a flag", async () => {
    const a = makeSession(home, "/work/api", "keyA");
    expect(await a.run(["create", "task one"])).toBe(0);
    expect(await a.run(["log", "--watch flag deprecated"])).toBe(0);
    expect(await a.run(["read", "log"])).toBe(0);
    expect(a.lastOut()).toContain("--watch flag deprecated");
  });
});
