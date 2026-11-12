CREATE TABLE "org_billing" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"setup_by" uuid,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"monthly_cap" double precision,
	"member_limit" double precision,
	"stripe_customer_id" text,
	"payment_method_id" text,
	"card_brand" text,
	"card_last4" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"company_name" text,
	"company_address" text,
	"tax_id" text,
	"billing_email" text,
	"last_charge_at" timestamp with time zone,
	"notice_month" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_member_limits" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"monthly_limit" double precision,
	"notice_month" text,
	CONSTRAINT "org_member_limits_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_usage" DROP CONSTRAINT "managed_usage_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_usage" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "notice_month" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "period" text;--> statement-breakpoint
ALTER TABLE "managed_usage" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "org_billing" ADD CONSTRAINT "org_billing_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_billing" ADD CONSTRAINT "org_billing_setup_by_users_id_fk" FOREIGN KEY ("setup_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_limits" ADD CONSTRAINT "org_member_limits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_limits" ADD CONSTRAINT "org_member_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage" ADD CONSTRAINT "managed_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage" ADD CONSTRAINT "managed_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_usage_org_time" ON "managed_usage" USING btree ("org_id","created_at");