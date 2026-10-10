DROP INDEX IF EXISTS "contacts_org_brand_channel_handle_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "matrix_connections_org_brand_channel_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "matrix_links_org_brand_channel_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "stripe_connections_org_brand_uq";--> statement-breakpoint
ALTER TABLE "matrix_links" ADD COLUMN "input_step" jsonb;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD COLUMN "credential_provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD COLUMN "account_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_org_brand_conn_channel_handle_uq" ON "contacts" USING btree ("org_id","brand_id","source_connection_id","channel","channel_handle");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_connections_org_brand_channel_account_uq" ON "matrix_connections" USING btree ("org_id","brand_id","channel","matrix_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_links_org_brand_channel_idx" ON "matrix_links" USING btree ("org_id","brand_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_connections_org_brand_provider_uq" ON "stripe_connections" USING btree ("org_id","brand_id","credential_provider");