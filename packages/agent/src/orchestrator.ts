import { randomUUID } from 'node:crypto';
import { count, eq } from '@salura/db/orm';
import { agentRuns, approvals, type Db } from '@salura/db';
import { Audit } from './audit.ts';
import type { Customer } from './domain/customers.ts';
import { DomainError } from './domain/orders.ts';
import type { EventBus } from './events.ts';
import { LlmError, type ChatMessage, type ModelClient, type ToolCall } from './llm/types.ts';
import { rupiah } from './domain/money.ts';
import type { SpeechToText } from './stt.ts';
import { toolSpec, ToolUsageError, type GuestSession, type ToolContext, type ToolDef } from './tools/types.ts';
import type { VisionReader } from './vision.ts';

export interface AgentDeps {
  db: Db;
  bus: EventBus;
  model: ModelClient;
  stt: SpeechToText;
  vision: VisionReader;
  clock: () => Date;
  /** Wall-clock budget for one run (default 90 s). */
  runDeadlineMs?: number;
  /** USD per 1M tokens; null when unknown, then cost is not reported. */
  pricing: { inputPerM: number; outputPerM: number } | null;
}

export interface RunInput {
  /** Pre-assigned id, so the caller can log the triggering message under the same run. */
  runId?: string;
  trigger: 'message' | 'schedule' | 'approval' | 'eval' | 'delivery';
  goal: string;
  waId: string | null;
  channel: string;
  customer: Customer | null;
  systemPrompt: string;
  history: ChatMessage[];
  tools: ToolDef[];
  allowedMessageIds?: Set<number>;
  maxSteps?: number;
  /** Lets tools message a customer directly (auto-sent reminders). */
  sendMessage?: (waId: string, text: string) => Promise<void>;
  conversationBusy?: (waId: string) => Promise<boolean>;
  deliveryCheckId?: number;
  /** A guest account typing as the customer: every change waits for an admin (see GuestSession). */
  guest?: GuestSession;
  /** Reply used when the run cannot finish (model down, step limit, repeated tool failure). */
  fallbackReply: string;
}

export interface RunResult {
  runId: string;
  status: 'completed' | 'escalated' | 'failed';
  reply: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const DEFAULT_MAX_STEPS = 12;
/** Whole-run budget: a customer waiting longer than this gets the fallback reply and a human. */
export const DEFAULT_RUN_DEADLINE_MS = 90_000;

function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const left = deadline - Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmError('Model tidak menjawab sebelum batas waktu run', false)), Math.max(0, left));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
/** A tool that fails this many times with an unexpected error in one run triggers escalation. */
const MAX_TOOL_FAILURES = 2;
/** Tools that return what the customer said or wrote; their numbers never back a quoted amount. */
const CUSTOMER_CONTENT_TOOLS = new Set(['transcribe_audio', 'read_order_image', 'read_delivery_document']);
/** Result fields that carry text copied from a customer's photo or message, wherever they appear. */
const CUSTOMER_TEXT_KEYS = new Set(['rawText', 'documentText', 'transcript', 'documentNumber']);

/**
 * Planner/executor loop: the model plans and picks tools, the runtime validates arguments,
 * executes, logs every step to the audit trail, and feeds results back until the model replies.
 */
