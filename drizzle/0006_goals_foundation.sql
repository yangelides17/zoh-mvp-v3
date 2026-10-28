CREATE TABLE "console_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author" text,
	"body" text NOT NULL,
	"topic" text,
	"event_key" text,
	"why" text,
	"plan_id" uuid,
	"suggestion_id" uuid,
	"request_status" text,
	"exact" boolean DEFAULT false NOT NULL,
	"send_now" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"message_id" uuid,
	"seen_at" timestamp with time zone,
	"seen_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_messages_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "console_messages_kind_check" CHECK ("console_messages"."kind" in ('founder', 'coach', 'alert', 'summary', 'note', 'request')),
	CONSTRAINT "console_messages_request_status_check" CHECK ("console_messages"."request_status" in ('pending', 'sent', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"date" date NOT NULL,
	"message_id" uuid,
	"answer" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_checkins_answer_check" CHECK ("maintenance_checkins"."answer" in ('kept_up', 'mostly', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"kind" text NOT NULL,
	"raised_by" text NOT NULL,
	"raised_by_name" text,
	"proposal" text NOT NULL,
	"reasoning" text,
	"new_goal_slug" text,
	"decision" text DEFAULT 'waiting' NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"decided_kind" text,
	"decided_proposal" text,
	"decided_at" timestamp with time zone,
	"outcome" text,
	"delivered_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	"plan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_kind_check" CHECK ("suggestions"."kind" in ('deepen', 'upgrade', 'new_focus')),
	CONSTRAINT "suggestions_raised_by_check" CHECK ("suggestions"."raised_by" in ('coach', 'tester', 'founder')),
	CONSTRAINT "suggestions_decision_check" CHECK ("suggestions"."decision" in ('waiting', 'approved', 'changed', 'rejected')),
	CONSTRAINT "suggestions_decided_kind_check" CHECK ("suggestions"."decided_kind" in ('deepen', 'upgrade', 'new_focus')),
	CONSTRAINT "suggestions_outcome_check" CHECK ("suggestions"."outcome" in ('delivered', 'agreed', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "tester_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"role" text NOT NULL,
	"nudges" boolean DEFAULT true NOT NULL,
	"proof" boolean DEFAULT true NOT NULL,
	"checkins_per_week" integer DEFAULT 0 NOT NULL,
	"role_since" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tester_goals_tester_goal_unique" UNIQUE("tester_id","goal_slug"),
	CONSTRAINT "tester_goals_role_check" CHECK ("tester_goals"."role" in ('focus', 'maintenance', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "change_kind" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checkins" ADD CONSTRAINT "maintenance_checkins_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checkins" ADD CONSTRAINT "maintenance_checkins_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checkins" ADD CONSTRAINT "maintenance_checkins_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_new_goal_slug_goals_slug_fk" FOREIGN KEY ("new_goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tester_goals" ADD CONSTRAINT "tester_goals_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tester_goals" ADD CONSTRAINT "tester_goals_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "console_messages_tester_created_idx" ON "console_messages" USING btree ("tester_id","created_at");--> statement-breakpoint
CREATE INDEX "maintenance_checkins_tester_goal_idx" ON "maintenance_checkins" USING btree ("tester_id","goal_slug","date");--> statement-breakpoint
CREATE INDEX "suggestions_tester_idx" ON "suggestions" USING btree ("tester_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tester_goals_one_focus_idx" ON "tester_goals" USING btree ("tester_id") WHERE "tester_goals"."role" = 'focus';--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_change_kind_check" CHECK ("plans"."change_kind" in ('deepen', 'upgrade', 'other'));--> statement-breakpoint
-- Today's goals: the current one is the focus; goals switched away from are dropped (their streaks frozen).
INSERT INTO "tester_goals" ("tester_id", "goal_slug", "role", "nudges", "proof", "checkins_per_week", "role_since")
SELECT "id", "goal_slug", 'focus', true, true, 0, "updated_at" FROM "testers" WHERE "goal_slug" IS NOT NULL;--> statement-breakpoint
INSERT INTO "tester_goals" ("tester_id", "goal_slug", "role", "nudges", "proof", "checkins_per_week", "role_since")
SELECT pi."tester_id", pi."goal_slug", 'dropped', false, false, 0, pi."updated_at"
FROM "plan_inputs" pi JOIN "testers" t ON t."id" = pi."tester_id"
WHERE t."goal_slug" IS DISTINCT FROM pi."goal_slug"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Every change after a goal's first lock so far kept the streak: "other".
UPDATE "plans" p SET "change_kind" = 'other'
WHERE p."status" = 'locked' AND p."version" > (
  SELECT min(q."version") FROM "plans" q WHERE q."tester_id" = p."tester_id" AND q."goal_slug" = p."goal_slug" AND q."status" = 'locked'
);
