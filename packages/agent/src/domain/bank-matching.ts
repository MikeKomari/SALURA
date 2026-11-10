import { createHash } from 'node:crypto';
import { and, between, eq, inArray, isNull, sql } from '@salura/db/orm';
import { approvals, bankStatementLines, customers, first, invoices, payments, type Db, type Q } from '@salura/db';
import { rupiah } from './money.ts';
import { DomainError } from './orders.ts';
import { allocate, decidePayment, recordBankPayment, type Allocation } from './payments.ts';

// Bank statement (mutasi rekening) matching. Each credit line on the statement is compared with the
// open invoices and the payments customers already reported, using fixed rules with fixed weights,
// so the same statement always gives the same proposals and every proposal says why. Nothing is
// written until the owner confirms; a confirmed line is stored by its hash and never applied twice.

/** A credit (money in) line read from the statement. */
export interface StatementLine {
  /** Row in the uploaded file, for messages. */
  row: number;
  /** Booking date, YYYY-MM-DD. */
  postedOn: string;
  description: string;
  /** Whole rupiah, > 0. */
  amount: number;
}

export type MatchKind = 'chat_payment' | 'recorded_payment' | 'invoices';

export interface MatchCandidate {
  /** Stable for the same data: "chat:<paymentId>", "paid:<paymentId>" or "inv:<customerId>". */
  id: string;
  kind: MatchKind;
  /** 0–100, from the rules below. */
  score: number;
  customer: { id: number; name: string; waId: string };
  /** How the money would be applied to the invoices as they are now. */
  allocations: Allocation[];
  /** Left over after every open invoice is paid: an overpayment. */
  unallocated: number;
  /** The reported payment this line confirms (chat_payment, recorded_payment). */
  paymentId: number | null;
  approvalId: number | null;
  /** Why this candidate, one rule per line, shown to the owner. */
  reasons: string[];
  /** What the owner should know before choosing it: an overpayment, a partial payment. */
  notes: string[];
}

export type LineStatus = 'confident' | 'review' | 'none' | 'recorded';

export interface LinePreview extends StatementLine {
  hash: string;
  status: LineStatus;
  /** Best first. */
  candidates: MatchCandidate[];
  /** Set when this line was already confirmed or set aside in an earlier upload. */
  recorded: { status: 'matched' | 'ignored'; paymentId: number | null; customerName: string | null; decidedBy: string; at: string } | null;
}

/** The owner's choice for one line: a candidate id, or null to set the line aside for good. */
export interface MatchSelection {
  hash: string;
  candidateId: string | null;
}

export interface AppliedLine {
  hash: string;
  row: number;
  postedOn: string;
  amount: number;
  outcome: 'payment_recorded' | 'chat_payment_approved' | 'linked' | 'ignored' | 'already_recorded';
  customer: { id: number; name: string; waId: string } | null;
  paymentId: number | null;
  approvalId: number | null;
  allocations: Allocation[];
  unallocated: number;
}

/** Rule weights. A match is confident at 70 with a clear lead of 25 over the next candidate. */
const WEIGHT = {
  invoiceNumber: 50,
  exactInvoice: 45,
  invoiceSum: 40,
  ownerName: 30,
  similarName: 20,
  phone: 30,
  chatPayment: 50,
  chatReference: 30,
  recordedPayment: 40,
  sameDate: 10,
} as const;
const CONFIDENT = 70;
const CLEAR_LEAD = 25;
/** Below this a candidate is not shown (one similar word alone is not evidence). */
const MIN_SCORE = 30;
const MAX_CANDIDATES = 4;
/** A reported transfer and a statement line this many days apart can still be the same transfer. */
const DATE_WINDOW_DAYS = 3;
/** Two exports of one account can book the same transfer a day apart (cut-off, time zone). */
const SAME_TRANSFER_DAYS = 1;
/** Sums of several invoices are only searched for customers with at most this many open invoices. */
const MAX_SUM_INVOICES = 12;
/** Words in store names that say nothing about who paid. */
const GENERIC = new Set(['WARUNG', 'TOKO', 'AGEN', 'MINIMARKET', 'KELONTONG', 'SEMBAKO', 'KOPI', 'MADURA', 'IBU', 'BAPAK', 'PAK', 'MAS', 'MBAK']);

