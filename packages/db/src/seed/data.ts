// Synthetic demo data for a fictional FMCG distributor in Bekasi ("CV Sumber Rejeki").
// Prices are illustrative, not a real price list.

export interface SeedProduct {
  sku: string;
  name: string;
  brand: string;
  category: string;
  baseUnit: string;
  /** Tier C price per base unit (IDR). Tiers B and A get a discount. */
  basePrice: number;
  /** Extra sale units and how many base units each holds. */
  units: Record<string, number>;
  /** Stock on hand in base units. */
  stock: number;
  aliases: string[];
}

export const TIER_DISCOUNT: Record<string, number> = { A: 0.96, B: 0.98, C: 1 };

export const PRODUCTS: SeedProduct[] = [
  { sku: 'IDM-GRG-85', name: 'Indomie Mi Goreng 85g', brand: 'Indomie', category: 'mi instan', baseUnit: 'pcs', basePrice: 3050, units: { dus: 40 }, stock: 80, aliases: ['indomie goreng', 'indomi goreng', 'mie goreng indomie', 'im goreng', 'indomie grg', 'indomi grg'] },
  { sku: 'IDM-SOTO-75', name: 'Indomie Soto Mie 75g', brand: 'Indomie', category: 'mi instan', baseUnit: 'pcs', basePrice: 2900, units: { dus: 40 }, stock: 1600, aliases: ['indomie soto', 'indomi soto', 'mie soto indomie'] },
  { sku: 'IDM-AYB-69', name: 'Indomie Ayam Bawang 69g', brand: 'Indomie', category: 'mi instan', baseUnit: 'pcs', basePrice: 2850, units: { dus: 40 }, stock: 1200, aliases: ['indomie ayam bawang', 'indomi ayam bawang', 'indomie kuah ayam bawang'] },
  { sku: 'MSD-GRG-90', name: 'Mie Sedaap Goreng 90g', brand: 'Mie Sedaap', category: 'mi instan', baseUnit: 'pcs', basePrice: 2950, units: { dus: 40 }, stock: 2000, aliases: ['mie sedaap goreng', 'sedap goreng', 'mi sedap goreng', 'sedaap goreng'] },
  { sku: 'MSD-SOTO-75', name: 'Mie Sedaap Soto 75g', brand: 'Mie Sedaap', category: 'mi instan', baseUnit: 'pcs', basePrice: 2800, units: { dus: 40 }, stock: 1200, aliases: ['mie sedaap soto', 'sedap soto', 'mi sedap soto'] },
  { sku: 'BML-2L', name: 'Bimoli Minyak Goreng 2L Pouch', brand: 'Bimoli', category: 'minyak goreng', baseUnit: 'pcs', basePrice: 38500, units: { dus: 6 }, stock: 0, aliases: ['bimoli 2 liter', 'bimoli 2l', 'minyak bimoli 2 liter', 'bimoli dua liter'] },
  { sku: 'BML-1L', name: 'Bimoli Minyak Goreng 1L Pouch', brand: 'Bimoli', category: 'minyak goreng', baseUnit: 'pcs', basePrice: 19800, units: { dus: 12 }, stock: 240, aliases: ['bimoli 1 liter', 'bimoli 1l', 'minyak bimoli 1 liter', 'bimoli seliter'] },
  { sku: 'SNC-2L', name: 'Sunco Minyak Goreng 2L Pouch', brand: 'Sunco', category: 'minyak goreng', baseUnit: 'pcs', basePrice: 37000, units: { dus: 6 }, stock: 180, aliases: ['sunco 2 liter', 'sunco 2l', 'minyak sunco 2 liter'] },
  { sku: 'FLM-2L', name: 'Filma Minyak Goreng 2L Pouch', brand: 'Filma', category: 'minyak goreng', baseUnit: 'pcs', basePrice: 37500, units: { dus: 6 }, stock: 120, aliases: ['filma 2 liter', 'filma 2l', 'minyak filma 2 liter'] },
  { sku: 'GLK-1KG', name: 'Gulaku Gula Pasir Premium 1kg', brand: 'Gulaku', category: 'gula', baseUnit: 'pcs', basePrice: 17500, units: { dus: 20 }, stock: 600, aliases: ['gulaku', 'gulaku 1 kilo', 'gula kuning gulaku'] },
  { sku: 'GRB-1KG', name: 'Gula Pasir Rose Brand 1kg', brand: 'Rose Brand', category: 'gula', baseUnit: 'pcs', basePrice: 17000, units: { dus: 20 }, stock: 800, aliases: ['gula rose brand', 'gula rosebrand', 'gula 1 kilo rose brand'] },
  { sku: 'BRS-SR-25', name: 'Beras Setra Ramos 25kg', brand: 'Setra Ramos', category: 'beras', baseUnit: 'karung', basePrice: 345000, units: {}, stock: 60, aliases: ['beras setra ramos', 'beras sr', 'setra ramos 25', 'beras sr karungan'] },
  { sku: 'BRS-SR-5', name: 'Beras Setra Ramos 5kg', brand: 'Setra Ramos', category: 'beras', baseUnit: 'pcs', basePrice: 71000, units: {}, stock: 150, aliases: ['beras setra ramos 5 kilo', 'beras sr 5kg', 'beras 5 kilo'] },
  { sku: 'TPG-SGB-1KG', name: 'Tepung Terigu Segitiga Biru 1kg', brand: 'Bogasari', category: 'tepung', baseUnit: 'pcs', basePrice: 13000, units: { dus: 12 }, stock: 360, aliases: ['segitiga biru', 'tepung segitiga', 'terigu segitiga biru'] },
  { sku: 'AQA-600', name: 'Aqua Air Mineral 600ml', brand: 'Aqua', category: 'minuman', baseUnit: 'pcs', basePrice: 3400, units: { dus: 24 }, stock: 2400, aliases: ['aqua 600', 'aqua tanggung', 'aqua botol tanggung', 'aqua sedang', 'aqua 600ml'] },
  { sku: 'AQA-1500', name: 'Aqua Air Mineral 1500ml', brand: 'Aqua', category: 'minuman', baseUnit: 'pcs', basePrice: 5800, units: { dus: 12 }, stock: 600, aliases: ['aqua besar', 'aqua 1.5', 'aqua 1500', 'aqua 1,5 liter'] },
  { sku: 'LMN-600', name: 'Le Minerale 600ml', brand: 'Le Minerale', category: 'minuman', baseUnit: 'pcs', basePrice: 3100, units: { dus: 24 }, stock: 1920, aliases: ['le minerale', 'leminerale', 'le mineral 600'] },
  { sku: 'TBS-KTK-250', name: 'Teh Botol Sosro Kotak 250ml', brand: 'Sosro', category: 'minuman', baseUnit: 'pcs', basePrice: 3300, units: { dus: 24 }, stock: 960, aliases: ['teh botol kotak', 'tebot kotak', 'teh kotak sosro', 'teh botol'] },
  { sku: 'KPA-SMX-25', name: 'Kopi Kapal Api Special Mix 25g', brand: 'Kapal Api', category: 'kopi', baseUnit: 'pcs', basePrice: 1350, units: { renceng: 10, dus: 120 }, stock: 3600, aliases: ['kapal api mix', 'kopi kapal api', 'kapal api special mix', 'kapal api renceng'] },
  { sku: 'GDY-MOC-20', name: 'Good Day Mocacinno 20g', brand: 'Good Day', category: 'kopi', baseUnit: 'pcs', basePrice: 1450, units: { renceng: 10, dus: 120 }, stock: 2400, aliases: ['good day', 'goodday', 'good day moka', 'good day mocacino'] },
  { sku: 'BNG-KCP-520', name: 'Kecap Manis Bango 520ml Pouch', brand: 'Bango', category: 'bumbu', baseUnit: 'pcs', basePrice: 23500, units: { dus: 12 }, stock: 240, aliases: ['kecap bango', 'bango 520', 'kecap manis bango'] },
  { sku: 'ABC-SBL-335', name: 'Saus Sambal ABC 335ml', brand: 'ABC', category: 'bumbu', baseUnit: 'pcs', basePrice: 11500, units: { dus: 24 }, stock: 480, aliases: ['sambal abc', 'sambel abc', 'saos sambal abc', 'saus abc'] },
  { sku: 'MSK-AYM-9', name: 'Masako Kaldu Ayam 9g', brand: 'Masako', category: 'bumbu', baseUnit: 'pcs', basePrice: 500, units: { renceng: 12, dus: 240 }, stock: 4800, aliases: ['masako', 'masako ayam', 'kaldu masako'] },
  { sku: 'RNS-770', name: 'Rinso Anti Noda Deterjen Bubuk 770g', brand: 'Rinso', category: 'kebersihan', baseUnit: 'pcs', basePrice: 23000, units: { dus: 12 }, stock: 240, aliases: ['rinso', 'rinso 770', 'deterjen rinso', 'rinso bubuk'] },
  { sku: 'SNL-755', name: 'Sunlight Jeruk Nipis 755ml Pouch', brand: 'Sunlight', category: 'kebersihan', baseUnit: 'pcs', basePrice: 15500, units: { dus: 12 }, stock: 36, aliases: ['sunlight', 'sunlight jeruk nipis', 'sabun cuci piring sunlight', 'sunlight 755'] },
  { sku: 'MML-780', name: 'Mama Lemon Jeruk Nipis 780ml Pouch', brand: 'Mama Lemon', category: 'kebersihan', baseUnit: 'pcs', basePrice: 14000, units: { dus: 12 }, stock: 300, aliases: ['mama lemon', 'mamalemon', 'sabun cuci piring mama lemon'] },
  { sku: 'LFB-SBN-110', name: 'Lifebuoy Sabun Batang 110g', brand: 'Lifebuoy', category: 'kebersihan', baseUnit: 'pcs', basePrice: 3900, units: { pak: 4, dus: 72 }, stock: 720, aliases: ['lifebuoy', 'sabun lifebuoy', 'lifeboy batang'] },
  { sku: 'PPD-190', name: 'Pepsodent Pasta Gigi 190g', brand: 'Pepsodent', category: 'kebersihan', baseUnit: 'pcs', basePrice: 13500, units: { dus: 48 }, stock: 480, aliases: ['pepsodent', 'odol pepsodent', 'pepsodent 190', 'pepsoden'] },
  { sku: 'FFL-SKM-370', name: 'Frisian Flag Kental Manis 370g Kaleng', brand: 'Frisian Flag', category: 'susu', baseUnit: 'pcs', basePrice: 11800, units: { dus: 48 }, stock: 0, aliases: ['susu bendera', 'frisian flag', 'skm frisian flag', 'susu kental manis bendera', 'susu kaleng bendera'] },
  { sku: 'IML-SKM-370', name: 'Indomilk Kental Manis 370g Kaleng', brand: 'Indomilk', category: 'susu', baseUnit: 'pcs', basePrice: 11500, units: { dus: 48 }, stock: 960, aliases: ['indomilk kental manis', 'susu indomilk', 'skm indomilk', 'susu kaleng indomilk'] },
];

