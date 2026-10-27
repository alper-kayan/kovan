ALTER TABLE "ai_agents" ADD COLUMN "hired_by_swarm" uuid;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD COLUMN "delivered_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_hired_by_swarm_swarms_id_fk" FOREIGN KEY ("hired_by_swarm") REFERENCES "public"."swarms"("id") ON DELETE set null ON UPDATE no action;