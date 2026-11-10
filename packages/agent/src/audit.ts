import { auditLog, type AuditType, type Db } from '@salura/db';
import type { EventBus } from './events.ts';

export interface AuditEntry {
  actor: 'agent' | 'system' | 'human' | 'customer';
  type: AuditType;
  summary: string;
  tool?: string;
  data?: unknown;
  confidence?: number;
  durationMs?: number;
}

/** Append-only writer for the audit log. Every entry is also pushed to the live trace. */
export class Audit {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly clock: () => Date,
    readonly runId: string | null,
  ) {}

  async log(entry: AuditEntry) {
    const [row] = await this.db
      .insert(auditLog)
      .values({
        runId: this.runId,
        ts: this.clock().toISOString(),
        actor: entry.actor,
        type: entry.type,
        tool: entry.tool ?? null,
        summary: entry.summary,
        data: entry.data ?? null,
        confidence: entry.confidence ?? null,
        durationMs: entry.durationMs ?? null,
      })
      .returning();
    await this.bus.emit({ type: 'audit', entry: row! });
    return row!;
  }

  forRun(runId: string): Audit {
    return new Audit(this.db, this.bus, this.clock, runId);
  }
}
