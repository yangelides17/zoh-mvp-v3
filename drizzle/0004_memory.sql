CREATE TABLE "memory_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"tester_id" uuid NOT NULL,
	"section" text DEFAULT '' NOT NULL,
	"label" text,
	"text" text NOT NULL,
	"source_message_id" uuid,
	"day" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_forgotten" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_forgotten_unique" UNIQUE("tester_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "memory_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_links_unique" UNIQUE("from_page_id","to_page_id","kind"),
	CONSTRAINT "memory_links_kind_check" CHECK ("memory_links"."kind" in ('related', 'leads_to'))
);
--> statement-breakpoint
CREATE TABLE "memory_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"goal_slug" text,
	"status" text DEFAULT 'active' NOT NULL,
	"date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_pages_kind_check" CHECK ("memory_pages"."kind" in ('self', 'preferences', 'goal', 'person', 'subject', 'daily')),
	CONSTRAINT "memory_pages_status_check" CHECK ("memory_pages"."status" in ('active', 'past'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "memory_through" date;--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "memory_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_page_id_memory_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."memory_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_forgotten" ADD CONSTRAINT "memory_forgotten_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_forgotten" ADD CONSTRAINT "memory_forgotten_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_from_page_id_memory_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."memory_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_to_page_id_memory_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."memory_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pages" ADD CONSTRAINT "memory_pages_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pages" ADD CONSTRAINT "memory_pages_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_facts_page_idx" ON "memory_facts" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "memory_facts_tester_idx" ON "memory_facts" USING btree ("tester_id");--> statement-breakpoint
CREATE INDEX "memory_links_tester_idx" ON "memory_links" USING btree ("tester_id");--> statement-breakpoint
CREATE INDEX "memory_pages_tester_updated_idx" ON "memory_pages" USING btree ("tester_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_pages_one_daily_idx" ON "memory_pages" USING btree ("tester_id","date") WHERE "memory_pages"."kind" = 'daily';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_pages_one_core_idx" ON "memory_pages" USING btree ("tester_id","kind") WHERE "memory_pages"."kind" in ('self', 'preferences');--> statement-breakpoint
CREATE UNIQUE INDEX "memory_pages_one_goal_idx" ON "memory_pages" USING btree ("tester_id","goal_slug") WHERE "memory_pages"."kind" = 'goal';