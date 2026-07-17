import { describe, it, expect } from "vitest";
import { deriveSilverRecord } from "../../src/lib/promote.js";
import { ColumnMapping } from "../../src/lib/column-typing.js";

const ROW_ID = "00000000-0000-0000-0000-000000000001";

describe("deriveSilverRecord", () => {
  it("types mapped columns and lowercases email", () => {
    const headers = ["Email", "First", "Last", "Phone", "Company"];
    const mapping: ColumnMapping = {
      Email: "email",
      First: "first_name",
      Last: "last_name",
      Phone: "phone",
      Company: "other",
    };
    const payload = {
      Email: "Alice@Example.COM",
      First: "Alice",
      Last: "Smith",
      Phone: "+1 (415) 555-0000",
      Company: "Acme",
    };
    const rec = deriveSilverRecord(payload, headers, mapping, ROW_ID);
    expect(rec.primaryEmail).toBe("alice@example.com");
    expect(rec.firstName).toBe("Alice");
    expect(rec.lastName).toBe("Smith");
    expect(rec.fullName).toBe("Alice Smith");
    expect(rec.phoneE164).toBe("+14155550000");
    expect(rec.rawAttributes).toEqual({ Company: "Acme" });
  });

  it("splits a full_name column into first/last when those are absent", () => {
    const headers = ["Full Name"];
    const mapping: ColumnMapping = { "Full Name": "full_name" };
    const rec = deriveSilverRecord({ "Full Name": "Bob Van Jones" }, headers, mapping, ROW_ID);
    expect(rec.firstName).toBe("Bob");
    expect(rec.lastName).toBe("Van Jones");
    expect(rec.fullName).toBe("Bob Van Jones");
  });

  it("detects unsubscribe from a known column name", () => {
    const headers = ["Email", "Unsubscribed"];
    const mapping: ColumnMapping = { Email: "email", Unsubscribed: "other" };
    const rec = deriveSilverRecord(
      { Email: "c@x.com", Unsubscribed: "TRUE" },
      headers,
      mapping,
      ROW_ID,
    );
    expect(rec.unsubscribed).toBe(true);
    expect(rec.rawAttributes.Unsubscribed).toBe("TRUE");
  });

  it("detects consent granted/denied", () => {
    const headers = ["Email", "Marketing Consent"];
    const mapping: ColumnMapping = { Email: "email", "Marketing Consent": "other" };
    const granted = deriveSilverRecord(
      { Email: "d@x.com", "Marketing Consent": "yes" },
      headers,
      mapping,
      ROW_ID,
    );
    const denied = deriveSilverRecord(
      { Email: "e@x.com", "Marketing Consent": "no" },
      headers,
      mapping,
      ROW_ID,
    );
    expect(granted.consentStatus).toBe("granted");
    expect(denied.consentStatus).toBe("denied");
  });

  it("leaves email null when the mapped value is empty", () => {
    const headers = ["Email", "Name"];
    const mapping: ColumnMapping = { Email: "email", Name: "full_name" };
    const rec = deriveSilverRecord({ Email: "", Name: "No Email" }, headers, mapping, ROW_ID);
    expect(rec.primaryEmail).toBeNull();
    expect(rec.fullName).toBe("No Email");
  });
});
