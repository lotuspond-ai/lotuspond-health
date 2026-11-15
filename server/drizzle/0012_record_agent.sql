CREATE TABLE "record_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"portal_url" text DEFAULT '' NOT NULL,
	"identifier_ct" text,
	"session_ct" text,
	"refresh_days" integer,
	"next_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consent_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_items" (
	"connection_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"step" text,
	"question" jsonb,
	"found" integer DEFAULT 0 NOT NULL,
	"saved" integer DEFAULT 0 NOT NULL,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "record_connections" ADD CONSTRAINT "record_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_connections" ADD CONSTRAINT "record_connections_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_items" ADD CONSTRAINT "record_items_connection_id_record_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."record_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_items" ADD CONSTRAINT "record_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_runs" ADD CONSTRAINT "record_runs_connection_id_record_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."record_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_runs" ADD CONSTRAINT "record_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_connections_key" ON "record_connections" USING btree ("user_id","profile_id","source_id","portal_url");--> statement-breakpoint
CREATE INDEX "record_connections_due_idx" ON "record_connections" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "record_items_key" ON "record_items" USING btree ("connection_id","item_key");--> statement-breakpoint
CREATE INDEX "record_runs_connection_idx" ON "record_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "record_runs_status_idx" ON "record_runs" USING btree ("status");