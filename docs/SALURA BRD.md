# SALURA: Business Requirements Document (BRD)

**Product:** SALURA, an AI order-to-cash agent for Indonesian FMCG distributors **Version:** 0.1 (draft) | **Date:** 5 Oct 2026 | **Context:** GTNIC 2026, AI Agent category **Status:** Market figures marked *(hypothesis)* are not yet validated with real distributors.

---

## 1. Executive summary

Indonesian FMCG distributors receive most orders from warung and small stores through WhatsApp: text, voice notes, photos of handwritten lists. Staff re-type these into spreadsheets or accounting software, check stock and credit by hand, and chase payments by chat. SALURA is an AI agent that works inside this existing WhatsApp flow. It turns messy messages into validated orders, handles stock and credit exceptions, reconciles delivery paperwork, and follows up on overdue payments, with a human approving risky actions.

## 2. Problem and opportunity

| Pain point | Who feels it | Current workaround |
| --- | --- | --- |
| Orders arrive as slang text, voice notes and photos | Sales admin | Manual re-typing |
| Stock or credit problems found after the order is accepted | Owner, finance | Phone calls, re-negotiation |
| Delivery paperwork (surat jalan, nota) disagrees with the order | Warehouse, finance | Manual comparison, disputes |
| Late payments chased inconsistently | Owner | Ad hoc chat reminders |

**Opportunity:** Traditional trade is about two-thirds of Indonesian FMCG sales (Kantar, Q1 2025: 67%), WhatsApp is the dominant business channel (MEF 2026: 74% prefer it for company messages), and marketplace players focus on replacing the ordering channel rather than automating the distributor's existing one.

## 3. Business objectives

**Competition (GTNIC 2026)**

- BO-1: Reach the Top 5 finalists and win at the live pitch on 14 Nov 2026.
- BO-2: Score highly on agent autonomy (25%), reasoning (15%), tool use (15%) and architecture (15%).

**Commercial (post-competition)**

- BO-3: Validate the problem with at least 5 distributors before 10 Nov.
- BO-4: Run 1-3 paid or free pilots within 3 months of the competition. *(hypothesis)*
- BO-5: Show positive unit economics per order (agent cost lower than manual handling cost).

## 4. Stakeholders

| Stakeholder | Interest |
| --- | --- |
| Distributor owner (economic buyer) | Fewer errors, faster cash collection, lower admin cost |
| Sales admin / order desk (daily user) | Less typing, fewer disputes; must not feel replaced |
| Warehouse and delivery staff | Clear, correct delivery instructions |
| Finance / bookkeeper | Clean order, invoice and payment records |
| Retailer / warung owner (end customer) | Easy ordering by voice or photo, fast confirmation |
| Competition judges | Real autonomy, tool use, measurable impact |
| Project team | Deliverable scope achievable in about 3 weeks |

## 5. Scope

**In scope:** WhatsApp-style order intake (text, voice, image); catalog, price and stock lookup; credit-limit check; exception handling (substitution, split order); delivery-document matching; payment reminders; approval queue; metrics dashboard; Indonesian market only.

**Out of scope:** tax invoicing, permits, contracts or any regulatory or government process; payments processing; logistics routing; non-Indonesian markets; replacing the distributor's ERP.

## 6. Business requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| BR-1 | Convert unstructured customer messages into structured orders without manual re-typing | Must |
| BR-2 | Check stock and customer credit terms before confirming an order | Must |
| BR-3 | Recover from exceptions (out of stock, over limit, ambiguity) without staff involvement where safe | Must |
| BR-4 | Escalate high-risk actions to a human, with an audit trail | Must |
| BR-5 | Compare delivery documents with the order and flag mismatches | Should |
| BR-6 | Send polite, template-based payment reminders and track outcomes | Should |
| BR-7 | Report time saved, errors caught and autonomy rate | Must |
| BR-8 | Work with data the distributor already has (CSV/Google Sheets first) | Must |
| BR-9 | Understand Indonesian slang, English mixing and voice notes | Must |
| BR-10 | Never fabricate prices, stock or commitments | Must |

## 7. Success metrics

Targets are starting hypotheses to be replaced by measured values.

| Metric | Definition | Target |
| --- | --- | --- |
| Order parse accuracy | Orders whose items and quantities match ground truth | 90% or higher on the test set |
| Reliability | Same task passing across repeated runs (pass^k style) | Reported for k = 5 |
| Straight-through rate | Orders completed with no human edit | 60% or higher *(hypothesis)* |
| Entry time per order | Minutes from message to confirmed order | Measured against a manual baseline |
| Mismatch detection | Seeded delivery discrepancies caught | 90% or higher |
| Cost per order | LLM, speech, vision and messaging cost | Measured and reported |

## 8. Assumptions and constraints

- Distributors take a meaningful share of orders by WhatsApp. *(to validate)*
- Official WhatsApp Business API access may take time to approve, so the competition demo uses a WhatsApp-style web interface; real WhatsApp is a stretch goal.
- Synthetic data only; the team owns privacy and copyright responsibility.
- Project window: 19 Oct to 10 Nov 2026; submission by 10 Nov, 23:59 WIB.
- The interface and repository must be public.

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Meta Business Agent and global AI order-entry tools compete | High | Differentiate on Indonesian depth: slang, voice, handwritten documents, credit terms |
| Agent errors on orders | High | Confidence thresholds, approval queue, repeated-run evaluation |
| Messy or missing distributor data and APIs | Medium | CSV/Sheets connectors, validation, clear data contract |
| Staff resistance | Medium | Position as assistant, keep staff in the approval loop |
| WhatsApp policy or pricing change | Medium | Channel abstraction layer |
| Scope too large for 3 weeks | High | Order intake first, paperwork and collections as thin slices |

## 10. Business model hypothesis

- Monthly subscription per distributor, with tiers by order volume.
- Optional setup fee for data onboarding.
- Pricing to be validated through interviews; set a price only after measuring cost per order.

## 11. Timeline

| Dates | Milestone |
| --- | --- |
| 5-18 Oct | Interviews, synthetic dataset, architecture decisions |
| 19-25 Oct | Order intake, tools, approval queue |
| 26 Oct-1 Nov | Exceptions, document matching, reminders |
| 2-8 Nov | Evaluation, dashboard, deployment, video |
| 9-10 Nov | Proposal polish, submission |
| 12 and 14 Nov | Finalist announcement, live pitch |