ALTER TABLE "step_days" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "landed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "landed_reason" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "landed_by" text;