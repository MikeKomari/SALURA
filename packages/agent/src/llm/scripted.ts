import { randomUUID } from 'node:crypto';
import type { ChatMessage, ModelClient, ModelResponse, ToolSpec } from './types.ts';

export type ScriptStep =
  | { say: string; thought?: string }
  | { call: { name: string; args: Record<string, unknown> }[]; thought?: string }
  | ((ctx: { messages: ChatMessage[]; tools: ToolSpec[]; lastToolResults: unknown[] }) => ScriptStep);

/**
 * Deterministic model for tests and offline demos: replays a fixed list of steps.
 * A step can be a function of the conversation so far, to branch on tool results.
 */
export class ScriptedModel implements ModelClient {
  readonly name = 'scripted';
  private index = 0;
  readonly seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];

  constructor(private readonly steps: ScriptStep[]) {}

  async complete(req: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<ModelResponse> {
    this.seen.push({ messages: [...req.messages], tools: req.tools });
    let step = this.steps[this.index++];
    if (!step) throw new Error(`ScriptedModel ran out of steps after ${this.steps.length}`);

    const lastToolResults: unknown[] = [];
    for (let i = req.messages.length - 1; i >= 0 && req.messages[i]!.role === 'tool'; i--) {
      const m = req.messages[i] as { content: string };
      lastToolResults.unshift(JSON.parse(m.content));
    }
    while (typeof step === 'function') step = step({ messages: req.messages, tools: req.tools, lastToolResults });

    const usage = { inputTokens: 100, outputTokens: 20 };
    if ('say' in step) return { content: step.say, thought: step.thought, toolCalls: [], usage };
    return {
      content: '',
      thought: step.thought,
      toolCalls: step.call.map((c) => ({ id: randomUUID(), name: c.name, arguments: c.args, rawArguments: JSON.stringify(c.args) })),
      usage,
    };
  }

  get remaining(): number {
    return this.steps.length - this.index;
  }
}
