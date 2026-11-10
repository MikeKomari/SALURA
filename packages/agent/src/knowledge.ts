import { knowledgeFiles } from './assets.ts';

export interface PolicyChunk {
  /** Stable citation id, e.g. "retur#batas-waktu-retur". */
  source: string;
  document: string;
  section: string;
  text: string;
}

export interface PolicyHit extends PolicyChunk {
  score: number;
}

// Words customers use that the policy text phrases differently.
const EXPANSIONS: Record<string, string[]> = {
  retur: ['rusak', 'penyok', 'bocor', 'tukar', 'kembalikan', 'komplain'],
  rusak: ['retur', 'penyok', 'bocor'],
  penyok: ['rusak', 'retur'],
  kirim: ['pengiriman', 'jadwal', 'antar', 'armada'],
  antar: ['pengiriman', 'kirim'],
  datang: ['pengiriman', 'jadwal'],
  kapan: ['jadwal', 'hari'],
  jam: ['pukul', 'batas', 'waktu'],
  sore: ['pukul', 'batas', 'waktu'],
  malam: ['pukul', 'batas', 'waktu'],
  besok: ['jadwal', 'berikutnya', 'batas'],
  telat: ['batas', 'waktu', 'terlambat'],
  bayar: ['pembayaran', 'transfer', 'tagihan'],
  transfer: ['pembayaran', 'rekening', 'bayar'],
  rekening: ['transfer', 'pembayaran'],
  tagihan: ['pembayaran', 'tempo', 'jatuh'],
  diskon: ['potongan', 'harga'],
  potongan: ['diskon', 'harga'],
  murah: ['potongan', 'harga'],
  ambil: ['gudang', 'sendiri'],
  gudang: ['ambil'],
  batal: ['membatalkan', 'ubah'],
  ganti: ['pengganti', 'ubah'],
  minimal: ['kecil', 'pesanan'],
  buka: ['jam', 'layanan'],
  admin: ['layanan', 'jam'],
};

const STOPWORDS = new Set(
  'yang dan di ke dari untuk dengan pada atau ini itu ada akan bisa tidak sudah juga saya kami kita mau ya pak bu mas mbak dong deh sih kak'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => w.replace(/(nya|lah|kah)$/, '').replace(/^di(?=[a-z]{4,})/, ''))
    .filter(Boolean);
}

/** Splits each markdown file into one chunk per "## " section, so every answer cites a specific section. */
export function loadPolicies(files = knowledgeFiles()): PolicyChunk[] {
  const chunks: PolicyChunk[] = [];
  for (const { name: file, content: raw } of files) {
    const document = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? file;
    const doc = file.replace(/\.md$/, '');
    for (const part of raw.split(/^##\s+/m).slice(1)) {
      const [heading = '', ...body] = part.split('\n');
      const section = heading.trim();
      chunks.push({ source: `${doc}#${slug(section)}`, document, section, text: body.join('\n').trim() });
    }
  }
  return chunks;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * BM25 retrieval over the distributor's policy documents. Lexical on purpose: the corpus is small,
 * written in the distributor's own words, and every result must be explainable to an auditor.
 */
export class PolicyIndex {
  private readonly docs: { chunk: PolicyChunk; terms: Map<string, number>; length: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(readonly chunks: PolicyChunk[] = loadPolicies()) {
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(`${chunk.section} ${chunk.section} ${chunk.text}`);
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { chunk, terms, length: tokens.length };
    });
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, limit = 3): PolicyHit[] {
    const base = tokenize(query);
    const weights = new Map<string, number>();
    for (const t of base) weights.set(t, 1);
    for (const t of base) for (const e of EXPANSIONS[t] ?? []) if (!weights.has(e)) weights.set(e, 0.5);

    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    return this.docs
      .map(({ chunk, terms, length }) => {
        let score = 0;
        for (const [term, w] of weights) {
          const tf = terms.get(term);
          if (!tf) continue;
          const idf = Math.log(1 + (n - this.df.get(term)! + 0.5) / (this.df.get(term)! + 0.5));
          score += w * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / this.avgLength)));
        }
        return { ...chunk, score: Math.round(score * 100) / 100 };
      })
      .filter((h) => h.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
