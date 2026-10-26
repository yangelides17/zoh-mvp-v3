CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" text NOT NULL,
	"contact_number" text NOT NULL,
	"line_number" text,
	"content" text,
	"media_url" text,
	"media_key" text,
	"media_content_type" text,
	"transcript" text,
	"sendblue_handle" text,
	"service" text,
	"status" text,
	"error" text,
	"in_reply_to" uuid,
	"sent_at" timestamp with time zone,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sendblue_handle_unique" UNIQUE("sendblue_handle"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('inbound', 'outbound'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_in_reply_to_messages_id_fk" FOREIGN KEY ("in_reply_to") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_contact_created_idx" ON "messages" USING btree ("contact_number","created_at");