/** Distributor-approved substitutes: [original sku, substitute sku in preference order]. */
export const SUBSTITUTES: [string, string[]][] = [
  ['IDM-GRG-85', ['MSD-GRG-90']],
  ['IDM-SOTO-75', ['MSD-SOTO-75']],
  ['BML-2L', ['SNC-2L', 'FLM-2L']],
  ['BML-1L', ['SNC-2L']],
  ['AQA-600', ['LMN-600']],
  ['SNL-755', ['MML-780']],
  ['FFL-SKM-370', ['IML-SKM-370']],
  ['GLK-1KG', ['GRB-1KG']],
];

export interface SeedCustomer {
  name: string;
  ownerName: string;
  honorific: string;
  waId: string;
  tier: 'A' | 'B' | 'C';
  creditLimit: number;
  paymentTermDays: number;
  area: string;
  address: string;
  reminderTone: 'friendly' | 'neutral' | 'firm';
  /** Past orders: days ago + lines [sku, qty, unit]. */
  history: { daysAgo: number; lines: [string, number, string][]; paid: boolean }[];
}

export const CUSTOMERS: SeedCustomer[] = [
  {
    name: 'Warung Bu Sari', ownerName: 'Sari Wulandari', honorific: 'Bu', waId: '6281234500001', tier: 'C', creditLimit: 5_000_000, paymentTermDays: 14,
    area: 'Bekasi Timur', address: 'Jl. Melati No. 12, Bekasi Timur', reminderTone: 'friendly',
    history: [
      { daysAgo: 30, paid: true, lines: [['IDM-GRG-85', 2, 'dus'], ['AQA-600', 1, 'dus'], ['KPA-SMX-25', 5, 'renceng'], ['GLK-1KG', 10, 'pcs']] },
      { daysAgo: 16, paid: true, lines: [['IDM-GRG-85', 2, 'dus'], ['AQA-600', 1, 'dus'], ['KPA-SMX-25', 5, 'renceng'], ['GLK-1KG', 10, 'pcs']] },
      { daysAgo: 5, paid: false, lines: [['IDM-GRG-85', 2, 'dus'], ['AQA-600', 1, 'dus'], ['KPA-SMX-25', 5, 'renceng'], ['BML-2L', 6, 'pcs']] },
    ],
  },
  {
    name: 'Toko Makmur Jaya', ownerName: 'Hendra Gunawan', honorific: 'Pak', waId: '6281234500002', tier: 'B', creditLimit: 15_000_000, paymentTermDays: 30,
    area: 'Bekasi Barat', address: 'Jl. Ahmad Yani No. 88, Bekasi Barat', reminderTone: 'neutral',
    history: [
      { daysAgo: 40, paid: true, lines: [['BRS-SR-25', 10, 'karung'], ['BML-2L', 3, 'dus'], ['GRB-1KG', 2, 'dus']] },
      { daysAgo: 20, paid: false, lines: [['BRS-SR-25', 15, 'karung'], ['SNC-2L', 4, 'dus'], ['GRB-1KG', 3, 'dus'], ['IDM-SOTO-75', 5, 'dus']] },
      { daysAgo: 8, paid: false, lines: [['BRS-SR-25', 12, 'karung'], ['FLM-2L', 3, 'dus'], ['TPG-SGB-1KG', 4, 'dus']] },
    ],
  },
  {
    name: 'Warung Madura Pak Rasyid', ownerName: 'Abdul Rasyid', honorific: 'Pak', waId: '6281234500003', tier: 'C', creditLimit: 4_000_000, paymentTermDays: 7,
    area: 'Tambun', address: 'Jl. Raya Tambun No. 5', reminderTone: 'firm',
    history: [
      { daysAgo: 28, paid: false, lines: [['AQA-600', 3, 'dus'], ['TBS-KTK-250', 2, 'dus'], ['GDY-MOC-20', 10, 'renceng'], ['IDM-AYB-69', 2, 'dus']] },
      { daysAgo: 12, paid: false, lines: [['AQA-600', 2, 'dus'], ['LFB-SBN-110', 1, 'dus'], ['MSK-AYM-9', 10, 'renceng']] },
    ],
  },
  {
    name: 'Toko Berkah', ownerName: 'Lina Marlina', honorific: 'Bu', waId: '6281234500004', tier: 'B', creditLimit: 10_000_000, paymentTermDays: 14,
    area: 'Cikarang', address: 'Ruko Cikarang Baru Blok C3', reminderTone: 'friendly',
    history: [
      { daysAgo: 21, paid: true, lines: [['RNS-770', 1, 'dus'], ['SNL-755', 1, 'dus'], ['PPD-190', 12, 'pcs'], ['LFB-SBN-110', 4, 'pak']] },
      { daysAgo: 7, paid: false, lines: [['RNS-770', 1, 'dus'], ['SNL-755', 1, 'dus'], ['FFL-SKM-370', 1, 'dus']] },
    ],
  },
  {
    name: 'Minimarket Sinar Pagi', ownerName: 'Agus Salim', honorific: 'Pak', waId: '6281234500005', tier: 'A', creditLimit: 40_000_000, paymentTermDays: 30,
    area: 'Bekasi Utara', address: 'Jl. Kaliabang No. 21', reminderTone: 'neutral',
    history: [
      { daysAgo: 25, paid: true, lines: [['IDM-GRG-85', 10, 'dus'], ['IDM-SOTO-75', 5, 'dus'], ['AQA-600', 10, 'dus'], ['AQA-1500', 5, 'dus'], ['BNG-KCP-520', 2, 'dus']] },
      { daysAgo: 10, paid: false, lines: [['IDM-GRG-85', 8, 'dus'], ['MSD-GRG-90', 4, 'dus'], ['LMN-600', 10, 'dus'], ['ABC-SBL-335', 2, 'dus']] },
    ],
  },
  {
    name: 'Warung Kopi Mas Dimas', ownerName: 'Dimas Prasetyo', honorific: 'Mas', waId: '6281234500006', tier: 'C', creditLimit: 2_000_000, paymentTermDays: 7,
    area: 'Bekasi Timur', address: 'Gg. Kenanga No. 3', reminderTone: 'friendly',
    history: [
      { daysAgo: 27, paid: true, lines: [['KPA-SMX-25', 1, 'dus'], ['GDY-MOC-20', 6, 'renceng'], ['GLK-1KG', 5, 'pcs'], ['IDM-GRG-85', 1, 'dus']] },
      { daysAgo: 13, paid: false, lines: [['KPA-SMX-25', 1, 'dus'], ['GDY-MOC-20', 6, 'renceng'], ['GLK-1KG', 5, 'pcs'], ['IDM-GRG-85', 1, 'dus']] },
    ],
  },
  {
    name: 'Toko Kelontong Bu Yanti', ownerName: 'Yanti Susilowati', honorific: 'Bu', waId: '6281234500007', tier: 'C', creditLimit: 3_000_000, paymentTermDays: 14,
    area: 'Cibitung', address: 'Jl. Sentosa No. 40, Cibitung', reminderTone: 'friendly',
    history: [
      { daysAgo: 32, paid: true, lines: [['BRS-SR-5', 4, 'pcs'], ['BML-1L', 6, 'pcs'], ['GRB-1KG', 10, 'pcs'], ['IML-SKM-370', 12, 'pcs']] },
      { daysAgo: 18, paid: true, lines: [['BRS-SR-5', 4, 'pcs'], ['BML-1L', 6, 'pcs'], ['GRB-1KG', 10, 'pcs'], ['IML-SKM-370', 12, 'pcs']] },
    ],
  },
  {
    name: 'Agen Sembako Pak Joko', ownerName: 'Joko Santoso', honorific: 'Pak', waId: '6281234500008', tier: 'A', creditLimit: 30_000_000, paymentTermDays: 14,
    area: 'Setu', address: 'Pasar Setu Blok A No. 7', reminderTone: 'neutral',
    history: [
      { daysAgo: 24, paid: false, lines: [['BRS-SR-25', 20, 'karung'], ['GRB-1KG', 5, 'dus'], ['SNC-2L', 5, 'dus'], ['TPG-SGB-1KG', 5, 'dus']] },
      { daysAgo: 6, paid: false, lines: [['BRS-SR-25', 10, 'karung'], ['GLK-1KG', 3, 'dus']] },
    ],
  },
];

