CREATE TABLE "subagents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_user_id" uuid NOT NULL,
	"task" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"checks_passed" integer DEFAULT 0 NOT NULL,
	"checks_total" integer DEFAULT 0 NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"base_sha" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"integrated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "paused" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pr_state" text;--> statement-breakpoint
ALTER TABLE "subagents" ADD CONSTRAINT "subagents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagents" ADD CONSTRAINT "subagents_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subagents_session" ON "subagents" USING btree ("session_id","created_at");