ALTER TABLE "agent_runs" ADD COLUMN "guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "overpayment_settled_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "overpayment_settled_at" text;