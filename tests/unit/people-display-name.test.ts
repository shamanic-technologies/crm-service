import { describe, it, expect } from "vitest";
import { firstNonNull } from "../../src/lib/people/build.js";
import type { PersonCluster, Presence } from "../../src/lib/people/identity.js";

const presence = (source: Presence["source"], displayName: string | null): Presence => ({
  source,
  sourceRef: `${source}-1`,
  displayName,
  company: null,
  emails: [],
  phones: [],
  firstActivityAt: null,
  lastActivityAt: null,
  messageCount: null,
  inboundCount: null,
  outboundCount: null,
  detail: {},
});

const cluster = (presences: Presence[]): PersonCluster => ({
  personKey: "email:s@x.com",
  identityKeys: ["email:s@x.com"],
  emails: ["s@x.com"],
  phones: [],
  presences,
  evidence: [],
});

describe("display name", () => {
  it("a WhatsApp label that is only a phone number never beats a real name", () => {
    expect(firstNonNull(cluster([presence("matrix", "+923065554166 (WA)"), presence("gmail", "Shahab Al Hassan")]), "displayName")).toBe("Shahab Al Hassan");
    expect(firstNonNull(cluster([presence("matrix", "+92 306 555 4166"), presence("gmail", "Shahab")]), "displayName")).toBe("Shahab");
  });

  it("the number label is still served when it is the only name; precedence is unchanged otherwise", () => {
    expect(firstNonNull(cluster([presence("matrix", "+923065554166 (WA)")]), "displayName")).toBe("+923065554166 (WA)");
    expect(firstNonNull(cluster([presence("matrix", "Shahab WA"), presence("gmail", "Shahab Al Hassan")]), "displayName")).toBe("Shahab WA");
  });
});
