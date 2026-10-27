CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"status" text NOT NULL,
	"version" integer,
	"setup_step" text,
	"step" text NOT NULL,
	"place" text,
	"step_time" text NOT NULL,
	"days" jsonb NOT NULL,
	"proof" text NOT NULL,
	"proof_note" text,
	"reason" text NOT NULL,
	"start_date" date,
	"commitment" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_tester_version_unique" UNIQUE("tester_id","version"),
	CONSTRAINT "plans_status_check" CHECK ("plans"."status" in ('draft', 'locked')),
	CONSTRAINT "plans_proof_check" CHECK ("plans"."proof" in ('photo', 'screenshot', 'voice'))
);
--> statement-breakpoint
ALTER TABLE "testers" DROP CONSTRAINT "testers_phase_check";--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_tester_idx" ON "plans" USING btree ("tester_id");--> statement-breakpoint
ALTER TABLE "testers" ADD CONSTRAINT "testers_phase_check" CHECK ("testers"."phase" in ('onboarding', 'planning', 'active'));