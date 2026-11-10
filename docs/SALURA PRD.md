# SALURA: Product Requirements Document (PRD)

**Version:** 0.1 (draft) | **Date:** 5 Oct 2026 | **Companion:** SALURA BRD v0.1 SALURA stands for Smart Agent for Line-items, Updates, Reminders & Approvals.

---

## 1. Product overview

SALURA is an AI agent for Indonesian FMCG distributors. It receives customer messages, builds and validates orders, resolves exceptions, matches delivery documents, and follows up on payments. It acts through tools against the distributor's data and asks a human to approve risky steps.

**Not a chatbot:** every flow ends in a real state change (order, reserved stock, claim, reminder), checked against a database.

## 2. Users

| Persona | Needs |
| --- | --- |
| **Pak Budi**, distributor owner | Fewer errors, visibility, faster collection |
| **Mbak Rina**, order desk admin | Review agent drafts, fix edge cases quickly |
| **Bu Sari**, warung owner | Order by voice or photo, get fast confirmation |
| **Dedi**, warehouse lead | Clear picking list, mismatch alerts |

## 3. Core user stories

1. As Bu Sari, I send a voice note and receive a clear order summary to confirm.
2. As Mbak Rina, I see only the orders that need me, with the reason.
3. As Pak Budi, I see time saved, errors caught and overdue amounts.
4. As Dedi, I get a flagged mismatch when delivered quantities differ from the order.
5. As Pak Budi, I set what the agent may do alone and what needs approval.

## 4. Functional requirements

**P0 = needed for the demo, P1 = should have, P2 = roadmap**

### 4.1 Order intake

| ID | Requirement | P |
| --- | --- | --- |
| FR-1 | Accept text, voice notes and photos in a WhatsApp-style web chat | P0 |
| FR-2 | Transcribe Indonesian voice (including slang and English mixing) | P0 |
| FR-3 | Extract line items, quantities, units (karung, dus, pcs) and delivery notes into a structured order | P0 |
| FR-4 | Resolve references like "yang biasa" from order history | P0 |
| FR-5 | Ask one clarifying question when an item is ambiguous, never guess silently | P0 |
| FR-6 | Match free-text product names to catalog SKUs with a confidence score | P0 |

### 4.2 Validation and exception handling

| ID | Requirement | P |
| --- | --- | --- |
| FR-7 | Check stock per SKU and reserve on confirmation | P0 |
| FR-8 | Propose substitutes for out-of-stock items and wait for customer consent | P0 |
| FR-9 | Check the order against the customer's credit limit and unpaid balance | P0 |
| FR-10 | Split or hold over-limit orders and request owner approval | P0 |
| FR-11 | Apply customer price tiers from the price list, never invent prices | P0 |

### 4.3 Approval and autonomy control

| ID | Requirement | P |
| --- | --- | --- |
| FR-12 | Autonomy modes per action: suggest-only, auto for low risk, approve for high risk | P0 |
| FR-13 | Approval queue with one-tap approve, edit and reject | P0 |
| FR-14 | Audit log for every tool call, decision and approval | P0 |

### 4.4 Document matching

| ID | Requirement | P |
| --- | --- | --- |
| FR-15 | Extract fields from a photo of a surat jalan or nota (including handwriting) | P1 |
| FR-16 | Compare ordered, delivered and invoiced quantities and prices | P1 |
| FR-17 | Draft a query message to warehouse or driver for each mismatch | P1 |

### 4.5 Collections

| ID | Requirement | P |
| --- | --- | --- |
| FR-18 | List overdue invoices by customer and age | P1 |
| FR-19 | Draft reminders in a tone suited to customer history, via approved templates | P1 |
| FR-20 | Record customer replies (promise-to-pay date) | P2 |

### 4.6 Dashboard

| ID | Requirement | P |
| --- | --- | --- |
| FR-21 | Show orders handled, straight-through rate, minutes saved, errors caught, cost per order | P0 |
| FR-22 | Show evaluation scoreboard (accuracy and repeated-run reliability) | P0 |
| FR-23 | Show the live Agent Trace beside the chat | P0 |

