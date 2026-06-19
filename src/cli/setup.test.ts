import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSetup } from "./setup.js";
import type { ExecOutcome, SetupDeps } from "./setup.js";

type Call = { command: string; args: string[] };

let workDir: string;
let homeDir: string;
let skillSource: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gori-setup-"));
  homeDir = join(workDir, "home");
  skillSource = join(workDir, "pkg-skill");
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, "SKILL.md"), "# skill v1\n");
  writeFileSync(join(skillSource, "reference.md"), "ref v1\n");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Build deps with a queue of exec outcomes and a real temp-dir copy. */
const makeDeps = (execResults: ExecOutcome[] = []) => {
  const calls: Call[] = [];
  const out: string[] = [];
  const errOut: string[] = [];
  let next = 0;
  const deps: SetupDeps = {
    exec: (command, args) => {
      calls.push({ command, args });
      return execResults[next++] ?? { code: 0 };
    },
    copyDir: (source, dest) => {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest, { recursive: true, force: true });
    },
    homeDir,
    skillSource,
    out: (text) => out.push(text),
    errOut: (text) => errOut.push(text),
  };
  const skillDest = join(homeDir, ".claude", "skills", "gori");
  return { deps, calls, out, errOut, skillDest };
};

describe("runSetup --claude", () => {
  it("adds the MCP server when it is not yet registered", () => {
    const { deps, calls, skillDest } = makeDeps([{ code: 1 }, { code: 0 }]);
    const code = runSetup("--claude", deps);

    expect(code).toBe(0);
    expect(calls[0]).toEqual({ command: "claude", args: ["mcp", "get", "gori"] });
    expect(calls[1]).toEqual({
      command: "claude",
      args: ["mcp", "add", "--scope", "user", "gori", "--", "gori", "mcp"],
    });
    expect(existsSync(join(skillDest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDest, "reference.md"))).toBe(true);
  });

  it("skips registration when the server already exists (no add call)", () => {
    const { deps, calls, out } = makeDeps([{ code: 0 }]);
    const code = runSetup("--claude", deps);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out.join("\n")).toContain("already registered");
  });

  it("reports a warning and a manual command when registration fails", () => {
    const { deps, errOut } = makeDeps([{ code: 1 }, { code: 2 }]);
    const code = runSetup("--claude", deps);

    expect(code).toBe(1);
    expect(errOut.join("\n")).toContain(
      "claude mcp add --scope user gori -- gori mcp",
    );
  });

  it("handles a missing claude CLI but still installs the skill", () => {
    const { deps, calls, errOut, skillDest } = makeDeps([{ error: "not-found" }]);
    const code = runSetup("--claude", deps);

    expect(code).toBe(1);
    expect(calls).toHaveLength(1); // probe attempted, no add
    expect(errOut.join("\n")).toContain("not found on PATH");
    expect(existsSync(join(skillDest, "SKILL.md"))).toBe(true);
  });

  it("overwrites the skill on re-run (the update path)", () => {
    const { deps, skillDest } = makeDeps([{ code: 0 }]);
    runSetup("--claude", deps);
    writeFileSync(join(skillSource, "SKILL.md"), "# skill v2\n");

    const second = makeDeps([{ code: 0 }]);
    runSetup("--claude", second.deps);

    expect(readFileSync(join(skillDest, "SKILL.md"), "utf8")).toBe("# skill v2\n");
  });
});

describe("runSetup target validation", () => {
  it("prints usage when no target is given", () => {
    const { deps, errOut } = makeDeps();
    expect(runSetup(undefined, deps)).toBe(1);
    expect(errOut.join("\n")).toContain("usage: gori setup --claude");
  });

  it("rejects an unsupported target", () => {
    const { deps, errOut } = makeDeps();
    expect(runSetup("--cursor", deps)).toBe(1);
    expect(errOut.join("\n")).toContain("unsupported setup target");
  });
});
