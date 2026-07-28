CREATE TABLE IF NOT EXISTS "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"role" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rep_shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_rep" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"is_house_account" boolean DEFAULT false NOT NULL,
	"hire_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "store" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"rotation_salt" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "store_closure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"closure_date" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "store_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"open_time" time,
	"close_time" time,
	"is_closed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eligibility_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"evaluated_prior_workday" text,
	"calls_found" integer DEFAULT 0 NOT NULL,
	"min_calls_required" integer NOT NULL,
	"would_be_status" text NOT NULL,
	"reason" text,
	"policy_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rep_daily_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"decided_by" text DEFAULT 'SYSTEM' NOT NULL,
	"daily_cap" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_note" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_requirement_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_calls" integer NOT NULL,
	"grace_days_after_hire" integer DEFAULT 0 NOT NULL,
	"grace_after_absence_days" integer DEFAULT 0 NOT NULL,
	"max_prior_workday_age" integer DEFAULT 7 NOT NULL,
	"enforcement_mode" text DEFAULT 'SHADOW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"phone_digits" text GENERATED ALWAYS AS (regexp_replace(regexp_replace(phone_e164, '^\+1', ''), '\D', '', 'g')) STORED,
	"do_not_call" boolean DEFAULT false NOT NULL,
	CONSTRAINT "customer_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"assigned_rep_id" uuid,
	"status" text NOT NULL,
	"business_date" text NOT NULL,
	"period_key" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"lead_id" uuid,
	"note_body" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" text NOT NULL,
	"entry_source" text DEFAULT 'CRM_IMPORT' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assignment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"rep_id" uuid,
	"event_type" text NOT NULL,
	"cycle_no" uuid NOT NULL,
	"credit_delta" integer DEFAULT 0 NOT NULL,
	"queue_snapshot" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rep_month_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"ups_mtd" integer DEFAULT 0 NOT NULL,
	"charged_skips_mtd" integer DEFAULT 0 NOT NULL,
	"credit_mtd" integer DEFAULT 0 NOT NULL,
	"ups_today" integer DEFAULT 0 NOT NULL,
	"last_assigned_at" timestamp with time zone,
	CONSTRAINT "rep_month_counters_rep_period_unique" UNIQUE("rep_id","period_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rotation_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rr_cycle_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"rep_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rr_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"current_cycle_id" uuid,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_date" text NOT NULL,
	"rep_id" uuid,
	"ups_count" integer DEFAULT 0 NOT NULL,
	"skips_count" integer DEFAULT 0 NOT NULL,
	"overrides_count" integer DEFAULT 0 NOT NULL,
	"disqualified_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reactivation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rep_id" uuid NOT NULL,
	"claim_text" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" uuid,
	"review_reason_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unassigned_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_shift" ADD CONSTRAINT "rep_shift_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_rep" ADD CONSTRAINT "sales_rep_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "store_closure" ADD CONSTRAINT "store_closure_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "store_hours" ADD CONSTRAINT "store_hours_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eligibility_snapshot" ADD CONSTRAINT "eligibility_snapshot_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eligibility_snapshot" ADD CONSTRAINT "eligibility_snapshot_policy_id_work_requirement_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."work_requirement_policy"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_daily_status" ADD CONSTRAINT "rep_daily_status_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_override" ADD CONSTRAINT "status_override_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_assigned_rep_id_sales_rep_id_fk" FOREIGN KEY ("assigned_rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_cycle_no_rotation_cycle_id_fk" FOREIGN KEY ("cycle_no") REFERENCES "public"."rotation_cycle"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_month_counters" ADD CONSTRAINT "rep_month_counters_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rr_cycle_assignments" ADD CONSTRAINT "rr_cycle_assignments_cycle_id_rotation_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."rotation_cycle"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rr_cycle_assignments" ADD CONSTRAINT "rr_cycle_assignments_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rr_state" ADD CONSTRAINT "rr_state_current_cycle_id_rotation_cycle_id_fk" FOREIGN KEY ("current_cycle_id") REFERENCES "public"."rotation_cycle"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_facts" ADD CONSTRAINT "daily_facts_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reactivation_request" ADD CONSTRAINT "reactivation_request_rep_id_sales_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unassigned_queue" ADD CONSTRAINT "unassigned_queue_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Single open cycle at a time (spec §2 rotation_cycle: "one_open_cycle unique index").
-- Single store in v1, so this is a store-wide constraint, not per-store.
CREATE UNIQUE INDEX IF NOT EXISTS "one_open_cycle" ON "rotation_cycle" (("closed_at" IS NULL)) WHERE "closed_at" IS NULL;
--> statement-breakpoint
-- Append-only enforcement (spec §0.2, §2): plain no-update/no-delete DB rule, no hash-chain sealing.
REVOKE UPDATE, DELETE ON "assignment_events" FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_events" FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "status_override" FROM PUBLIC;
