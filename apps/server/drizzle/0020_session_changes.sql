CREATE TABLE "session_changes" (
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"diff_enc" text,
	"commit" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_changes_session_id_user_id_pk" PRIMARY KEY("session_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;