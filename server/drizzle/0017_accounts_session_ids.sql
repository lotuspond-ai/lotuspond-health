ALTER TABLE "sessions" ADD COLUMN "accounts_sid" text;--> statement-breakpoint
CREATE INDEX "sessions_accounts_sid_idx" ON "sessions" USING btree ("accounts_sid");