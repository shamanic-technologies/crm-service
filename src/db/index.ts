import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { Sql } from "postgres";
import * as schema from "./schema.js";

let sqlClient: Sql | null = null;
let dbInstance: PostgresJsDatabase<typeof schema> | null = null;

function getConnectionString(): string {
  const connectionString = process.env.CRM_SERVICE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("CRM_SERVICE_DATABASE_URL is not set");
  }
  return connectionString;
}

export function getSql(): Sql {
  if (!sqlClient) {
    // connect_timeout bumped to 30s so the first query after a Neon
    // scale-to-zero suspend waits for the compute to resume instead of failing.
    sqlClient = postgres(getConnectionString(), {
      idle_timeout: 20,
      max_lifetime: 300,
      connect_timeout: 30,
      max: 10,
      // No JIT (DASH-LATENCY-1014): on this box's short reads, compiling the plan cost
      // 2-3.4 s of CPU per heavy query (the outcomes read: 2.1 s of a 4 s run) and never
      // paid back; the box runs CPU-saturated, so JIT only added load.
      connection: { jit: "off" },
    });
  }
  return sqlClient;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_, prop) {
    if (!dbInstance) {
      dbInstance = drizzle(getSql(), { schema });
    }
    return (dbInstance as any)[prop];
  },
});
