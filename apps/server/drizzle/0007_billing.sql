CREATE TABLE "billing_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"allowance" double precision,
	"uncapped" boolean DEFAULT false NOT NULL,
	"allowance_since" timestamp with time zone DEFAULT now() NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"stripe_customer_id" text,
	"payment_method_id" text,
	"card_brand" text,
	"card_last4" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_charge_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"usage" double precision NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_intent_id" text,
	"receipt_url" text,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "managed_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"generation_id" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"provider_cost" double precision NOT NULL,
	"billed" double precision NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage" ADD CONSTRAINT "managed_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage" ADD CONSTRAINT "managed_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage" ADD CONSTRAINT "managed_usage_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_user" ON "invoices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_usage_user_time" ON "managed_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_usage_generation" ON "managed_usage" USING btree ("generation_id");