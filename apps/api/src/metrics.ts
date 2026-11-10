import { and, count, desc, eq, gte, inArray, isNotNull, or, sql, type SQL } from '@salura/db/orm';
import { agentRuns, approvals, auditLog, customers, orders, type Db } from '@salura/db';
import { overdueInvoices } from '@salura/agent';

const HANDLED = ['confirmed', 'awaiting_approval', 'rejected'] as const;

export interface DashboardMetrics {
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
}

/** Counts JSON array elements of `data -> key` matching `match` (0 when it is not an array). */
const countIn = (key: 'issues' | 'results', match: SQL) => {
  const list = sql`${auditLog.data} -> ${sql.raw(`'${key}'`)}`;
  return sql`(select count(*) from jsonb_array_elements(case when jsonb_typeof(${list}) = 'array' then ${list} else '[]'::jsonb end) as e where ${match})`;
};

/** A guest account's test chats are left out of every number: they are not the distributor's business. */
const notGuestRun = sql`not exists (select 1 from ${agentRuns} where ${agentRuns.id} = ${auditLog.runId} and ${agentRuns.guest})`;

/** Numbers on the Ringkasan screen. Everything is computed from stored data, nothing is a mock. */
export async function dashboardMetrics(db: Db, now: Date, manualMinutesPerOrder: number): Promise<DashboardMetrics> {
  const since = new Date(now.getTime() - 6 * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const isDraft = sql`${auditLog.type} = 'tool_result' and ${auditLog.tool} = 'draft_order'`;
  // Two rounds of three queries: a cold serverless instance opens a connection per parallel query.
  const [orderCounts, errorCounts, runStats] = await Promise.all([
    db
      .select({
        handled: count(),
        confirmed: count(sql`case when ${orders.status} = 'confirmed' then 1 end`),
        // Confirmed without a person touching it: never edited and never sent for approval.
        straightThrough: count(
          sql`case when ${orders.status} = 'confirmed' and not ${orders.humanEdited} and not exists (select 1 from ${approvals} where ${approvals.orderId} = ${orders.id}) then 1 end`,
        ),
      })
      .from(orders)
      .where(and(eq(orders.historic, false), eq(orders.guest, false), inArray(orders.status, [...HANDLED]))),
    // Errors the agent caught before they reached the warehouse: issues reported by draft_order,
    // ambiguous product phrases, and actions the business rules refused.
    db
      .select({
        outOfStock: sql`coalesce(sum(case when ${isDraft} then ${countIn('issues', sql`e ->> 'type' = 'out_of_stock'`)} end), 0)`.mapWith(Number),
        overCredit: sql`coalesce(sum(case when ${isDraft} then ${countIn('issues', sql`e ->> 'type' = 'over_credit'`)} end), 0)`.mapWith(Number),
        ambiguous: sql`coalesce(sum(case when ${auditLog.type} = 'tool_result' and ${auditLog.tool} = 'search_catalog' then ${countIn('results', sql`e -> 'ambiguous' = 'true'::jsonb`)} end), 0)`.mapWith(Number),
        blockedActions: count(sql`case when ${auditLog.type} = 'validation' then 1 end`),
      })
      .from(auditLog)
      .where(and(or(eq(auditLog.type, 'validation'), and(eq(auditLog.type, 'tool_result'), inArray(auditLog.tool, ['draft_order', 'search_catalog']))), notGuestRun)),
    db
      .select({
        runs: count(),
        priced: count(agentRuns.costUsd),
        totalCost: sql`coalesce(sum(${agentRuns.costUsd}), 0)`.mapWith(Number),
        avgSeconds: sql`avg(extract(epoch from (${agentRuns.endedAt}::timestamptz - ${agentRuns.startedAt}::timestamptz)))`.mapWith(Number),
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.trigger, 'message'), eq(agentRuns.guest, false), isNotNull(agentRuns.endedAt))),
  ]);
  const [perDayRows, pending, overdue] = await Promise.all([
    db
      .select({ date: sql<string>`substr(${orders.createdAt}, 1, 10)`, count: count() })
      .from(orders)
      .where(and(inArray(orders.status, [...HANDLED]), eq(orders.guest, false), gte(orders.createdAt, since.toISOString())))
      .groupBy(sql`1`),
    db.select({ n: count() }).from(approvals).where(eq(approvals.status, 'pending')),
    overdueInvoices(db, now),
  ]);
  const { handled, confirmed, straightThrough } = orderCounts[0]!;
  const { outOfStock, overCredit, ambiguous, blockedActions } = errorCounts[0]!;
  const { runs, priced, totalCost, avgSeconds } = runStats[0]!;

  const perDay = new Map<string, number>();
  for (let i = 0; i < 7; i++) perDay.set(new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10), 0);
  for (const d of perDayRows) if (perDay.has(d.date)) perDay.set(d.date, d.count);

  return {
    ordersHandled: handled,
    straightThrough,
    straightThroughRate: handled ? straightThrough / handled : null,
    pendingApprovals: pending[0]?.n ?? 0,
    overdue: {
      amount: overdue.reduce((s, i) => s + i.outstanding, 0),
      invoices: overdue.length,
      customers: new Set(overdue.map((i) => i.customerId)).size,
    },
    minutesSaved: confirmed * manualMinutesPerOrder,
    manualMinutesPerOrder,
    errorsCaught: { total: outOfStock + overCredit + ambiguous + blockedActions, outOfStock, overCredit, ambiguous, blockedActions },
    costPerOrderUsd: priced && handled ? totalCost / handled : null,
    avgRunSeconds: runs ? avgSeconds : null,
    ordersPerDay: [...perDay.entries()].map(([date, count]) => ({ date, count })),
  };
}

export function recentAgentOrders(db: Db, limit = 8) {
  return db
    .select({ order: orders, customer: { id: customers.id, name: customers.name, waId: customers.waId } })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.historic, false), eq(orders.guest, false)))
    .orderBy(desc(orders.updatedAt), desc(orders.id))
    .limit(limit);
}
