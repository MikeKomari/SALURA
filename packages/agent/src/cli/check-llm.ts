// `pnpm check:llm`: confirms the LLM key and model work, and which tool-calling mode the endpoint supports.
import { loadAgentEnv } from '../config.ts';
import { OpenAICompatibleClient } from '../llm/openai-compatible.ts';
import type { ToolSpec } from '../llm/types.ts';

const env = loadAgentEnv();
if (!env.LLM_API_KEY) {
  console.error('✗ LLM_API_KEY is empty. Put your Nous Portal key in .env (see SETUP.md).');
  process.exit(1);
}
console.log(`Endpoint ${env.LLM_BASE_URL}\nModel    ${env.LLM_MODEL}\nMode     ${env.LLM_TOOL_MODE} (from .env)\n`);

const tool: ToolSpec = {
  name: 'search_catalog',
  description: 'Match product phrases to catalog products.',
  parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] },
};
const messages = [
  { role: 'system' as const, content: 'You are an order-desk agent. Always use tools to look up products before answering.' },
  { role: 'user' as const, content: 'pesan indomie goreng 2 dus' },
];

async function tryMode(mode: 'native' | 'prompt') {
  const client = new OpenAICompatibleClient({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, toolMode: mode, timeoutMs: 45_000 });
  const started = Date.now();
  try {
    const r = await client.complete({ messages, tools: [tool] });
    const call = r.toolCalls.find((c) => c.name === 'search_catalog' && c.arguments !== undefined);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (call) {
      console.log(`✓ ${mode.padEnd(6)} tool call works (${secs}s, ${r.usage.inputTokens}+${r.usage.outputTokens} tokens): ${JSON.stringify(call.arguments)}`);
      return true;
    }
    console.log(`✗ ${mode.padEnd(6)} answered without calling the tool (${secs}s): "${r.content.slice(0, 120)}"`);
  } catch (err) {
    console.log(`✗ ${mode.padEnd(6)} request failed: ${(err as Error).message.slice(0, 300)}`);
  }
  return false;
}

const native = await tryMode('native');
const prompt = await tryMode('prompt');
console.log('');
if (!native && !prompt) {
  console.log('Neither mode worked. Check the key, the model id (as listed in your Nous Portal account) and LLM_BASE_URL.');
  process.exit(1);
}
const best = native ? 'native' : 'prompt';
console.log(best === env.LLM_TOOL_MODE ? `OK: keep LLM_TOOL_MODE=${best}.` : `Set LLM_TOOL_MODE=${best} in .env (currently ${env.LLM_TOOL_MODE}).`);
