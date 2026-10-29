CREATE TABLE "pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"until" date,
	"reason" text,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	CONSTRAINT "pauses_ended_by_check" CHECK ("pauses"."ended_by" in ('tester', 'end_date', 'stop', 'reset'))
);
--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pauses_tester_idx" ON "pauses" USING btree ("tester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pauses_one_open_idx" ON "pauses" USING btree ("tester_id") WHERE "pauses"."ended_at" is null;