ALTER TABLE "step_days" ADD COLUMN "went_well" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "differently" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "went_deeper" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "open_thread" boolean DEFAULT false NOT NULL;