ALTER TABLE "nudges" DROP CONSTRAINT "nudges_status_check";--> statement-breakpoint
ALTER TABLE "pauses" DROP CONSTRAINT "pauses_ended_by_check";--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_status_check" CHECK ("nudges"."status" in ('claimed', 'sent', 'failed', 'skipped', 'held'));--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_ended_by_check" CHECK ("pauses"."ended_by" in ('tester', 'end_date', 'stop', 'reset', 'restart'));