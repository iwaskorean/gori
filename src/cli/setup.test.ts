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
import { classifyLaunch, runSetup } from "./setup.js";
import type { ExecOutcome, McpLaunch, SetupDeps } from "./setup.js";

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
const makeDeps = (
  execResults: ExecOutcome[] = [],
  mcpLaunch: McpLaunch = { command: "gori", args: ["mcp"] },
) => {
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
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    homeDir,
    skillSource,
    mcpLaunch,
    out: (text) => out.push(text),
    errOut: (text) => errOut.push(text),
  };
  const skillDest = join(homeDir, ".claude", "skills", "gori");
  return { deps, calls, out, errOut, skillDest };
};

describe("classifyLaunch", () => {
  it("registers npx when run from an npm npx cache path", () => {
    expect(
      classifyLaunch("/Users/me/.npm/_npx/abc123/node_modules/gori/dist/cli/index.js"),
    ).toEqual({ command: "npx", args: ["-y", "gori-mcp", "mcp"] });
  });

  it("registers the bare gori binary for a global/local install path", () => {
    expect(classifyLaunch("/usr/local/lib/node_modules/gori/dist/cli/index.js")).toEqual({
      command: "gori",
      args: ["mcp"],
    });
  });

  it("matches _npx as a full path segment, not a substring", () => {
    expect(
      classifyLaunch("/Users/me/projects/my_npx_tool/node_modules/gori/dist/cli/index.js"),
    ).toEqual({ command: "gori", args: ["mcp"] });
  });

  it("handles a Windows backslash npx cache path", () => {
    expect(
      classifyLaunch("C:\\Users\\me\\npm-cache\\_npx\\h\\node_modules\\gori\\dist\\cli\\index.js"),
    ).toEqual({ command: "npx", args: ["-y", "gori-mcp", "mcp"] });
  });
});

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
    expect(errOut.join("\n")).toContain("claude mcp add --scope user gori -- gori mcp");
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

describe("runSetup --cursor", () => {
  const cursorConfig = () => join(homeDir, ".cursor", "mcp.json");

  it("creates mcp.json with the gori server when none exists", () => {
    const { deps } = makeDeps();
    expect(runSetup("--cursor", deps)).toBe(0);
    const config = JSON.parse(readFileSync(cursorConfig(), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.gori).toEqual({ command: "gori", args: ["mcp"] });
  });

  it("merges into existing servers without clobbering them", () => {
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(cursorConfig(), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    runSetup("--cursor", makeDeps().deps);
    const config = JSON.parse(readFileSync(cursorConfig(), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.gori).toEqual({ command: "gori", args: ["mcp"] });
  });

  it("is idempotent on re-run", () => {
    runSetup("--cursor", makeDeps().deps);
    const second = makeDeps();
    expect(runSetup("--cursor", second.deps)).toBe(0);
    expect(second.out.join("\n")).toContain("already");
  });

  it("leaves a malformed config untouched and warns", () => {
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(cursorConfig(), "{ not json");
    const { deps, errOut } = makeDeps();
    expect(runSetup("--cursor", deps)).toBe(1);
    expect(readFileSync(cursorConfig(), "utf8")).toBe("{ not json");
    expect(errOut.join("\n")).toContain("could not update");
  });

  it("warns and leaves the file untouched when the root is not a JSON object", () => {
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(cursorConfig(), "[1, 2, 3]");
    const { deps, errOut } = makeDeps();
    expect(runSetup("--cursor", deps)).toBe(1);
    expect(readFileSync(cursorConfig(), "utf8")).toBe("[1, 2, 3]");
    expect(errOut.join("\n")).toContain("could not update");
  });

  it("treats a non-object mcpServers as empty and still adds gori", () => {
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(cursorConfig(), JSON.stringify({ mcpServers: "oops" }));
    expect(runSetup("--cursor", makeDeps().deps)).toBe(0);
    const config = JSON.parse(readFileSync(cursorConfig(), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.gori).toEqual({ command: "gori", args: ["mcp"] });
  });

  it("installs no skill (Claude Code only)", () => {
    const { deps, skillDest } = makeDeps();
    runSetup("--cursor", deps);
    expect(existsSync(join(skillDest, "SKILL.md"))).toBe(false);
  });
});

describe("runSetup --codex", () => {
  const codexConfig = () => join(homeDir, ".codex", "config.toml");

  it("creates config.toml with the [mcp_servers.gori] table when none exists", () => {
    const { deps } = makeDeps();
    expect(runSetup("--codex", deps)).toBe(0);
    const toml = readFileSync(codexConfig(), "utf8");
    expect(toml).toContain("[mcp_servers.gori]");
    expect(toml).toContain('command = "gori"');
    expect(toml).toContain('args = ["mcp"]');
  });

  it("appends without disturbing existing config", () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), 'model = "o3"\n');
    runSetup("--codex", makeDeps().deps);
    const toml = readFileSync(codexConfig(), "utf8");
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain("[mcp_servers.gori]");
  });

  it("is idempotent when the table is already present", () => {
    runSetup("--codex", makeDeps().deps);
    const before = readFileSync(codexConfig(), "utf8");
    const second = makeDeps();
    expect(runSetup("--codex", second.deps)).toBe(0);
    expect(readFileSync(codexConfig(), "utf8")).toBe(before);
    expect(second.out.join("\n")).toContain("already");
  });

  it("warns when the config cannot be written", () => {
    const base = makeDeps();
    const deps: SetupDeps = {
      ...base.deps,
      writeText: () => {
        throw new Error("disk full");
      },
    };
    expect(runSetup("--codex", deps)).toBe(1);
    expect(base.errOut.join("\n")).toContain("could not update");
  });
});

describe("runSetup launch command (deps.mcpLaunch)", () => {
  const npx: McpLaunch = { command: "npx", args: ["-y", "gori-mcp", "mcp"] };

  it("claude: threads the npx launcher into `claude mcp add`", () => {
    const { deps, calls } = makeDeps([{ code: 1 }, { code: 0 }], npx);
    expect(runSetup("--claude", deps)).toBe(0);
    expect(calls[1]).toEqual({
      command: "claude",
      args: ["mcp", "add", "--scope", "user", "gori", "--", "npx", "-y", "gori-mcp", "mcp"],
    });
  });

  it("cursor: writes the npx launcher into mcp.json", () => {
    const { deps } = makeDeps([], npx);
    expect(runSetup("--cursor", deps)).toBe(0);
    const config = JSON.parse(readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.gori).toEqual({ command: "npx", args: ["-y", "gori-mcp", "mcp"] });
  });

  it("codex: writes the npx launcher into config.toml", () => {
    const { deps } = makeDeps([], npx);
    expect(runSetup("--codex", deps)).toBe(0);
    const toml = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "gori-mcp", "mcp"]');
  });
});

describe("runSetup target validation", () => {
  it("prints usage when no target is given", () => {
    const { deps, errOut } = makeDeps();
    expect(runSetup(undefined, deps)).toBe(1);
    expect(errOut.join("\n")).toContain("usage: gori setup");
  });

  it("rejects an unsupported target", () => {
    const { deps, errOut } = makeDeps();
    expect(runSetup("--vscode", deps)).toBe(1);
    expect(errOut.join("\n")).toContain("unsupported setup target");
  });
});
