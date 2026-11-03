CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"granted" boolean NOT NULL,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory" (
	"email_hash" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "region" text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unit_system" text DEFAULT 'conventional' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_user_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "consents_user_idx" ON "consents" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "directory_user_idx" ON "directory" USING btree ("user_id");