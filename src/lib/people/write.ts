import { getTableColumns, is, sql, SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "../../db/index.js";
import { people } from "../../db/schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PeopleRowInput = typeof people.$inferInsert;

/**
 * Columns a build does not decide: the row's own uuid and the time it was written.
 * Every other column IS the person as the build saw it, so two rows equal on all of
 * them are the same row and need no write.
 */
const NOT_CONTENT = new Set(["id", "built_at"]);

const CHUNK = 500;

type ContentColumn = { name: string; key: string; fallback: unknown };

/** The content columns, each with the static default the INSERT it replaces would have applied. */
function contentColumns(): ContentColumn[] {
  return Object.entries(getTableColumns(people))
    .filter(([, c]) => !NOT_CONTENT.has(c.name))
    .map(([key, c]) => {
      const d = (c as { default?: unknown }).default;
      if (d !== undefined && is(d as SQLWrapper, SQL)) {
        throw new Error(`people.${c.name} has an SQL default: replaceScopePeople cannot apply it`);
      }
      return { name: c.name, key, fallback: d === undefined ? null : d };
    });
}

/**
 * Replace a scope's `people` with `rows`, writing ONLY what moved (BOX-DISK-FULL-1029).
 *
 * Before, every build deleted the scope's rows and re-inserted all of them: on prod
 * 2026-10-29 that was ~868k row writes an hour on a 67k-row table (13 full rewrites,
 * a 33k-person scope rebuilt every few minutes by follow-up kicks), the fastest growing
 * table of the box (420 MB -> 451 MB in 20 min, 175 MB live) and its WAL with it, while
 * the disk was full. Now the next state goes to a TEMP table (not WAL-logged, dropped at
 * commit), then: a row whose person_key is gone or whose content differs is deleted, a
 * row with no identical twin is inserted. An unchanged person keeps its row (and its
 * `built_at`, now "when this row last changed"). Same transaction as before, so a reader
 * still sees the whole old build or the whole new one.
 */
export async function replaceScopePeople(
  tx: Tx,
  scopeId: string,
  rows: PeopleRowInput[],
): Promise<{ deleted: number; inserted: number; unchanged: number }> {
  const content = contentColumns();
  const names = (prefix = "") => sql.raw(content.map((c) => `${prefix}"${c.name}"`).join(", "));

  await tx.execute(sql`CREATE TEMP TABLE people_next (LIKE people INCLUDING DEFAULTS) ON COMMIT DROP`);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const payload = rows.slice(i, i + CHUNK).map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of content) {
        const v = (r as Record<string, unknown>)[c.key];
        o[c.name] = v === undefined ? c.fallback : v;
      }
      return o;
    });
    await tx.execute(sql`
      INSERT INTO people_next (${names()})
      SELECT ${names("j.")} FROM jsonb_populate_recordset(NULL::people_next, ${JSON.stringify(payload)}::jsonb) AS j`);
  }
  await tx.execute(sql`CREATE INDEX ON people_next (person_key)`);
  await tx.execute(sql`ANALYZE people_next`);

  const same = sql.join(
    content.map((c) => sql`n.${sql.identifier(c.name)} IS NOT DISTINCT FROM p.${sql.identifier(c.name)}`),
    sql` AND `,
  );
  const deleted = await tx.execute(sql`
    DELETE FROM people p
    WHERE p.scope_id = ${scopeId}
      AND NOT EXISTS (SELECT 1 FROM people_next n WHERE n.person_key = p.person_key AND ${same})
    RETURNING 1`);
  const inserted = await tx.execute(sql`
    INSERT INTO people (${names()})
    SELECT ${names("n.")} FROM people_next n
    WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.scope_id = ${scopeId} AND p.person_key = n.person_key)
    RETURNING 1`);
  await tx.execute(sql`DROP TABLE people_next`);
  return { deleted: deleted.length, inserted: inserted.length, unchanged: rows.length - inserted.length };
}
