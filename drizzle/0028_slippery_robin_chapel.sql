ALTER TABLE "console_messages" ADD COLUMN "question" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "alert_on_answer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "answer_status" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "media_key" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "media_content_type" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "media_name" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "media_account" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "media_partial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "sendblue_media_url" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_answer_status_check" CHECK ("console_messages"."answer_status" in ('answered', 'dodged'));