export async function runAgent(deps: AgentDeps, input: RunInput): Promise<RunResult> {
  const runId = input.runId ?? randomUUID();
  const audit = new Audit(deps.db, deps.bus, deps.clock, runId);
  const [run] = await deps.db
    .insert(agentRuns)
    .values({ id: runId, trigger: input.trigger, goal: input.goal, waId: input.waId, customerId: input.customer?.id ?? null, status: 'running', guest: Boolean(input.guest), startedAt: deps.clock().toISOString() })
    .returning();
  await deps.bus.emit({ type: 'run', run: run! });

  const toolsByName = new Map(input.tools.map((t) => [t.name, t]));
  const specs = input.tools.map(toolSpec);
  const ctx: ToolContext = {
    db: deps.db,
    now: deps.clock,
    runId,
    audit,
    stt: deps.stt,
    vision: deps.vision,
    waId: input.waId,
    channel: input.channel,
    customer: input.customer,
    allowedMessageIds: input.allowedMessageIds ?? new Set(),
    sendMessage: input.sendMessage,
    conversationBusy: input.conversationBusy,
    deliveryCheckId: input.deliveryCheckId,
    guest: input.guest,
  };

  const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt }, ...input.history];
  const failures = new Map<string, number>();
  const toolResultNumbers = new Set<number>();
  let usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;
  let priceGuardTripped = false;
  let outcome: { status: RunResult['status']; reply: string; error?: string } | null = null;

  const escalate = async (reason: string) => {
    // A guest past their allowance does not add to the queue; the trace still shows what happened.
    if (!input.guest || (await input.guest.reserveApproval())) {
      await deps.db
        .insert(approvals)
        .values({ type: 'escalation', customerId: input.customer?.id ?? 0, reason, payload: { waId: input.waId }, runId, requestedAt: deps.clock().toISOString() });
    }
    await audit.log({ actor: 'system', type: 'error', summary: `Dialihkan ke admin: ${reason}` });
  };

  const deadline = Date.now() + (deps.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS);
  try {
    while (!outcome) {
      if (steps >= (input.maxSteps ?? DEFAULT_MAX_STEPS)) {
        await escalate(`Batas ${steps} langkah tercapai sebelum selesai`);
        outcome = { status: 'escalated', reply: input.fallbackReply };
        break;
      }
      if (Date.now() >= deadline) {
        await escalate(`Batas waktu ${Math.round((deps.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS) / 1000)} detik tercapai sebelum selesai`);
        outcome = { status: 'escalated', reply: input.fallbackReply };
        break;
      }
      steps++;
      const started = Date.now();
      const response = await withDeadline(deps.model.complete({ messages, tools: specs }), deadline);
      usage = { inputTokens: usage.inputTokens + response.usage.inputTokens, outputTokens: usage.outputTokens + response.usage.outputTokens };
      if (response.thought) await audit.log({ actor: 'agent', type: 'thought', summary: response.thought, durationMs: Date.now() - started });

      if (!response.toolCalls.length) {
        const reply = response.content.trim();
        if (!reply) {
          messages.push({ role: 'assistant', content: '' }, { role: 'user', content: '[runtime] Your reply was empty. Write the message for the customer.' });
          continue;
        }
        const unknownAmounts = amountsNotFromTools(reply, toolResultNumbers);
        if (unknownAmounts.length) {
          await audit.log({
            actor: 'system',
            type: 'validation',
            summary: `Balasan ditahan: menyebut ${unknownAmounts.map(rupiah).join(', ')} yang tidak berasal dari hasil tool mana pun`,
            data: { reply, unknownAmounts },
          });
          if (!priceGuardTripped) {
            priceGuardTripped = true;
            messages.push(
              { role: 'assistant', content: reply },
              { role: 'user', content: `[runtime] Not sent. Your reply mentions ${unknownAmounts.map((n) => `Rp${n}`).join(', ')}, which did not come from any tool result. Rewrite using only figures returned by tools.` },
            );
            continue;
          }
          await escalate('Agen berulang kali menyebut nominal yang tidak didukung hasil tool');
          outcome = { status: 'escalated', reply: input.fallbackReply };
          break;
        }
        outcome = { status: 'completed', reply };
        break;
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
      for (const call of response.toolCalls) {
        // Slow tools (speech-to-text, photo reading) count against the run's time budget too.
        const result = await withDeadline(executeTool(call, toolsByName, ctx, audit, failures), deadline);
        if (!CUSTOMER_CONTENT_TOOLS.has(call.name)) collectNumbers(result, toolResultNumbers);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
      }
      const exhausted = [...failures.entries()].find(([, n]) => n >= MAX_TOOL_FAILURES);
      if (exhausted) {
        await escalate(`Tool ${exhausted[0]} gagal ${exhausted[1]} kali`);
        outcome = { status: 'escalated', reply: input.fallbackReply };
      }
    }
  } catch (err) {
    const message = err instanceof LlmError ? err.message : `Unexpected error: ${(err as Error).message}`;
    const summary = err instanceof LlmError ? `Model AI gagal merespons: ${err.message}` : `Galat tak terduga: ${(err as Error).message}`;
    // Logging the failure must not hide it: if the database itself is down, give up quietly here.
    await audit.log({ actor: 'system', type: 'error', summary }).catch(() => undefined);
    await escalate(`Run agen gagal. ${summary}`).catch(() => undefined);
    outcome = { status: 'failed', reply: input.fallbackReply, error: message };
  }

  const costUsd = deps.pricing
    ? (usage.inputTokens * deps.pricing.inputPerM + usage.outputTokens * deps.pricing.outputPerM) / 1_000_000
    : null;
  const [finished] = await deps.db
    .update(agentRuns)
    .set({ status: outcome.status, steps, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd, error: outcome.error ?? null, endedAt: deps.clock().toISOString() })
    .where(eq(agentRuns.id, runId))
    .returning();
  // The row is gone if the demo was reset mid-run; there is nothing left to report then.
  if (finished) await deps.bus.emit({ type: 'run', run: finished });

  return { runId, status: outcome.status, reply: outcome.reply, steps, ...usage, costUsd };
}

