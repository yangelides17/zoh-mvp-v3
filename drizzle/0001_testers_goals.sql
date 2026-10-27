CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"sort_order" integer NOT NULL,
	"plan_questions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"what" text,
	"where" text,
	"when" text,
	"how_long" text,
	"tracks_with" text,
	"extra_notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_inputs_tester_goal_unique" UNIQUE("tester_id","goal_slug")
);
--> statement-breakpoint
CREATE TABLE "testers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"phase" text DEFAULT 'onboarding' NOT NULL,
	"goal_slug" text,
	"time_zone" text NOT NULL,
	"time_zone_status" text NOT NULL,
	"quiet_hours_start" text DEFAULT '22:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '09:00' NOT NULL,
	"pushiness" text DEFAULT 'pushy' NOT NULL,
	"style_notes" text DEFAULT '' NOT NULL,
	"is_test_user" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"context_started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testers_phone_unique" UNIQUE("phone"),
	CONSTRAINT "testers_phase_check" CHECK ("testers"."phase" in ('onboarding', 'planning')),
	CONSTRAINT "testers_time_zone_status_check" CHECK ("testers"."time_zone_status" in ('assumed_eastern', 'needs_city', 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_inputs" ADD CONSTRAINT "plan_inputs_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_inputs" ADD CONSTRAINT "plan_inputs_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testers" ADD CONSTRAINT "testers_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flags_tester_idx" ON "flags" USING btree ("tester_id");--> statement-breakpoint
-- Seed: the starting goals (feature 4, "Starting goals"). Added by hand after generation; drizzle-kit has no seed step.
INSERT INTO "goals" ("slug", "title", "description", "sort_order", "plan_questions") VALUES
	('reading', 'Daily reading', 'Pages or minutes of a book', 1, '[{"key":"what","required":true},{"key":"where","required":false},{"key":"when","required":true},{"key":"how_long","required":true}]'::jsonb),
	('exercise', 'Daily exercise', 'Gym, home workout, walk or run, a sport', 2, '[{"key":"what","required":true},{"key":"where","required":true},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":true}]'::jsonb),
	('nutrition', 'Daily nutrition', 'A calorie or protein target for the day', 3, '[{"key":"what","required":true},{"key":"when","required":false},{"key":"tracks_with","required":true}]'::jsonb),
	('reflection', 'Daily reflection and planning', 'Journaling, a nightly reflection, or planning tomorrow', 4, '[{"key":"what","required":true},{"key":"where","required":false},{"key":"when","required":true},{"key":"how_long","required":true}]'::jsonb),
	('deep_work', 'Daily deep work target', 'A set amount of focused, distraction-free work each day', 5, '[{"key":"what","required":true},{"key":"where","required":false},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":true}]'::jsonb),
	('bedtime', 'Same bedtime every night', 'In bed, lights out, at the agreed time (wake time not a goal for now)', 6, '[{"key":"what","required":true,"note":"What usually keeps them up"},{"key":"when","required":true,"note":"The time they want to be in bed, lights out"},{"key":"tracks_with","required":true}]'::jsonb),
	('something_else', 'Something else', 'Accepted only if it''s close to a goal above and ZOH is confident it can coach and check it', 7, '[{"key":"what","required":true},{"key":"where","required":true},{"key":"when","required":true},{"key":"how_long","required":true}]'::jsonb);
