ALTER TABLE "invites" ADD COLUMN "token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash" ON "invites" USING btree ("token_hash");