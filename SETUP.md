# SALURA setup guide

Everything you need to get SALURA running: on your machine first, then on a public URL (Vercel + Supabase) for the judges. Follow the steps in order.

**Minimum to see the agent working:** Node 22, pnpm, and an LLM API key. Supabase, voice notes, photo reading and WhatsApp come after.

---

## 1. What you need

| Item | Required? | Where to get it |
|---|---|---|
| **Node.js 22** or newer | Yes | `node -v` to check |
| **pnpm 11** | Yes | `corepack enable`, or `npm i -g pnpm` |
| **LLM API key** (OpenAI-compatible) | **Yes** | Default: Nous Portal <https://portal.nousresearch.com>. Any OpenAI-compatible provider works; set a spending limit on the key |
| **Supabase project** | For the public demo | <https://supabase.com>, region Singapore. Locally SALURA runs an embedded Postgres instead |
| **Vercel account** | For the public demo | <https://vercel.com>, connected to the GitHub repository |
| Groq (or OpenAI) API key | Optional: voice notes | <https://console.groq.com> → API keys |
| A vision-model API key | Optional: photos (order lists, receipts, surat jalan) | Groq, OpenAI, OpenRouter, or any OpenAI-compatible provider |
| Docker | Optional: self-hosting, WhatsApp | Docker Desktop with WSL integration, or Docker Engine on a server |

Without an LLM key the app still starts: the console works, but every chat message gets a polite holding reply and is escalated to the order desk. Without a vision key, the chat's **Kirim contoh …** buttons still work (the bundled sample photos carry stored transcripts).

---

## 2. Run it locally

```bash
pnpm install
cp .env.example .env      # then edit .env (section 3); at minimum set LLM_API_KEY
pnpm check:llm            # tests your key and model, and tells you which LLM_TOOL_MODE to use
pnpm test                 # optional: the full test suite, no API key needed
```

Then pick one way to run it:

**A. One process:** builds the console and serves it from the API.

```bash
pnpm start:prod           # = pnpm build && pnpm start
```

Open <http://localhost:8787>.

**B. Development, with hot reload:** two terminals.

```bash
pnpm dev                                  # terminal 1: API on :8787, restarts on code changes
pnpm --filter @salura/web dev             # terminal 2: console on :5173, proxies /api to :8787
```

Open <http://localhost:5173>.

**Database.** With `DATABASE_URL` blank, an embedded Postgres (PGlite) is created in `data/pglite` and filled with the demo distributor (8 warung, 30 products, order history and invoices). With `DATABASE_URL` set to your Supabase URL, the local server uses Supabase instead (and migrates it on start).

**Accounts.** On first start SALURA creates `admin` (admin) and `tamu` (guest) with `ADMIN_PASSWORD` / `VIEWER_PASSWORD`. If those are blank, a local run generates passwords and prints them in the terminal. Manage accounts any time:

```bash
pnpm user list
pnpm user add juri admin "Juri GTNIC"          # prints a generated password (or set USER_PASSWORD=...)
pnpm user password admin                       # new password, signs the account out everywhere
pnpm user disable tamu
```

### First things to try

1. Sign in as `admin`. **Percakapan** → *Warung Bu Sari* → `kirim yang biasa ya` → reply `ya`.
2. Watch the **Jejak agen** tab: every tool call, result and rule refusal.
3. *Toko Makmur Jaya* → `beras sr 10 karung` → `ya`. Over the credit limit, so the agent splits it.
4. **Persetujuan** → approve the held part.
5. *Warung Bu Sari* → **Kirim contoh bukti transfer**, then approve the payment in **Persetujuan**.
6. **Gudang** → the confirmed orders as a picking list. **Bantuan** lists more ready-made scenarios.

---

## 3. Environment variables (`.env`)

### LLM (required)

| Variable | Value | Notes |
|---|---|---|
| `LLM_BASE_URL` | `https://inference-api.nousresearch.com/v1` | Any OpenAI-compatible endpoint |
| `LLM_API_KEY` | your key | **Required.** Never commit it. Set a spending limit at the provider |
| `LLM_MODEL` | `deepseek/deepseek-v4.1-flash` | The model id exactly as your provider lists it |
| `LLM_TOOL_MODE` | `native` | `native` = OpenAI function calling. `prompt` = tools described in the prompt and parsed from `<tool_call>` blocks. **Run `pnpm check:llm`**: it tries both and tells you which one works |
| `LLM_PRICE_INPUT_PER_M` | your model's price | Optional. USD per 1M input tokens; shown as cost per order. Blank = cost not shown |
| `LLM_PRICE_OUTPUT_PER_M` | your model's price | Optional. Same, for output tokens |

### Voice notes and photos (optional)

