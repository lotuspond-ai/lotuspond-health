CREATE TABLE "spent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "via_accounts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "accounts_sid" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accounts_subject" text;--> statement-breakpoint
CREATE INDEX "spent_tokens_expires_idx" ON "spent_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_accounts_sid_idx" ON "sessions" USING btree ("accounts_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "users_accounts_subject_key" ON "users" USING btree ("accounts_subject");