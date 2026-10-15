-- WHATSAPP-RESOLVE-1015: one owner alert per (what, brand, UTC day), claimed before the send so it never goes twice.
CREATE TABLE IF NOT EXISTS "staff_alerts" (
  "alert_key" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
