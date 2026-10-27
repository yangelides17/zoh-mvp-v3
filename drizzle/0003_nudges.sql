CREATE TABLE "nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"moment" text NOT NULL,
	"message_id" uuid,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nudges_tester_date_kind_unique" UNIQUE("tester_id","date","kind"),
	CONSTRAINT "nudges_status_check" CHECK ("nudges"."status" in ('claimed', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "step_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"date" date NOT NULL,
	"plan_id" uuid,
	"status" text,
	"moved_time" text,
	"on_it_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_days_tester_date_unique" UNIQUE("tester_id","date"),
	CONSTRAINT "step_days_status_check" CHECK ("step_days"."status" in ('done', 'done_reduced', 'missed'))
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "minutes" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "auto_texts_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_days" ADD CONSTRAINT "step_days_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_days" ADD CONSTRAINT "step_days_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;