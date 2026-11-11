ALTER TABLE "record_connections" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "record_runs" ADD COLUMN "note" text;--> statement-breakpoint
CREATE INDEX "record_connections_external_idx" ON "record_connections" USING btree ("external_ref");