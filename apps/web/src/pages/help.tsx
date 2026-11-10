import { ArrowRight, Banknote, CalendarClock, Truck, ClipboardCheck, FileSpreadsheet, FlaskConical, KeyRound, ListChecks, MessagesSquare, RotateCcw, Route, Send, Warehouse } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useNavigate } from 'react-router';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { CopyIcon, useCopy } from '../components/pages/code-block.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip, type Tone } from '../components/ui/chip.tsx';
import { Avatar } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { hover, pageGroup } from '../lib/motion.ts';

interface Scenario {
  title: string;
  tag: string;
  tone: Tone;
  store: string;
  owner: string;
  waId: string;
  message: string;
  followUp?: string;
  expect: string[];
}

// Facts below come from the seed data (packages/db/src/seed/data.ts) and the eval cases.
const SCENARIOS: Scenario[] = [
  {
    title: 'Pesanan langganan',
    tag: '“Yang biasa”',
    tone: 'success',
    store: 'Warung Bu Sari',
    owner: 'Bu Sari',
    waId: '6281234500001',
    message: 'kirim yang biasa ya bu',
    followUp: 'ya',
    expect: [
      'Agen membaca riwayat belanja: Indomie Goreng 2 dus, Aqua 600 ml 1 dus, Kapal Api 5 renceng, Gulaku 10 bungkus.',
      'Mengecek stok dan limit, lalu mengirim ringkasan dan total untuk dikonfirmasi.',
      'Setelah dibalas “ya”, pesanan langsung dikonfirmasi tanpa admin.',
    ],
  },
  {
    title: 'Barang habis, tawarkan pengganti',
    tag: 'Stok habis',
    tone: 'danger',
    store: 'Warung Bu Sari',
    owner: 'Bu Sari',
    waId: '6281234500001',
    message: 'bimoli 2 liter 6 bungkus',
    expect: [
      'Stok Bimoli 2 liter sedang kosong. Agen tidak menjanjikan barang yang tidak ada.',
      'Agen menawarkan pengganti yang disetujui distributor: Sunco 2 liter.',
      'Belum ada pesanan yang diproses sampai pelanggan setuju.',
    ],
  },
  {
    title: 'Melewati limit kredit',
    tag: 'Limit kredit',
    tone: 'warning',
    store: 'Toko Makmur Jaya',
    owner: 'Pak Hendra',
    waId: '6281234500002',
    message: 'beras sr 10 karung',
    followUp: 'ya',
    expect: [
      'Limit Pak Hendra Rp15 juta dan sebagian besar sudah terpakai tagihan berjalan.',
      'Agen memecah pesanan: bagian yang masih masuk limit diproses, sisanya ditahan.',
      'Bagian yang ditahan muncul di halaman Persetujuan dengan alasannya.',
    ],
  },
  {
    title: 'Tagihan lama belum dibayar',
    tag: 'Tagihan terlambat',
    tone: 'danger',
    store: 'Warung Madura Pak Rasyid',
    owner: 'Pak Rasyid',
    waId: '6281234500003',
    message: 'teh botol kotak 2 dus, le minerale 3 dus, masako 10 renceng',
    followUp: 'ya',
    expect: [
      'Pak Rasyid punya tagihan yang terlambat lebih dari 14 hari.',
      'Sesuai kebijakan pembayaran, pesanan baru ditahan dan diteruskan ke pemilik untuk diputuskan.',
      'Pelanggan diberi tahu dengan sopan bahwa pesanan sedang ditinjau.',
    ],
  },
  {
    title: 'Nama barang kurang jelas',
    tag: 'Nama ambigu',
    tone: 'info',
    store: 'Toko Berkah',
    owner: 'Bu Lina',
    waId: '6281234500004',
    message: 'minyak 2 liter 1 dus',
    followUp: 'yang filma aja',
    expect: [
      'Bu Lina belum pernah membeli minyak goreng, jadi agen tidak menebak merek.',
      'Agen bertanya satu kali, menyebut pilihan yang ada stoknya (misalnya Sunco atau Filma).',
      'Setelah dijawab, agen menyusun ringkasan; balas “ya” untuk konfirmasi.',
    ],
  },
  {
    title: 'Pertanyaan jadwal kirim',
    tag: 'Kebijakan',
    tone: 'info',
    store: 'Toko Berkah',
    owner: 'Bu Lina',
    waId: '6281234500004',
    message: 'kalau ke cikarang dikirimnya hari apa aja ya?',
    expect: [
      'Agen mencari di dokumen kebijakan distributor, bukan mengarang jawaban.',
      'Menjawab jadwal pengiriman area Cikarang: Rabu dan Sabtu.',
      'Di Jejak agen terlihat dokumen dan bagian yang dikutip.',
    ],
  },
  {
    title: 'Barang rusak, minta retur',
    tag: 'Dialihkan ke admin',
    tone: 'info',
    store: 'Warung Bu Sari',
    owner: 'Bu Sari',
    waId: '6281234500001',
    message: 'indomie yang kemarin ada yang penyok 3 bungkus, bisa retur?',
    expect: ['Agen membaca kebijakan retur dan meminta foto barang yang rusak.', 'Karena retur perlu keputusan orang, percakapan dialihkan ke admin.', 'Tidak ada pesanan baru yang dibuat.'],
  },
  {
    title: 'Pesanan besar di atas batas otomatis',
    tag: 'Perlu persetujuan',
    tone: 'warning',
    store: 'Minimarket Sinar Pagi',
    owner: 'Pak Agus',
    waId: '6281234500005',
    message: 'beras sr 25kg 35 karung',
    followUp: 'ya',
    expect: [
      'Totalnya sekitar Rp11,6 juta, di atas batas konfirmasi otomatis Rp10 juta.',
      'Limit kredit cukup, tetapi agen tetap menahan pesanan untuk persetujuan pemilik.',
      'Batas ini bisa diubah di Pengaturan.',
    ],
  },
];

