ALTER TABLE "swarm_messages" ADD COLUMN "read_by" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD COLUMN "kind" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD COLUMN "reply_to" uuid;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD COLUMN "key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "swarm_messages_key" ON "swarm_messages" USING btree ("swarm_id","key");