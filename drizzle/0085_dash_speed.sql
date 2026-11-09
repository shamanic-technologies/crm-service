-- DASH-SPEED-1110: the fact emission skips its ownership pass while the people index is unchanged;
-- the Outcomes read serves its last stored answer at once.
ALTER TABLE "people_scopes" ADD COLUMN IF NOT EXISTS "ownership_index_hash" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outcome_snapshots" (
  "scope_id" uuid PRIMARY KEY NOT NULL REFERENCES "people_scopes"("id") ON DELETE CASCADE,
  "inputs" jsonb,
  "inputs_at" timestamp with time zone,
  "counts" jsonb,
  "counts_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
