// Response shapes of the SALURA API (apps/api/src/app.ts).

export type OrderStatus = 'draft' | 'awaiting_customer' | 'awaiting_approval' | 'confirmed' | 'rejected' | 'cancelled';
export type ApprovalType = 'order' | 'credit_override' | 'reminder' | 'escalation' | 'reorder' | 'delivery_query' | 'invoice_adjustment' | 'payment';

export interface OrderLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
  rawText: string | null;
  substitutedFromProductId: number | null;
}

export interface Order {
  orderId: number;
  customerId: number;
  status: OrderStatus;
  lines: OrderLine[];
  subtotal: number;
  deliveryNote: string | null;
  splitFromOrderId: number | null;
  customer?: { name: string; waId: string };
  channel?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Placed in a guest account's test chat: approving it reserves no stock and raises no invoice. */
  guest?: boolean;
}

export interface Credit {
  creditLimit: number;
  unpaid: number;
  available: number;
  overdueAmount: number;
  oldestOverdueDays: number;
}

export interface Approval {
  id: number;
  type: ApprovalType;
  status: 'pending' | 'approved' | 'rejected';
  orderId: number | null;
  customerId: number;
  reason: string;
  payload: Record<string, unknown> | null;
  runId: string | null;
  /** Queued from a guest account's test chat (sent by the approvals list). */
  guest?: boolean;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  customer: { id: number; name: string; waId: string; tier: string } | null;
  order: Order | null;
  credit: Credit | null;
  /** Pending order approvals only: what is in stock now, per line (held orders do not reserve stock). */
  stock: { productId: number; unit: string; available: string; enough: boolean }[] | null;
}

export interface Conversation {
  waId: string;
  customerId: number;
  name: string;
  ownerName: string;
  honorific: string;
  area: string;
  tier: string;
  lastMessage: { text: string; direction: 'in' | 'out'; at: string; kind: string } | null;
}

export interface Message {
  id: number;
  waId: string;
  direction: 'in' | 'out';
  channel: string;
  kind: 'text' | 'voice' | 'image';
  text: string | null;
  transcript: string | null;
  mediaUrl: string | null;
  runId: string | null;
  /** Typed by, or answered to, a guest account; the customer's own runs never see it. */
  guest?: boolean;
  createdAt: string;
}

export type AuditType = 'message_in' | 'message_out' | 'thought' | 'tool_call' | 'tool_result' | 'validation' | 'approval' | 'error' | 'data_change';

export interface AuditEntry {
  id: number;
  runId: string | null;
  ts: string;
  actor: 'agent' | 'system' | 'human' | 'customer';
  type: AuditType;
  tool: string | null;
  summary: string;
  data: unknown;
  confidence: number | null;
  durationMs: number | null;
}

export interface AgentRun {
  id: string;
  trigger: 'message' | 'schedule' | 'approval' | 'eval';
  goal: string;
  waId: string | null;
  customerId: number | null;
  status: 'running' | 'completed' | 'escalated' | 'failed';
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Profile {
  customer: { id: number; name: string; ownerName: string; honorific: string; waId: string; tier: string; creditLimit: number; paymentTermDays: number; area: string; address: string };
  credit: Credit;
  usualOrder: { productId: number; sku: string; name: string; qty: number; unit: string; timesOrdered: number }[];
  lastOrderAt: string | null;
}

export interface DashboardData {
  metrics: {
    ordersHandled: number;
    straightThrough: number;
    straightThroughRate: number | null;
    pendingApprovals: number;
    overdue: { amount: number; invoices: number; customers: number };
    minutesSaved: number;
    manualMinutesPerOrder: number;
    errorsCaught: { total: number; outOfStock: number; overCredit: number; ambiguous: number; blockedActions: number };
    costPerOrderUsd: number | null;
    avgRunSeconds: number | null;
    ordersPerDay: { date: string; count: number }[];
  };
  recentOrders: (Order & { customer: { id: number; name: string; waId: string }; updatedAt: string })[];
  oldestPendingApproval: (Approval & { customerName: string | null }) | null;
  evaluation: { ranAt: string; cases: number; accuracy: number | null; passK: number; k: number } | null;
}

export interface OverdueInvoice {
  invoiceId: number;
  number: string;
  customerId: number;
  customerName: string;
  ownerName: string;
  preferredTone: string;
  outstanding: number;
  dueAt: string;
  daysOverdue: number;
  promiseToPayAt: string | null;
  lastReminderDaysAgo: number | null;
  remindersSent: number;
}

export interface AutonomyPolicy {
  action: 'confirm_order' | 'over_credit_order' | 'send_reminder' | 'send_reorder_nudge';
  mode: 'suggest' | 'auto' | 'approve';
  maxAutoAmount: number | null;
}

export interface EvalReport {
  ranAt: string;
  model: string;
  k: number;
  summary: {
    cases: number;
    k: number;
    passRate: number;
    passK: number;
    itemAccuracy: number | null;
    avgSecondsPerTurn: number;
    avgCostPerCaseUsd: number | null;
    byCategory: Record<string, { cases: number; passRate: number; passK: number }>;
  };
  cases: {
    id: string;
    category: string;
    turns: string[];
    passes: number;
    attempts: number;
    passAllK: boolean;
    runs: { attempt: number; grade: { pass: boolean; checks: { name: string; ok: boolean; detail?: string }[] }; replies: string[]; seconds: number }[];
  }[];
}

export type LiveEvent =
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'message'; message: Message & { mediaPath?: string | null } }
  | { type: 'run'; run: AgentRun }
  | { type: 'approval'; approvalId: number }
  | { type: 'order'; orderId: number }
  | { type: 'reset' };

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'viewer';
}

