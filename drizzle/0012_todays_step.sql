ALTER TABLE "plans" ADD COLUMN "destination" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "step" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "step_minutes" integer;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "step_proof" text;