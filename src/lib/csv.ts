import { parse } from "csv-parse/sync";

export interface ParsedCsv {
  /** Ordered, de-duplicated header names. */
  headers: string[];
  /** One object per data row, keyed by header name (raw string values). */
  rows: Record<string, string>[];
}

/**
 * Parse a CSV buffer into ordered headers + row objects. Quoted fields, embedded
 * commas, and embedded newlines are handled by the parser. Duplicate header names
 * are de-duplicated (`name`, `name_2`, ...) so row objects never collide.
 *
 * The whole file is parsed in memory. An 80K-row B2C export is a few tens of MB
 * at most — comfortably in memory; we chunk the DB writes, not the parse.
 */
export function parseCsv(buffer: Buffer): ParsedCsv {
  let headers: string[] = [];

  const rows = parse(buffer, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    columns: (firstRow: string[]) => {
      const seen = new Map<string, number>();
      headers = firstRow.map((raw) => {
        const name = String(raw ?? "").trim() || "column";
        const n = seen.get(name) ?? 0;
        seen.set(name, n + 1);
        return n === 0 ? name : `${name}_${n + 1}`;
      });
      return headers;
    },
  }) as Record<string, string>[];

  return { headers, rows };
}
