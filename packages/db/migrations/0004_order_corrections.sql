ALTER TABLE "orders" ADD COLUMN "cancelled_at" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancel_reason" text;