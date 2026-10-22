import { DrizzleQueryError } from "drizzle-orm";
import { PgPreparedQuery } from "drizzle-orm/pg-core";

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

/**
 * Since drizzle-orm 0.44 a failed query throws DrizzleQueryError whose MESSAGE is
 * `Failed query: <SQL>\nparams: <values>`: every `err.message` we answer with (HTTP bodies) or
 * store (error columns) would leak the SQL and the bound values, and lose the database's reason.
 * Every pg query error is raised from one place, `PgPreparedQuery.queryWithCache`: wrap it once so
 * the thrown DrizzleQueryError carries the driver's own message again (as under drizzle-orm 0.36).
 * The error stays a DrizzleQueryError with `cause` (the postgres error), `query` and `params`.
 * Idempotent; call once at db client creation.
 */
const PATCHED = Symbol.for("distribute.drizzle-query-error-message");

export function restoreDriverErrorMessages(): void {
  const proto = PgPreparedQuery.prototype as unknown as Record<string | symbol, unknown> & {
    queryWithCache: (...args: unknown[]) => Promise<unknown>;
  };
  if (proto[PATCHED]) return;
  const original = proto.queryWithCache;
  proto.queryWithCache = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (err) {
      if (err instanceof DrizzleQueryError && err.cause instanceof Error) {
        // Before anything reads `stack` (V8 formats it lazily from the current message).
        err.message = err.cause.message;
      }
      throw err;
    }
  };
  proto[PATCHED] = true;
}
