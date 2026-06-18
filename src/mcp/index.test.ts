import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./index.js";

/**
 * An in-process MCP session: a server built around a fixed Ctx, linked to a
 * client over an in-memory transport. Mirrors how one agent session talks to
 * its own `gori mcp` process; two sessions share goriHome but nothing else.
 */
const connectSession = async (home: string, cwd: string, key: string) => {
  const server = buildMcpServer({ goriHome: home, cwd, sessionKey: key });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const first: unknown = content[0];
    const text =
      first !== null &&
      typeof first === "object" &&
      "text" in first &&
      typeof first.text === "string"
        ? first.text
        : "";
    return { text, isError: result.isError === true };
  };

  return { client, call };
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gori-mcp-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes the 13 verbs (help is covered by the tool list itself)", async () => {
    const a = await connectSession(home, "/work/api", "mcp-a");
    const { tools } = await a.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "gori_answer",
        "gori_ask",
        "gori_attach",
        "gori_close",
        "gori_create",
        "gori_detach",
        "gori_link",
        "gori_list",
        "gori_log",
        "gori_read",
        "gori_reopen",
        "gori_scope",
        "gori_status",
      ].sort(),
    );
  });
});

describe("two-session pairing flow", () => {
  it("runs create(+scope) → link → ask/answer → log → read → close", async () => {
    const a = await connectSession(home, "/work/api", "mcp-a");
    const b = await connectSession(home, "/work/web", "mcp-b");

    const created = await a.call("gori_create", {
      keyword: "billing webhook",
      scope: "BE: webhook endpoint",
    });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("pair-A");
    expect(created.text).toContain("scope recorded");

    // B discovers the candidate, then joins with the explicit id.
    const candidates = await b.call("gori_link");
    expect(candidates.isError).toBe(false);
    expect(candidates.text).toContain('"billing webhook"');
    const taskId = /billing-webhook_[\d-]+/.exec(candidates.text)?.[0];
    expect(taskId).toBeDefined();

    const linked = await b.call("gori_link", { task_id: taskId });
    expect(linked.isError).toBe(false);
    expect(linked.text).toContain("pair-B");

    const asked = await b.call("gori_ask", { question: "Retry policy?" });
    expect(asked.isError).toBe(false);

    // A sees the turn alert, reads the queue, and answers by stable id.
    const statusA = await a.call("gori_status");
    expect(statusA.text).toContain("🆕");
    expect(statusA.text).toContain("session: mcp-a");

    const readA = await a.call("gori_read");
    expect(readA.text).toContain("Retry policy?");
    expect(readA.text).toContain("BE: webhook endpoint");

    const answered = await a.call("gori_answer", {
      ref: "#1",
      answer: "Exponential backoff.",
    });
    expect(answered.isError).toBe(false);

    const logged = await a.call("gori_log", { message: "deployed to staging" });
    expect(logged.isError).toBe(false);

    const readB = await b.call("gori_read", { which: "log" });
    expect(readB.text).toContain("deployed to staging");

    const closed = await b.call("gori_close");
    expect(closed.isError).toBe(false);
  });

  it("keeps sessions isolated: linking your own task is rejected", async () => {
    const a = await connectSession(home, "/work/api", "mcp-a");
    await a.call("gori_create", { keyword: "solo" });

    const selfLink = await a.call("gori_link");
    expect(selfLink.isError).toBe(true);
    expect(selfLink.text).toContain("NO_PAIRABLE_TASK");
  });
});

describe("remaining tool wiring", () => {
  // Several formatters share the `{ taskId }` shape, so a verb wired to the
  // wrong formatter would still typecheck — only calling each tool catches it.
  it("exercises scope, detach, attach, list, and reopen end-to-end", async () => {
    const a = await connectSession(home, "/work/api", "mcp-a");
    await a.call("gori_create", { keyword: "wiring" });

    expect((await a.call("gori_scope", { text: "first" })).isError).toBe(false);
    const conflict = await a.call("gori_scope", { text: "second" });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/^SCOPE_EXISTS: /);
    const appended = await a.call("gori_scope", { text: "second", mode: "append" });
    expect(appended.isError).toBe(false);

    const detached = await a.call("gori_detach");
    expect(detached.text).toContain("detached");

    // A fresh server process for the same directory recovers via attach.
    const restarted = await connectSession(home, "/work/api", "mcp-a2");
    const candidates = await restarted.call("gori_attach");
    expect(candidates.text).toContain('"wiring"');
    const taskId = /wiring_[\d-]+/.exec(candidates.text)?.[0];
    expect(taskId).toBeDefined();
    const attached = await restarted.call("gori_attach", { task_id: taskId });
    expect(attached.isError).toBe(false);
    expect(attached.text).toContain("pair-A");

    const listed = await restarted.call("gori_list");
    expect(listed.text).toContain('"wiring"');

    await restarted.call("gori_close");
    const reopened = await restarted.call("gori_reopen", { task_id: taskId });
    expect(reopened.isError).toBe(false);
    expect(reopened.text).toContain("reopened");
  });

  it("edits one scope sub-section through gori_scope section", async () => {
    const a = await connectSession(home, "/work/api", "mcp-a");
    await a.call("gori_create", { keyword: "x" });
    await a.call("gori_scope", { text: "### A\n\nalpha\n\n### B\n\nbeta" });

    const edited = await a.call("gori_scope", {
      text: "ALPHA2",
      section: "A",
      mode: "replace",
    });
    expect(edited.isError).toBe(false);

    const view = await a.call("gori_read", {});
    expect(view.text).toContain("ALPHA2");
    expect(view.text).toContain("beta");

    const missing = await a.call("gori_scope", {
      text: "x",
      section: "Z",
      mode: "replace",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^SECTION_NOT_FOUND: /);
  });
});

describe("error responses", () => {
  it("prefixes the core error code for agent branching", async () => {
    const a = await connectSession(home, "/work/api", "mcp-a");
    await a.call("gori_create", { keyword: "one" });

    const duplicate = await a.call("gori_create", { keyword: "two" });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/^CWD_IN_USE: /);

    const forced = await a.call("gori_create", { keyword: "two", force: true });
    expect(forced.isError).toBe(false);
  });

  it("reports a missing active task on log", async () => {
    const a = await connectSession(home, "/work/none", "mcp-a");
    const result = await a.call("gori_log", { message: "hello" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^NO_ACTIVE_TASK: /);
  });
});
