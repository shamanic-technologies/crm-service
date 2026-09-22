ALTER TABLE "contacts" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "state_region" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "street_address" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "lead_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "contact_type" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "origin_medium" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "origin_url" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "origin_referrer" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_updated_at" timestamp with time zone;