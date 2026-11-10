import type { OrderStatus } from '@salura/db';

export type Category = 'simple' | 'slang' | 'usual' | 'ambiguous' | 'out_of_stock' | 'over_credit' | 'payment' | 'policy' | 'escalation' | 'voice' | 'photo' | 'cancel' | 'proactive' | 'delivery';

/** A voice or photo turn carries the text a speech-to-text or vision model would return for it. */
/** A customer message, a voice note or photo (stored transcript), or the daily proactive run. */
export type Turn = string | { voice: string } | { image: string; caption?: string } | { proactive: true } | { delivery: string };

export interface EvalCase {
  id: string;
  category: Category;
  waId: string;
  turns: Turn[];
  expect: {
    /** Final order lines [sku, qty, unit], across the order and any split remainder. */
    lines?: [string, number, string][];
    /** Every agent-created order must end in one of these statuses. */
    statuses?: OrderStatus[];
    /** No order may reach confirmed or awaiting_approval. */
    noProcessedOrder?: boolean;
    /** The first reply must ask a question and nothing may be processed after it. */
    asksClarification?: boolean;
    /** The given reply (0-based) must mention these words (case-insensitive). */
    replyMentions?: { turn: number; words: string[] };
    escalated?: boolean;
    promiseToPay?: boolean;
    deliveryNote?: boolean;
    /** search_policies must have returned a source starting with this id. */
    citesPolicy?: string;
    /** Proactive run: these customers must receive a reorder offer, and these must not. */
    offered?: string[];
    notOffered?: string[];
    /** Delivery check: the expected verdict, and which follow-ups must (and must not) be queued. */
    deliveryStatus?: 'match' | 'mismatch';
    queued?: ('delivery_query' | 'invoice_adjustment' | 'payment')[];
    notQueued?: ('delivery_query' | 'invoice_adjustment' | 'payment')[];
    /** A reported payment waiting for the owner, with this amount (and allocated to these invoices). */
    payment?: { amount: number; invoices?: string[] };
    noPayment?: boolean;
  };
}

// Synthetic customers from the seed: see packages/db/src/seed/data.ts
const SARI = '6281234500001'; // tier C, buys the same 4 items, Bimoli history
const HENDRA = '6281234500002'; // tier B, close to credit limit
const RASYID = '6281234500003'; // tier C, overdue invoices
const LINA = '6281234500004'; // tier B, cleaning products, no cooking-oil history
const AGUS = '6281234500005'; // tier A minimarket, large orders
const DIMAS = '6281234500006'; // tier C, small limit, one past order
const YANTI = '6281234500007'; // tier C, bought Indomilk
const JOKO = '6281234500008'; // tier A agen sembako
const UNKNOWN = '6289999999999';

/** The bundled surat jalan sample (packages/agent/samples/surat-jalan-bu-sari.jpg.txt): Kapal Api corrected 5 → 4. */
const SARI_SURAT_JALAN = [
  'No: SJ-2026-1017 · 16/10/2026',
  'Indomie Mi Goreng 85g 2 dus [✓]',
  'Aqua 600ml 1 dus [✓]',
  'Kapal Api Special Mix 25g 5 → 4 renceng',
  'Bimoli Minyak Goreng 2L 6 pcs [✓]',
  'Catatan: kurang 1 renceng kapal api, stok di mobil habis',
].join('\n');

