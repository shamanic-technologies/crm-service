import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { DRIZZLE_PASSTHROUGH_ARRAY_OIDS, restorePostgresArrayTypes } from "../../src/db/postgres-array-types.js";

type Options = { parsers: Record<string, unknown>; serializers: Record<string, unknown> };

describe("postgres.js array types under drizzle-orm >= 0.41", () => {
  it("drizzle(client) overrides date[] / timestamptz[] / timestamp[] / numeric[]; restore hands them back", () => {
    const client = postgres("postgres://u:p@127.0.0.1:1/never-connected");
    drizzle(client);
    const options = client.options as unknown as Options;
    for (const oid of DRIZZLE_PASSTHROUGH_ARRAY_OIDS) expect(options.serializers[oid]).toBeTypeOf("function");
    restorePostgresArrayTypes(client);
    for (const oid of DRIZZLE_PASSTHROUGH_ARRAY_OIDS) {
      expect(options.parsers[oid]).toBeUndefined();
      expect(options.serializers[oid]).toBeUndefined();
    }
    // The scalar overrides drizzle relies on (timestamptz 1184) stay in place.
    expect(options.parsers["1184"]).toBeTypeOf("function");
  });

  it("the service's own client has them restored", async () => {
    const m = await import("../../src/db/index.js");
    const options = (void m.db.select, m.getSql()).options as unknown as Options;
    for (const oid of DRIZZLE_PASSTHROUGH_ARRAY_OIDS) {
      expect(options.parsers[oid]).toBeUndefined();
      expect(options.serializers[oid]).toBeUndefined();
    }
  });

  it("the service's db module restores the database's own message on failed queries", async () => {
    await import("../../src/db/index.js");
    const { PgPreparedQuery } = await import("drizzle-orm/pg-core");
    expect((PgPreparedQuery.prototype as unknown as Record<symbol, unknown>)[Symbol.for("distribute.drizzle-query-error-message")]).toBe(true);
  });
});
