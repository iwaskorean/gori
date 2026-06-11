import { describe, expect, it } from "vitest";
import {
  renderHelpOverview,
  renderVerbHelp,
  suggestVerbs,
  VERBS,
} from "./help.js";

describe("renderHelpOverview", () => {
  it("lists every verb exactly once, grouped under category titles", () => {
    const overview = renderHelpOverview();
    for (const verb of VERBS) {
      expect(overview.match(new RegExp(`^  ${verb} `, "gm"))).toHaveLength(1);
    }
    for (const title of [
      "session / task:",
      "lifecycle:",
      "note channel:",
      "spec channel:",
      "reading / help:",
    ]) {
      expect(overview).toContain(title);
    }
  });
});

describe("renderVerbHelp", () => {
  it("shows the signature, summary, and an example for a verb", () => {
    const detail = renderVerbHelp("answer");
    expect(detail).toContain('gori answer <#id|text> "<answer>"');
    expect(detail).toContain("e.g. ");
  });

  it("returns null for an unknown name", () => {
    expect(renderVerbHelp("push")).toBeNull();
  });
});

describe("suggestVerbs", () => {
  it("suggests the verb behind a small typo", () => {
    expect(suggestVerbs("lnik")).toContain("link");
    expect(suggestVerbs("clse")[0]).toBe("close");
  });

  it("suggests prefix matches even beyond edit distance", () => {
    expect(suggestVerbs("cr")).toContain("create");
  });

  it("caps suggestions at three", () => {
    expect(suggestVerbs("a").length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for input near no verb", () => {
    expect(suggestVerbs("zzzzzz")).toEqual([]);
    expect(suggestVerbs("")).toEqual([]);
  });
});
