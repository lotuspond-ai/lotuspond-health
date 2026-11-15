CREATE TABLE "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"client_id" text,
	"name" text NOT NULL,
	"redirect_host" text,
	"scopes" jsonb NOT NULL,
	"profile_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_logged_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"expires_at" timestamp with time zone,
	"code_challenge" text,
	"redirect_uri" text,
	"resource" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_grant_id_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_grants_user_idx" ON "agent_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_user_client_key" ON "agent_grants" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "agent_tokens_grant_idx" ON "agent_tokens" USING btree ("grant_id");