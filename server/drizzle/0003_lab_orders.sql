CREATE TABLE "lab_order_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lab_order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"partner_status" text,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "lab_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"partner" text NOT NULL,
	"partner_ref" text,
	"status" text NOT NULL,
	"partner_status" text,
	"partner_status_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slot_start" timestamp with time zone,
	"slot_end" timestamp with time zone,
	"price_paise" integer DEFAULT 0 NOT NULL,
	"payer" text DEFAULT 'partner' NOT NULL,
	"contact_ct" text,
	"pii_purged_at" timestamp with time zone,
	"consent_version" text,
	"consented_at" timestamp with time zone,
	"idempotency_key" text,
	"request_hash" text,
	"placement_attempts" integer DEFAULT 0 NOT NULL,
	"next_placement_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_webhook_inbox" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lab_webhook_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"partner" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"dead_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lab_order_events" ADD CONSTRAINT "lab_order_events_order_id_lab_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."lab_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_order_events_order_idx" ON "lab_order_events" USING btree ("order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_orders_partner_ref_key" ON "lab_orders" USING btree ("partner","partner_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_orders_idempotency_key" ON "lab_orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "lab_orders_profile_idx" ON "lab_orders" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "lab_orders_status_idx" ON "lab_orders" USING btree ("status","last_synced_at");--> statement-breakpoint
CREATE INDEX "lab_orders_placement_idx" ON "lab_orders" USING btree ("next_placement_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_webhook_inbox_dedupe_key" ON "lab_webhook_inbox" USING btree ("partner","dedupe_key");--> statement-breakpoint
CREATE INDEX "lab_webhook_inbox_due_idx" ON "lab_webhook_inbox" USING btree ("processed_at","next_attempt_at");