CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"goal" text NOT NULL,
	"wa_id" text,
	"customer_id" integer,
	"status" text NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	"error" text,
	"started_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"ended_at" text
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"order_id" integer,
	"customer_id" integer NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb,
	"run_id" text,
	"requested_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"decided_by" text,
	"decided_at" text,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text,
	"ts" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"tool" text,
	"summary" text NOT NULL,
	"data" jsonb,
	"confidence" double precision,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "autonomy_policies" (
	"action" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"max_auto_amount" integer
);
--> statement-breakpoint
CREATE TABLE "conversation_locks" (
	"wa_id" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_state" (
	"wa_id" text PRIMARY KEY NOT NULL,
	"active_order_id" integer,
	"notes" text,
	"updated_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_name" text NOT NULL,
	"honorific" text NOT NULL,
	"wa_id" text NOT NULL,
	"tier" text NOT NULL,
	"credit_limit" integer NOT NULL,
	"payment_term_days" integer NOT NULL,
	"area" text NOT NULL,
	"address" text NOT NULL,
	"reminder_tone" text DEFAULT 'friendly' NOT NULL,
	CONSTRAINT "customers_wa_id_unique" UNIQUE("wa_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"media_id" text NOT NULL,
	"document_text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"run_id" text,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" text NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"customer_id" integer NOT NULL,
	"order_id" integer,
	"amount" integer NOT NULL,
	"paid_amount" integer DEFAULT 0 NOT NULL,
	"issued_at" text NOT NULL,
	"due_at" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"promise_to_pay_at" text,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	"sidecar_text" text,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"wa_id" text NOT NULL,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"media_id" text,
	"transcript" text,
	"run_id" text,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"unit" text NOT NULL,
	"unit_price" integer NOT NULL,
	"line_total" integer NOT NULL,
	"raw_text" text,
	"match_confidence" double precision,
	"substituted_from_product_id" integer
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"channel" text NOT NULL,
	"delivery_note" text,
	"subtotal" integer DEFAULT 0 NOT NULL,
	"split_from_order_id" integer,
	"human_edited" boolean DEFAULT false NOT NULL,
	"historic" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"updated_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"confirmed_at" text,
	"summary_sent_at" text,
	"shipped_at" text
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"message_id" integer,
	"amount" integer NOT NULL,
	"paid_on" text,
	"bank" text,
	"reference" text,
	"sender_name" text,
	"allocations" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" text,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"decided_at" text
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"product_id" integer NOT NULL,
	"tier" text NOT NULL,
	"unit" text NOT NULL,
	"unit_price" integer NOT NULL,
	CONSTRAINT "product_prices_product_id_tier_unit_pk" PRIMARY KEY("product_id","tier","unit")
);
--> statement-breakpoint
CREATE TABLE "product_substitutes" (
	"product_id" integer NOT NULL,
	"substitute_id" integer NOT NULL,
	"rank" integer NOT NULL,
	CONSTRAINT "product_substitutes_product_id_substitute_id_pk" PRIMARY KEY("product_id","substitute_id")
);
--> statement-breakpoint
CREATE TABLE "product_synonyms" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_units" (
	"product_id" integer NOT NULL,
	"unit" text NOT NULL,
	"factor" integer NOT NULL,
	CONSTRAINT "product_units_product_id_unit_pk" PRIMARY KEY("product_id","unit")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"brand" text NOT NULL,
	"category" text NOT NULL,
	"base_unit" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"tone" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"sent_at" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"wa_id" text NOT NULL,
	CONSTRAINT "staff_wa_id_unique" UNIQUE("wa_id")
);
--> statement-breakpoint
CREATE TABLE "stock" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "delivery_checks" ADD CONSTRAINT "delivery_checks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_substitutes" ADD CONSTRAINT "product_substitutes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_substitutes" ADD CONSTRAINT "product_substitutes_substitute_id_products_id_fk" FOREIGN KEY ("substitute_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_synonyms" ADD CONSTRAINT "product_synonyms_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_wa_idx" ON "agent_runs" USING btree ("wa_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_run_idx" ON "audit_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "delivery_checks_order_idx" ON "delivery_checks" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "messages_wa_idx" ON "messages" USING btree ("wa_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "product_synonyms_alias_idx" ON "product_synonyms" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");