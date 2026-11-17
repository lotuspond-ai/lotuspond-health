CREATE TABLE "organisation_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"key_id" uuid,
	"operation" text NOT NULL,
	"summary" text NOT NULL,
	"input_ct" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ct" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_region" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisation_calls" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "access" text DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "live_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "live_request" jsonb;--> statement-breakpoint
ALTER TABLE "organisation_approvals" ADD CONSTRAINT "organisation_approvals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_approvals" ADD CONSTRAINT "organisation_approvals_connection_id_organisation_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."organisation_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_approvals" ADD CONSTRAINT "organisation_approvals_key_id_organisation_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."organisation_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_connections" ADD CONSTRAINT "organisation_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organisation_approvals_org_idx" ON "organisation_approvals" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "organisation_connections_org_idx" ON "organisation_connections" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_members_user_key" ON "organisation_members" USING btree ("organisation_id","user_region","user_id");--> statement-breakpoint
CREATE INDEX "organisation_members_user_idx" ON "organisation_members" USING btree ("user_region","user_id");