| Variable | Value | Notes |
|---|---|---|
| `STT_API` | `chat` | `transcriptions` for a Whisper endpoint, `chat` for a multimodal model that takes audio |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL` | Nous Portal, `openai/gpt-audio-mini` | The speech provider. Blank = voice notes are escalated. In `chat` mode only wav and mp3 are accepted |
| `VISION_BASE_URL`, `VISION_API_KEY`, `VISION_MODEL` | a vision model | Any OpenAI-compatible `/chat/completions` that accepts `image_url`. Used for order lists, transfer receipts and surat jalan/nota. Blank = uploaded photos are escalated; the bundled samples still work. Check the model id against your provider's current list |

### Database and accounts

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres URL. Supabase: **Transaction pooler** string (port 6543, user `postgres.<ref>`, host `aws-0-<region>.pooler.supabase.com`). The direct `db.<ref>.supabase.co` host is IPv6-only: Vercel and many home networks cannot reach it. URL-encode special characters in the password (`&` → `%26`, `*` → `%2A`, `@` → `%40`). Blank = embedded PGlite in `./data/pglite` |
| `ADMIN_PASSWORD` | Password of the `admin` account, created on first start if it does not exist (8+ characters). Changing the variable later does not change an existing account: use `pnpm user password admin` |
| `VIEWER_PASSWORD` | Same, for the `tamu` (guest) account |
| `CRON_SECRET` | Random secret (`openssl rand -hex 24`). Vercel Cron sends it to the daily agent routes; without it they are refused |

### App

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | Local / Docker only |
| `MANUAL_MINUTES_PER_ORDER` | `6` | Your baseline for "minutes saved" on the dashboard. Replace with a value you measured |
| `DEMO_RESET_IDLE_MINUTES` | `0` | **Set to `60` on the public demo.** Resets the demo data after an hour without activity |
| `AGENT_SCHEDULE` | `on` | Long-running server: daily reorder offers at 08:00 WIB and reminders at 09:00 WIB. On Vercel, Vercel Cron does this |
| `TRUST_PROXY`, `CLIENT_IP_HEADER` | `0`, blank | Self-hosting behind your own reverse proxy only. On Vercel this is automatic (`x-real-ip`) |
| `CORS_ORIGINS` | blank | Only if the console is hosted on a different domain from the API |
| `WEB_DIST` | `apps/web/dist` | Long-running server only |

### WhatsApp via OpenWA (optional, self-hosted only)

| Variable | Notes |
|---|---|
| `OPENWA_BASE_URL` | `http://localhost:2785/api` locally. In Docker Compose it is set for you |
| `OPENWA_API_KEY` | OpenWA's admin key: `docker exec openwa-api cat /app/data/.api-key` |
| `OPENWA_SESSION_ID` | The id of the session you create and pair (section 6) |
| `OPENWA_WEBHOOK_SECRET` | A random secret you also give OpenWA when registering the webhook. **Without it every WhatsApp message is rejected** |

---

## 4. Supabase (the database for the public demo)

1. Create a project, region **Southeast Asia (Singapore)**. Note the database password.
2. **Project → Connect → Transaction pooler**: copy the connection string, put the password in (URL-encoded) and set it as `DATABASE_URL` in your local `.env`.
3. Create the tables and load the demo data from your machine:

   ```bash
   pnpm db:migrate        # tables + row level security on every table
   pnpm db:reset          # demo distributor (accounts and eval reports are kept)
   ```

Row level security matters on Supabase: the `public` schema is also reachable through Supabase's REST API. The migration turns RLS on for every table without policies, so that API sees nothing. SALURA connects as the table owner and is not affected. Do not add policies unless you mean to expose a table.

---

## 5. Deploy on Vercel (public URL)

The repository is ready for Vercel: `vercel.json` sets the commands and `scripts/build-vercel.mjs` writes the Build Output (console on the CDN, the API as one Node function in Singapore, routes, crons).

1. **New project** → import the GitHub repository. Leave framework settings alone; `vercel.json` overrides them.
2. **Environment variables** (Production and Preview):
   - `DATABASE_URL` (the pooler URL, port 6543)
   - `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TOOL_MODE`, optional `LLM_PRICE_*`
   - optional `STT_*`, `VISION_*`
   - `ADMIN_PASSWORD`, `VIEWER_PASSWORD`, `CRON_SECRET`
   - `DEMO_RESET_IDLE_MINUTES=60`
   - `ENABLE_EXPERIMENTAL_COREPACK=1` (uses the pnpm version pinned in `package.json`)
3. **Deploy.** Open the URL; you should see the login page. Sign in as `admin`.
4. **Settings → Functions:** Fluid compute on (the default). The function runs up to 300 s; an agent run takes at most 90 s.
5. **Cron jobs** appear under Settings → Cron Jobs: `/api/cron/proactive` at 01:00 UTC (08:00 WIB) and `/api/cron/collections` at 02:00 UTC (09:00 WIB). On the Hobby plan, Vercel may run them any time within that hour.

Before every deploy that adds a migration, run `pnpm db:migrate` against the same `DATABASE_URL` first: the function never migrates on its own.

### Before you submit

