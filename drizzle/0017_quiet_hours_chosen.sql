ALTER TABLE "testers" ADD COLUMN "quiet_hours_chosen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "quiet_hours_asked_for" text;--> statement-breakpoint
-- #48: hours that aren't the default were chosen by the tester (set_quiet_hours); they don't stretch on their own.
UPDATE "testers" SET "quiet_hours_chosen" = true WHERE "quiet_hours_start" <> '22:00' OR "quiet_hours_end" <> '09:00';
