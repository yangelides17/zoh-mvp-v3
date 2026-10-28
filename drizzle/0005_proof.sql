ALTER TABLE "messages" ADD COLUMN "media_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "proof_verdict" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "proof_seen" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "proof_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_days" ADD CONSTRAINT "step_days_proof_verdict_check" CHECK ("step_days"."proof_verdict" in ('clear', 'plausible', 'unclear', 'doesnt_match'));