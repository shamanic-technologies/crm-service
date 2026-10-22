/**
 * The Postgres error behind a failed query.
 *
 * Since drizzle-orm 0.44 every driver error is wrapped in a `DrizzleQueryError`
 * ("Failed query: …") whose `cause` is the postgres.js `PostgresError` that
 * carries `code`, `constraint_name`, `detail`. Reading `err.code` on the
 * wrapper is always `undefined`, so a unique-violation branch would silently
 * stop matching. This walks the `cause` chain and returns the first error that
 * carries a SQLSTATE `code` (or the error itself when none does, e.g. a raw
 * postgres.js error thrown outside drizzle).
 */
export interface PgErrorFields {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  detail?: string;
  [key: string]: unknown;
}

export function pgErrorOf(err: unknown): PgErrorFields {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    if (typeof (cur as PgErrorFields).code === "string") return cur as PgErrorFields;
    cur = (cur as { cause?: unknown }).cause;
  }
  return (err && typeof err === "object" ? err : {}) as PgErrorFields;
}

/** True when the failed query hit a unique violation (23505) on `constraint`. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg.code === "23505" && (pg.constraint_name ?? pg.constraint) === constraint;
}
