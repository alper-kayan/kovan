ALTER TABLE "plan_steps" ADD COLUMN "acceptance" text;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subagents" ADD COLUMN "checks" jsonb DEFAULT '[]'::jsonb NOT NULL;