import { describe, it, expect } from "vitest";
import { normalizeDomain, normalizeLinkedinUrl } from "../../src/lib/contacts/normalize.js";
import { deriveManualRecords, type ManualPayload } from "../../src/lib/contacts/manual.js";
import { heuristicMapping } from "../../src/lib/column-typing.js";

const stmt = (over: Partial<ManualPayload>): ManualPayload => ({
  kind: "manual_contact",
  email: null, phone: null, firstName: null, lastName: null, fullName: null, companyName: null,
  companyDomain: null, jobTitle: null, linkedinUrl: null, note: null, addedByUserId: null,
  addedAt: "2026-10-21T00:00:00Z", runId: "r", fromContact: null, ...over,
});

describe("contact normalizers", () => {
  it("LinkedIn profiles in one spelling", () => {
    for (const v of ["linkedin.com/in/Jane-Doe", "https://fr.linkedin.com/in/jane-doe/", "http://www.linkedin.com/in/jane-doe?trk=a#x"]) {
      expect(normalizeLinkedinUrl(v)).toBe("https://www.linkedin.com/in/jane-doe");
    }
    expect(normalizeLinkedinUrl("https://example.com/in/jane")).toBeNull();
    expect(normalizeLinkedinUrl("https://www.linkedin.com/")).toBeNull();
  });
  it("domains bare", () => {
    expect(normalizeDomain("https://www.NTT.com/en/")).toBe("ntt.com");
    expect(normalizeDomain("ntt.com")).toBe("ntt.com");
    expect(normalizeDomain("someone@ntt.co.jp")).toBe("ntt.co.jp");
    expect(normalizeDomain("not a domain")).toBeNull();
  });
});

describe("deriveManualRecords", () => {
  it("one person per email / LinkedIn, anchored on the first statement, later values win, notes kept", () => {
    const recs = deriveManualRecords([
      { id: "a", row_number: 0, payload: stmt({ fullName: "Jane Doe", linkedinUrl: "li1", note: "n1", jobTitle: "CTO" }) },
      { id: "b", row_number: 1, payload: stmt({ email: "j@x.test", fullName: "Other" }) },
      { id: "c", row_number: 2, payload: stmt({ email: "j@x.test", linkedinUrl: "li1", jobTitle: "CEO", note: "n2" }) },
      { id: "d", row_number: 3, payload: stmt({ fullName: "Solo", companyName: "Co" }) },
    ]);
    expect(recs).toHaveLength(2);
    const jane = recs.find((r) => r.rowIds.includes("a"))!;
    expect(jane.anchorRowId).toBe("a");
    expect(jane.rowIds.sort()).toEqual(["a", "b", "c"]);
    expect(jane).toMatchObject({ primaryEmail: "j@x.test", jobTitle: "CEO", fullName: "Other", note: "n1\n\nn2" });
  });
  it("a taken-over file contact keeps its opt-out", () => {
    const [r] = deriveManualRecords([
      {
        id: "a", row_number: 0,
        payload: stmt({ email: "j@x.test", fromContact: { contactId: "c", uploadId: "u", email: "j@x.test", phone: "+331", firstName: null, lastName: null, fullName: null, companyName: null, companyDomain: null, jobTitle: null, linkedinUrl: null, note: null, rawAttributes: { City: "Paris" }, consentStatus: "denied", unsubscribed: true } }),
      },
    ]);
    expect(r).toMatchObject({ phoneE164: "+331", unsubscribed: true, consentStatus: "denied", rawAttributes: { City: "Paris" } });
  });
});

describe("heuristic column typing", () => {
  it("types company, website, title and LinkedIn columns; names and emails as before", () => {
    expect(heuristicMapping(["Email", "First Name", "Company", "Company Website", "Job Title", "LinkedIn URL", "City"])).toEqual({
      Email: "email", "First Name": "first_name", Company: "company_name", "Company Website": "company_domain",
      "Job Title": "job_title", "LinkedIn URL": "linkedin_url", City: "other",
    });
  });
});
