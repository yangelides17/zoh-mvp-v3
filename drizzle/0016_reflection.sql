-- #93: added without a default first, so days from before stay empty ("not recorded"); new rows default to false.
ALTER TABLE "step_days" ADD COLUMN "how_it_went_said" boolean;--> statement-breakpoint
ALTER TABLE "step_days" ALTER COLUMN "how_it_went_said" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "in_the_way" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "coach_take" text;--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "next_reason" text;
