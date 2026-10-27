ALTER TABLE "workspaces" ALTER COLUMN "auto_git_sync" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "git_sync_changed_by" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "git_sync_changed_at" timestamp with time zone;--> statement-breakpoint
-- Nothing could turn it on before (no setting reached it) and every app synced anyway: on for all.
UPDATE "workspaces" SET "auto_git_sync" = true;
