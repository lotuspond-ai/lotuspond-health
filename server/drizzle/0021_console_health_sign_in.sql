ALTER TABLE "organisation_accounts" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_accounts" ADD COLUMN "health_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organisation_accounts" ADD COLUMN "health_region" text;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_accounts_health_user_key" ON "organisation_accounts" USING btree ("health_region","health_user_id");