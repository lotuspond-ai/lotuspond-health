CREATE TABLE "lab_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"partial" boolean NOT NULL,
	"partner_version" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"pdf_key" text,
	"pdf_bytes" integer,
	"pdf_sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lab_orders" ADD COLUMN "report_version" text;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD COLUMN "report_checked_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD COLUMN "report_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD COLUMN "next_report_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_order_id_lab_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."lab_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_results_order_sequence_key" ON "lab_results" USING btree ("order_id","sequence");--> statement-breakpoint
CREATE INDEX "lab_results_profile_idx" ON "lab_results" USING btree ("profile_id","status");