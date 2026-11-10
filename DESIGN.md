# SALURA — DESIGN.md

The source of truth for how the SALURA ops console looks and behaves. When this file and a component disagree, this file wins. Token values live in `apps/web/src/styles/tokens.css`; components reference tokens only, never raw hex, font names, radii or shadows.

**References**

- **Primary (source of truth):** the "Donezo" project dashboard shot. It defines the shell, cards, buttons, chips, charts, density and shape.
- **Secondary (chat layout only):** the "Inbox" messaging shot. Use its three-column chat arrangement (conversation list, thread, contact panel), bubbles and composer. Ignore its colours, its icon rail and its left inbox navigation; SALURA keeps the primary reference's sidebar.

---

## 1. Visual theme

Calm, clean, trustworthy. A tool a 55-year-old distributor owner reads on a laptop or a projector without squinting. One deep green does all the emphasis; everything else is white, warm grey and near-black ink.

| Attribute | Decision |
|---|---|
| Mood | Quiet, confident, operational. No decoration that carries no information |
| Density | Medium. Generous padding inside cards, tight grid gaps between them (bento) |
| Shape | Soft: rounded cards, pill buttons and chips, capsule chart bars |
| Depth | Flat. White cards on a grey canvas; separation comes from the canvas, not shadows |
| Emphasis | One highlighted element per area (a filled green KPI card, a filled primary button) |
| Theme | Light only. The audience and projector demo both favour a light UI |
| Language | Bahasa Indonesia for all UI copy. Numbers in Indonesian format (Rp1.234.500, 21 Okt 2026) |

## 2. Readability rules for older owners

These are acceptance criteria, not suggestions.

1. **Body text is 16px.** Nothing meaningful is smaller than 14px. 13px is allowed only for timestamps and footnotes.
2. **All text meets WCAG AA (4.5:1); body and numbers meet AAA (7:1).** The palette below was checked; do not introduce lighter greys for text.
3. **Never colour alone.** Every status chip has a word, and where useful an icon. Charts have labels or a legend with text.
4. **Buttons say what they do** ("Setujui pesanan", not "OK"). Icon-only buttons are limited to the top bar and composer, and each has an `aria-label` and a tooltip.
5. **Hit areas are at least 44×44px** for primary actions and 40×40px in dense lists.
6. **Big numbers for money and counts**, tabular figures so columns line up.
7. **One idea per card.** If a card needs a paragraph to explain, split it.

## 3. Colour tokens

Minimal palette: neutrals, one green, three status hues. Contrast ratios are against the background they are used on.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--canvas` | `#F2F4F1` | App background behind cards | — |
| `--surface` | `#FFFFFF` | Cards, sidebar, top bar, panels | — |
| `--surface-muted` | `#EDF0EC` | Inputs, search pill, hover rows, outbound chat bubble, neutral chip | — |
| `--border` | `#DDE2DC` | Dividers, outline buttons, input borders | — |
| `--ink` | `#111813` | Headings, body text, big numbers | 18.0 on surface |
| `--ink-2` | `#3D4840` | Secondary text, labels, inactive nav | 9.6 on surface |
| `--ink-3` | `#56625A` | Meta text, timestamps, placeholders | 6.4 on surface |
| `--primary` | `#17603A` | Primary buttons, active nav, links, chart main series, focus ring | 7.6 with white text |
| `--primary-strong` | `#0E3F25` | Feature cards (highlight KPI, "waktu dihemat"), primary button hover | 12.0 with white text |
| `--primary-soft` | `#E7F2EA` | Selected row, inbound chat bubble, success chip background | ink 15.7 · primary 6.6 |
| `--primary-on-strong` | `#D4EDDC` | Secondary text on `--primary-strong` cards | 9.7 |
| `--chart-2` | `#3E9B63` | Second chart series, gauge "in progress" | non-text |
| `--chart-3` | `#9FD3B2` | Third chart series | non-text |
| `--warning-fg` / `--warning-bg` | `#7A4E00` / `#FFF1CC` | "Menunggu", awaiting approval/customer | 6.4 |
| `--danger-fg` / `--danger-bg` | `#A8231A` / `#FDE8E6` | Rejected, over credit, out of stock, errors | 6.1 |
| `--info-fg` / `--info-bg` | `#1F5FAD` / `#E6EFFA` | Agent/system notes in the trace, informational chips | 5.5 |
| `--focus` | `#17603A` | 2px focus outline, 2px offset | — |

Gradients: only one, on the highlighted KPI card and feature cards, from `--primary` to `--primary-strong` (top-left to bottom-right). Nowhere else.

## 4. Typography

