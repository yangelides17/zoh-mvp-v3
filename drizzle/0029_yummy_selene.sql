CREATE TABLE "coaching_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"area" text NOT NULL,
	"action" text NOT NULL,
	"from" text,
	"to" text,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coaching_changes_area_check" CHECK ("coaching_changes"."area" in ('guidance', 'style', 'learned')),
	CONSTRAINT "coaching_changes_action_check" CHECK ("coaching_changes"."action" in ('add', 'edit', 'remove', 'clear'))
);
--> statement-breakpoint
CREATE TABLE "coaching_guidance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"text" text NOT NULL,
	"author" text NOT NULL,
	"overridden_by" text,
	"overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coaching_changes" ADD CONSTRAINT "coaching_changes_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_guidance" ADD CONSTRAINT "coaching_guidance_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coaching_changes_tester_at_idx" ON "coaching_changes" USING btree ("tester_id","at");