# SALURA — Technical Specification Document (TSD)

**Product:** SALURA, an AI order-to-cash agent for Indonesian FMCG distributors
**Version:** 0.1 (draft) | **Companion:** SALURA BRD v0.1, SALURA PRD v0.1
**Scope:** Competition MVP only. No production SaaS, billing, or multi-tenant hardening.

---

## 1. Document Information

| Field | Value |
|-------|-------|
| Version | 0.1 |
| Status | Draft |
| Author | SALURA team |
| Audience | Developer (solo build), competition judges |
| Scope | Competition MVP — order intake, validation, approval, dashboard, evaluation |

---

## 2. Executive Summary

SALURA is an AI agent that lives inside a distributor's existing WhatsApp channel. A warung owner sends a text, voice note, or photo of a handwritten order; the agent transcribes and extracts a structured order, validates it against stock and credit, resolves exceptions (substitution, over-limit split) with the minimum human involvement, and drives risky actions through an approval queue. The human-facing surface is an ops console — approval queue, dashboard, live agent trace — not a chat UI.

This document fixes the technical decisions for the competition build: a TypeScript monorepo, a self-hosted OpenWA gateway for the WhatsApp channel (Telegram behind the same abstraction as a fallback), a planner/executor agent loop over a typed tool layer, a Postgres (or SQLite) store for structured data plus a vector store for product synonyms, and a replayable evaluation harness. Dates and interview milestones from the BRD/PRD are ignored; build order is dependency-driven only.

---

## 3. Scope

### 3.1 In Scope (MVP)

- Native WhatsApp order intake via OpenWA (text, voice note, photo), Telegram as fallback channel.
- Indonesian speech-to-text (slang + English mixing).
- Structured order extraction: line items, quantities, units, delivery notes.
- Catalog SKU matching with confidence; "yang biasa" resolution from order history.
- Stock check + reserve; credit-limit check; substitute proposal; over-limit split/hold.
- Price-tier application (never invent prices).
- Autonomy modes (suggest-only / auto / approve) with an approval queue and full audit log.
- Ops console: approval queue, metrics dashboard, evaluation scoreboard, live agent trace.
- Synthetic dataset + evaluation harness (accuracy, pass^k reliability, cost per order).
- Public repository and public live URL.

### 3.2 Out of Scope (MVP)

- Real distributor data or integrations (CSV/Sheets connector is a stub for the demo).
- Document matching (surat jalan) and collections — thin slice only, P1/P2.
- Tax invoicing, payments, logistics, ERP replacement, non-Indonesian markets.
- Production WhatsApp Cloud API migration (OpenWA is the demo harness; Cloud API is a later adapter swap).
- Billing, auth for paying tenants, multi-tenancy hardening.

---

## 4. Requirements

### 4.1 Functional Requirements (traceable to PRD FR-IDs)

| ID | Requirement | Priority | Acceptance Criteria |
|----|-------------|----------|---------------------|
| FR-1 | Receive text, voice, and photo orders over OpenWA (Telegram fallback) | P0 | Message arrives via webhook and is normalized; send_message reaches the warung |
| FR-2 | Transcribe Indonesian voice with slang/English mixing | P0 | Voice note → text with item/quantity correctly parsed |
| FR-3 | Extract line items, quantities, units, delivery notes | P0 | Structured order matches ground truth ≥ 90% on test set |
| FR-4 | Resolve "yang biasa" from order history | P0 | Reference resolves to the customer's prior items |
| FR-5 | Ask one clarifying question on ambiguity, never guess | P0 | Ambiguous item triggers exactly one targeted question |
| FR-6 | Match free-text names to SKUs with confidence | P0 | Confidence score returned per match; low confidence escalates |
| FR-7 | Check stock and reserve on confirmation | P0 | Order blocked when stock insufficient; reserve on confirm |
| FR-8 | Propose substitute on out-of-stock, wait for consent | P0 | No order change without customer consent |
| FR-9 | Check credit limit vs unpaid balance | P0 | Over-limit order does not auto-confirm |
| FR-10 | Split/hold over-limit orders, request owner approval | P0 | Approval queue entry with clear reason |
| FR-11 | Apply customer price tier, never invent prices | P0 | Every price traced to the price list |
| FR-12 | Autonomy modes per action | P0 | Owner can set suggest/auto/approve per action class |
| FR-13 | Approval queue (approve/edit/reject) | P0 | One-tap decision writes back to the order |
| FR-14 | Audit log for every tool call, decision, approval | P0 | Full replayable trace |
| FR-21 | Metrics dashboard (handled, STR, minutes saved, errors, cost) | P0 | Live numbers, not mockups |
| FR-22 | Evaluation scoreboard (accuracy, pass^k) | P0 | Runs against the eval harness |
| FR-23 | Live agent trace beside the conversation | P0 | Every tool call + reasoning visible in order |

