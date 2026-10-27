ALTER TABLE "plan_steps" ADD COLUMN "approval" text;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "approval_reason" text;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;