/**
 * One hash per line: date, amount and description, plus how often that same line already appeared
 * earlier in the file, so two identical transfers on one day are two lines while uploading the same
 * statement again gives the same hashes.
 */
export function lineHashes(lines: StatementLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = `${l.postedOn}|${l.amount}|${l.description.toUpperCase().replace(/\s+/g, ' ').trim()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return createHash('sha256').update(`${key}|${n}`).digest('hex');
  });
}

interface Description {
  words: Set<string>;
  /** Letters and digits only, for reference numbers. */
  compact: string;
  /** Digit runs of 9+ (phone numbers), with spaces, dots and dashes inside them removed. */
  numbers: string[];
  invoiceNumbers: Set<string>;
}

function readDescription(text: string): Description {
  const upper = text.toUpperCase();
  return {
    words: new Set(upper.split(/[^A-Z0-9]+/).filter(Boolean)),
    compact: upper.replace(/[^A-Z0-9]/g, ''),
    numbers: upper.replace(/(?<=\d)[\s.-](?=\d)/g, '').match(/\d{9,15}/g) ?? [],
    // INV-00003, INV 3, inv00003
    invoiceNumbers: new Set([...upper.matchAll(/\bINV[\s\-_./]*0*(\d{1,7})\b/g)].map((m) => `INV-${m[1]!.padStart(5, '0')}`)),
  };
}

const nameWords = (name: string) => name.toUpperCase().split(/[^A-Z]+/).filter(Boolean);

/** Who the description points at: the owner's full name, a distinctive word of the name, or the WhatsApp number. */
function customerSignals(c: typeof customers.$inferSelect, d: Description): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const owner = nameWords(c.ownerName).filter((w) => w.length >= 3);
  if (owner.length >= 2 && owner.every((w) => d.words.has(w))) {
    score += WEIGHT.ownerName;
    reasons.push(`Nama pemilik ${c.ownerName} ada di keterangan`);
  } else {
    const word = [...owner, ...nameWords(c.name)].find((w) => w.length >= 4 && !GENERIC.has(w) && d.words.has(w));
    if (word) {
      score += WEIGHT.similarName;
      reasons.push(`Kata "${word}" di keterangan mirip nama ${c.name}`);
    }
  }
  const local = c.waId.replace(/^62/, '');
  if (d.numbers.some((n) => n.endsWith(local) && n.length - local.length <= 2)) {
    score += WEIGHT.phone;
    reasons.push(`Nomor WhatsApp ${c.name} ada di keterangan`);
  }
  return { score, reasons };
}

const outstanding = (i: typeof invoices.$inferSelect) => i.amount - i.paidAmount;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const shiftDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Every amount two or more of a customer's open invoices add up to, with the fewest invoices that
 * do (oldest first on a tie). Built once per customer per check, not once per statement line.
 */
function invoiceSums(open: (typeof invoices.$inferSelect)[]): Map<number, (typeof invoices.$inferSelect)[]> {
  const best = new Map<number, number>();
  if (open.length < 2 || open.length > MAX_SUM_INVOICES) return new Map();
  const sum = new Array<number>(1 << open.length).fill(0);
  const size = new Array<number>(1 << open.length).fill(0);
  for (let mask = 1; mask < 1 << open.length; mask++) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low]! + outstanding(open[31 - Math.clz32(low)]!);
    size[mask] = size[mask ^ low]! + 1;
    const seen = best.get(sum[mask]!);
    if (size[mask]! >= 2 && (seen === undefined || size[seen]! > size[mask]!)) best.set(sum[mask]!, mask);
  }
  return new Map([...best].map(([total, mask]) => [total, open.filter((_, i) => mask & (1 << i))]));
}

/** Proposes matches for every line. Reads only. */
export async function matchStatement(db: Q, lines: StatementLine[]): Promise<LinePreview[]> {
  if (!lines.length) return [];
  const hashes = lineHashes(lines);
  const days = lines.map((l) => l.postedOn).sort();
  const [firstDay, lastDay] = [days[0]!, days.at(-1)!];
  const recorded = hashes.length
    ? await db
        .select({ line: bankStatementLines, customerName: customers.name })
        .from(bankStatementLines)
        .leftJoin(payments, eq(payments.id, bankStatementLines.paymentId))
        .leftJoin(customers, eq(customers.id, payments.customerId))
        .where(inArray(bankStatementLines.lineHash, [...new Set(hashes)]))
    : [];
  const recordedByHash = new Map(recorded.map((r) => [r.line.lineHash, r]));
  const allCustomers = await db.select().from(customers).orderBy(customers.id);
  const openInvoices = await db.select().from(invoices).where(eq(invoices.status, 'open')).orderBy(invoices.dueAt, invoices.id);
  const pendingApprovals = await db.select().from(approvals).where(and(eq(approvals.type, 'payment'), eq(approvals.status, 'pending')));
  const approvalOf = new Map(pendingApprovals.map((a) => [Number((a.payload as { paymentId?: number } | null)?.paymentId), a.id]));
  // Claims from a guest's test chat are never real money, so a statement line is never matched to one.
  const pending = (await db.select().from(payments).where(and(eq(payments.status, 'pending'), eq(payments.guest, false)))).filter((p) => approvalOf.has(p.id));
  // Approved payments no statement line confirmed yet (approved from the chat after checking the bank by hand).
  const unconfirmed = (
    await db
      .select({ payment: payments })
      .from(payments)
      .leftJoin(bankStatementLines, eq(bankStatementLines.paymentId, payments.id))
      .where(
        and(
          eq(payments.status, 'approved'),
          eq(payments.guest, false),
          isNull(bankStatementLines.id),
          // Only those within the date window of some line; the rest can never match.
          between(sql`coalesce(${payments.paidOn}, substr(${payments.createdAt}, 1, 10))`, shiftDays(firstDay, -DATE_WINDOW_DAYS), shiftDays(lastDay, DATE_WINDOW_DAYS)),
        ),
      )
  ).map((r) => r.payment);
  // Lines matched from another export of the same account (other wording, so another hash) within a
  // day, same amount; lines of this file already recorded are accounted for by their own hash.
  const matchedNearby = (
    await db
      .select({ line: bankStatementLines, customerId: payments.customerId })
      .from(bankStatementLines)
      .innerJoin(payments, eq(payments.id, bankStatementLines.paymentId))
      .where(
        and(
          eq(bankStatementLines.status, 'matched'),
          inArray(bankStatementLines.amount, [...new Set(lines.map((l) => l.amount))]),
          between(bankStatementLines.postedOn, shiftDays(firstDay, -SAME_TRANSFER_DAYS), shiftDays(lastDay, SAME_TRANSFER_DAYS)),
        ),
      )
  ).filter((r) => !hashes.includes(r.line.lineHash));
  const customerById = new Map(allCustomers.map((c) => [c.id, c]));
  const openOf = (customerId: number) => openInvoices.filter((i) => i.customerId === customerId && outstanding(i) > 0);
  const who = (c: typeof customers.$inferSelect) => ({ id: c.id, name: c.name, waId: c.waId });
  const sumsOf = new Map<number, ReturnType<typeof invoiceSums>>();

  return lines.map((line, index) => {
    const hash = hashes[index]!;
    const done = recordedByHash.get(hash);
    if (done) {
      const r = done.line;
      return { ...line, hash, status: 'recorded', candidates: [], recorded: { status: r.status, paymentId: r.paymentId, customerName: done.customerName, decidedBy: r.decidedBy, at: r.createdAt } };
    }
    const d = readDescription(line.description);
    const signals = new Map(allCustomers.map((c) => [c.id, customerSignals(c, d)]));
    const candidates: MatchCandidate[] = [];
    const claimed = new Set<number>();

    // 1. A transfer the customer already reported in the chat: confirm that one instead of recording it twice.
    for (const p of pending.filter((p) => p.amount === line.amount)) {
      const c = customerById.get(p.customerId)!;
      const sig = signals.get(c.id)!;
      let score = WEIGHT.chatPayment + sig.score;
      const reasons = [`Sama dengan bukti transfer ${rupiah(p.amount)} yang dikirim ${c.name} lewat chat${p.paidOn ? ` (tanggal ${p.paidOn})` : ''}`, ...sig.reasons];
      if (p.reference && p.reference.length >= 6 && d.compact.includes(p.reference.toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
        score += WEIGHT.chatReference;
        reasons.push(`Nomor referensi ${p.reference} ada di keterangan`);
      }
      if (p.paidOn && daysApart(p.paidOn, line.postedOn) <= DATE_WINDOW_DAYS) {
        score += WEIGHT.sameDate;
        reasons.push(p.paidOn === line.postedOn ? 'Tanggal transfer sama' : `Tanggal transfer di chat ${p.paidOn}, selisih ${daysApart(p.paidOn, line.postedOn)} hari`);
      }
      const { allocations, unallocated } = allocate(openOf(c.id), p.amount, p.allocations.map((a) => a.number));
      const notes = unallocated > 0 ? [`Lebih bayar ${rupiah(unallocated)}: masuk daftar Lebih bayar`] : [];
      candidates.push({ id: `chat:${p.id}`, kind: 'chat_payment', score, customer: who(c), allocations, unallocated, paymentId: p.id, approvalId: approvalOf.get(p.id)!, reasons, notes });
      claimed.add(c.id);
    }

    // 2. A payment already approved by hand: only mark the line as matched, the invoices do not change again.
    for (const p of unconfirmed) {
      const paidOn = p.paidOn ?? p.createdAt.slice(0, 10);
      if (p.amount !== line.amount || daysApart(paidOn, line.postedOn) > DATE_WINDOW_DAYS) continue;
      const c = customerById.get(p.customerId)!;
      const sig = signals.get(c.id)!;
      const score = WEIGHT.recordedPayment + sig.score + (paidOn === line.postedOn ? WEIGHT.sameDate : 0);
      const reasons = [`Sudah dicatat lunas sebagai pembayaran #${p.id} dari ${c.name} (${rupiah(p.amount)}, ${paidOn}); hanya ditandai cocok, tagihan tidak berubah lagi`, ...sig.reasons];
      if (paidOn === line.postedOn) reasons.push('Tanggal transfer sama');
      const unallocated = p.amount - p.allocations.reduce((s, a) => s + a.amount, 0);
      candidates.push({ id: `paid:${p.id}`, kind: 'recorded_payment', score, customer: who(c), allocations: p.allocations, unallocated, paymentId: p.id, approvalId: null, reasons, notes: [] });
      claimed.add(c.id);
    }

    // 3. Open invoices: named in the description, exactly the amount, or several adding up to it.
    for (const c of allCustomers) {
      const open = openOf(c.id);
      if (claimed.has(c.id) || !open.length) continue;
      const sig = signals.get(c.id)!;
      let score = sig.score;
      const reasons: string[] = [];
      const named = open.filter((i) => d.invoiceNumbers.has(i.number));
      if (named.length) {
        score += WEIGHT.invoiceNumber;
        reasons.push(`Nomor tagihan ${named.map((i) => i.number).join(', ')} disebut di keterangan`);
      }
      const exact = open.find((i) => outstanding(i) === line.amount);
      if (!exact && !sumsOf.has(c.id)) sumsOf.set(c.id, invoiceSums(open));
      const sum = exact ? null : (sumsOf.get(c.id)!.get(line.amount) ?? null);
      if (exact) {
        score += WEIGHT.exactInvoice;
        reasons.push(`Nominal sama persis dengan sisa ${exact.number} (${rupiah(outstanding(exact))})`);
      } else if (sum) {
        score += WEIGHT.invoiceSum;
        reasons.push(`Nominal sama dengan jumlah ${sum.length} tagihan: ${sum.map((i) => `${i.number} ${rupiah(outstanding(i))}`).join(' + ')}`);
      }
      reasons.push(...sig.reasons);
      if (score < MIN_SCORE) continue;
      const preferred = [...new Set([...named, ...(exact ? [exact] : (sum ?? []))].map((i) => i.number))];
      const { allocations, unallocated } = allocate(open, line.amount, preferred);
      const owed = open.reduce((s, i) => s + outstanding(i), 0);
      const notes: string[] = [];
      if (unallocated > 0) notes.push(`Lebih besar dari semua tagihan terbuka (${rupiah(owed)}): lebih bayar ${rupiah(unallocated)} masuk daftar Lebih bayar`);
      else if (!exact && !sum) notes.push(`Nominal tidak sama dengan tagihan mana pun: dicatat sebagai bayar sebagian, sisa tagihan ${rupiah(owed - line.amount)}`);
      candidates.push({ id: `inv:${c.id}`, kind: 'invoices', score, customer: who(c), allocations, unallocated, paymentId: null, approvalId: null, reasons, notes });
    }

    // The same transfer may already be recorded from another export: say so, and never pre-select it.
    const nearby = matchedNearby.filter((m) => m.line.amount === line.amount && daysApart(m.line.postedOn, line.postedOn) <= SAME_TRANSFER_DAYS);
    for (const cand of candidates) {
      cand.score = Math.min(100, cand.score);
      const twin = nearby.find((m) => m.customerId === cand.customer.id);
      if (twin) {
        cand.notes.unshift(
          `Mungkin sudah dicatat: mutasi ${twin.line.postedOn} ${rupiah(twin.line.amount)} dari ${cand.customer.name} sudah dicocokkan oleh ${twin.line.decidedBy} (pembayaran #${twin.line.paymentId}). Pilih ini hanya kalau memang transfer lain.`,
        );
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.customer.id - b.customer.id);
    const shown = candidates.slice(0, MAX_CANDIDATES);
    const [top, second] = shown;
    const twinOfTop = top && nearby.some((m) => m.customerId === top.customer.id);
    const status: LineStatus = !top ? 'none' : !twinOfTop && top.score >= CONFIDENT && (!second || top.score - second.score >= CLEAR_LEAD) ? 'confident' : 'review';
    return { ...line, hash, status, candidates: shown, recorded: null };
  });
}

