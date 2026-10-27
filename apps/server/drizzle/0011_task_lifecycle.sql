ALTER TABLE "plan_steps" ADD COLUMN "run_state" text;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "run_detail" text;--> statement-breakpoint
ALTER TABLE "subagents" ADD COLUMN "request_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "subagents_request_key" ON "subagents" USING btree ("parent_user_id","request_key") WHERE "subagents"."request_key" is not null;