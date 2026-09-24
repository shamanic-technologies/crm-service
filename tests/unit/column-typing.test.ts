import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildColumnProfiles,
  classifyColumns,
  heuristicMapping,
  normalizeMapping,
} from "../../src/lib/column-typing.js";

describe("buildColumnProfiles", () => {
  it("collects up to 5 non-empty samples per header", () => {
    const headers = ["email", "note"];
    const rows = Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.com`, note: "" }));
    const profiles = buildColumnProfiles(headers, rows);
    expect(profiles[0].header).toBe("email");
    expect(profiles[0].samples).toHaveLength(5);
    expect(profiles[1].samples).toHaveLength(0);
  });
});

describe("normalizeMapping", () => {
  it("keeps valid enum fields, collapses unknown to other, fills missing headers", () => {
    const headers = ["Email", "First Name", "Weird", "Missing"];
    const raw = { Email: "email", "First Name": "first_name", Weird: "banana" };
    const mapping = normalizeMapping(headers, raw);
    expect(mapping).toEqual({
      Email: "email",
      "First Name": "first_name",
      Weird: "other",
      Missing: "other",
    });
  });
});

describe("heuristicMapping (chat-service fallback)", () => {
  it("classifies common CRM header names deterministically, no network", () => {
    const headers = [
      "Email Address",
      "Mobile Phone",
      "First Name",
      "Last Name",
      "Full Name",
      "Lifetime Value",
    ];
    expect(heuristicMapping(headers)).toEqual({
      "Email Address": "email",
      "Mobile Phone": "phone",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Full Name": "full_name",
      "Lifetime Value": "other",
    });
  });

  it("prefers email/phone over name rules and defaults unknowns to other", () => {
    const m = heuristicMapping(["e-mail", "Contact Name", "Company", "Notes"]);
    expect(m["e-mail"]).toBe("email");
    expect(m["Contact Name"]).toBe("full_name");
    expect(m["Company"]).toBe("other");
    expect(m["Notes"]).toBe("other");
  });

  it("maps a bare 'Name' column to full_name but not 'First Name'", () => {
    const m = heuristicMapping(["Name", "First Name"]);
    expect(m["Name"]).toBe("full_name");
    expect(m["First Name"]).toBe("first_name");
  });
});

describe("classifyColumns (Jev judgments)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks one choice per column and types a hesitant column as other", async () => {
    let sent: { url: string; body: { state: unknown; questions: Record<string, unknown> } } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      const answer = (choice: string, confidence: number) => ({
        type: "choice",
        choice,
        confidence,
        probabilities: { [choice]: confidence },
      });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { c0: answer("email", 1), c1: answer("full_name", 0.3) },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const mapping = await classifyColumns(
      [
        { header: "Mail", samples: ["a@b.com"] },
        { header: "Ref", samples: ["X-12"] },
      ],
      { orgId: "o", userId: "u", runId: "r" },
    );

    expect(mapping).toEqual({ Mail: "email", Ref: "other" });
    expect(sent!.url).toMatch(/\/orgs\/judgments$/);
    expect(Object.keys(sent!.body.questions)).toEqual(["c0", "c1"]);
  });

  it("fails loud on a field outside the list, so the upload falls back to the heuristic", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { c0: { type: "choice", choice: "company", confidence: 1, probabilities: {} } },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
        { status: 200 },
      ),
    );
    await expect(
      classifyColumns([{ header: "Co", samples: [] }], { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/unknown field/);
  });
});
