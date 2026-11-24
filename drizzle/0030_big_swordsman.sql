CREATE TABLE "memory_v2_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"date" date NOT NULL,
	"summary" text NOT NULL,
	"source_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_v2_daily_tester_date_unique" UNIQUE("tester_id","date")
);
--> statement-breakpoint
CREATE TABLE "memory_v2_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"tester_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"text" text NOT NULL,
	"detail" text,
	"when" date,
	"as_of" date,
	"origin" text DEFAULT 'stated' NOT NULL,
	"source_message_id" uuid NOT NULL,
	"replaces_id" uuid,
	"learned_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_v2_entries_type_check" CHECK ("memory_v2_entries"."type" in ('fact', 'note', 'unsure', 'todo', 'event', 'followup')),
	CONSTRAINT "memory_v2_entries_status_check" CHECK ("memory_v2_entries"."status" in ('current', 'expired', 'open', 'done', 'dropped')),
	CONSTRAINT "memory_v2_entries_type_status_check" CHECK (("memory_v2_entries"."type" in ('fact', 'note', 'unsure') and "memory_v2_entries"."status" in ('current', 'expired'))
          or ("memory_v2_entries"."type" in ('todo', 'event', 'followup') and "memory_v2_entries"."status" in ('open', 'done', 'dropped'))),
	CONSTRAINT "memory_v2_entries_when_check" CHECK ("memory_v2_entries"."type" in ('fact', 'note', 'unsure') or "memory_v2_entries"."when" is not null),
	CONSTRAINT "memory_v2_entries_origin_check" CHECK ("memory_v2_entries"."origin" in ('stated', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "memory_v2_entry_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	CONSTRAINT "memory_v2_entry_people_unique" UNIQUE("entry_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "memory_v2_forget_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_v2_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_v2_links_unique" UNIQUE("from_page_id","to_page_id","kind"),
	CONSTRAINT "memory_v2_links_kind_check" CHECK ("memory_v2_links"."kind" in ('related', 'leads_to'))
);
--> statement-breakpoint
CREATE TABLE "memory_v2_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"parent_id" uuid,
	"tier" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"other_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"goal_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_v2_pages_kind_check" CHECK ("memory_v2_pages"."kind" in ('root', 'coaching', 'people', 'places', 'area', 'project', 'goal', 'person', 'place')),
	CONSTRAINT "memory_v2_pages_status_check" CHECK ("memory_v2_pages"."status" in ('active', 'paused', 'done', 'past')),
	CONSTRAINT "memory_v2_pages_tier_check" CHECK ("memory_v2_pages"."tier" >= 0 and "memory_v2_pages"."tier" <= 2),
	CONSTRAINT "memory_v2_pages_parent_check" CHECK (("memory_v2_pages"."kind" = 'root' and "memory_v2_pages"."parent_id" is null) or ("memory_v2_pages"."kind" != 'root' and "memory_v2_pages"."parent_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "memory_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "memory_v2_through" date;--> statement-breakpoint
ALTER TABLE "memory_v2_daily" ADD CONSTRAINT "memory_v2_daily_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_entries" ADD CONSTRAINT "memory_v2_entries_page_id_memory_v2_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."memory_v2_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_entries" ADD CONSTRAINT "memory_v2_entries_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_entries" ADD CONSTRAINT "memory_v2_entries_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_entries" ADD CONSTRAINT "memory_v2_entries_replaces_id_memory_v2_entries_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."memory_v2_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_entry_people" ADD CONSTRAINT "memory_v2_entry_people_entry_id_memory_v2_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."memory_v2_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_entry_people" ADD CONSTRAINT "memory_v2_entry_people_page_id_memory_v2_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."memory_v2_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_forget_topics" ADD CONSTRAINT "memory_v2_forget_topics_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_links" ADD CONSTRAINT "memory_v2_links_from_page_id_memory_v2_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."memory_v2_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_links" ADD CONSTRAINT "memory_v2_links_to_page_id_memory_v2_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."memory_v2_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_pages" ADD CONSTRAINT "memory_v2_pages_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_pages" ADD CONSTRAINT "memory_v2_pages_parent_id_memory_v2_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."memory_v2_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_v2_pages" ADD CONSTRAINT "memory_v2_pages_goal_slug_goals_slug_fk" FOREIGN KEY ("goal_slug") REFERENCES "public"."goals"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_v2_daily_tester_idx" ON "memory_v2_daily" USING btree ("tester_id");--> statement-breakpoint
CREATE INDEX "memory_v2_entries_page_idx" ON "memory_v2_entries" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "memory_v2_entries_tester_idx" ON "memory_v2_entries" USING btree ("tester_id");--> statement-breakpoint
CREATE INDEX "memory_v2_entry_people_entry_idx" ON "memory_v2_entry_people" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "memory_v2_forget_topics_tester_idx" ON "memory_v2_forget_topics" USING btree ("tester_id");--> statement-breakpoint
CREATE INDEX "memory_v2_pages_tester_idx" ON "memory_v2_pages" USING btree ("tester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_v2_pages_one_root_idx" ON "memory_v2_pages" USING btree ("tester_id") WHERE "memory_v2_pages"."kind" = 'root';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_v2_pages_one_coaching_idx" ON "memory_v2_pages" USING btree ("tester_id") WHERE "memory_v2_pages"."kind" = 'coaching';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_v2_pages_one_people_idx" ON "memory_v2_pages" USING btree ("tester_id") WHERE "memory_v2_pages"."kind" = 'people';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_v2_pages_one_places_idx" ON "memory_v2_pages" USING btree ("tester_id") WHERE "memory_v2_pages"."kind" = 'places';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_v2_pages_one_goal_idx" ON "memory_v2_pages" USING btree ("tester_id","goal_slug") WHERE "memory_v2_pages"."kind" = 'goal';--> statement-breakpoint
ALTER TABLE "testers" ADD CONSTRAINT "testers_memory_version_check" CHECK ("testers"."memory_version" in ('v1', 'v2'));