CREATE TABLE "organisation_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
-- Console members were personal Health accounts, kept in other databases (the cells), so they cannot be carried over.
-- Their organisations stay; an operator re-adds an owner with `org:member` (server/src/index.ts).
DELETE FROM "organisation_members";--> statement-breakpoint
DROP INDEX "organisation_members_user_key";--> statement-breakpoint
DROP INDEX "organisation_members_user_idx";--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "approves" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_sessions" ADD CONSTRAINT "organisation_sessions_account_id_organisation_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."organisation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_accounts_email_key" ON "organisation_accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "organisation_sessions_account_idx" ON "organisation_sessions" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_account_id_organisation_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."organisation_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_members_account_key" ON "organisation_members" USING btree ("organisation_id","account_id");--> statement-breakpoint
CREATE INDEX "organisation_members_account_idx" ON "organisation_members" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "organisation_members" DROP COLUMN "user_region";--> statement-breakpoint
ALTER TABLE "organisation_members" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "organisation_members" DROP COLUMN "email";