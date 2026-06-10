import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGoriHome, sessionsDir, tasksDir } from "./env.js";

describe("resolveGoriHome", () => {
  it("defaults to ~/.gori", () => {
    expect(resolveGoriHome({})).toBe(join(homedir(), ".gori"));
  });

  it("uses $GORI_HOME when set (test isolation)", () => {
    expect(resolveGoriHome({ GORI_HOME: "/tmp/.gori-test" })).toBe(
      "/tmp/.gori-test",
    );
  });

  it("ignores a blank $GORI_HOME and falls back to the default", () => {
    expect(resolveGoriHome({ GORI_HOME: "   " })).toBe(join(homedir(), ".gori"));
  });
});

describe("path helpers", () => {
  it("build the tasks and sessions subpaths", () => {
    expect(tasksDir("/x")).toBe(join("/x", "tasks"));
    expect(sessionsDir("/x")).toBe(join("/x", "sessions"));
  });
});
