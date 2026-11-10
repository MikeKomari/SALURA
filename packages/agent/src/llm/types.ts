export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Undefined when the model sent arguments that are not valid JSON. */
  arguments: unknown;
  rawArguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelResponse {
  /** Text the customer may see (reasoning blocks removed). */
  content: string;
  /** Reasoning the model wrote before acting, if any. Shown in the trace, never sent to customers. */
  thought?: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelClient {
  readonly name: string;
  complete(req: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<ModelResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
