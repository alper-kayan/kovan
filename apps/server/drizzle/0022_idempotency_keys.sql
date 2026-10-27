CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_owner_key" ON "idempotency_keys" USING btree ("owner","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created" ON "idempotency_keys" USING btree ("created_at");