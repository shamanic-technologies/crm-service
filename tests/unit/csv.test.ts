import { describe, it, expect } from "vitest";
import { parseCsv } from "../../src/lib/csv.js";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const csv = "Email,First Name,Last Name\na@x.com,Alice,Smith\nb@x.com,Bob,Jones\n";
    const { headers, rows } = parseCsv(Buffer.from(csv));
    expect(headers).toEqual(["Email", "First Name", "Last Name"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Email: "a@x.com", "First Name": "Alice", "Last Name": "Smith" });
  });

  it("handles quoted fields with embedded commas and newlines", () => {
    const csv = 'Name,Note\n"Smith, Alice","line1\nline2"\n';
    const { rows } = parseCsv(Buffer.from(csv));
    expect(rows[0].Name).toBe("Smith, Alice");
    expect(rows[0].Note).toBe("line1\nline2");
  });

  it("de-duplicates repeated header names", () => {
    const csv = "email,email,phone\na@x.com,alt@x.com,123\n";
    const { headers, rows } = parseCsv(Buffer.from(csv));
    expect(headers).toEqual(["email", "email_2", "phone"]);
    expect(rows[0]).toEqual({ email: "a@x.com", email_2: "alt@x.com", phone: "123" });
  });

  it("tolerates ragged rows via relax_column_count", () => {
    const csv = "a,b,c\n1,2\n4,5,6,7\n";
    const { rows } = parseCsv(Buffer.from(csv));
    expect(rows).toHaveLength(2);
  });

  it("strips a UTF-8 BOM and trims cells", () => {
    const csv = "﻿Email , Name\n a@x.com , Alice \n\n";
    const { headers, rows } = parseCsv(Buffer.from(csv));
    expect(headers).toEqual(["Email", "Name"]);
    expect(rows).toEqual([{ Email: "a@x.com", Name: "Alice" }]);
  });

  it("never replaces a row's prototype through a __proto__ header (csv-parse >= 7.0.2)", () => {
    const csv = "__proto__,email\nhijacked,a@x.com\n";
    const { rows } = parseCsv(Buffer.from(csv));
    expect(rows).toHaveLength(1);
    expect(typeof Object.getPrototypeOf(rows[0])).not.toBe("string");
    expect(rows[0].email).toBe("a@x.com");
  });
});
