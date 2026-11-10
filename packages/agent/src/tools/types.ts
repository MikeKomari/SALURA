import { z } from 'zod';
import type { Db } from '@salura/db';
import type { Audit } from '../audit.ts';
import type { Customer } from '../domain/customers.ts';
import type { SpeechToText } from '../stt.ts';
import type { VisionReader } from '../vision.ts';
import type { ToolSpec } from '../llm/types.ts';

export interface ToolContext {
  db: Db;
  now: () => Date;
  runId: string;
  audit: Audit;
  stt: SpeechToText;
  vision: VisionReader;
  /** Conversation the run belongs to; null for scheduled runs. */
  waId: string | null;
  channel: string;
  customer: Customer | null;
  /** Message ids that belong to this conversation (guards transcribe_audio and read_order_image). */
  allowedMessageIds: Set<number>;
  sendMessage?: (waId: string, text: string) => Promise<void>;
  /** The delivery check a delivery run works on; delivery tools refuse any other id. */
  deliveryCheckId?: number;
  /** True while the agent is handling a message from this customer (scheduled runs must not interfere). */
  conversationBusy?: (waId: string) => Promise<boolean>;
  /** Set when a guest account types as the customer in the console (see GuestSession). */
  guest?: GuestSession;
}

/**
 * A run started by a guest (viewer) account playing a customer in the console. It works on drafts,
 * messages, payment claims and delivery checks of its own, never the customer's. Nothing it does
 * reserves stock or changes invoices: orders wait for an admin, promise-to-pay dates are not saved,
 * and the approvals it may queue are capped.
 */
export interface GuestSession {
  /**
   * Takes one approval from this hour's allowance in a single step, so parallel runs cannot both take
   * the last one. False, taking nothing, once it is used up.
   */
  reserveApproval(): Promise<boolean>;
  /** Corrects the count afterwards: negative gives back reservations nothing used, positive counts extra approvals queued. */
  adjustApprovals(n: number): Promise<void>;
}

export type SideEffect = 'read' | 'write' | 'external';

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  sideEffect: SideEffect;
  /** May queue an approval for the owner; counted against a guest's allowance before it runs. */
  queuesApproval?: boolean;
  schema: S;
  run(ctx: ToolContext, args: z.infer<S>): Promise<unknown> | unknown;
  /** One line for the trace, e.g. "Matched 3 items, 1 ambiguous". */
  summarize?(args: z.infer<S>, result: any): string;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function toolSpec(def: ToolDef): ToolSpec {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(def.schema) as Record<string, unknown>;
  return { name: def.name, description: def.description, parameters };
}

export function requireCustomer(ctx: ToolContext): Customer {
  if (!ctx.customer) throw new ToolUsageError('unknown_customer', 'This WhatsApp number is not a registered customer. Escalate to a human.');
  return ctx.customer;
}

/** Bad tool usage the model can fix (wrong ids, missing context). */
export class ToolUsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