**Font:** Plus Jakarta Sans (Google Fonts), weights 400, 500, 600, 700. Fallback: `ui-sans-serif, system-ui, sans-serif`. It matches the reference's geometric grotesk and reads well at small sizes. Turn on `font-variant-numeric: tabular-nums` for all numbers in cards, tables and the trace.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--type-display` | 48 / 52 | 600 | KPI numbers ("24") |
| `--type-h1` | 32 / 40 | 600 | Page title ("Ringkasan") |
| `--type-h2` | 20 / 28 | 600 | Card titles |
| `--type-h3` | 17 / 24 | 600 | List item titles, customer names |
| `--type-body` | 16 / 24 | 400 | Body, chat messages, table cells |
| `--type-label` | 15 / 20 | 500 | Buttons, nav items, form labels |
| `--type-small` | 14 / 20 | 400 | Subtitles, secondary lines, chips |
| `--type-meta` | 13 / 18 | 400 | Timestamps, footnotes only |

Letter spacing: `-0.02em` on display and h1, normal elsewhere. Section labels in the sidebar ("MENU", "UMUM") are 13px, 600, uppercase, `0.06em` tracking, `--ink-3`.

## 5. Spacing, radius, elevation

**Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32, 40, 48. Card padding 24. Grid gap between cards 16. Page padding 32 (desktop), 16 (mobile).

**Radius** (concentric: inner = outer − padding):

| Token | Value | Use |
|---|---|---|
| `--radius-frame` | 28px | Main content panel |
| `--radius-card` | 20px | Cards |
| `--radius-inner` | 12px | Elements inside cards (list rows, chart tooltip, bubbles) |
| `--radius-input` | 12px | Inputs, select |
| `--radius-pill` | 999px | Buttons, chips, search, composer, chart capsules |

**Elevation:** cards have no border and no shadow; the grey canvas separates them. Only floating layers get a shadow: `--shadow-pop: 0 1px 2px rgb(17 24 19 / 0.06), 0 8px 24px rgb(17 24 19 / 0.10)` for menus, toasts, dialogs.

## 6. Layout shell

Desktop (≥1280px), from the primary reference:

```
┌────────────┬──────────────────────────────────────────────────────────┐
│  Sidebar   │  Top bar: [search pill ⌘K]          [bell] [avatar name]   │
│  248px     ├──────────────────────────────────────────────────────────┤
│  white     │  Content panel (canvas-grey area, frame radius)          │
│            │   H1 + subtitle                     [Primary] [Outline]  │
│  MENU      │   ┌KPI┐┌KPI┐┌KPI┐┌KPI┐   4-up row                         │
│  UMUM      │   ┌──────────┐┌──────┐┌──────┐   bento grid, 12 columns  │
│            │   └──────────┘└──────┘└──────┘                           │
│ [WA card]  │                                                          │
└────────────┴──────────────────────────────────────────────────────────┘
```

- **App frame:** as in the reference, the browser background is `--surface` (white) and the sidebar, top bar and content area are `--canvas` panels inside it (12px gap, `--radius-card` for sidebar/top bar, `--radius-frame` for content). White cards sit on the grey content panel.
- **Sidebar:** logo (SALURA wordmark + mark) top-left. Groups "MENU" and "UMUM". Items: icon 24 + label. Active item: `--ink` text, 600 weight, filled icon tint in `--primary`, and a 4px `--primary` bar on the left edge (as in the reference). Pending-approval count shows as a small dark-green pill badge next to "Persetujuan".
- **Sidebar footer card:** replaces the reference's "Download our Mobile App" card with **WhatsApp connection status** on a `--primary-strong` card: channel name, "Terhubung"/"Terputus" with a dot + word, and a "Lihat sesi" button.
- **Top bar:** search pill (`--surface-muted`, 44px tall, shortcut hint chip on the right), then circular icon buttons (40px, `--surface`, border) for notifications, then avatar + name + role.
- **Page header:** H1 + one-line subtitle in `--ink-3`; actions right-aligned: one filled primary pill (with leading icon) and one outline pill.
- **Breakpoints:** ≥1280 full layout; 1024–1279 sidebar collapses to an icon rail (72px) with tooltips; <1024 sidebar becomes a drawer behind a menu button, KPI row 2×2, bento cards stack to one column; <640 KPI row stacks to one column. No horizontal page scroll at any width.

## 7. Components

Build each once in `apps/web/src/components/ui/` and reuse.