### 4.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Text reply latency | < 10 s |
| NFR-2 | Voice handling latency | < 20 s |
| NFR-3 | Reliability | Reported over pass^k (k = 5), not a single run |
| NFR-4 | Cost observability | Cost per order logged and surfaced |
| NFR-5 | Security | Secrets in env; scoped OpenWA keys; immutable audit log |
| NFR-6 | Language | Indonesian first, English mixing |
| NFR-7 | Deployment | Public live URL + public repository |

---

## 5. Technical Design

### 5.1 Architecture Overview

```
                    ┌─────────────────────────────────────────────┐
                    │              Ops Console (Next.js)           │
                    │   Approval Queue · Dashboard · Agent Trace   │
                    └───────────────────┬─────────────────────────┘
                                        │ REST
                    ┌───────────────────▼─────────────────────────┐
                    │            API + Agent Runtime (Node)         │
                    │  orchestrator · tool layer · webhook receiver │
                    └───────┬──────────────────┬──────────────────┘
                            │                  │
                     ┌──────▼──────┐    ┌──────▼──────┐
                     │   OpenWA     │    │   Database   │
                     │ (WhatsApp)   │    │ Postgres/SQLite
                     │  + Telegram   │    │  + pgvector   │
                     └─────────────┘    └─────────────┘
```

One always-on host runs the API + agent runtime + OpenWA (a live WebSocket session cannot run on serverless). The Next.js console is served separately. The channel is behind a `Channel` interface with two adapters (`OpenWAChannel`, `TelegramChannel`); the agent never talks to WhatsApp directly.

### 5.2 Stack (recommended — flag for veto)

| Layer | Choice | Why |
|-------|--------|-----|
| Language / workspace | TypeScript, pnpm monorepo | Matches solo Node strength; OpenWA is TS |
| Frontend | Next.js (App Router) | React; design.md will drive it later |
| Backend | Fastify or Hono (single Node service) | Webhooks + long agent loops need always-on, not serverless |
| Agent orchestration | Thin custom planner/executor over OpenAI-compatible SDK | Full control of the audit trace; matches PRD's stated pattern |
| DB | Postgres (Neon/Supabase free) + pgvector; SQLite fallback | Relational for orders; vector for synonyms |
| ORM | Drizzle (TS-first) | Lightweight, typed |
| Channel | OpenWA (self-hosted, whatsapp-web.js engine) | Immediate WhatsApp, no Meta approval cliff |
| LLM | OpenAI-compatible endpoint (deepseek-v4-pro default) | Configurable base URL |
| STT | OpenAI Whisper (or local faster-whisper) | Best Indonesian accuracy per cost |
| Vision (P1) | Multimodal model (Qwen-VL / GPT-4o-mini) | Surat jalan / nota extraction |
| Embeddings | text-embedding-3-small or local | Product-synonym vector store |

### 5.3 Component Design

#### 5.3.1 Channel abstraction

**Purpose:** Isolate messaging so WhatsApp/Telegram are interchangeable and OpenWA can later be swapped for the Cloud API.

**Responsibilities:** normalize inbound (text / voice / image / buttons) into a `Message` envelope; send outbound via templates or free-form; track the 24h-window and template constraints (not relevant on OpenWA, relevant on Cloud API later).

**Dependencies:** OpenWA REST API + webhooks; Telegram Bot API.

#### 5.3.2 Agent orchestrator

**Purpose:** Planner/executor loop — reason, select tool, call tool, read result, replan — with a validation gate before any write.

**Dependencies:** tool registry, memory (short + long term), audit log, model client.

#### 5.3.3 Tool layer

Typed tool definitions (name, schema, side-effect class) registered in one place. Reads are side-effect-free; writes pass validation; external sends are templated. From PRD section 5:

| Tool | Side effect |
|------|-------------|
| `transcribe_audio` | none |
| `read_document_image` | none |
| `search_catalog` | none |
| `get_customer_profile` | none |
| `check_stock` / `reserve_stock` | reserve = write |
| `check_credit` | none |
| `create_order` / `update_order` | write |
| `request_approval` | write |
| `compare_documents` | none |
| `send_message` | external |
| `get_overdue_invoices` | none |

