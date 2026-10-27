CREATE TABLE "ai_agents" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"model" text NOT NULL,
	"effort" text,
	"mode" text DEFAULT 'allow' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid,
	"swarm_id" uuid,
	"kind" text NOT NULL,
	"text_enc" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"evidence" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_agents" (
	"swarm_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"task" text,
	"spent" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "swarm_agents_swarm_id_agent_id_pk" PRIMARY KEY("swarm_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "swarm_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid,
	"text_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"created_by" uuid,
	"launched_by" uuid,
	"goal" text NOT NULL,
	"lead_agent_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"budget" double precision,
	"spent" double precision DEFAULT 0 NOT NULL,
	"max_parallel" integer DEFAULT 2 NOT NULL,
	"mode" text DEFAULT 'allow' NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "host_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_agents" ADD CONSTRAINT "swarm_agents_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_agents" ADD CONSTRAINT "swarm_agents_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_launched_by_users_id_fk" FOREIGN KEY ("launched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_lead_agent_id_users_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_agents_workspace" ON "ai_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "learnings_workspace" ON "learnings" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "swarm_messages_swarm" ON "swarm_messages" USING btree ("swarm_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "swarms_one_live_per_session" ON "swarms" USING btree ("session_id") WHERE "swarms"."status" in ('draft', 'running', 'paused');--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;