### Buttons
- **Primary:** pill, `--primary` fill, white text, 44px tall, 20px horizontal padding, optional leading icon in a white circle (as "+ Add Project"). Hover `--primary-strong`.
- **Outline:** pill, `--surface` fill, 1px `--primary` border, `--primary` text.
- **Ghost / small outline:** pill, 32px tall, `--border` border, `--ink` text, leading "+" (as "+ New" / "+ Add Member").
- **Danger:** outline pill in `--danger-fg`, used only for "Tolak".
- States: hover, focus (2px `--focus` outline, 2px offset), active `scale(0.97)`, disabled (`--surface-muted` fill, `--ink-3` text, no pointer), loading (spinner replaces leading icon, label stays).

### KPI card (stat tile)
White card, title (h2 size at 17px, 600) top-left, a 36px circular outline button with an `ArrowUpRight` icon top-right linking to the detail page, display number, and a footer line: a small trend chip (icon + number) followed by `--type-small` text ("naik dari minggu lalu"). **Exactly one** KPI card per row is highlighted: gradient fill, white text, `--primary-on-strong` secondary text.

### Bento card
White, `--radius-card`, 24px padding, title row (h2 + optional small outline button on the right). Content fills the card; no nested borders.

### Status chip
Pill, 26px tall, 10px horizontal padding, `--type-small` 500, background + foreground pair from the status tokens, always with a word:

| Status | Word | Tokens |
|---|---|---|
| confirmed | Dikonfirmasi | `--primary` on `--primary-soft` |
| awaiting_customer | Menunggu pelanggan | warning |
| awaiting_approval | Perlu persetujuan | warning |
| rejected / cancelled | Ditolak / Dibatalkan | danger / neutral (`--ink-2` on `--surface-muted`) |
| draft | Draf | neutral |
| escalated | Dialihkan ke admin | info |

### List row
Avatar or icon tile (36px circle) + title (h3) + secondary line ("Pesanan #42 · 3 barang") + right-aligned chip or amount. 12px vertical padding, divider-free (spacing separates rows), hover `--surface-muted` with `--radius-inner`.

### Capsule bar chart
From the reference's "Project Analytics": 7 vertical capsules (full pill radius), one per day. Filled days in `--primary` / `--chart-2` / `--chart-3`; days with no data or in the future use a diagonal hatch (`--border` stripes on `--surface`). Day label below each capsule (S S R K J S M). The selected or highest bar shows a small value tooltip chip above it. Values also exist as text for screen readers.

### Gauge
Half-donut, as "Project Progress": big centred percentage (display size) with a label under it; segments `--primary`, `--chart-2`, hatched remainder; legend below with dot + word.

### Feature card (dark)
`--primary-strong` with the gradient, white text, used for one standout number per page (e.g. "Waktu dihemat 3 j 20 m"). Replaces the reference's time tracker. Optional subtle line pattern at 6% opacity; no glow, no orb.

### Inputs
44px, `--surface-muted` fill, `--radius-input`, `--ink` text, placeholder in `--ink-3`, 2px `--focus` outline on focus. Labels above, 15px 500. Errors: `--danger-fg` text under the field with an icon, field border `--danger-fg`.

### Toast
Bottom-right, `--surface`, `--shadow-pop`, `--radius-inner`, icon + one sentence + optional action. Auto-dismiss 5s; errors stay until closed.

### Dialog
Centred, max 520px, `--radius-card`, `--shadow-pop`, title + body + right-aligned actions (outline cancel, primary confirm). Used for reject reason and approval edits.

## 8. Chat (from the secondary reference)

Three columns inside the content panel:

```
┌ Conversations 320px ┬ Thread (flex) ────────────────┬ Context 340px ──────┐
│ search pill          │ header: name · status chip    │ tabs: Pelanggan |   │
│ filter chips         │         actions               │       Jejak agen    │
│ ─ row (selected) ─   │  inbound bubble (left)        │                     │
│ ─ row ─              │        outbound bubble (right)│ customer card,      │
│ ─ row ─              │  order card in thread         │ credit, usual order │
│                      │ composer pill  [mic][photo] [send]  │ or live trace       │
└──────────────────────┴───────────────────────────────┴─────────────────────┘
```

