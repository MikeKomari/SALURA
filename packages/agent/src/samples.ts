import { and, eq } from '@salura/db/orm';
import { customers, first, orderItems, orders, products, type Q } from '@salura/db';
import { sampleFile } from './assets.ts';
import { saveMedia } from './media.ts';

/** Bundled delivery documents for the seeded demo orders, each with a stored transcript next to it. */
export interface DeliverySample {
  id: string;
  title: string;
  kind: 'surat_jalan' | 'nota';
  file: string;
  customerWaId: string;
  /** The seeded order this document belongs to, as [sku, qty, unit]. */
  orderLines: [string, number, string][];
}

export const DELIVERY_SAMPLES: DeliverySample[] = [
  {
    id: 'surat-jalan-bu-sari',
    title: 'Surat jalan Warung Bu Sari: Kapal Api dikoreksi 5 → 4 renceng',
    kind: 'surat_jalan',
    file: 'surat-jalan-bu-sari.jpg',
    customerWaId: '6281234500001',
    orderLines: [['IDM-GRG-85', 2, 'dus'], ['AQA-600', 1, 'dus'], ['KPA-SMX-25', 5, 'renceng'], ['BML-2L', 6, 'pcs']],
  },
  {
    id: 'nota-toko-makmur-jaya',
    title: 'Nota Toko Makmur Jaya: beras turun 10 dari 12 karung',
    kind: 'nota',
    file: 'nota-toko-makmur-jaya.jpg',
    customerWaId: '6281234500002',
    orderLines: [['BRS-SR-25', 12, 'karung'], ['FLM-2L', 3, 'dus'], ['TPG-SGB-1KG', 4, 'dus']],
  },
  {
    id: 'surat-jalan-pak-joko',
    title: 'Surat jalan Agen Sembako Pak Joko: semua sesuai',
    kind: 'surat_jalan',
    file: 'surat-jalan-pak-joko.jpg',
    customerWaId: '6281234500008',
    orderLines: [['BRS-SR-25', 10, 'karung'], ['GLK-1KG', 3, 'dus']],
  },
];

/** The confirmed order a sample document belongs to, if it exists in this database. */
export async function sampleOrderId(db: Q, sample: DeliverySample): Promise<number | null> {
  const customer = await first(db.select().from(customers).where(eq(customers.waId, sample.customerWaId)));
  if (!customer) return null;
  const want = sample.orderLines.map(([sku, qty, unit]) => `${sku}|${qty}|${unit}`).sort().join(',');
  for (const o of await db.select().from(orders).where(and(eq(orders.customerId, customer.id), eq(orders.status, 'confirmed'), eq(orders.guest, false))).orderBy(orders.id)) {
    const have = (
      await db
        .select({ sku: products.sku, qty: orderItems.qty, unit: orderItems.unit })
        .from(orderItems)
        .innerJoin(products, eq(products.id, orderItems.productId))
        .where(eq(orderItems.orderId, o.id))
    )
      .map((l) => `${l.sku}|${l.qty}|${l.unit}`)
      .sort()
      .join(',');
    if (have === want) return o.id;
  }
  return null;
}

/** The sample photo, as served to the console. */
export function samplePhoto(sample: DeliverySample): Buffer {
  return sampleFile(sample.file);
}

/** Stores a copy of the sample photo with its transcript, so the check works without a vision provider. */
export function storeSample(db: Q, sample: DeliverySample): Promise<string> {
  return saveMedia(db, { id: `sample-${sample.id}`, data: sampleFile(sample.file), mime: 'image/jpeg', sidecarText: sampleFile(`${sample.file}.txt`).toString('utf8') });
}

/** Photos a warung owner would send in the chat, with stored transcripts, for trying the after-sales flows without a vision provider. */
export interface ChatSample {
  id: string;
  label: string;
  file: string;
  customerWaId: string;
  /** What the customer types with the photo. */
  caption: string;
  /** Prepended to the stored transcript: tells the reader what kind of photo it is (see parsePhotoText). */
  type: 'payment_proof' | 'delivery_document';
}

export const CHAT_SAMPLES: ChatSample[] = [
  {
    id: 'bukti-transfer-bu-sari',
    label: 'Kirim contoh bukti transfer',
    file: 'bukti-transfer-bu-sari.jpg',
    customerWaId: '6281234500001',
    caption: 'pak sudah saya transfer ya buat tagihan yang kemarin',
    type: 'payment_proof',
  },
  {
    id: 'surat-jalan-bu-sari',
    label: 'Kirim contoh surat jalan (barang kurang)',
    file: 'surat-jalan-bu-sari.jpg',
    customerWaId: '6281234500001',
    caption: 'kapal apinya kurang 1 renceng pak, ini surat jalannya',
    type: 'delivery_document',
  },
];

/** Stores a chat sample photo with its transcript (typed, as the chat photo reader would return it). */
export function storeChatSample(db: Q, sample: ChatSample): Promise<string> {
  const text = sampleFile(`${sample.file}.txt`).toString('utf8').replace(/^TYPE:.*\n/, '');
  return saveMedia(db, { id: `chat-sample-${sample.id}`, data: sampleFile(sample.file), mime: 'image/jpeg', sidecarText: `TYPE: ${sample.type}\n${text}` });
}

export function chatSamplePhoto(sample: ChatSample): Buffer {
  return sampleFile(sample.file);
}

/** A bank statement export (KlikBCA CSV) for the seeded demo, to try bank statement matching in one click. */
export const BANK_STATEMENT_SAMPLE = 'mutasi-bca-contoh.csv';

export function bankStatementSample(): string {
  return sampleFile(BANK_STATEMENT_SAMPLE).toString('utf8');
}
