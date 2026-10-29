CREATE TABLE "jumps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tester_id" uuid NOT NULL,
	"text" text NOT NULL,
	"sendblue_handle" text NOT NULL,
	"from_at" timestamp with time zone,
	"to_at" timestamp with time zone,
	"log" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jumps_sendblue_handle_unique" UNIQUE("sendblue_handle")
);
--> statement-breakpoint
ALTER TABLE "testers" ADD COLUMN "clock_offset_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jumps" ADD CONSTRAINT "jumps_tester_id_testers_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."testers"("id") ON DELETE cascade ON UPDATE no action;