/** The same invoices and amounts, in any order. */
const sameAllocations = (a: Allocation[], b: Allocation[]) => {
  const key = (x: Allocation[]) => x.map((y) => `${y.number}:${y.amount}`).sort().join(',');
  return key(a) === key(b);
};

/**
 * Applies the owner's choices in one transaction. Proposals are computed again inside it, so only a
 * candidate the rules still propose can be applied; a line recorded meanwhile is skipped. Each line
 * must pay exactly what the owner saw: when an earlier line of the same batch already paid those
 * invoices, nothing is applied. Returns what happened per line and the thank-you messages to send
 * once committed.
 */
export function applyStatementMatches(
  db: Db,
  input: { lines: StatementLine[]; selections: MatchSelection[]; decidedBy: string; now: Date },
): Promise<{ applied: AppliedLine[]; messages: { waId: string; text: string }[] }> {
  return db.transaction(async (tx) => {
    const preview = await matchStatement(tx, input.lines);
    const byHash = new Map(preview.map((l) => [l.hash, l]));
    const used = new Map<string, number>();
    const applied: AppliedLine[] = [];
    const messages: { waId: string; text: string }[] = [];
    const nowIso = input.now.toISOString();

    const chosen = input.selections.map((sel) => {
      const line = byHash.get(sel.hash);
      if (!line) throw new DomainError('line_not_found', 'Baris mutasi yang dipilih tidak ada di file ini. Periksa ulang mutasinya.');
      if (line.recorded) return { line, candidate: null };
      const candidate = sel.candidateId === null ? null : line.candidates.find((c) => c.id === sel.candidateId);
      if (sel.candidateId !== null && !candidate) throw new DomainError('match_stale', `Usulan untuk baris ${line.row} sudah berubah. Periksa ulang mutasinya.`);
      if (candidate && candidate.kind !== 'invoices') {
        const other = used.get(candidate.id);
        if (other !== undefined) throw new DomainError('match_conflict', `Baris ${other} dan baris ${line.row} dicocokkan dengan pembayaran yang sama. Pilih salah satu saja.`);
        used.set(candidate.id, line.row);
      }
      return { line, candidate: candidate ?? null };
    });

    // Lines are stored first, in hash order: a line inserted concurrently (or twice in one request) is
    // skipped, never applied twice, and two uploads of overlapping lines lock them in the same order.
    const stored = new Map<number, number>();
    const order = chosen.flatMap((c, i) => (c.line.recorded ? [] : [i])).sort((a, b) => chosen[a]!.line.hash.localeCompare(chosen[b]!.line.hash));
    for (const i of order) {
      const { line, candidate } = chosen[i]!;
      const [row] = await tx
        .insert(bankStatementLines)
        .values({ lineHash: line.hash, postedOn: line.postedOn, description: line.description, amount: line.amount, status: candidate ? 'matched' : 'ignored', decidedBy: input.decidedBy, createdAt: nowIso })
        .onConflictDoNothing()
        .returning({ id: bankStatementLines.id });
      if (row) stored.set(i, row.id);
    }

    /** Invoice number → the row that paid it in this batch. */
    const paidBy = new Map<string, number>();
    for (const [i, { line, candidate }] of chosen.entries()) {
      const base = { hash: line.hash, row: line.row, postedOn: line.postedOn, amount: line.amount, customer: null, paymentId: null, approvalId: null, allocations: [], unallocated: 0 };
      const storedId = stored.get(i);
      if (storedId === undefined) {
        applied.push({ ...base, outcome: 'already_recorded' });
        continue;
      }
      if (!candidate) {
        applied.push({ ...base, outcome: 'ignored' });
        continue;
      }

      let result: AppliedLine;
      if (candidate.kind === 'invoices') {
        // A chat claim for this amount committed after the proposals were read: confirm that one instead.
        await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, candidate.customer.id)).for('update');
        const claim = await first(
          tx
            .select({ id: payments.id })
            .from(payments)
            .where(and(eq(payments.customerId, candidate.customer.id), eq(payments.status, 'pending'), eq(payments.guest, false), eq(payments.amount, line.amount))),
        );
        if (claim) throw new DomainError('match_stale', `${candidate.customer.name} baru saja mengirim bukti transfer ${rupiah(line.amount)} lewat chat. Periksa ulang mutasinya.`);
        const r = await recordBankPayment(tx, {
          customerId: candidate.customer.id,
          amount: line.amount,
          postedOn: line.postedOn,
          description: line.description,
          preferred: candidate.allocations.map((a) => a.number),
          decidedBy: input.decidedBy,
          now: input.now,
        });
        messages.push(r.message);
        result = { ...base, outcome: 'payment_recorded', customer: candidate.customer, paymentId: r.paymentId, approvalId: r.approvalId, allocations: r.allocations, unallocated: r.unallocated };
      } else if (candidate.kind === 'chat_payment') {
        messages.push(
          await decidePayment(tx, {
            approvalId: candidate.approvalId!,
            decision: 'approve',
            decidedBy: input.decidedBy,
            note: `Cocok dengan mutasi rekening ${line.postedOn}: ${line.description}`,
            now: input.now,
          }),
        );
        const p = (await first(tx.select().from(payments).where(eq(payments.id, candidate.paymentId!))))!;
        const allocated = p.allocations.reduce((s, a) => s + a.amount, 0);
        result = { ...base, outcome: 'chat_payment_approved', customer: candidate.customer, paymentId: p.id, approvalId: candidate.approvalId, allocations: p.allocations, unallocated: p.amount - allocated };
      } else {
        result = { ...base, outcome: 'linked', customer: candidate.customer, paymentId: candidate.paymentId, allocations: candidate.allocations, unallocated: candidate.unallocated };
      }
      if (result.outcome !== 'linked') {
        if (!sameAllocations(result.allocations, candidate.allocations)) {
          const earlier = candidate.allocations.find((a) => paidBy.has(a.number));
          throw earlier
            ? new DomainError('match_conflict', `Baris ${paidBy.get(earlier.number)} dan baris ${line.row} sama-sama melunasi ${earlier.number}. Simpan salah satu dulu, lalu periksa ulang mutasinya untuk baris yang lain.`)
            : new DomainError('match_stale', `Usulan untuk baris ${line.row} sudah berubah. Periksa ulang mutasinya.`);
        }
        for (const a of result.allocations) paidBy.set(a.number, line.row);
      }
      await tx.update(bankStatementLines).set({ paymentId: result.paymentId }).where(eq(bankStatementLines.id, storedId));
      applied.push(result);
    }
    return { applied, messages };
  });
}
