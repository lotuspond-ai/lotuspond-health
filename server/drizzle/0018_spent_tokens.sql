CREATE TABLE "spent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spent_tokens_expires_idx" ON "spent_tokens" USING btree ("expires_at");