- [ ] Open the public URL in a private window, sign in as the judges' account, and run `TESTING_CHECKLIST.md`.
- [ ] Run the evaluation (section 7) with `--publish` and check **Evaluasi**.
- [ ] Put the live URL in `README.md` ("Live demo") and the judges' account in the proposal.
- [ ] Repository is public, and `.env` is **not** committed (it is in `.gitignore`).
- [ ] Change the Supabase database password if it was ever shared in plain text, and update `DATABASE_URL` in Vercel and `.env`.

---

## 6. Self-hosting with Docker, and real WhatsApp (optional)

```bash
cp .env.example .env               # DATABASE_URL (or blank for the embedded database), LLM_*, ADMIN_PASSWORD, ...
docker compose up -d --build       # http://localhost:8787
```

WhatsApp through OpenWA needs this always-on setup (a WhatsApp Web session cannot live in a serverless function). Use a **dedicated** number: OpenWA is unofficial and WhatsApp may restrict it.

```bash
docker compose --profile whatsapp up -d --build
docker exec openwa-api cat /app/data/.api-key          # → OPENWA_API_KEY
```

1. Open the OpenWA dashboard at <http://localhost:2785>. Create a session, start it, and scan the QR code with the dedicated phone. Copy the session id into `OPENWA_SESSION_ID`.
2. Pick a secret (`openssl rand -hex 24`) and put it in `OPENWA_WEBHOOK_SECRET`.
3. Register the webhook in OpenWA, pointing at SALURA:

   ```bash
   curl -X POST http://localhost:2785/api/sessions/$OPENWA_SESSION_ID/webhooks \
     -H "X-API-Key: $OPENWA_API_KEY" -H "content-type: application/json" \
     -d '{"url":"http://salura:8787/webhooks/openwa","events":["message.received"],"secret":"'$OPENWA_WEBHOOK_SECRET'"}'
   ```

4. `docker compose up -d` again so SALURA picks up the new variables. The sidebar card should say **WhatsApp: terhubung**.

**Not verified yet:** OpenWA's README does not document the webhook payload fields or the signature header. SALURA accepts the common shapes and checks `X-OpenWA-Signature`, `X-Webhook-Signature` or `X-Signature` (HMAC-SHA256, hex). If messages get a 401 or are ignored, compare a real delivery with OpenWA's Swagger at <http://localhost:2785/api/docs> and adjust `parseOpenWAWebhook` / `verifySignature` in `apps/api/src/channels.ts`.

---

## 7. Measure reliability (evaluation)

```bash
pnpm eval -- --k 1              # quick pass: one run per case
pnpm eval                       # every case × 5 runs, with your real model; costs tokens
pnpm eval -- --case s01 --case p03
pnpm eval -- --category payment --category delivery
pnpm eval -- --publish          # also store the report in DATABASE_URL for the console
```

Each run uses a fresh in-memory Postgres, so nothing touches your real database except the published report. Results go to `packages/eval/results/latest.json`. With `--publish`, the **Evaluasi** page and the dashboard's "Keandalan agen" card show them. Run it after any prompt or model change.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Every chat reply is "Admin kami akan segera mengecek…" | The agent cannot reach the model. Run `pnpm check:llm`. The **Jejak agen** tab shows the exact error |
| `pnpm check:llm` says the model answered without calling the tool | Set the `LLM_TOOL_MODE` it recommends. If neither works, try another model id |
| `getaddrinfo` / `ENETUNREACH` connecting to Supabase | You used the direct `db.<ref>.supabase.co` host (IPv6 only). Use the pooler URL |
| `tenant/user postgres.<ref> not found` | Wrong pooler host for your region (`aws-0-…` vs `aws-1-…`); copy it from Project → Connect |
| Login page says "Server belum bisa dihubungi" on Vercel | The function failed to start: check `DATABASE_URL` and the function logs (Vercel → Logs) |
| Cannot sign in with the new `ADMIN_PASSWORD` | The account already existed; the variable only seeds new accounts. Run `pnpm user password admin` |
| "Terlalu banyak percobaan masuk" | 10 failed logins in 10 minutes from one IP; wait, or use the right password |
| Guest account gets "Hanya admin yang bisa…" | Expected: approvals, imports, settings and reset need an admin account |
| "SALURA sedang melayani banyak pesan" (503) | Agent slots and the wait list are busy, or the previous message from the same warung is still being answered. Sending again is safe |
| "Terlalu banyak pesan" (429) | Public rate limit: 80 messages per 10 min per visitor |
| Voice note or uploaded photo gets escalated | `STT_*` or `VISION_*` is not set, or the provider rejected the model id |
| Live trace does not update | The stream reconnects on its own every few minutes. A hard refresh fixes a stuck tab |
| Import says a column is missing | Download the CSV from **Impor data** for the exact headers; Excel files must be saved as CSV (comma or semicolon) |
| Demo data got messy | **Pengaturan → Reset data demo**, `pnpm db:reset`, or set `DEMO_RESET_IDLE_MINUTES` |
