ALTER TABLE "memories" ADD COLUMN "rationale" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "consequences" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "affects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "conflicts_with" jsonb DEFAULT '[]'::jsonb NOT NULL;