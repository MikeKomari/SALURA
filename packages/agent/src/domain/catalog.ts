import { and, eq, inArray } from '@salura/db/orm';
import { orderItems, orders, products, productSynonyms, productUnits, type Q } from '@salura/db';

// Word-level fixes for how warung owners actually type product names.
const WORD_FIXES: Record<string, string> = {
  indomi: 'indomie',
  indomei: 'indomie',
  sedap: 'sedaap',
  sedaaap: 'sedaap',
  liter: 'l',
  ltr: 'l',
  lt: 'l',
  seliter: '1l',
  kilo: 'kg',
  kg: 'kg',
  sambel: 'sambal',
  saos: 'saus',
  grg: 'goreng',
  pepsoden: 'pepsodent',
  lifeboy: 'lifebuoy',
  aqwa: 'aqua',
  akua: 'aqua',
};

// Unit words and the canonical unit they mean.
const UNIT_WORDS: Record<string, string> = {
  dus: 'dus', dos: 'dus', dusan: 'dus', karton: 'dus', ktn: 'dus', box: 'dus', kardus: 'dus',
  pcs: 'pcs', pc: 'pcs', biji: 'pcs', bks: 'pcs', bungkus: 'pcs', buah: 'pcs', btl: 'pcs', botol: 'pcs', kaleng: 'pcs', pouch: 'pcs', pck: 'pcs',
  renceng: 'renceng', renteng: 'renceng', rcg: 'renceng', rentengan: 'renceng',
  karung: 'karung', krg: 'karung', sak: 'karung', karungan: 'karung',
  pak: 'pak', pack: 'pak', pax: 'pak',
};

/** Maps a unit word ("dos", "biji", "rcg") to its canonical unit, or returns it lowercased if unknown. */
export function canonicalUnit(word: string): string {
  const w = word.trim().toLowerCase();
  return UNIT_WORDS[w] ?? w;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d+)\s*(liter|ltr|lt|l)\b/g, '$1l')
    .replace(/(\d+)\s*(kilo|kg)\b/g, '$1kg')
    .replace(/(\d+)\s*ml\b/g, '$1ml')
    .replace(/(\d+)\s*(gr|gram|g)\b/g, '$1g')
    .replace(/[^a-z0-9.,\s]/g, ' ')
    .replace(/[.,]+(?=\s|$)|(?<=\s|^)[.,]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORD_FIXES[w] ?? w)
    .join(' ');
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** Similarity between a customer phrase and a catalog alias, in [0, 1]. */
export function similarity(query: string, alias: string): number {
  const q = normalize(query);
  const a = normalize(alias);
  if (!q || !a) return 0;
  if (q === a) return 1;
  const qTokens = new Set(q.split(' '));
  const aTokens = new Set(a.split(' '));
  let score = 0.55 * dice(qTokens, aTokens) + 0.45 * dice(trigrams(q), trigrams(a));
  // Every word the customer typed appears in the alias ("indomie" ⊂ "indomie goreng").
  if ([...qTokens].every((t) => aTokens.has(t))) score = Math.max(score, 0.7 + 0.25 * (qTokens.size / aTokens.size));
  // Every alias word appears in what the customer typed ("indomie goreng yang 85").
  if ([...aTokens].every((t) => qTokens.has(t))) score = Math.max(score, 0.9);
  return Math.min(score, 1);
}

export interface CatalogCandidate {
  productId: number;
  sku: string;
  name: string;
  units: string[];
  confidence: number;
  matchedAlias: string;
  timesBoughtByCustomer: number;
}

export interface CatalogSearchResult {
  query: string;
  candidates: CatalogCandidate[];
  /** True when the top match is weak or another product scores almost the same. */
  ambiguous: boolean;
  /** When ambiguous but the customer has only ever bought one of the close candidates. */
  historyHint?: { productId: number; reason: string };
}

const AMBIGUITY_MARGIN = 0.08;
const MIN_CONFIDENCE = 0.6;

export async function searchCatalog(db: Q, query: string, customerId?: number): Promise<CatalogSearchResult> {
  const rows = await db
    .select({ productId: products.id, sku: products.sku, name: products.name, alias: productSynonyms.alias })
    .from(productSynonyms)
    .innerJoin(products, eq(products.id, productSynonyms.productId))
    .where(eq(products.active, true))
    .orderBy(productSynonyms.id);

  const best = new Map<number, { sku: string; name: string; score: number; alias: string }>();
  for (const r of rows) {
    const score = similarity(query, r.alias);
    const prev = best.get(r.productId);
    if (!prev || score > prev.score) best.set(r.productId, { sku: r.sku, name: r.name, score, alias: r.alias });
  }

  const top = [...best.entries()]
    .filter(([, v]) => v.score >= 0.35)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5);

  const ids = top.map(([id]) => id);
  const unitRows = ids.length ? await db.select().from(productUnits).where(inArray(productUnits.productId, ids)) : [];
  const bought = customerId ? await purchaseCounts(db, customerId, ids) : new Map<number, number>();

  const candidates: CatalogCandidate[] = top.map(([productId, v]) => ({
    productId,
    sku: v.sku,
    name: v.name,
    units: unitRows.filter((u) => u.productId === productId).sort((a, b) => a.factor - b.factor).map((u) => u.unit),
    confidence: Math.round(v.score * 100) / 100,
    matchedAlias: v.alias,
    timesBoughtByCustomer: bought.get(productId) ?? 0,
  }));

  const [first, second] = candidates;
  const ambiguous =
    !first || first.confidence < MIN_CONFIDENCE || (second !== undefined && first.confidence - second.confidence < AMBIGUITY_MARGIN);

  let historyHint: CatalogSearchResult['historyHint'];
  if (ambiguous && first && first.confidence >= MIN_CONFIDENCE - 0.1) {
    const close = candidates.filter((c) => first.confidence - c.confidence < AMBIGUITY_MARGIN);
    const boughtBefore = close.filter((c) => c.timesBoughtByCustomer > 0);
    if (boughtBefore.length === 1) {
      const c = boughtBefore[0]!;
      historyHint = { productId: c.productId, reason: `Customer bought ${c.name} ${c.timesBoughtByCustomer}x before; no other close match in their history` };
    }
  }

  return { query, candidates, ambiguous, historyHint };
}

async function purchaseCounts(db: Q, customerId: number, productIds: number[]): Promise<Map<number, number>> {
  if (!productIds.length) return new Map();
  const rows = await db
    .select({ productId: orderItems.productId, orderId: orderItems.orderId })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.customerId, customerId), eq(orders.status, 'confirmed'), eq(orders.guest, false), inArray(orderItems.productId, productIds)));
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.productId, (counts.get(r.productId) ?? 0) + 1);
  return counts;
}
