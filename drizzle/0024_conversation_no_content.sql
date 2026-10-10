ALTER TABLE "conversation_verdicts" ALTER COLUMN "topic" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ALTER COLUMN "confidence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ALTER COLUMN "probabilities" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ALTER COLUMN "brand_probability" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ALTER COLUMN "offer_scores" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ADD COLUMN "content" text DEFAULT 'readable' NOT NULL;