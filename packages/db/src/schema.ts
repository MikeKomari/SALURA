import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';

/** Timestamps are ISO-8601 strings in UTC ("2026-10-21T03:00:00.000Z"), so they sort and compare as text. */
const now = sql`(to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  brand: text('brand').notNull(),
  category: text('category').notNull(),
  /** Smallest unit stock is counted in, e.g. "pcs". */
  baseUnit: text('base_unit').notNull(),
  active: boolean('active').notNull().default(true),
});

/** Units a product can be sold in and how many base units each contains (1 dus = 40 pcs). */
export const productUnits = pgTable(
  'product_units',
  {
    productId: integer('product_id').notNull().references(() => products.id),
    unit: text('unit').notNull(),
    factor: integer('factor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.unit] })],
);

/** Price list: the only source of prices the agent may quote. */
export const productPrices = pgTable(
  'product_prices',
  {
    productId: integer('product_id').notNull().references(() => products.id),
    tier: text('tier').notNull(),
    unit: text('unit').notNull(),
    unitPrice: integer('unit_price').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.tier, t.unit] })],
);

/** Free-text names customers use for a product ("indomi goreng", "minyak bimoli 2 liter"). */
export const productSynonyms = pgTable(
  'product_synonyms',
  {
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id),
    alias: text('alias').notNull(),
  },
  (t) => [index('product_synonyms_alias_idx').on(t.alias)],
);

/** Distributor-approved substitutes, in order of preference. */
export const productSubstitutes = pgTable(
  'product_substitutes',
  {
    productId: integer('product_id').notNull().references(() => products.id),
    substituteId: integer('substitute_id').notNull().references(() => products.id),
    rank: integer('rank').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.substituteId] })],
);

/** Quantities are in the product's base unit. */
export const stock = pgTable('stock', {
  productId: integer('product_id').primaryKey().references(() => products.id),
  onHand: integer('on_hand').notNull(),
  reserved: integer('reserved').notNull().default(0),
});

// ---------------------------------------------------------------------------
// Customers and receivables
// ---------------------------------------------------------------------------

export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  ownerName: text('owner_name').notNull(),
  /** How the distributor addresses the owner (Bu, Pak, Mas, ...), as recorded by the order desk. */
  honorific: text('honorific').notNull(),
  waId: text('wa_id').notNull().unique(),
  tier: text('tier').notNull(),
  creditLimit: integer('credit_limit').notNull(),
  paymentTermDays: integer('payment_term_days').notNull(),
  area: text('area').notNull(),
  address: text('address').notNull(),
  /** Preferred reminder tone, learned from history: "friendly" | "neutral" | "firm". */
  reminderTone: text('reminder_tone').notNull().default('friendly'),
});

export const invoices = pgTable(
  'invoices',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull().unique(),
    customerId: integer('customer_id').notNull().references(() => customers.id),
    orderId: integer('order_id'),
    amount: integer('amount').notNull(),
    paidAmount: integer('paid_amount').notNull().default(0),
    issuedAt: text('issued_at').notNull(),
    dueAt: text('due_at').notNull(),
    status: text('status', { enum: ['open', 'paid'] }).notNull().default('open'),
    promiseToPayAt: text('promise_to_pay_at'),
    /** When the owner refunded or offset what was paid above `amount` (after a correction). */
    overpaymentSettledAt: text('overpayment_settled_at'),
  },
  (t) => [index('invoices_customer_idx').on(t.customerId)],
);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  'draft',
  'awaiting_customer',
  'awaiting_approval',
  'confirmed',
  'rejected',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    customerId: integer('customer_id').notNull().references(() => customers.id),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('draft'),
    channel: text('channel').notNull(),
    deliveryNote: text('delivery_note'),
    subtotal: integer('subtotal').notNull().default(0),
    /** Set when this order is the held remainder of a split. */
    splitFromOrderId: integer('split_from_order_id'),
    /** True when a person changed the agent's draft; drives straight-through rate. */
    humanEdited: boolean('human_edited').notNull().default(false),
    /** Historic orders are seed data, not handled by the agent. */
    historic: boolean('historic').notNull().default(false),
    /** Drafted in a guest account's test chat: kept apart from the customer's own drafts. */
    guest: boolean('guest').notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    confirmedAt: text('confirmed_at'),
    /** When the customer was last shown this version of the order; consent must come after it. */
    summarySentAt: text('summary_sent_at'),
    /** Set when the warehouse marks the order as loaded for delivery (Gudang page). */
    shippedAt: text('shipped_at'),
    /** A correction by a person: when the order was pulled back after it had been confirmed. */
    cancelledAt: text('cancelled_at'),
    /** Who pulled it back. Null when the agent or the customer cancelled a draft, which needs no repair. */
    cancelledBy: text('cancelled_by'),
    /** What the admin picked or typed as the reason, shown on the order and in the audit log. */
    cancelReason: text('cancel_reason'),
  },
  (t) => [index('orders_customer_idx').on(t.customerId), index('orders_status_idx').on(t.status)],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id').notNull().references(() => orders.id),
    productId: integer('product_id').notNull().references(() => products.id),
    qty: integer('qty').notNull(),
    unit: text('unit').notNull(),
    unitPrice: integer('unit_price').notNull(),
    lineTotal: integer('line_total').notNull(),
    /** What the customer actually wrote for this line. */
    rawText: text('raw_text'),
    matchConfidence: doublePrecision('match_confidence'),
    substitutedFromProductId: integer('substituted_from_product_id'),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

// ---------------------------------------------------------------------------
// Autonomy and approvals
// ---------------------------------------------------------------------------

export const AUTONOMY_ACTIONS = ['confirm_order', 'over_credit_order', 'send_reminder', 'send_reorder_nudge'] as const;
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];
export const AUTONOMY_MODES = ['suggest', 'auto', 'approve'] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const autonomyPolicies = pgTable('autonomy_policies', {
  action: text('action', { enum: AUTONOMY_ACTIONS }).primaryKey(),
  mode: text('mode', { enum: AUTONOMY_MODES }).notNull(),
  /** confirm_order only: orders above this subtotal need approval even in auto mode. */
  maxAutoAmount: integer('max_auto_amount'),
});

export const APPROVAL_TYPES = ['order', 'credit_override', 'reminder', 'escalation', 'reorder', 'delivery_query', 'invoice_adjustment', 'payment'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const approvals = pgTable(
  'approvals',
  {
    id: serial('id').primaryKey(),
    type: text('type', { enum: APPROVAL_TYPES }).notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
    orderId: integer('order_id'),
    customerId: integer('customer_id').notNull(),
    reason: text('reason').notNull(),
    /** Action-specific data, e.g. the reminder text to send. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    runId: text('run_id'),
    requestedAt: text('requested_at').notNull().default(now),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    decisionNote: text('decision_note'),
  },
  (t) => [index('approvals_status_idx').on(t.status)],
);

export const reminders = pgTable('reminders', {
  id: serial('id').primaryKey(),
  invoiceId: integer('invoice_id').notNull().references(() => invoices.id),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  tone: text('tone').notNull(),
  text: text('text').notNull(),
  status: text('status', { enum: ['pending_approval', 'sent', 'rejected'] }).notNull(),
  runId: text('run_id'),
  createdAt: text('created_at').notNull().default(now),
  sentAt: text('sent_at'),
});

export const PAYMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * A payment a customer reported (usually a transfer screenshot in the chat). The agent proposes
 * which invoices it pays; nothing is marked paid until the owner checks the bank and approves.
 */
export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),
    customerId: integer('customer_id').notNull().references(() => customers.id),
    /** The chat message with the proof, when there is one. */
    messageId: integer('message_id'),
    amount: integer('amount').notNull(),
    /** Transfer date as written on the proof (YYYY-MM-DD), when readable. */
    paidOn: text('paid_on'),
    bank: text('bank'),
    reference: text('reference'),
    senderName: text('sender_name'),
    /** Proposed allocation, oldest invoice first: [{ invoiceId, number, amount }]. */
    allocations: jsonb('allocations').$type<{ invoiceId: number; number: string; amount: number }[]>().notNull(),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull().default('pending'),
    runId: text('run_id'),
    /** Reported in a guest account's test chat; never treated as a duplicate of the customer's own claims. */
    guest: boolean('guest').notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
    decidedAt: text('decided_at'),
    /** When the owner refunded or offset the part of the transfer no open invoice took. */
    overpaymentSettledAt: text('overpayment_settled_at'),
  },
  (t) => [index('payments_customer_idx').on(t.customerId)],
);

export const BANK_LINE_STATUSES = ['matched', 'ignored'] as const;

/**
 * Credit lines from an uploaded bank statement (mutasi rekening) the owner matched to a payment or
 * set aside. Unique by a hash of date, amount and description, so uploading the same statement
 * again records nothing twice.
 */
export const bankStatementLines = pgTable('bank_statement_lines', {
  id: serial('id').primaryKey(),
  lineHash: text('line_hash').notNull().unique(),
  /** Booking date on the statement (YYYY-MM-DD). */
  postedOn: text('posted_on').notNull(),
  description: text('description').notNull(),
  amount: integer('amount').notNull(),
  status: text('status', { enum: BANK_LINE_STATUSES }).notNull(),
  /** The payment this line confirmed: a new one, or one the customer reported in the chat. */
  paymentId: integer('payment_id').references(() => payments.id),
  decidedBy: text('decided_by').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

// ---------------------------------------------------------------------------
// Delivery: staff contacts and document checks (surat jalan / nota vs order vs invoice)
// ---------------------------------------------------------------------------

export const STAFF_ROLES = ['warehouse', 'driver'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** People inside the distributor the agent may message (through the owner's approval). */
export const staff = pgTable('staff', {
  id: serial('id').primaryKey(),
  role: text('role', { enum: STAFF_ROLES }).notNull(),
  name: text('name').notNull(),
  waId: text('wa_id').notNull().unique(),
});

export const DELIVERY_CHECK_STATUSES = ['pending', 'match', 'mismatch', 'unreadable', 'failed'] as const;

export const deliveryChecks = pgTable(
  'delivery_checks',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id').notNull().references(() => orders.id),
    kind: text('kind', { enum: ['surat_jalan', 'nota'] }).notNull(),
    /** `guest`: opened from a guest account's test chat, never shown as the order's delivery status. */
    source: text('source', { enum: ['console', 'chat', 'guest'] }).notNull(),
    mediaId: text('media_id').notNull(),
    /** What the vision model read from the photo. */
    documentText: text('document_text'),
    status: text('status', { enum: DELIVERY_CHECK_STATUSES }).notNull().default('pending'),
    /** Line-by-line comparison and totals (see domain/delivery.ts). */
    result: jsonb('result').$type<Record<string, unknown>>(),
    runId: text('run_id'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('delivery_checks_order_idx').on(t.orderId)],
);

// ---------------------------------------------------------------------------
// Conversations, agent runs and audit
// ---------------------------------------------------------------------------

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    waId: text('wa_id').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    channel: text('channel').notNull(),
    kind: text('kind', { enum: ['text', 'voice', 'image'] }).notNull(),
    text: text('text'),
    mediaId: text('media_id'),
    transcript: text('transcript'),
    runId: text('run_id'),
    /** Typed by, or answered to, a guest account in the console: left out of the customer's own runs. */
    guest: boolean('guest').notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('messages_wa_idx').on(t.waId)],
);

/** Short-term memory: what the agent is in the middle of with each customer. */
export const conversationState = pgTable('conversation_state', {
  waId: text('wa_id').primaryKey(),
  activeOrderId: integer('active_order_id'),
  notes: text('notes'),
  updatedAt: text('updated_at').notNull().default(now),
});

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    trigger: text('trigger', { enum: ['message', 'schedule', 'approval', 'eval', 'delivery'] }).notNull(),
    goal: text('goal').notNull(),
    waId: text('wa_id'),
    customerId: integer('customer_id'),
    status: text('status', { enum: ['running', 'completed', 'escalated', 'failed'] }).notNull(),
    steps: integer('steps').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd'),
    error: text('error'),
    startedAt: text('started_at').notNull().default(now),
    endedAt: text('ended_at'),
    /** Started by a guest account's test chat. */
    guest: boolean('guest').notNull().default(false),
  },
  (t) => [index('agent_runs_wa_idx').on(t.waId)],
);

export const AUDIT_TYPES = [
  'message_in',
  'message_out',
  'thought',
  'tool_call',
  'tool_result',
  'validation',
  'approval',
  'error',
  /** A person changed master data (spreadsheet import, warehouse dispatch). */
  'data_change',
] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

/** Append-only. Nothing in the codebase updates or deletes rows here (except a full demo reset). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id'),
    ts: text('ts').notNull().default(now),
    actor: text('actor', { enum: ['agent', 'system', 'human', 'customer'] }).notNull(),
    type: text('type', { enum: AUDIT_TYPES }).notNull(),
    tool: text('tool'),
    summary: text('summary').notNull(),
    data: jsonb('data').$type<unknown>(),
    confidence: doublePrecision('confidence'),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('audit_log_run_idx').on(t.runId)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// Platform: accounts, uploaded media, live events, limits (shared by every server instance)
// ---------------------------------------------------------------------------

export const USER_ROLES = ['admin', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Console accounts. Admins decide approvals and change data; viewers chat and look around. */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull(),
  /** scrypt$N$r$p$salt$hash (see apps/api/src/auth.ts). */
  passwordHash: text('password_hash').notNull(),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
});

/** Login sessions. Only a SHA-256 of the cookie token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Voice notes and photos. Stored in the database so every server instance can read them. */
export const media = pgTable('media', {
  /** "<uuid>.<ext>", also the public file name under /media/. */
  id: text('id').primaryKey(),
  mime: text('mime').notNull(),
  data: bytea('data').notNull(),
  /** Stored transcript (eval dataset, bundled samples); used when no speech or vision provider is set. */
  sidecarText: text('sidecar_text'),
  createdAt: text('created_at').notNull().default(now),
});

/** Outbox for the live console (SSE). Any instance writes, any instance streams. Pruned on the go. */
export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  ts: text('ts').notNull().default(now),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
});

/** Fixed-window counters for rate limits. */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  resetAt: bigint('reset_at', { mode: 'number' }).notNull(),
});

/** One agent run at a time per conversation, across server instances (a lease, not a held lock). */
export const conversationLocks = pgTable('conversation_locks', {
  waId: text('wa_id').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

/** Evaluation reports uploaded by `pnpm eval -- --publish`. */
export const evalReports = pgTable('eval_reports', {
  id: serial('id').primaryKey(),
  ranAt: text('ran_at').notNull(),
  report: jsonb('report').$type<Record<string, unknown>>().notNull(),
});