type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

async function executeTool(
  call: ToolCall,
  tools: Map<string, ToolDef>,
  ctx: ToolContext,
  audit: Audit,
  failures: Map<string, number>,
): Promise<ToolOutcome> {
  const tool = tools.get(call.name);
  await audit.log({ actor: 'agent', type: 'tool_call', tool: call.name, summary: `Memanggil ${call.name}`, data: call.arguments ?? call.rawArguments });

  // `message` goes back to the model (English); `summary` is what the ops console shows (Bahasa).
  const fail = async (code: string, message: string, summary: string, details?: unknown, countsAsFailure = false): Promise<ToolOutcome> => {
    if (countsAsFailure) failures.set(call.name, (failures.get(call.name) ?? 0) + 1);
    await audit.log({ actor: 'system', type: code === 'rule' ? 'validation' : 'error', tool: call.name, summary, data: details });
    return { ok: false, error: { code, message, details } };
  };

  if (!tool) return fail('unknown_tool', `There is no tool named "${call.name}". Available: ${[...tools.keys()].join(', ')}`, `Tool "${call.name}" tidak ada`);
  if (call.arguments === undefined) {
    return fail('invalid_json', `Arguments for ${call.name} were not valid JSON: ${call.rawArguments.slice(0, 200)}`, `Argumen ${call.name} bukan JSON yang valid`, call.rawArguments.slice(0, 200), true);
  }

  const parsed = tool.schema.safeParse(call.arguments);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return fail('invalid_arguments', `Invalid arguments for ${call.name}`, `Argumen ${call.name} ditolak validasi skema`, issues);
  }

  const started = Date.now();
  try {
    // A guest's allowance counts approvals actually queued, not refusals or outcomes that queue nothing:
    // one is reserved before the tool runs and the count is corrected to what it really queued.
    const guest = tool.queuesApproval ? ctx.guest : undefined;
    if (guest && !(await guest.reserveApproval())) {
      throw new DomainError('guest_limit', 'This guest test account has used up its approval requests for this hour, so nothing was queued. Tell the customer it cannot be passed to the admin right now and to try again later.');
    }
    const queuedBefore = guest ? await runApprovalCount(ctx) : 0;
    let result: unknown;
    try {
      result = await tool.run(ctx, parsed.data);
    } finally {
      if (guest) {
        const queued = (await runApprovalCount(ctx)) - queuedBefore;
        if (queued !== 1) await guest.adjustApprovals(queued - 1);
      }
    }
    const summary = tool.summarize ? safeSummary(() => tool.summarize!(parsed.data, result)) : `${call.name} selesai`;
    await audit.log({ actor: 'agent', type: 'tool_result', tool: call.name, summary, data: result, durationMs: Date.now() - started });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof DomainError) {
      // A business rule refused the action. This is the guardrail working, not a failure.
      await audit.log({ actor: 'system', type: 'validation', tool: call.name, summary: `Ditolak aturan (${err.code}): ${refusalText(err)}`, data: err.details, durationMs: Date.now() - started });
      return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
    }
    if (err instanceof ToolUsageError) return fail(err.code, err.message, `${call.name} ditolak (${err.code}): ${refusalText(err)}`);
    return fail('tool_failed', `${call.name} failed: ${(err as Error).message}`, `${call.name} gagal: ${(err as Error).message}`, undefined, true);
  }
}

