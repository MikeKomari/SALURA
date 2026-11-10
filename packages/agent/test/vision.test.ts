import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaFile } from '../src/media.ts';
import { FallbackVision, OpenAICompatibleVision, parsePhotoText, SidecarVision } from '../src/vision.ts';

function photo(mime = 'image/png', sidecarText: string | null = null): MediaFile {
  return { id: `list${mime === 'image/png' ? '.png' : '.jpg'}`, mime, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), sidecarText };
}

function mockReply(content: string, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('vision reader', () => {
  const config = { baseUrl: 'https://vision.example/v1/', apiKey: 'k', model: 'vision-model' };

  it('sends the photo as a data URI to /chat/completions and returns the lines', async () => {
    const fetchMock = mockReply('<think>two lines</think>indomie goreng 2 dus\naqua 1 dus');
    const { text } = await new OpenAICompatibleVision(config).read(photo());
    expect(text).toBe('indomie goreng 2 dus\naqua 1 dus');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://vision.example/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('vision-model');
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } });
  });

  it('asks a chat photo for its type first', async () => {
    const fetchMock = mockReply('TYPE: payment_proof\nJumlah: Rp500.000');
    const { text } = await new OpenAICompatibleVision(config).read(photo(), 'chat_photo');
    expect(parsePhotoText(text)).toEqual({ type: 'payment_proof', lines: ['Jumlah: Rp500.000'] });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].content[0].text).toContain('TYPE: delivery_document');
  });

  it('returns empty text when the photo has no order list', async () => {
    mockReply('NO_ORDER');
    expect((await new OpenAICompatibleVision(config).read(photo())).text).toBe('');
  });

  it('falls back to the stored text when the provider fails', async () => {
    mockReply('down', 503);
    const vision = new FallbackVision([new OpenAICompatibleVision(config), new SidecarVision()]);
    expect(await vision.read(photo('image/jpeg', 'gulaku 10 bks\n'))).toEqual({ text: 'gulaku 10 bks' });
  });

  it('fails when there is neither a provider nor stored text', async () => {
    await expect(new SidecarVision().read(photo())).rejects.toThrow(/not configured/);
  });
});

describe('chat photo types', () => {
  it('treats text without a TYPE line as an order list, dropping bullets and blank lines', () => {
    expect(parsePhotoText('- aqua 2 dus\n\n* kopi 5 renceng\n• gula 1 kg')).toEqual({ type: 'order_list', lines: ['aqua 2 dus', 'kopi 5 renceng', 'gula 1 kg'] });
  });

  it.each([
    ['TYPE: order_list\nindomie 2 dus', 'order_list', ['indomie 2 dus']],
    ['type: Delivery_Document\nNo: SJ-1\nAqua 1 dus', 'delivery_document', ['No: SJ-1', 'Aqua 1 dus']],
    ['TYPE: payment_proof\nJumlah: Rp1.000.000\nBank: BCA', 'payment_proof', ['Jumlah: Rp1.000.000', 'Bank: BCA']],
    ['TYPE: other\nfoto etalase toko', 'other', ['foto etalase toko']],
    ['TYPE: selfie\nwajah', 'other', ['wajah']],
  ])('reads the type header of %j', (text, type, lines) => {
    expect(parsePhotoText(text)).toEqual({ type, lines });
  });

  it('reads nothing from the NO_ORDER sentinel or an empty reply', () => {
    expect(parsePhotoText('NO_ORDER')).toEqual({ type: 'other', lines: [] });
    expect(parsePhotoText('  \n')).toEqual({ type: 'order_list', lines: [] });
  });
});
