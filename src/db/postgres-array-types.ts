import type { Sql } from "postgres";

/**
 * Array OIDs drizzle-orm >= 0.41 overrides on the postgres.js client: date[] (1182),
 * timestamptz[] (1185), timestamp[] (1115), numeric[] (1231).
 *
 * `drizzle(client)` installs pass-through parsers/serializers for them, so postgres.js skips its
 * own array handling: a JS array of Dates bound to a query (`= ANY(${dates})`,
 * `${dates}::timestamptz[]`) fails with ERR_INVALID_ARG_TYPE, and such a column reads back as a
 * raw '{...}' string. drizzle-orm 0.36 did not touch them.
 */
export const DRIZZLE_PASSTHROUGH_ARRAY_OIDS = ["1182", "1185", "1115", "1231"] as const;

/**
 * Hand those four array types back to postgres.js, exactly as under drizzle-orm 0.36.
 * Call AFTER every `drizzle(client)` on that client (each construct re-installs them).
 */
export function restorePostgresArrayTypes(client: Sql<any>): void {
  const options = client.options as unknown as {
    parsers: Record<string, unknown>;
    serializers: Record<string, unknown>;
  };
  for (const oid of DRIZZLE_PASSTHROUGH_ARRAY_OIDS) {
    delete options.parsers[oid];
    delete options.serializers[oid];
  }
}