- **Conversation row:** avatar (initials on `--primary-soft` when no photo), store name (h3), last message preview (1 line, `--ink-2`), time (`--type-meta`), unread count badge (`--primary` fill, white). Selected row: `--primary-soft` background and a 4px `--primary` left bar.
- **Inbound bubble (warung owner):** `--primary-soft`, left-aligned, `--radius-inner` with the corner nearest the avatar at 4px, sender name 600 + time on the first line, body 16px. Voice notes show a play button, waveform, duration, and the transcript beneath in `--ink-2` italic once transcribed.
- **Outbound bubble (SALURA agent or admin):** `--surface-muted`, right-aligned, label "SALURA" (or the admin's name) + delivery ticks. Meta line under each bubble in `--type-meta`: "Diterima 10.15" / "Terkirim 10.16".
- **Order card in thread:** when the agent sends a summary, render it as a card inside the outbound bubble: lines (qty, unit, name, price), total in 600, status chip, and link "Lihat pesanan".
- **Composer:** pill input on `--surface-muted`, icon buttons for voice note and photo inside the pill, send button as a 44px square with `--radius-inner`, `--primary` fill (the reference uses black; SALURA uses primary). Enter sends, Shift+Enter new line.
- **Context panel, "Pelanggan" tab:** customer name + tier chip, then detail rows (icon tile + label + value, as the reference's Status/Appeals rows): limit kredit, belum dibayar, jatuh tempo, terakhir pesan; then "Pesanan biasa" list.
- **Context panel, "Jejak agen" tab:** the live agent trace (section 9).
- **Responsive:** three columns from 1440px (at 1280 the thread would be too narrow beside the 248px sidebar); <1440 the context panel becomes a slide-over opened by "Info & jejak" in the thread header; <1024 one column at a time with back navigation.

## 9. Agent trace

A vertical timeline, newest at the bottom, auto-scrolling while a run is live.

- Each step: 28px icon dot on a 2px `--border` rail, step title (`--type-label`), one-line summary, duration and time in `--type-meta`, expandable "Detail" disclosure showing the tool input and output as formatted JSON in a `--surface-muted` block (monospace 14px).
- Step kinds and icons (Lucide): message in `MessageSquare`, thought `Lightbulb`, tool call `Wrench`, result `CircleCheck`, validation `ShieldCheck`, approval `UserCheck`, error `TriangleAlert`. Errors use danger tokens; validation passes use primary; thoughts use info.
- Live run: the last dot pulses (opacity 1 → 0.4, 1.2s), with "Sedang bekerja…" text beside it. Reduced motion: no pulse, text only.
- Run header: run status chip, steps, total time, tokens, cost.

## 10. Screens

| Screen (nav label) | Purpose | Layout |
|---|---|---|
| **Ringkasan** (Dashboard) | Is the agent saving time and catching errors? | KPI row: Pesanan ditangani (highlighted) · Lolos otomatis (%) · Perlu persetujuan · Piutang jatuh tempo (Rp). Bento: capsule chart "Pesanan 7 hari" (wide) · "Perlu tindakan" card showing the oldest pending approval with a primary "Tinjau sekarang" button (from the reference's Reminders card) · "Pesanan terbaru" list · "Kesalahan dicegah" list with chips (stok habis, lewat limit, nama ambigu) · gauge "Akurasi evaluasi" · dark feature card "Waktu dihemat" |
| **Percakapan** (Chat) | Watch and test orders arriving | Section 8 |
| **Persetujuan** (Approval queue) | Decide what the agent held back | Split view: list of pending items (row: store, type chip, amount, age, one-line reason) on the left; detail on the right: reason in a warning callout, order lines table, credit facts, links to the conversation and trace, and actions "Setujui" (primary), "Ubah lalu setujui" (outline), "Tolak" (danger outline, opens reason dialog). Empty state: "Tidak ada yang menunggu. Agen menangani semuanya sendiri." |
| **Pesanan** (Orders) | Every order and its state | Filter chips by status, table with store, items, total, status chip, channel, time; row opens detail with trace |
| **Pengiriman** (Deliveries) | Match delivery documents to orders | List of shipped orders (status chip: Belum dicek / Cocok / Ada selisih) on the left; right: order lines, a "Cek dokumen pengiriman" panel (Surat jalan / Nota segmented, "Pakai contoh dokumen", "Unggah foto"), then the result: comparison table (Barang, Dipesan, Di dokumen, Status chip), four stat tiles (nilai dipesan, terkirim, tagihan, kelebihan tagih), the agent's report, the document photo and the run trace |
| **Penagihan** (Collections) | Overdue invoices and reminders | KPI row (total jatuh tempo, pelanggan terlambat, janji bayar), table of overdue invoices with days overdue chip, last reminder, promise date; "Jalankan penagihan" primary button triggers the agent run |
| **Evaluasi** (Evaluation) | Prove reliability | KPI row (akurasi item, pass^5, rata-rata biaya per pesanan, rata-rata waktu); per-case table with pass/fail chips per run (5 dots); "Jalankan evaluasi" button |
| **Pengaturan** (Settings) | Autonomy and demo controls | Autonomy policy per action as a 3-option segmented control (Sarankan saja / Otomatis / Perlu persetujuan) with the auto limit input; "Reset data demo" danger button with confirm dialog |

## 11. States (every screen)

- **Loading:** skeleton blocks in `--surface-muted` matching the final layout; no spinners for whole pages.
- **Empty:** one sentence saying what will appear and, where possible, a button to make it happen. No illustration needed.
- **Error:** inline callout in danger tokens, plain-language cause, and a "Coba lagi" button. Never show raw stack traces; the trace detail may show tool errors.
- **Live update:** new items fade in (opacity, 200ms) and a toast appears for new approvals.

## 12. Motion

Library: **Motion** (`motion` package, `import { motion, AnimatePresence } from "motion/react"`). Define shared variants and transitions once in `apps/web/src/lib/motion.ts`; components import them instead of inventing their own.

| Interaction | Animation | Timing |
|---|---|---|
| Button hover | Background colour change; primary button's leading icon circle nudges right 2px | 150ms ease-out |
| Button press | `scale: 0.97` (`whileTap`) | spring, stiffness 500, damping 30, no bounce |
| Card hover (clickable cards, KPI tiles, list rows) | Lift `y: -2` and the KPI arrow button rotates 45° | 180ms ease-out |
| Page load | Header, KPI row, then bento cards fade in with `y: 8 → 0`, staggered 60ms per group (not per card) | 250ms ease-out, first load of a route only |
| KPI numbers | Count up from the previous value when data changes (not from 0 on every render) | 600ms ease-out |
| Capsule chart bars | Grow from the bottom (`scaleY: 0 → 1`, origin bottom) on first load, staggered 40ms | 400ms ease-out |
| Gauge | Arc draws from 0 to value on first load | 700ms ease-out |
| New chat bubble / trace step / approval row | Fade + `y: 6 → 0`; list re-orders animate with `layout` | 200ms ease-out |
| Removed approval row (after decision) | Fade + collapse height, then the next row slides up with `layout` | 220ms ease-out |
| Panels, dialogs, slide-overs | `AnimatePresence`: fade + `y: 8` (dialog) or `x: 24` (slide-over); exit softer than enter | 250ms enter, 180ms exit |
| Toast | Slide in from bottom-right `y: 12 → 0` + fade | 220ms |
| Live trace | Last dot pulses (opacity 1 → 0.4) while the run is working | 1.2s loop |
| Icon swaps (copy → check, send → spinner) | Cross-fade with scale 0.25 → 1 and blur 4px → 0 | spring, no bounce |

Rules:
- Motion supports meaning, never decorates. Every animated change also has a static cue (colour, label or icon).
- No floating, shimmering, bouncing, parallax or animated gradients; no animation on typing or scroll.
- `initial={false}` on `AnimatePresence` so content already on screen does not animate on first paint, except the page-load sequence above.
- Respect `prefers-reduced-motion` with `MotionConfig reducedMotion="user"` at the app root: transforms are dropped and only opacity fades remain.
- Animate only `transform` and `opacity` (plus the gauge's SVG `pathLength`), never layout properties directly.

## 13. Icons

Lucide React only, outline, stroke 1.5 next to regular text and 2 next to semibold. Sizes: 16 inline, 20 default, 24 sidebar nav. Sidebar icons: Ringkasan `LayoutDashboard`, Percakapan `MessagesSquare`, Persetujuan `ClipboardCheck`, Pesanan `Package`, Penagihan `ReceiptText`, Evaluasi `FlaskConical`, Pengaturan `Settings`, Bantuan `CircleQuestionMark`. Verify each name against the installed version before use.

## 14. Copy

Bahasa Indonesia, polite and plain, as a good admin would speak to a boss: short sentences, concrete numbers, no jargon ("pass^k" appears only on the Evaluasi screen, with a one-line explanation). Address customers as Bu/Pak in chat. No exclamation marks in the console UI. No English UI labels except product and brand names.

## 15. Do's and don'ts

**Do**
- Keep one green. Status colours appear only in chips, callouts and trace states.
- Put the most important number on each card at display size.
- Show the reason next to every agent decision a human must act on.
- Use real seeded data in every screen and screenshot; no lorem ipsum.

**Don't**
- No text lighter than `--ink-3`, no text under 13px.
- No borders on cards, no heavy shadows, no glassmorphism.
- No gradient anywhere except the highlighted KPI card and the dark feature card.
- No emoji as icons in the console UI (customers may use emoji in their chat messages; render them as-is).
- No sparkle or "AI magic" iconography; the agent is shown through its trace, not decoration.
- No dark mode for now.