### 5.4 Data Model (MVP entities)

- `product` — id, sku, name, unit, price-tier rows.
- `price_tier` / `product_price` — product_id, tier, unit_price.
- `customer` — id, name, wa_id, price_tier, credit_limit, unpaid_balance.
- `stock` — product_id, qty_on_hand, reserved_qty.
- `order` — id, customer_id, status, source_message_ref, total, created_at.
- `order_item` — order_id, product_id, qty, unit, unit_price, substituted_from.
- `approval` — id, type, action_payload, status, reason, decided_by, decided_at.
- `audit_log` — id, ts, actor, tool, input_summary, output_summary, decision, confidence.
- `conversation_state` — wa_id, session state, recent context (short-term memory).
- `invoice` (P1) — id, customer_id, amount, due_date, status.
- `product_synonym` / vector table — for SKU matching and "yang biasa".

### 5.5 API (consumed by the ops console)

| Endpoint | Purpose |
|----------|---------|
| `POST /webhooks/openwa` | Inbound messages from OpenWA |
| `GET /api/orders` | List orders (filter by status / needs-approval) |
| `GET /api/orders/:id` | Order detail + agent trace |
| `POST /api/approvals/:id/approve` | One-tap approve |
| `POST /api/approvals/:id/reject` | Reject with reason |
| `POST /api/approvals/:id/edit` | Edit then approve |
| `GET /api/dashboard/metrics` | STR, minutes saved, errors, cost/order |
| `GET /api/eval/scoreboard` | Accuracy + pass^k results |
| `GET /api/traces/:orderId` | Live tool-call trace |

---

## 6. Security Considerations

### 6.1 Authentication / Authorization

- OpenWA API keys scoped to the session (and chat) the agent uses — the agent must not reach the whole account.
- Ops console: owner vs viewer roles for approval actions.

### 6.2 Data Protection

- Synthetic data only — no real customer PII in the demo.
- Secrets (OpenWA key, model keys, DB URL) in environment config, never committed.

### 6.3 Audit Logging

- Immutable append-only log: every tool call, decision, and approval, with confidence and reasoning.

---

## 7. Error Handling

| Category | Strategy |
|----------|----------|
| Tool failure / timeout | Retry once, then escalate to approval queue with the reason |
| Low confidence (SKU match, extraction) | One clarifying question; never silent guess |
| Channel disconnect (OpenWA) | Reconnect with backoff; surface session status in console |
| Validation failure before write | Block the write, log, return to planner |

---

## 8. Testing / Evaluation Strategy

- Dataset: ~100 synthetic messages (text, voice, photo) with ground-truth orders — slang, abbreviations, ambiguity, out-of-stock, over-limit, seeded delivery mismatches.
- Metrics: item/quantity accuracy, exception-handling success, mismatch detection, straight-through rate, cost per order.
- Reliability: run each case 5 times, report consistency (pass^k).
- Baseline: time a human entering the same orders manually.

---

## 9. Deployment

### 9.1 Prerequisites

- Always-on host for API + OpenWA (Railway / Fly.io / small VPS) — OpenWA needs a persistent WebSocket session.
- Managed Postgres (Neon/Supabase free tier), or SQLite on the host for a zero-dep single-container demo.
- Next.js frontend on Vercel (or served from the same host).

### 9.2 Open Decisions (confirm before build)

1. Stack veto — TypeScript monorepo vs Python (LangGraph) backend.
2. STT provider — OpenAI Whisper API vs local faster-whisper (cost vs accuracy).
3. Vision provider for P1 document matching.
4. DB — managed Postgres vs SQLite for the demo.
5. Host — Railway vs Fly.io vs a VPS you already have.

---

## 10. References

- SALURA BRD v0.1
- SALURA PRD v0.1
- OpenWA — https://github.com/rmyndharis/OpenWA (unofficial WhatsApp API gateway)
- OpenWA risk guidance (ban risk, safe-sending) — README "Before you connect a number"

---

## Appendix A. Glossary

| Term | Definition |
|------|------------|
| STR | Straight-through rate — orders completed with no human edit |
| pass^k | Same task passing across k repeated runs |
| surat jalan | Indonesian delivery note / waybill |
| nota | Invoice / receipt |
| warung | Small family-owned shop (the end customer) |
| OpenWA | Self-hosted unofficial WhatsApp API gateway |
