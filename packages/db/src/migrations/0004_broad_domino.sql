CREATE TABLE IF NOT EXISTS "rep_daily_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'IMPORT' NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rep_daily_activity_rep_date_unique" UNIQUE("rep_id","business_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rep_recurring_day_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	CONSTRAINT "rep_recurring_day_off_rep_day_unique" UNIQUE("rep_id","day_of_week")
);
--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "manager_note" text;--> statement-breakpoint
-- Drizzle's DSL emits text enums without a DB-level constraint; the design spec calls for
-- `source text check in ('IMPORT','MANUAL')`, so add it by hand.
DO $$ BEGIN
 ALTER TABLE "rep_daily_activity" ADD CONSTRAINT "rep_daily_activity_source_check" CHECK ("source" IN ('IMPORT','MANUAL'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- 0=Sunday..6=Saturday, matching store_hours.day_of_week
DO $$ BEGIN
 ALTER TABLE "rep_recurring_day_off" ADD CONSTRAINT "rep_recurring_day_off_dow_check" CHECK ("day_of_week" BETWEEN 0 AND 6);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_daily_activity" ADD CONSTRAINT "rep_daily_activity_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_recurring_day_off" ADD CONSTRAINT "rep_recurring_day_off_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
