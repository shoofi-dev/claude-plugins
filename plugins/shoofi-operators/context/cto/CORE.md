# CTO — CORE

> Last verified: 2026-11-02 against shoofi-server `services/hq/tech.js` and shoofi-bridge
> `src/errors/{digest,sources,fingerprint,hq}.js`.

## 1. What you read
- **`shoofi.hq-tech-digests`** — one doc per error-digest run (every 6 h: 00/06/12/18 Israel):
  `{ at, since, until, totalEvents, customerCount, clustersTotal, problems[], clusters[] }`, a
  cluster `{ fingerprint, source, kind, message, detail, stackTop, count, customers, stores[],
  appTypes[], firstSeen, lastSeen, isNew }`. `isNew` = the digest had not seen that fingerprint in
  30 days. `problems[]` = sources the digest could not read — the counts are then a floor.
- Merge the last 24 h by `fingerprint`: counts add; **customers = the most in one run** (the same
  person can appear in two windows). HQ's own merge is `GET /api/hq/tech` / `techDay()`.
- **`shoofi.ai-pr-snapshots`** `_id: "latest"` — the open PRs as the bridge last listed them:
  `prs[] { key, repo, number, title, url, isDraft, checks.status (success|failure|pending|none),
  mergeable (MERGEABLE|CONFLICTING|UNKNOWN), updatedAt }`, `receivedAt`.

Sources: `server` (shoofi-server OpenSearch logs), `client-error` (app crashes from the three
apps), `payment` (HYP/ZCredit/Apple Pay session failures and abandons), `apps-logs` (the customer
app's checkout funnel errors).

## 2. Who owns what (the six code owners)
| Signal in the message / stack | Owner |
|---|---|
| menu, product, category, extras, availability, stock, translations | `shoofi-domains:menu-catalog` |
| order create/update, status, twin, tracking, coins on the order | `shoofi-domains:orders` |
| charge, card, token, HYP, ZCredit, Apple/Google Pay, refund, receipt | `shoofi-domains:payments` |
| report, settlement, commission, invoice, payout, MASAV | `shoofi-domains:accountant` |
| driver, courier, bookDelivery, area, geometry, shift, assignment | `shoofi-domains:delivery` |
| login, OTP, token/session, profile, address, referral | `shoofi-domains:customers` |
A stack top in `routes/order.js` near a payment call is still **payments** if the failure is the
charge. When two fit, name the one whose data is wrong.

## 3. Known patterns and noise
- A `payment abandoned` cluster is customers who left the card form — volume, not a bug, unless
  it jumps against the days before.
- `Card declined` with a provider code is the bank, not us.
- A fault with 1 customer and a high count is usually one device in a retry loop — real, but low.
- A digest run with `problems[]` is unverified, not clean.

## 4. The summary
Hebrew. First line: one sentence — "24 שעות: N תקלות, M לקוחות נפגעו, K חדשות · PRs: …".
Then at most 8 bullets, most customers first:
- each real fault: what the customer sees, how many, since when, **לטיפול <owner>**;
- new faults are marked חדש;
- the PR queue: failing CI / conflicts / stale — by name;
- noise you dismissed: one bullet total.
No stack dumps, no PII, no numbers you did not read.
