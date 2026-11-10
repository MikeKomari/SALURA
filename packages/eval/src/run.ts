import { inArray } from '@salura/db/orm';
import { agentRuns, closeDb, openDb, seed } from '@salura/db';
import { DELIVERY_SAMPLES, EventBus, type ModelClient, SaluraService, sampleOrderId, saveMedia, SidecarStt, SidecarVision, storeSample } from '@salura/agent';
import { CASES, type Category, type EvalCase } from './cases.ts';
import { grade, type Grade } from './grade.ts';

/** Fixed "today" so overdue days and credit balances are identical in every run. */
export const EVAL_NOW = new Date('2026-10-21T03:00:00.000Z');

export interface RunRecord {
  caseId: string;
  attempt: number;
  grade: Grade;
  replies: string[];
  seconds: number;
  turnSeconds: number[];
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface CaseReport {
  id: string;
  category: Category;
  turns: string[];
  passes: number;
  attempts: number;
  passAllK: boolean;
  runs: RunRecord[];
}

export interface EvalReport {
  ranAt: string;
  model: string;
  k: number;
  summary: {
    cases: number;
    k: number;
    /** Share of all runs that passed (pass@1 averaged). */
    passRate: number;
    /** Share of cases that passed in every one of k runs (pass^k). */
    passK: number;
    /** Share of runs with expected lines where the processed order matched exactly. */
    itemAccuracy: number | null;
    avgSecondsPerTurn: number;
    avgCostPerCaseUsd: number | null;
    byCategory: Record<string, { cases: number; passRate: number; passK: number }>;
  };
  cases: CaseReport[];
}

export async function runCase(c: EvalCase, attempt: number, model: ModelClient, pricing: { inputPerM: number; outputPerM: number } | null): Promise<RunRecord> {
  // A fresh embedded Postgres per run: no case can see another's data.
  const db = await openDb('memory://');
  await seed(db, EVAL_NOW.getTime());
  // Simulated clock: one second per read, so the conversation is ordered and reproducible.
  let t = EVAL_NOW.getTime();
  const clock = () => new Date((t += 1000));
  const service = new SaluraService({ db, bus: new EventBus(), model, stt: new SidecarStt(), vision: new SidecarVision(), clock, pricing, outbox: { send: async () => {} } });

  const replies: string[] = [];
  const turnSeconds: number[] = [];
  const started = Date.now();
  let error: string | undefined;
  try {
    for (const turn of c.turns) {
      const turnStart = Date.now();
      if (typeof turn === 'object' && 'delivery' in turn) {
        const sample = DELIVERY_SAMPLES.find((s) => s.id === turn.delivery);
        if (!sample) throw new Error(`Unknown delivery sample ${turn.delivery}`);
        const orderId = await sampleOrderId(db, sample);
        if (!orderId) throw new Error(`Sample order for ${sample.id} not found in the seed`);
        replies.push((await service.runDeliveryCheck({ orderId, kind: sample.kind, mediaId: await storeSample(db, sample), source: 'console' })).run.reply);
      } else if (typeof turn === 'object' && 'proactive' in turn) {
        replies.push((await service.runProactive('eval')).reply);
      } else if (typeof turn === 'string') {
        replies.push((await service.handleInbound({ waId: c.waId, channel: 'eval', kind: 'text', text: turn })).reply);
      } else if ('voice' in turn) {
        const mediaId = await saveMedia(db, { data: Buffer.alloc(0), mime: 'audio/ogg', sidecarText: turn.voice });
        replies.push((await service.handleInbound({ waId: c.waId, channel: 'eval', kind: 'voice', mediaId })).reply);
      } else {
        const mediaId = await saveMedia(db, { data: Buffer.alloc(0), mime: 'image/jpeg', sidecarText: turn.image });
        replies.push((await service.handleInbound({ waId: c.waId, channel: 'eval', kind: 'image', text: turn.caption, mediaId })).reply);
      }
      turnSeconds.push((Date.now() - turnStart) / 1000);
    }
  } catch (err) {
    error = (err as Error).message;
  }

  const runs = await db.select().from(agentRuns).where(inArray(agentRuns.trigger, ['message', 'eval', 'delivery']));
  const costs = runs.map((r) => r.costUsd).filter((x): x is number => x !== null);
  const g = await grade(db, c, replies);
  await closeDb(db);
  if (error) g.checks.push({ name: 'no crash', ok: false, detail: error }), (g.pass = false);
  return {
    caseId: c.id,
    attempt,
    grade: g,
    replies,
    seconds: (Date.now() - started) / 1000,
    turnSeconds,
    costUsd: costs.length ? costs.reduce((s, x) => s + x, 0) : null,
    inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
    error,
  };
}

export async function runEval(opts: {
  model: ModelClient;
  pricing: { inputPerM: number; outputPerM: number } | null;
  k: number;
  concurrency: number;
  filter?: (c: EvalCase) => boolean;
  onRun?: (r: RunRecord) => void;
}): Promise<EvalReport> {
  const cases = CASES.filter(opts.filter ?? (() => true));
  const jobs = cases.flatMap((c) => Array.from({ length: opts.k }, (_, attempt) => ({ c, attempt })));
  const records: RunRecord[] = [];

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const r = await runCase(job.c, job.attempt, opts.model, opts.pricing);
      records.push(r);
      opts.onRun?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker));

  const caseReports: CaseReport[] = cases.map((c) => {
    const runs = records.filter((r) => r.caseId === c.id).sort((a, b) => a.attempt - b.attempt);
    const passes = runs.filter((r) => r.grade.pass).length;
    return {
      id: c.id,
      category: c.category,
      turns: c.turns.map((t) => (typeof t === 'string' ? t : 'voice' in t ? `[voice] ${t.voice}` : 'image' in t ? `[photo] ${t.image.replace(/\n/g, ' / ')}${t.caption ? ` + "${t.caption}"` : ''}` : 'delivery' in t ? `[delivery document] ${t.delivery}` : '[proactive run]')),
      passes,
      attempts: runs.length,
      passAllK: passes === runs.length,
      runs,
    };
  });

  const lineRuns = records.filter((r) => r.grade.linesExact !== null);
  const costs = records.map((r) => r.costUsd).filter((x): x is number => x !== null);
  const allTurns = records.flatMap((r) => r.turnSeconds);
  const byCategory: EvalReport['summary']['byCategory'] = {};
  for (const cat of new Set(cases.map((c) => c.category))) {
    const cr = caseReports.filter((c) => c.category === cat);
    const runs = cr.flatMap((c) => c.runs);
    byCategory[cat] = { cases: cr.length, passRate: ratio(runs.filter((r) => r.grade.pass).length, runs.length), passK: ratio(cr.filter((c) => c.passAllK).length, cr.length) };
  }

  return {
    ranAt: new Date().toISOString(),
    model: opts.model.name,
    k: opts.k,
    summary: {
      cases: cases.length,
      k: opts.k,
      passRate: ratio(records.filter((r) => r.grade.pass).length, records.length),
      passK: ratio(caseReports.filter((c) => c.passAllK).length, caseReports.length),
      itemAccuracy: lineRuns.length ? ratio(lineRuns.filter((r) => r.grade.linesExact).length, lineRuns.length) : null,
      avgSecondsPerTurn: allTurns.length ? allTurns.reduce((s, x) => s + x, 0) / allTurns.length : 0,
      avgCostPerCaseUsd: costs.length ? costs.reduce((s, x) => s + x, 0) / costs.length : null,
      byCategory,
    },
    cases: caseReports,
  };
}

function ratio(n: number, d: number): number {
  return d ? n / d : 0;
}