/** Distributor staff the agent may message about deliveries (synthetic numbers). */
export const STAFF = [
  { role: 'warehouse', name: 'Dedi (Kepala Gudang)', waId: '6281234509001' },
  { role: 'driver', name: 'Pak Udin (Sopir)', waId: '6281234509002' },
] as const;

/** Default autonomy: small orders go straight through, credit overrides and reminders need the owner. */
export const AUTONOMY_DEFAULTS = [
  { action: 'confirm_order', mode: 'auto', maxAutoAmount: 10_000_000 },
  { action: 'over_credit_order', mode: 'approve', maxAutoAmount: null },
  { action: 'send_reminder', mode: 'approve', maxAutoAmount: null },
  { action: 'send_reorder_nudge', mode: 'approve', maxAutoAmount: null },
] as const;

/** Delivery days per area (0 = Sunday), as published in knowledge/pengiriman.md. */
export const DELIVERY_DAYS: Record<string, number[]> = {
  'Bekasi Timur': [1, 3, 5],
  'Bekasi Utara': [1, 3, 5],
  'Bekasi Barat': [2, 4, 6],
  Tambun: [3, 6],
  Cibitung: [3, 6],
  Cikarang: [3, 6],
  Setu: [3, 6],
};

/** Console accounts created on first start when none exist. Passwords come from the environment. */
export const DEFAULT_ACCOUNTS = [
  { username: 'admin', displayName: 'Pak Budi (Pemilik)', role: 'admin', passwordEnv: 'ADMIN_PASSWORD' },
  { username: 'tamu', displayName: 'Tamu', role: 'viewer', passwordEnv: 'VIEWER_PASSWORD' },
] as const;
