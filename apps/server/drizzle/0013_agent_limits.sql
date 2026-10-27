CREATE TABLE "agent_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"swarm_id" uuid,
	"step_id" uuid,
	"agent_id" uuid,
	"amount" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "spent" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "swarms" ADD COLUMN "task_budget" double precision;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_monthly_limit" double precision;--> statement-breakpoint
ALTER TABLE "agent_spend" ADD CONSTRAINT "agent_spend_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spend" ADD CONSTRAINT "agent_spend_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spend" ADD CONSTRAINT "agent_spend_step_id_plan_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."plan_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spend" ADD CONSTRAINT "agent_spend_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_spend_workspace" ON "agent_spend" USING btree ("workspace_id","created_at");