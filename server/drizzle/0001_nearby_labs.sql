CREATE TABLE "facility_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_labs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"locality" text,
	"region" text,
	"postal_code" text,
	"country" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"phone" text,
	"website" text,
	"booking_url" text,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opening_hours" text,
	"accreditation" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "locality" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "longitude" double precision;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_labs_slug_key" ON "partner_labs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "partner_labs_country_idx" ON "partner_labs" USING btree ("country");