export function HelpPage() {
  return (
    <Page>
      <PageHeader title="Bantuan" subtitle="Panduan singkat untuk mencoba SALURA sendiri dalam 5 menit." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card title="Apa yang dikerjakan SALURA" className="lg:col-span-7" group={1}>
          <p className="text-body text-ink-2">
            SALURA adalah agen pesanan dan penagihan untuk distributor sembako CV Sumber Rejeki di Bekasi. Pemilik warung memesan lewat WhatsApp atau chat web dengan bahasa sehari-hari. Agen memahami
            pesanannya, lalu bekerja seperti admin yang teliti:
          </p>
          <ol className="mt-4 flex flex-col gap-3">
            <Step n={1} title="Memahami pesan">
              Bahasa gaul, salah ketik, pesan suara, dan “yang biasa” dicocokkan ke katalog dan riwayat belanja.
            </Step>
            <Step n={2} title="Memeriksa sebelum menjanjikan">
              Stok, limit kredit, tagihan terlambat, dan kebijakan distributor dicek dengan alat, bukan ditebak.
            </Step>
            <Step n={3} title="Bertindak atau menahan">
              Pesanan aman dikonfirmasi sendiri. Yang berisiko ditahan dengan alasan yang jelas untuk Anda putuskan.
            </Step>
          </ol>
        </Card>

        <Card title="Di mana melihat hasilnya" className="lg:col-span-5" group={1}>
          <ul className="flex flex-col gap-4">
            <Where icon={Route} title="Tab “Jejak agen” di Percakapan" to="/percakapan">
              Setiap langkah agen: rencana, alat yang dipanggil beserta datanya, aturan yang menolak, dan balasan.
            </Where>
            <Where icon={ClipboardCheck} title="Halaman Persetujuan" to="/persetujuan">
              Pesanan dan pengingat yang ditahan agen, lengkap dengan alasannya.
            </Where>
            <Where icon={KeyRound} title="Akun admin dan akun tamu">
              Akun admin bisa menyetujui, menolak, mengimpor data, mengubah pengaturan, dan mereset demo. Akun tamu bisa mencoba chat dan melihat semua halaman. Akun untuk juri tercantum di dokumen
              proposal.
            </Where>
            <Where icon={Banknote} title="Bukti transfer di chat" to="/penagihan">
              Kirim foto bukti transfer sebagai warung. Agen membaca nominalnya, mengusulkan tagihan yang dilunasi, dan menunggu Anda mengecek rekening di Persetujuan.
            </Where>
            <Where icon={Warehouse} title="Daftar ambil barang di Gudang" to="/gudang">
              Pesanan yang dikonfirmasi langsung masuk ke daftar ambil barang per hari kirim dan area, siap dicetak.
            </Where>
            <Where icon={FileSpreadsheet} title="Impor dari Excel atau Google Sheets" to="/impor">
              Produk, harga, stok, dan pelanggan bisa diambil dari spreadsheet yang sudah dipakai distributor.
            </Where>
            <Where icon={Truck} title="Cek surat jalan di Pengiriman" to="/pengiriman">
              Pilih pesanan bertanda "Ada contoh dokumen", tekan "Pakai contoh dokumen". Agen membaca foto, mencocokkan dengan pesanan dan tagihan, lalu menyiapkan pertanyaan ke gudang dan koreksi tagihan.
            </Where>
            <Where icon={CalendarClock} title="Pesan ulang otomatis di Ringkasan" to="/">
              Agen yang bekerja tanpa diminta: mencari warung yang lewat jadwal belanja, menawarkan pesanan biasanya, dan menjelaskan kenapa warung lain dilewati. Tekan "Jalankan sekarang".
            </Where>
            <Where icon={FlaskConical} title="Halaman Evaluasi" to="/evaluasi">
              Hasil uji otomatis: puluhan percakapan dijalankan berulang untuk mengukur akurasi dan konsistensi.
            </Where>
          </ul>
        </Card>
      </div>

      <motion.div variants={pageGroup} custom={2} className="mt-8 mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-ink">Skenario uji</h2>
          <p className="mt-1 text-body text-ink-3">Tekan “Coba sekarang”: chat warung terbuka dengan pesan sudah terisi. Tinggal kirim.</p>
        </div>
        <Link to="/pengaturan" className="inline-flex h-10 items-center gap-1.5 rounded-pill text-label font-medium text-primary hover:underline">
          <Icon icon={RotateCcw} size={16} weight="semibold" /> Mulai dari awal: reset data demo
        </Link>
      </motion.div>

      <motion.ul variants={pageGroup} custom={3} className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {SCENARIOS.map((s, i) => (
          <ScenarioCard key={s.title} n={i + 1} s={s} />
        ))}
      </motion.ul>
    </Page>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tabular grid size-9 shrink-0 place-items-center rounded-full bg-primary-soft text-label font-semibold text-primary">{n}</span>
      <div>
        <p className="text-label font-semibold text-ink">{title}</p>
        <p className="text-body text-ink-2">{children}</p>
      </div>
    </li>
  );
}

