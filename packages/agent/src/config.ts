import { z } from 'zod';
import { OpenAICompatibleClient } from './llm/openai-compatible.ts';
import { LlmError, type ModelClient } from './llm/types.ts';
import { ChatAudioStt, FallbackStt, OpenAICompatibleStt, SidecarStt, type SpeechToText } from './stt.ts';
import { FallbackVision, OpenAICompatibleVision, SidecarVision, type VisionReader } from './vision.ts';

const optionalNumber = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : Number(v)))
  .pipe(z.number().nonnegative().nullable());

const EnvSchema = z.object({
  LLM_BASE_URL: z.string().url().default('https://inference-api.nousresearch.com/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('deepseek/deepseek-v4.1-flash'),
  LLM_TOOL_MODE: z.enum(['native', 'prompt']).default('native'),
  LLM_PRICE_INPUT_PER_M: optionalNumber,
  LLM_PRICE_OUTPUT_PER_M: optionalNumber,
  STT_BASE_URL: z.string().default(''),
  STT_API_KEY: z.string().default(''),
  STT_MODEL: z.string().default('whisper-large-v3'),
  /**
   * `transcriptions`: the OpenAI-compatible /audio/transcriptions endpoint (Groq, OpenAI Whisper).
   * `chat`: a multimodal chat model that takes audio (openai/gpt-audio on Nous Portal), for
   * providers without that endpoint. In `chat` mode the voice note must be wav or mp3.
   */
  STT_API: z.enum(['transcriptions', 'chat']).default('transcriptions'),
  VISION_BASE_URL: z.string().default(''),
  VISION_API_KEY: z.string().default(''),
  VISION_MODEL: z.string().default(''),
});

export type AgentEnv = z.infer<typeof EnvSchema>;

export function loadAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  return EnvSchema.parse(env);
}

export function modelFromEnv(env: AgentEnv): ModelClient {
  if (!env.LLM_API_KEY) {
    // Keep the console usable without a key; every agent run fails safely and escalates to a human.
    console.warn('LLM_API_KEY is not set: agent runs will escalate to the order desk. Add your Nous Portal key to .env.');
    return {
      name: 'unconfigured',
      complete: async () => {
        throw new LlmError('LLM_API_KEY is not set', false);
      },
    };
  }
  return new OpenAICompatibleClient({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, toolMode: env.LLM_TOOL_MODE });
}

export function sttFromEnv(env: AgentEnv): SpeechToText {
  const sidecar = new SidecarStt();
  if (!env.STT_BASE_URL || !env.STT_API_KEY) return sidecar;
  const config = { baseUrl: env.STT_BASE_URL, apiKey: env.STT_API_KEY, model: env.STT_MODEL };
  const provider = env.STT_API === 'chat' ? new ChatAudioStt(config) : new OpenAICompatibleStt(config);
  return new FallbackStt([provider, sidecar]);
}

export function visionFromEnv(env: AgentEnv): VisionReader {
  const sidecar = new SidecarVision();
  if (!env.VISION_BASE_URL || !env.VISION_API_KEY || !env.VISION_MODEL) return sidecar;
  return new FallbackVision([new OpenAICompatibleVision({ baseUrl: env.VISION_BASE_URL, apiKey: env.VISION_API_KEY, model: env.VISION_MODEL }), sidecar]);
}

export function pricingFromEnv(env: AgentEnv) {
  return env.LLM_PRICE_INPUT_PER_M !== null && env.LLM_PRICE_OUTPUT_PER_M !== null
    ? { inputPerM: env.LLM_PRICE_INPUT_PER_M, outputPerM: env.LLM_PRICE_OUTPUT_PER_M }
    : null;
}
