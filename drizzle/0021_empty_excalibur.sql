ALTER TABLE "console_messages" DROP CONSTRAINT "console_messages_kind_check";--> statement-breakpoint
ALTER TABLE "console_messages" DROP CONSTRAINT "console_messages_request_status_check";--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_kind_check";--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_decision_check";--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "draft_action" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "draft_input" jsonb;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "draft_status" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD COLUMN "draft_result" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "plan_changes" jsonb;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "outcome_note" text;--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_draft_status_check" CHECK ("console_messages"."draft_status" in ('draft', 'confirmed', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_kind_check" CHECK ("console_messages"."kind" in ('founder', 'coach', 'alert', 'summary', 'note', 'request', 'draft'));--> statement-breakpoint
ALTER TABLE "console_messages" ADD CONSTRAINT "console_messages_request_status_check" CHECK ("console_messages"."request_status" in ('pending', 'sending', 'sent', 'done', 'cancelled'));--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_kind_check" CHECK ("suggestions"."kind" in ('deepen', 'upgrade', 'new_focus', 'adjust'));--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_decision_check" CHECK ("suggestions"."decision" in ('waiting', 'approved', 'changed', 'rejected', 'withdrawn'));