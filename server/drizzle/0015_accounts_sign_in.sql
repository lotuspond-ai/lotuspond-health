ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accounts_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_accounts_subject_key" ON "users" USING btree ("accounts_subject");