function Where({ icon, title, to, children }: { icon: typeof Route; title: string; to?: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-muted text-ink-2">
        <Icon icon={icon} size={20} />
      </span>
      <div className="min-w-0">
        {to ? (
          <Link to={to} className="inline-flex items-center gap-1 text-label font-semibold text-primary hover:underline">
            {title} <Icon icon={ArrowRight} size={16} weight="semibold" />
          </Link>
        ) : (
          <p className="text-label font-semibold text-ink">{title}</p>
        )}
        <p className="text-small text-ink-2">{children}</p>
      </div>
    </li>
  );
}

function ScenarioCard({ n, s }: { n: number; s: Scenario }) {
  const navigate = useNavigate();
  const { copied, copy } = useCopy();
  return (
    <motion.li whileHover={{ y: -2 }} transition={hover} className="flex flex-col rounded-card bg-surface p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-h3 font-semibold text-ink">
          <span className="tabular mr-2 text-ink-3">{n}.</span>
          {s.title}
        </h3>
        <Chip tone={s.tone}>{s.tag}</Chip>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Avatar name={s.store} size={36} />
        <div className="min-w-0">
          <p className="truncate text-label font-semibold text-ink">{s.store}</p>
          <p className="text-small text-ink-3">Pilih warung ini, lalu ketik sebagai {s.owner}</p>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-inner rounded-tl-[4px] bg-primary-soft p-3">
        <p className="min-w-0 flex-1 text-body text-ink">“{s.message}”</p>
        <button
          type="button"
          onClick={() => void copy(s.message)}
          aria-label={copied ? 'Pesan tersalin' : `Salin pesan: ${s.message}`}
          title={copied ? 'Tersalin' : 'Salin pesan'}
          className="-m-1 grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-primary hover:bg-surface"
        >
          <CopyIcon copied={copied} />
        </button>
      </div>
      {s.followUp && (
        <p className="mt-2 flex items-center gap-1.5 text-small text-ink-2">
          <Icon icon={Send} size={16} /> Lalu balas: <span className="font-semibold text-ink">“{s.followUp}”</span>
        </p>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-small font-semibold text-ink-2">
        <Icon icon={ListChecks} size={16} weight="semibold" /> Yang seharusnya terjadi
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {s.expect.map((e) => (
          <li key={e} className="flex gap-2 text-body text-ink-2">
            <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            {e}
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-5">
        <Button icon={MessagesSquare} className="w-full" onClick={() => navigate(`/percakapan/${s.waId}?draft=${encodeURIComponent(s.message)}`)}>
          Coba sekarang
        </Button>
      </div>
    </motion.li>
  );
}
