ALTER TABLE "console_messages" ADD COLUMN "delivery" text DEFAULT 'natural' NOT NULL;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_delivery_check" CHECK ("console_messages"."delivery" in ('natural', 'morning', 'own_text'));