async function runApprovalCount(ctx: ToolContext): Promise<number> {
  const [row] = await ctx.db.select({ n: count() }).from(approvals).where(eq(approvals.runId, ctx.runId));
  return row?.n ?? 0;
}

/** Bahasa wording for refusals shown in the console. Unlisted codes fall back to the model-facing message. */
const REFUSAL_TEXT: Record<string, string> = {
  needs_customer_confirmation: 'pelanggan belum membalas ringkasan pesanan terbaru',
  out_of_stock: 'stok tidak cukup',
  invalid_lines: 'ada baris pesanan yang tidak valid',
  empty_order: 'pesanan tanpa baris',
  invalid_status: 'status pesanan tidak memungkinkan aksi ini',
  not_over_credit: 'pesanan masih muat di limit kredit',
  cannot_split: 'sisa kredit tidak cukup untuk satu unit pun',
  order_not_found: 'pesanan tidak ditemukan untuk pelanggan ini',
  customer_not_found: 'pelanggan tidak ditemukan',
  not_overdue: 'tagihan tidak terbuka atau belum jatuh tempo',
  too_soon: 'pengingat terakhir kurang dari 3 hari lalu',
  promise_pending: 'tanggal janji bayar pelanggan belum lewat',
  invoice_not_found: 'tagihan terbuka tidak ditemukan',
  invalid_date: 'tanggal tidak valid',
  date_in_past: 'tanggal sudah lewat',
  date_in_future: 'tanggal transfer di masa depan',
  invalid_amount: 'nominal pembayaran tidak valid',
  duplicate_payment: 'bukti bayar ini sudah pernah tercatat',
  comparison_stale: 'tagihan berubah sejak dibandingkan; bandingkan ulang',
  no_open_invoices: 'pelanggan tidak punya tagihan terbuka',
  no_delivery_order: 'pelanggan belum punya pesanan yang sudah dikirim',
  no_check: 'belum ada cek pengiriman yang dibuka',
  check_open: 'cek pengiriman sudah dibuka di run ini',
  wrong_check: 'cek pengiriman lain dari yang sedang dikerjakan',
  unknown_customer: 'nomor ini bukan pelanggan terdaftar',
  unknown_message: 'pesan bukan bagian dari percakapan ini',
  not_voice: 'pesan ini bukan pesan suara',
  not_image: 'pesan ini bukan foto',
  overdue_hold: 'ada tagihan terlambat lebih dari 14 hari, pesanan harus ditahan utuh',
  promise_too_far: 'janji bayar lebih dari 30 hari, perlu keputusan pemilik',
  customer_busy: 'agen sedang melayani pelanggan ini, dilewati dulu',
  reorder_stale: 'tawaran sudah tidak berlaku',
  no_pattern: 'pelanggan belum punya pola belanja tetap',
  not_due: 'pelanggan belum waktunya ditawari',
  all_out_of_stock: 'semua barang pesanan biasanya sedang habis',
  guest_limit: 'akun tamu sudah mencapai batas permintaan persetujuan per jam',
  guest_no_split: 'di chat uji akun tamu pesanan ditahan utuh, tidak dipecah',
  not_shipped: 'pesanan belum dikirim dari gudang',
};

