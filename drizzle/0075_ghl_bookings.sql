-- AUTO-BOOK-1103: book a prospect on the brand's GoHighLevel calendar through its own connection.
ALTER TABLE "ghl_connections" ADD COLUMN IF NOT EXISTS "booking_access" text;--> statement-breakpoint
ALTER TABLE "ghl_connections" ADD COLUMN IF NOT EXISTS "booking_access_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ghl_connections" ADD COLUMN IF NOT EXISTS "booking_access_error" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghl_bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "connection_id" uuid,
  "location_id" text,
  "calendar_id" text,
  "booking_page_url" text,
  "requested_start" text NOT NULL,
  "email" text NOT NULL,
  "phone" text,
  "full_name" text,
  "status" text NOT NULL,
  "code" text,
  "error" text,
  "vendor_status" integer,
  "vendor_error" text,
  "ghl_contact_id" text,
  "appointment_id" text,
  "answer" jsonb,
  "attempts" integer DEFAULT 0 NOT NULL,
  "run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_bookings_org_brand_key_uq" ON "ghl_bookings" ("org_id", "brand_id", "idempotency_key");
