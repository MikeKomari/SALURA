CREATE TABLE "bank_statement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"line_hash" text NOT NULL,
	"posted_on" text NOT NULL,
	"description" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"payment_id" integer,
	"decided_by" text NOT NULL,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	CONSTRAINT "bank_statement_lines_line_hash_unique" UNIQUE("line_hash")
);
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Same as 0001_enable_rls: no policies, so Supabase's REST API can read nothing here.
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY;
