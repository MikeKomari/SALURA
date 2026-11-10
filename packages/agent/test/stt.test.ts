import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAudioStt, FallbackStt, SidecarStt } from '../src/stt.ts';
import type { MediaFile } from '../src/media.ts';

const file = (mime: string, sidecarText: string | null = null): MediaFile =>
  ({ id: 'pesan-suara.wav', mime, data: Buffer.from('fake-audio'), sidecarText }) as MediaFile;

const reply = (content: unknown) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response;

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const stt = () => new ChatAudioStt({ baseUrl: 'https://portal.example/v1/', apiKey: 'k', model: 'openai/gpt-audio-mini' });

afterEach(() => vi.unstubAllGlobals());

describe('speech to text through a multimodal chat model', () => {
  it('sends the audio as an input_audio part and returns the transcript', async () => {
    const fetchMock = stubFetch(reply('mau pesen aqua tanggung dua dus'));

    expect(await stt().transcribe(file('audio/wav'))).toEqual({ text: 'mau pesen aqua tanggung dua dus' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://portal.example/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('openai/gpt-audio-mini');
    const [text, audio] = body.messages[0].content;
    expect(text.type).toBe('text');
    expect(audio).toEqual({ type: 'input_audio', input_audio: { data: Buffer.from('fake-audio').toString('base64'), format: 'wav' } });
  });

  it('maps mp3 and ignores the codec suffix on the mime type', async () => {
    const formatSentFor = async (mime: string) => {
      const fetchMock = stubFetch(reply('satu dus indomie'));
      await stt().transcribe(file(mime));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).messages[0].content[1].input_audio.format;
    };
    expect(await formatSentFor('audio/mpeg')).toBe('mp3');
    expect(await formatSentFor('audio/wav; codecs=1')).toBe('wav');
  });

  it('refuses formats these models reject, without calling the provider', async () => {
    const fetchMock = stubFetch(reply('never reached'));
    for (const mime of ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a']) {
      await expect(stt().transcribe(file(mime))).rejects.toThrow(/only wav and mp3/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips quotation marks the model adds around the transcript', async () => {
    stubFetch(reply('“aqua tanggung dua dus”'));
    expect((await stt().transcribe(file('audio/wav'))).text).toBe('aqua tanggung dua dus');
  });

  it('fails on silence instead of handing "[NO_SPEECH]" to the agent as an order', async () => {
    for (const content of ['[NO_SPEECH]', 'NO_SPEECH', '   ', null]) {
      stubFetch(reply(content));
      await expect(stt().transcribe(file('audio/wav'))).rejects.toThrow(/No speech/);
    }
  });

  it('reports the provider status when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, text: async () => 'key_spend_limit_reached' }) as unknown as Response));
    await expect(stt().transcribe(file('audio/wav'))).rejects.toThrow(/STT HTTP 402: key_spend_limit_reached/);
  });

  it('falls back to the stored transcript when the provider cannot read the audio', async () => {
    stubFetch(new Error('network down'));
    const chain = new FallbackStt([stt(), new SidecarStt()]);
    expect(await chain.transcribe(file('audio/wav', 'aqua tanggung 2 dus'))).toEqual({ text: 'aqua tanggung 2 dus' });
  });
});