export const CASES: EvalCase[] = [
  // --- Clear orders ---------------------------------------------------------
  { id: 's01', category: 'simple', waId: SARI, turns: ['pesan aqua tanggung 2 dus sama kapal api mix 5 renceng', 'ya'], expect: { lines: [['AQA-600', 2, 'dus'], ['KPA-SMX-25', 5, 'renceng']], statuses: ['confirmed'] } },
  { id: 's02', category: 'simple', waId: LINA, turns: ['bu, rinso 1 dus, mama lemon 1 dus, pepsodent 12 biji', 'iya bener'], expect: { lines: [['RNS-770', 1, 'dus'], ['MML-780', 1, 'dus'], ['PPD-190', 12, 'pcs']], statuses: ['confirmed'] } },
  { id: 's03', category: 'simple', waId: YANTI, turns: ['beras sr 5kg 4 pcs, minyak bimoli seliter 6 bungkus, gula rose brand 10 bks', 'ok'], expect: { lines: [['BRS-SR-5', 4, 'pcs'], ['BML-1L', 6, 'pcs'], ['GRB-1KG', 10, 'pcs']], statuses: ['confirmed'] } },
  { id: 's04', category: 'simple', waId: DIMAS, turns: ['mas kopi kapal api 1 dos, good day 6 renceng', 'sip lanjut'], expect: { lines: [['KPA-SMX-25', 1, 'dus'], ['GDY-MOC-20', 6, 'renceng']], statuses: ['confirmed'] } },
  { id: 's05', category: 'simple', waId: JOKO, turns: ['beras setra ramos 25kg 8 karung, segitiga biru 3 dus', 'ya pak'], expect: { lines: [['BRS-SR-25', 8, 'karung'], ['TPG-SGB-1KG', 3, 'dus']], statuses: ['confirmed'] } },
  { id: 's06', category: 'over_credit', waId: RASYID, turns: ['teh botol kotak 2 dus, le minerale 3 dus, masako 10 renceng', 'ya'], expect: { lines: [['TBS-KTK-250', 2, 'dus'], ['LMN-600', 3, 'dus'], ['MSK-AYM-9', 10, 'renceng']], statuses: ['awaiting_approval'] } },
  { id: 's07', category: 'simple', waId: AGUS, turns: ['indomie soto 5 dus, aqua besar 5 dus, sambal abc 2 dus, kecap bango 2 dus', 'oke proses'], expect: { lines: [['IDM-SOTO-75', 5, 'dus'], ['AQA-1500', 5, 'dus'], ['ABC-SBL-335', 2, 'dus'], ['BNG-KCP-520', 2, 'dus']], statuses: ['confirmed'] } },
  { id: 's11', category: 'simple', waId: HENDRA, turns: ['tepung segitiga biru 2 dus aja', 'ya'], expect: { lines: [['TPG-SGB-1KG', 2, 'dus']], statuses: ['confirmed'] } },
  { id: 's12', category: 'simple', waId: JOKO, turns: ['gulaku 2 dus, sunco 2 liter 3 dus, kirim besok pagi ya', 'ya'], expect: { lines: [['GLK-1KG', 2, 'dus'], ['SNC-2L', 3, 'dus']], statuses: ['confirmed'], deliveryNote: true } },

  // --- Slang, typos, word numbers, English mixing ---------------------------
  { id: 's08', category: 'slang', waId: SARI, turns: ['indomi ayam bawang 1 dos, sedap goreng 2 dos, lifeboy 1 pak', 'y'], expect: { lines: [['IDM-AYB-69', 1, 'dus'], ['MSD-GRG-90', 2, 'dus'], ['LFB-SBN-110', 1, 'pak']], statuses: ['confirmed'] } },
  { id: 's09', category: 'slang', waId: LINA, turns: ['Hi bu, order dong: sunlight 2 box, rinso 1 box, thanks', 'yes confirm'], expect: { lines: [['SNL-755', 2, 'dus'], ['RNS-770', 1, 'dus']], statuses: ['confirmed'] } },
  { id: 's10', category: 'slang', waId: SARI, turns: ['minta aqua 600 tiga dus sama gulaku sepuluh bungkus', 'iya'], expect: { lines: [['AQA-600', 3, 'dus'], ['GLK-1KG', 10, 'pcs']], statuses: ['confirmed'] } },
  { id: 's13', category: 'slang', waId: AGUS, turns: ['pak mau ambil le mineral 10 dos + sambel abc 1 dos + odol pepsoden 2 dus', 'gas'], expect: { lines: [['LMN-600', 10, 'dus'], ['ABC-SBL-335', 1, 'dus'], ['PPD-190', 2, 'dus']], statuses: ['confirmed'] } },
  { id: 's14', category: 'slang', waId: DIMAS, turns: ['bang masako 2 renteng, tebot kotak 1 dus', 'okeee'], expect: { lines: [['MSK-AYM-9', 2, 'renceng'], ['TBS-KTK-250', 1, 'dus']], statuses: ['confirmed'] } },

  // --- "Yang biasa" ---------------------------------------------------------
  { id: 'u01', category: 'usual', waId: SARI, turns: ['kirim yang biasa ya bu', 'ya'], expect: { lines: [['IDM-GRG-85', 2, 'dus'], ['AQA-600', 1, 'dus'], ['KPA-SMX-25', 5, 'renceng'], ['GLK-1KG', 10, 'pcs']], statuses: ['confirmed'] } },
  { id: 'u03', category: 'usual', waId: DIMAS, turns: ['kayak kemarin aja mas', 'ya'], expect: { lines: [['KPA-SMX-25', 1, 'dus'], ['GDY-MOC-20', 6, 'renceng'], ['GLK-1KG', 5, 'pcs'], ['IDM-GRG-85', 1, 'dus']], statuses: ['confirmed'] } },
  { id: 'u04', category: 'usual', waId: SARI, turns: ['yang biasa tapi aqua nya 2 dus', 'ya'], expect: { lines: [['IDM-GRG-85', 2, 'dus'], ['AQA-600', 2, 'dus'], ['KPA-SMX-25', 5, 'renceng'], ['GLK-1KG', 10, 'pcs']], statuses: ['confirmed'] } },

  // --- Ambiguous items -------------------------------------------------------
  { id: 'a01', category: 'ambiguous', waId: LINA, turns: ['minyak 2 liter 1 dus'], expect: { asksClarification: true } },
  { id: 'a03', category: 'ambiguous', waId: AGUS, turns: ['indomie 5 dus'], expect: { asksClarification: true } },
  { id: 'a05', category: 'ambiguous', waId: JOKO, turns: ['gula 2 dus'], expect: { asksClarification: true } },
  { id: 'a06', category: 'ambiguous', waId: DIMAS, turns: ['aqua 2 dus'], expect: { asksClarification: true } },
  { id: 'a04', category: 'slang', waId: YANTI, turns: ['susu kaleng indomilk 1 dus', 'ya'], expect: { lines: [['IML-SKM-370', 1, 'dus']], statuses: ['confirmed'] } },
  { id: 'a07', category: 'ambiguous', waId: LINA, turns: ['minyak 2 liter 1 dus', 'yang filma aja', 'ya'], expect: { lines: [['FLM-2L', 1, 'dus']], statuses: ['confirmed'] } },

  // --- Out of stock -----------------------------------------------------------
  { id: 'a02', category: 'out_of_stock', waId: SARI, turns: ['minyak 2 liter 1 dus', 'boleh ganti sunco', 'ya'], expect: { lines: [['SNC-2L', 1, 'dus']], statuses: ['confirmed'] } },
  { id: 'o01', category: 'out_of_stock', waId: LINA, turns: ['frisian flag 1 dus', 'boleh ganti indomilk', 'ya'], expect: { lines: [['IML-SKM-370', 1, 'dus']], statuses: ['confirmed'] } },
  { id: 'o02', category: 'out_of_stock', waId: AGUS, turns: ['indomie goreng 5 dus', 'ganti mie sedaap goreng aja semua 5 dus', 'ya'], expect: { lines: [['MSD-GRG-90', 5, 'dus']], statuses: ['confirmed'] } },
  { id: 'o03', category: 'out_of_stock', waId: SARI, turns: ['bimoli 2 liter 6 bungkus'], expect: { noProcessedOrder: true, replyMentions: { turn: 0, words: ['sunco'] } } },
  { id: 'o04', category: 'out_of_stock', waId: LINA, turns: ['sunlight 5 dus', 'yaudah 3 dus aja', 'ya'], expect: { lines: [['SNL-755', 3, 'dus']], statuses: ['confirmed'] } },
  { id: 'o05', category: 'out_of_stock', waId: SARI, turns: ['bimoli 2l 6 pcs', 'ga usah deh, batal aja'], expect: { noProcessedOrder: true } },

  // --- Credit limit and approval policy ----------------------------------------
  { id: 'c01', category: 'over_credit', waId: HENDRA, turns: ['beras sr 10 karung', 'ya'], expect: { lines: [['BRS-SR-25', 10, 'karung']], statuses: ['confirmed', 'awaiting_approval'] } },
  { id: 'c02', category: 'over_credit', waId: DIMAS, turns: ['kapal api 2 dus, good day 5 dus, gulaku 2 dus', 'ya'], expect: { lines: [['KPA-SMX-25', 2, 'dus'], ['GDY-MOC-20', 5, 'dus'], ['GLK-1KG', 2, 'dus']], statuses: ['confirmed', 'awaiting_approval'] } },
  { id: 'u02', category: 'over_credit', waId: HENDRA, turns: ['seperti biasa ya', 'ya'], expect: { lines: [['BRS-SR-25', 12, 'karung'], ['GRB-1KG', 3, 'dus']], statuses: ['confirmed', 'awaiting_approval'] } },
  { id: 'c03', category: 'over_credit', waId: AGUS, turns: ['beras sr 25kg 35 karung', 'ya'], expect: { lines: [['BRS-SR-25', 35, 'karung']], statuses: ['awaiting_approval'] } },

  // --- Payments -----------------------------------------------------------------
  { id: 'p01', category: 'payment', waId: RASYID, turns: ['saya transfer hari jumat ya buat tagihan yang telat'], expect: { promiseToPay: true, noProcessedOrder: true } },
  { id: 'p02', category: 'payment', waId: DIMAS, turns: ['tagihan saya berapa ya mas?'], expect: { noProcessedOrder: true, replyMentions: { turn: 0, words: ['rp'] } } },

  // --- Policy questions (retrieval over the distributor's documents) ---------------
  { id: 'r01', category: 'policy', waId: LINA, turns: ['kalau ke cikarang dikirimnya hari apa aja ya?'], expect: { noProcessedOrder: true, replyMentions: { turn: 0, words: ['rabu', 'sabtu'] }, citesPolicy: 'pengiriman#jadwal-pengiriman-per-area' } },
  { id: 'r02', category: 'policy', waId: SARI, turns: ['bu kalau pesan sore jam 4 masih bisa dikirim besok?'], expect: { noProcessedOrder: true, citesPolicy: 'pengiriman#batas-waktu-pesanan' } },
  { id: 'r03', category: 'policy', waId: JOKO, turns: ['boleh ambil sendiri ke gudang? alamatnya dimana'], expect: { noProcessedOrder: true, replyMentions: { turn: 0, words: ['narogong'] }, citesPolicy: 'pengiriman#ambil-sendiri-di-gudang' } },
  { id: 'r04', category: 'policy', waId: DIMAS, turns: ['bayarnya bisa pake qris ga mas?'], expect: { noProcessedOrder: true, replyMentions: { turn: 0, words: ['qris'] }, citesPolicy: 'pembayaran#cara-membayar' } },

  // --- Hand-off to a human --------------------------------------------------------
  { id: 'e01', category: 'escalation', waId: SARI, turns: ['indomie yang kemarin ada yang penyok 3 bungkus, bisa retur?'], expect: { escalated: true, noProcessedOrder: true, replyMentions: { turn: 0, words: ['foto'] }, citesPolicy: 'retur' } },
  { id: 'e02', category: 'escalation', waId: UNKNOWN, turns: ['halo mau pesan aqua 2 dus'], expect: { escalated: true, noProcessedOrder: true } },
  { id: 'e03', category: 'escalation', waId: LINA, turns: ['bisa kurangi harga rinso jadi 250rb per dus?'], expect: { escalated: true, noProcessedOrder: true } },
  { id: 'e04', category: 'escalation', waId: SARI, turns: ['siapa presiden indonesia sekarang?'], expect: { noProcessedOrder: true } },

  // --- Voice notes (stored transcripts stand in for speech-to-text) -----------------
  { id: 'v01', category: 'voice', waId: SARI, turns: [{ voice: 'bu ini sari, mau pesen aqua tanggung dua dus sama kapal api lima renceng ya' }, 'ya'], expect: { lines: [['AQA-600', 2, 'dus'], ['KPA-SMX-25', 5, 'renceng']], statuses: ['confirmed'] } },
  { id: 'v02', category: 'voice', waId: JOKO, turns: [{ voice: 'pak saya mau ambil beras setra ramos sepuluh karung sama gula rose brand dua dus' }, 'ya'], expect: { lines: [['BRS-SR-25', 10, 'karung'], ['GRB-1KG', 2, 'dus']], statuses: ['confirmed'] } },
  { id: 'v03', category: 'voice', waId: LINA, turns: [{ voice: 'mbak tolong rinso sedus, sunlight sedus, odol pepsodent dua belas biji' }, 'iya'], expect: { lines: [['RNS-770', 1, 'dus'], ['SNL-755', 1, 'dus'], ['PPD-190', 12, 'pcs']], statuses: ['confirmed'] } },

  // --- Photos of order lists (stored text stands in for the vision model) -----------------
  { id: 'i01', category: 'photo', waId: JOKO, turns: [{ image: 'Beras SR 25kg - 8 krg\nTepung segitiga biru 3 dus' }, 'ya'], expect: { lines: [['BRS-SR-25', 8, 'karung'], ['TPG-SGB-1KG', 3, 'dus']], statuses: ['confirmed'] } },
  { id: 'i02', category: 'photo', waId: YANTI, turns: [{ image: 'beras sr 5kg 4 pcs\nminyak bimoli 1L 6 bks\n[?] 10 bks' }], expect: { asksClarification: true } },

  // --- Proactive reorder (agent acts without being asked) ---------------------------
  // Yanti (every ~14 days, last 18 days ago) and Dimas (every ~14, last 13) are due; everyone else
  // must be skipped: not due yet, or Pak Rasyid's invoice is 21 days overdue.
  { id: 'pr01', category: 'proactive', waId: YANTI, turns: [{ proactive: true }], expect: { offered: [YANTI, DIMAS], notOffered: [SARI, HENDRA, RASYID, LINA, AGUS, JOKO] } },
  // Yanti already has an open draft from a message, so offering her again would be spam.
  { id: 'pr02', category: 'proactive', waId: YANTI, turns: ['aqua tanggung 1 dus', { proactive: true }], expect: { offered: [DIMAS], notOffered: [YANTI, RASYID] } },

  // --- Delivery documents (photo of surat jalan / nota vs order vs invoice) -----------
  // Beras corrected 12 → 10 karung on the nota: ask the warehouse and correct the invoice.
  { id: 'd01', category: 'delivery', waId: HENDRA, turns: [{ delivery: 'nota-toko-makmur-jaya' }], expect: { deliveryStatus: 'mismatch', queued: ['delivery_query', 'invoice_adjustment'] } },
  // Kapal Api corrected 5 → 4 renceng on the surat jalan.
  { id: 'd02', category: 'delivery', waId: SARI, turns: [{ delivery: 'surat-jalan-bu-sari' }], expect: { deliveryStatus: 'mismatch', queued: ['delivery_query', 'invoice_adjustment'] } },
  // Everything delivered: no false alarm, nothing queued.
  { id: 'd03', category: 'delivery', waId: JOKO, turns: [{ delivery: 'surat-jalan-pak-joko' }], expect: { deliveryStatus: 'match', notQueued: ['delivery_query', 'invoice_adjustment'] } },
  // The customer reports the shortage from the chat with a photo of the surat jalan: same check, same follow-ups.
  {
    id: 'd04',
    category: 'delivery',
    waId: SARI,
    turns: [{ image: `TYPE: delivery_document\n${SARI_SURAT_JALAN}`, caption: 'kapal apinya kurang 1 renceng pak, ini surat jalannya' }],
    expect: { deliveryStatus: 'mismatch', queued: ['delivery_query', 'invoice_adjustment'], noProcessedOrder: true, noPayment: true },
  },

  // --- Payments reported in the chat (transfer receipts) ---------------------------------
  // Bu Sari pays her open invoice (INV-00003, Rp624.100) with a receipt photo: recorded for the owner, never marked paid.
  {
    id: 'p03',
    category: 'payment',
    waId: SARI,
    turns: [{ image: 'TYPE: payment_proof\nJumlah: Rp 624.100\nTanggal: 20 Okt 2026 09:14 WIB\nBank: BCA m-Transfer\nReferensi: 2010MT0091447\nPengirim: SARI WULANDARI\nPenerima: CV SUMBER REJEKI', caption: 'pak sudah saya transfer ya' }],
    expect: { payment: { amount: 624_100, invoices: ['INV-00003'] }, queued: ['payment'], noProcessedOrder: true },
  },
  // Partial payment without naming an invoice: applied to the oldest due invoice first.
  {
    id: 'p04',
    category: 'payment',
    waId: HENDRA,
    turns: [{ image: 'TYPE: payment_proof\nJumlah: Rp5.000.000\nTanggal: 19/10/2026\nBank: Mandiri\nPengirim: HENDRA GUNAWAN\nPenerima: CV SUMBER REJEKI' }],
    expect: { payment: { amount: 5_000_000, invoices: ['INV-00005'] }, queued: ['payment'], noProcessedOrder: true },
  },
  // The amount typed instead of a photo.
  { id: 'p05', category: 'payment', waId: SARI, turns: ['pak tagihan yang kemarin sudah saya transfer 624.100 ya, lewat bca'], expect: { payment: { amount: 624_100 }, noProcessedOrder: true } },
  // "Sudah transfer" with no amount and no proof: ask for it, record nothing.
  { id: 'p06', category: 'payment', waId: HENDRA, turns: ['pak sudah saya transfer kemarin ya'], expect: { noPayment: true, noProcessedOrder: true, replyMentions: { turn: 0, words: ['bukti'] } } },
  // A photo that is neither an order nor a receipt: no order, no payment.
  { id: 'i03', category: 'photo', waId: LINA, turns: [{ image: 'TYPE: other\nFoto rak toko yang berisi deterjen dan sabun' }], expect: { noProcessedOrder: true, noPayment: true } },

  // --- Cancellation -------------------------------------------------------------------
  { id: 'x01', category: 'cancel', waId: SARI, turns: ['aqua tanggung 2 dus', 'eh batal deh'], expect: { noProcessedOrder: true } },
];
