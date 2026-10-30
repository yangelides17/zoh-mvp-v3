CREATE TABLE "takeaways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"day" date NOT NULL,
	"text" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "takeaways_evidence_check" CHECK ("takeaways"."evidence" in ('explained', 'applied', 'recalled'))
);
--> statement-breakpoint
ALTER TABLE "step_days" ADD COLUMN "reflection" text;--> statement-breakpoint
ALTER TABLE "takeaways" ADD CONSTRAINT "takeaways_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeaways" ADD CONSTRAINT "takeaways_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "takeaways_tester_day_idx" ON "takeaways" USING btree ("tester_id","day");