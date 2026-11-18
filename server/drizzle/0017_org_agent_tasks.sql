CREATE TABLE "organisation_agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"step" integer NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text_ct" text,
	"outcome" text DEFAULT 'started' NOT NULL,
	"screenshot_sha256" text,
	"url" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"approval_id" uuid,
	"key_id" uuid,
	"summary" text NOT NULL,
	"instruction_ct" text NOT NULL,
	"model" text NOT NULL,
	"max_steps" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_ct" text,
	"error" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"sandbox" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organisation_agent_actions" ADD CONSTRAINT "organisation_agent_actions_task_id_organisation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."organisation_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_agent_actions" ADD CONSTRAINT "organisation_agent_actions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_tasks" ADD CONSTRAINT "organisation_tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_tasks" ADD CONSTRAINT "organisation_tasks_connection_id_organisation_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."organisation_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_tasks" ADD CONSTRAINT "organisation_tasks_approval_id_organisation_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."organisation_approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_tasks" ADD CONSTRAINT "organisation_tasks_key_id_organisation_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."organisation_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_agent_actions_task_seq_key" ON "organisation_agent_actions" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "organisation_agent_actions_org_idx" ON "organisation_agent_actions" USING btree ("organisation_id","at");--> statement-breakpoint
CREATE INDEX "organisation_tasks_org_idx" ON "organisation_tasks" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "organisation_tasks_status_idx" ON "organisation_tasks" USING btree ("status");