function refusalText(err: { code: string; message: string }): string {
  return REFUSAL_TEXT[err.code] ?? err.message;
}

function safeSummary(fn: () => string): string {
  try {
    return fn();
  } catch {
    return 'selesai';
  }
}

/** Result fields that hold money; other numbers (stock counts, ids, days) are never evidence for a price. */
const MONEY_FIELDS = new Set([
  'unitPrice',
  'lineTotal',
  'subtotal',
  'available',
  'availableCredit',
  'unpaid',
  'outstanding',
  'overdueAmount',
  'shortfall',
  'creditLimit',
  'amount',
  // record_payment
  'outstandingBefore',
  'outstandingAfter',
  'unallocated',
  // compare_delivery
  'orderedValue',
  'deliveredValue',
  'invoiceAmount',
  'overbilled',
  'shortfallValue',
  // propose_invoice_adjustment (specific names: a bare from/to in another result is not money)
  'invoiceFrom',
  'invoiceTo',
  'credit',
  'overpaid',
]);

/** Money in a tool result: numeric money fields, plus "Rp…" amounts inside text (policies, reasons, templates). */
function collectNumbers(value: unknown, into: Set<number>, key?: string): void {
  if (key && CUSTOMER_TEXT_KEYS.has(key)) return;
  if (typeof value === 'number') {
    if (key && MONEY_FIELDS.has(key)) into.add(Math.round(value));
  } else if (typeof value === 'string') {
    for (const a of parseRupiahAmounts(value)) into.add(a.value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into, key);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectNumbers(v, into, k);
  }
}

export interface ParsedAmount {
  value: number;
  /** How far a written amount may be from the real one and still be the same number rounded (e.g. "Rp2,03 jt"). */
  tolerance: number;
}

const SCALE: Record<string, number> = { rb: 1_000, ribu: 1_000, k: 1_000, jt: 1_000_000, juta: 1_000_000 };

/**
 * Amounts as Indonesians write them on WhatsApp: "Rp118.000", "118.000", "Rp 118000",
 * "245rb", "245 ribu", "Rp1,2 jt", "2 juta".
 */
export function parseRupiahAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => taken.every(([a, b]) => end <= a || start >= b);
  for (const m of text.matchAll(/(?:Rp\.?\s?)?(\d+(?:[.,]\d+)?)\s?(rb|ribu|k|jt|juta)\b/gi)) {
    const [whole = '0', frac = ''] = m[1]!.split(/[.,]/);
    const scale = SCALE[m[2]!.toLowerCase()]!;
    const value = Math.round(Number(`${whole}.${frac || 0}`) * scale);
    // Rounding to the written precision, but never looser than 3% ("1 jt" is not "Rp1.450.000").
    out.push({ value, tolerance: Math.min(scale / 10 ** frac.length / 2, value * 0.03) });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(/Rp\.?\s?(\d{1,3}(?:[.,]\d{3})+|\d+)|\b(\d{1,3}(?:\.\d{3})+)\b(?!\s*(?:pcs|dus|karton|kg|gram|g|liter|l|ml|botol|bungkus|bks|renceng|karung|pak|biji|kaleng))/gi)) {
    if (!free(m.index!, m.index! + m[0].length)) continue;
    out.push({ value: Number((m[1] ?? m[2])!.replace(/[.,]/g, '')), tolerance: 0 });
  }
  return out;
}

/** Amounts in a reply that no tool returned (rounded shorthand allowed). Small amounts (< Rp1.000) are ignored. */
export function amountsNotFromTools(reply: string, known: Set<number>): number[] {
  const knownList = [...known];
  return parseRupiahAmounts(reply)
    .filter((a) => a.value >= 1000)
    .filter((a) => !(known.has(a.value) || (a.tolerance > 0 && knownList.some((k) => Math.abs(k - a.value) <= a.tolerance))))
    .map((a) => a.value);
}
