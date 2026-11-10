import { randomUUID } from 'node:crypto';
import { LlmError, type ChatMessage, type ModelClient, type ModelResponse, type ToolCall, type ToolSpec } from './types.ts';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * native: send `tools` and read `tool_calls` (OpenAI function calling).
   * prompt: describe tools in the system prompt and parse Hermes-style <tool_call> blocks,
   * for endpoints that ignore the `tools` field.
   */
  toolMode: 'native' | 'prompt';
  temperature?: number;
  timeoutMs?: number;
}

const RETRY_DELAY_MS = 1500;

/** Client for any OpenAI-compatible /chat/completions endpoint (Nous Portal, DeepSeek, OpenRouter, ...). */
export class OpenAICompatibleClient implements ModelClient {
  readonly name: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.name = `${config.model} (${config.toolMode})`;
  }

  async complete(req: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<ModelResponse> {
    const body =
      this.config.toolMode === 'native' ? this.nativeBody(req.messages, req.tools) : this.promptBody(req.messages, req.tools);

    const json = await this.post(body);
    const choice = json?.choices?.[0]?.message;
    if (!choice) throw new LlmError('Model returned no choices', true);

    const usage = {
      inputTokens: Number(json.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json.usage?.completion_tokens ?? 0),
    };
    const { text, thought } = splitThinking(String(choice.content ?? ''));

    if (this.config.toolMode === 'native') {
      const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((tc: any) => {
        const raw = String(tc.function?.arguments ?? '{}');
        return { id: String(tc.id ?? randomUUID()), name: String(tc.function?.name), arguments: tryParse(raw), rawArguments: raw };
      });
      return { content: text, thought, toolCalls, usage };
    }

    const parsed = parseHermesToolCalls(text);
    return { content: parsed.content, thought: joinThoughts(thought, parsed.toolCalls.length ? parsed.content : undefined), toolCalls: parsed.toolCalls, usage };
  }

  private nativeBody(messages: ChatMessage[], tools: ToolSpec[]) {
    return {
      model: this.config.model,
      temperature: this.config.temperature ?? 0.2,
      messages: messages.map((m) => {
        if (m.role === 'assistant') {
          return {
            role: 'assistant',
            content: m.content || null,
            ...(m.toolCalls?.length
              ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.rawArguments } })) }
              : {}),
          };
        }
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        return m;
      }),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' }
        : {}),
    };
  }

  private promptBody(messages: ChatMessage[], tools: ToolSpec[]) {
    const out: { role: string; content: string }[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        out.push({ role: 'system', content: tools.length ? `${m.content}\n\n${hermesToolBlock(tools)}` : m.content });
      } else if (m.role === 'assistant') {
        const calls = (m.toolCalls ?? [])
          .map((tc) => `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.arguments ?? tc.rawArguments })}\n</tool_call>`)
          .join('\n');
        out.push({ role: 'assistant', content: [m.content, calls].filter(Boolean).join('\n') });
      } else if (m.role === 'tool') {
        // Consecutive tool results are merged into one user turn, as Hermes models expect.
        const block = `<tool_response>\n${JSON.stringify({ name: m.name, content: m.content })}\n</tool_response>`;
        const last = out.at(-1);
        if (last?.role === 'user' && last.content.startsWith('<tool_response>')) last.content += `\n${block}`;
        else out.push({ role: 'user', content: block });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return { model: this.config.model, temperature: this.config.temperature ?? 0.2, messages: out };
  }

  private async post(body: unknown, attempt = 1): Promise<any> {
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new LlmError(`LLM HTTP ${res.status}: ${detail}`, res.status === 429 || res.status >= 500);
      }
      return await res.json();
    } catch (err) {
      const retryable = err instanceof LlmError ? err.retryable : true; // network errors and timeouts
      if (retryable && attempt < 2) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        return this.post(body, attempt + 1);
      }
      throw err instanceof LlmError ? err : new LlmError(`LLM request failed: ${(err as Error).message}`, retryable);
    }
  }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function joinThoughts(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((p) => p && p.trim()).join('\n').trim();
  return joined || undefined;
}

/** Separates <think>…</think> reasoning (Hermes 4, DeepSeek R-style) from the visible reply. */
export function splitThinking(raw: string): { text: string; thought?: string } {
  const thoughts: string[] = [];
  const text = raw
    .replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, t: string) => {
      thoughts.push(t.trim());
      return '';
    })
    .trim();
  return { text, thought: thoughts.filter(Boolean).join('\n') || undefined };
}

export function hermesToolBlock(tools: ToolSpec[]): string {
  return [
    'You can call functions. Their signatures are inside <tools></tools>:',
    `<tools>\n${tools.map((t) => JSON.stringify({ type: 'function', function: t })).join('\n')}\n</tools>`,
    'To call a function, reply with one or more blocks of exactly this form and nothing after them:',
    '<tool_call>\n{"name": "<function-name>", "arguments": {<json-arguments>}}\n</tool_call>',
    'Function results come back inside <tool_response></tool_response>. When you need no more functions, reply with plain text only.',
  ].join('\n');
}

/**
 * Extracts Hermes <tool_call>{json}</tool_call> blocks. Each opening tag starts a new call, so a
 * missing closing tag never merges two calls. Hallucinated <tool_response> blocks are dropped.
 */
export function parseHermesToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const cleaned = text.replace(/<tool_response>[\s\S]*?(<\/tool_response>|$)/g, '');
  const parts = cleaned.split('<tool_call>');
  const textParts = [parts[0] ?? ''];
  const toolCalls: ToolCall[] = [];
  for (const part of parts.slice(1)) {
    const close = part.indexOf('</tool_call>');
    const body = (close >= 0 ? part.slice(0, close) : part).trim();
    if (close >= 0) textParts.push(part.slice(close + '</tool_call>'.length));
    const parsed = tryParse(body) as { name?: unknown; arguments?: unknown } | undefined;
    const args = typeof parsed?.arguments === 'string' ? tryParse(parsed.arguments) : parsed?.arguments;
    toolCalls.push({
      id: randomUUID(),
      name: typeof parsed?.name === 'string' ? parsed.name : 'invalid_tool_call',
      arguments: parsed ? (args ?? {}) : undefined,
      rawArguments: parsed ? JSON.stringify(args ?? {}) : body,
    });
  }
  return { content: textParts.join('').trim(), toolCalls };
}
