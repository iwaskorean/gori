import { describe, expect, it } from "vitest";
import {
  emptySpec,
  findReservedHeadings,
  matchScopeSections,
  nextId,
  parseScopeSections,
  parseSpec,
  renderForRead,
  serializeScopeSections,
  serializeSpec,
} from "./spec.js";
import type { SpecDoc } from "./spec.js";

const filled: SpecDoc = {
  summary: "Bill customers on webhook receipt.",
  scopeA: "Own the API.\nValidate signatures.",
  scopeB: "Own the worker.",
  openA: [{ id: 2, asker: "pair-B", text: "Which signing secret?" }],
  openB: [
    { id: 1, asker: "pair-A", text: "Retry policy?" },
    { id: 3, asker: "pair-A", text: "Timeout budget?\nPer attempt or total?" },
  ],
  answered: [
    {
      id: 4,
      asker: "pair-A",
      answerer: "pair-B",
      date: "2026-01-01 10:00:00",
      question: "Which queue?",
      answer: "SQS standard.",
    },
  ],
};

describe("serializeSpec / parseSpec round-trip", () => {
  it("round-trips an empty spec", () => {
    expect(parseSpec(serializeSpec(emptySpec()))).toEqual(emptySpec());
  });

  it("round-trips a filled spec including a multiline question", () => {
    expect(parseSpec(serializeSpec(filled))).toEqual(filled);
  });

  it("is idempotent under re-serialization", () => {
    const once = serializeSpec(filled);
    expect(serializeSpec(parseSpec(once))).toBe(once);
  });
});

describe("emptySpec serialization", () => {
  it("emits the six headings as a skeleton", () => {
    expect(serializeSpec(emptySpec())).toBe(
      [
        "## Task Summary",
        "",
        "## pair-A Scope",
        "",
        "## pair-B Scope",
        "",
        "## Open Questions for pair-A",
        "",
        "## Open Questions for pair-B",
        "",
        "## Answered",
        "",
      ].join("\n"),
    );
  });
});

describe("parseSpec body handling", () => {
  it("keeps an arbitrary ## line as scope content, not a boundary", () => {
    const doc = parseSpec(
      ["## pair-A Scope", "", "Steps:", "## not a real heading", "done", "", "## Answered"].join(
        "\n",
      ),
    );
    expect(doc.scopeA).toBe("Steps:\n## not a real heading\ndone");
  });
});

describe("nextId", () => {
  it("starts at 1 for an empty spec", () => {
    expect(nextId(emptySpec())).toBe(1);
  });

  it("is one past the max id across open queues and answered", () => {
    // filled has ids 1, 2, 3 (open) and 4 (answered) — answered must count.
    expect(nextId(filled)).toBe(5);
  });
});

describe("renderForRead", () => {
  it("returns an empty string for an empty spec", () => {
    expect(renderForRead(emptySpec())).toBe("");
  });

  it("renders only the sections that have content", () => {
    const rendered = renderForRead({
      ...emptySpec(),
      scopeA: "Own the API.",
      openB: [{ id: 1, asker: "pair-A", text: "Retry policy?" }],
    });
    expect(rendered).toBe(
      [
        "## pair-A Scope",
        "",
        "Own the API.",
        "",
        "## Open Questions for pair-B",
        "",
        "- [ ] [#1] (pair-A) Retry policy?",
        "",
      ].join("\n"),
    );
  });

  it("renders a fully filled spec with all six sections", () => {
    const rendered = renderForRead(filled);
    for (const heading of [
      "## Task Summary",
      "## pair-A Scope",
      "## pair-B Scope",
      "## Open Questions for pair-A",
      "## Open Questions for pair-B",
      "## Answered",
    ]) {
      expect(rendered).toContain(heading);
    }
  });
});

describe("findReservedHeadings", () => {
  it("returns every reserved heading in the text, in document order", () => {
    expect(findReservedHeadings("intro\n## Answered\nmid\n## pair-A Scope\nend")).toEqual([
      "## pair-A Scope",
      "## Answered",
    ]);
  });

  it("returns an empty array for indented or altered heading lines", () => {
    expect(findReservedHeadings("  ## Answered\n### Answered\n## answered")).toEqual([]);
  });
});

describe("scope sub-sections", () => {
  it("treats a scope with no ### heading as preamble only", () => {
    expect(parseScopeSections("Own the API.\nValidate signatures.")).toEqual({
      preamble: "Own the API.\nValidate signatures.",
      sections: [],
    });
  });

  it("splits ### headings into sections, keeping leading text as preamble", () => {
    const parsed = parseScopeSections(
      [
        "Overview line.",
        "",
        "### 6. Rendering",
        "renders the spec",
        "",
        "### 7. Errors",
        "error handling",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      preamble: "Overview line.",
      sections: [
        { heading: "6. Rendering", body: "renders the spec" },
        { heading: "7. Errors", body: "error handling" },
      ],
    });
  });

  it("keeps a heading with an empty body", () => {
    expect(parseScopeSections("### Rendering")).toEqual({
      preamble: "",
      sections: [{ heading: "Rendering", body: "" }],
    });
  });

  it("round-trips through serialize and back", () => {
    const parsed = {
      preamble: "Overview.",
      sections: [
        { heading: "Rendering", body: "renders\nthe spec" },
        { heading: "Errors", body: "handles errors" },
      ],
    };
    expect(parseScopeSections(serializeScopeSections(parsed))).toEqual(parsed);
  });

  it("is idempotent under re-serialization", () => {
    const once = serializeScopeSections({
      preamble: "",
      sections: [{ heading: "Rendering", body: "body" }],
    });
    expect(serializeScopeSections(parseScopeSections(once))).toBe(once);
  });

  it("round-trips an empty scope to an empty string", () => {
    expect(serializeScopeSections(parseScopeSections(""))).toBe("");
  });
});

describe("matchScopeSections", () => {
  const sections = [
    { heading: "Rendering", body: "" },
    { heading: "Rendering Details", body: "" },
    { heading: "Errors", body: "" },
  ];

  it("prefers an exact heading match over substring matches", () => {
    expect(matchScopeSections(sections, "Rendering")).toEqual([0]);
  });

  it("matches every section containing the ref as a substring", () => {
    expect(matchScopeSections(sections, "Render")).toEqual([0, 1]);
  });

  it("is case-insensitive", () => {
    expect(matchScopeSections(sections, "errors")).toEqual([2]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchScopeSections(sections, "deploy")).toEqual([]);
  });
});