## 5. Agent design

**Pattern:** planner/executor loop (reason, call tool, read result, replan) with a validation step before any write.

| Tool | Purpose | Side effect |
| --- | --- | --- |
| `transcribe_audio` | Voice to text | None |
| `read_document_image` | Extract fields from photos | None |
| `search_catalog` | Fuzzy SKU match | None |
| `get_customer_profile` | History, price tier, credit terms | None |
| `check_stock` / `reserve_stock` | Inventory | Writes |
| `check_credit` | Limit versus balance | None |
| `create_order` / `update_order` | Order record | Writes |
| `request_approval` | Send to human queue | Writes |
| `compare_documents` | Order versus delivery versus invoice | None |
| `send_message` | Customer or staff message via template | External |
| `get_overdue_invoices` | Collections list | None |

**Memory:** short-term conversation state; long-term customer order history and preferences. **Knowledge (RAG):** price lists, product synonyms, distributor policies written in the distributor's own terms. **Recovery:** on tool failure or low confidence, retry once, then escalate with a clear reason.

## 6. Guardrails

- The agent cannot confirm prices, discounts or stock not returned by a tool.
- Writes only after validation passes; high-risk actions require approval.
- Responses must avoid bias, offensive content and unsupported claims.
- Reminders use approved templates and respect sending limits.
- Personal data is minimal, access-controlled and deletable; demo uses synthetic data only.

## 7. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Latency | Text reply under 10 s; voice under 20 s (demo target) |
| Reliability | Report accuracy over repeated runs, not a single run |
| Cost | Cost per order logged and shown |
| Security | Secrets in environment config; role-based access to approvals |
| Observability | Structured logs for each tool call |
| Language | Indonesian first, English mixing supported |
| Deployment | Public live URL and public repository |

## 8. Architecture (proposed)

- **Frontend:** web app with WhatsApp-style chat, approval queue, dashboard and Agent Trace.
- **Backend:** API server with an agent orchestrator, tool layer and message abstraction (web chat now, WhatsApp Cloud API later).
- **Models:** LLM with tool calling; speech-to-text; vision model for documents.
- **Data:** relational database for catalog, customers, orders, invoices, audit log; vector store for policies and synonyms.
- **Jobs:** scheduler for overdue-invoice scans.

Final stack to be chosen in week 1, keeping everything deployable on free or low-cost tiers.

## 9. Evaluation plan

- **Dataset:** about 100 synthetic messages (text, voice, photo) with ground-truth orders, including slang, abbreviations, ambiguity, out-of-stock and over-limit cases, and seeded delivery mismatches.
- **Metrics:** item/quantity accuracy, exception-handling success, mismatch detection, straight-through rate, cost per order.
- **Reliability:** run each case 5 times and report consistency (pass^k style).
- **Baseline:** time a person to enter the same orders manually.

## 10. Demo scenarios

1. Slangy voice note becomes a confirmed order.
2. Out-of-stock substitution followed by an over-limit split with owner approval.
3. Handwritten surat jalan mismatch triggers a drafted query and a payment reminder.
4. Dashboard and evaluation scoreboard.

## 11. Milestones

| Week | Deliverable |
| --- | --- |
| Pre-start (to 18 Oct) | Interviews, dataset, stack decisions |
| 1 (19-25 Oct) | FR-1 to FR-6, FR-12 to FR-14, basic UI |
| 2 (26 Oct-1 Nov) | FR-7 to FR-11, FR-15 to FR-19 |
| 3 (2-10 Nov) | FR-21 to FR-23, evaluation, deployment, video, submission |

## 12. Open questions

- Which model and speech providers fit the budget and give acceptable Indonesian voice accuracy?
- Which accounting or ERP export format should we mirror in the CSV/Sheets connector?
- Is a real WhatsApp clip feasible before submission, or is it roadmap only?
- What price tiers and credit-term rules do real distributors actually use?