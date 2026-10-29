ALTER TABLE "nudges" DROP CONSTRAINT "nudges_status_check";--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "agreed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_status_check" CHECK ("nudges"."status" in ('claimed', 'sent', 'failed', 'skipped'));