export interface Payment {
  id: number;
  customerId: number;
  messageId: number | null;
  amount: number;
  paidOn: string | null;
  bank: string | null;
  reference: string | null;
  senderName: string | null;
  allocations: { invoiceId: number; number: string; amount: number }[];
  status: 'pending' | 'approved' | 'rejected';
  /** Reported in a guest account's test chat: approving it settles no invoice. */
  guest?: boolean;
  createdAt: string;
  decidedAt: string | null;
  customer: { id: number; name: string; waId: string };
}

/** Money a customer paid beyond what they owe: a corrected invoice, or a transfer larger than the bills it settled. */
export interface Overpayment {
  source: 'invoice_correction' | 'payment';
  id: number;
  reference: string;
  amount: number;
  customer: { id: number; name: string; waId: string };
}

export interface PickBatch {
  date: string | null;
  area: string;
  orders: { orderId: number; customer: string; address: string; confirmedAt: string | null; subtotal: number; deliveryNote: string | null; lines: { name: string; qty: number; unit: string }[] }[];
  lines: { productId: number; sku: string; name: string; baseQty: number; quantity: string; orders: number }[];
}

export type ImportDataset = 'produk' | 'satuan' | 'harga' | 'stok' | 'pelanggan';

export interface ImportPreview {
  dataset: ImportDataset;
  rows: number;
  inserts: number;
  updates: number;
  errors: { row: number; message: string }[];
  sample: Record<string, unknown>[];
}

/** One proposed match for a bank statement line, with the rules that produced it. */
export interface BankMatchCandidate {
  id: string;
  kind: 'chat_payment' | 'recorded_payment' | 'invoices';
  score: number;
  customer: { id: number; name: string; waId: string };
  allocations: { invoiceId: number; number: string; amount: number }[];
  unallocated: number;
  paymentId: number | null;
  approvalId: number | null;
  reasons: string[];
  notes: string[];
}

export interface BankLine {
  hash: string;
  row: number;
  postedOn: string;
  description: string;
  amount: number;
  status: 'confident' | 'review' | 'none' | 'recorded';
  candidates: BankMatchCandidate[];
  recorded: { status: 'matched' | 'ignored'; paymentId: number | null; customerName: string | null; decidedBy: string; at: string } | null;
}

export interface BankPreview {
  lines: BankLine[];
  /** The first 200 unreadable rows; `errorCount` counts them all. */
  errors: { row: number; message: string }[];
  errorCount: number;
  debitRows: number;
  pendingRows: number;
  warnings: string[];
}

export interface BankApplied {
  hash: string;
  row: number;
  amount: number;
  outcome: 'payment_recorded' | 'chat_payment_approved' | 'linked' | 'ignored' | 'already_recorded';
  customer: { id: number; name: string; waId: string } | null;
  unallocated: number;
}
