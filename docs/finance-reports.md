---
title: Finance reports
description: "Finance reports — journal, monthly rollups, CSV export"
status: living
area: payments
order: 9
---
# Finance reports

The financial reporting substrate. For the double-entry accounting module built
on top of it, see [accounting.md](./accounting.md).

## Architecture

```
member_payments ──(Connect webhook + payout events)──┐
payment_events ──(BYO webhooks + recordManualPayment)┤→ teams/{id}/finance_transactions   ← THE source of truth
                                (backfill script) ───┘        │
                                                              ├→ teams/{id}/finance_monthly_reports/{YYYY-MM}  (cron, always overwritten)
                                                              ├→ exportFinanceReport CSV   (plugin-gated callable)
                                                              └→ accounting_entries        (accounting plugin, see accounting.md)
```

- **`finance_transactions`** — one immutable row per money event, all rails
  (Connect, BYO Stripe, Payrexx, manual). Deterministic doc ids
  (`{source}:{type}:{ref}`) make every writer idempotent. Written **only** by
  Cloud Functions; manager/owner read. Journal writing is always on — the
  finance plugin gates the export and UI, never data capture.
- **Sign convention** — signed integer minor units (Rappen/cents), studio
  perspective. Invariant: `gross + stripe_fee + platform_fee === net`
  (exception: `payout` rows are pure balance movements, `net = -amount`).
- **Fees** — Connect charges are enriched with the charge's balance
  transaction (`fee_source: 'balance_transaction'`): actual Stripe processing
  fee, application (platform) fee, and net. Async payment methods (TWINT, …)
  have NO balance transaction yet at `payment_intent.succeeded` — their row is
  written with `fee_source: 'recorded'` (platform fee from our record, Stripe
  fee 0) and **healed automatically by the `charge.updated` handler** once
  Stripe populates the balance transaction. Rows that miss the healer (e.g.
  the event wasn't subscribed) are upgraded by the backfill (`--force-fees`).
- **Payouts** — `payout.paid` / `payout.failed` events write `payout` rows and
  stamp `payout_id` onto the swept charge rows, so the journal reconciles
  against the studio's bank statement.
- **Monthly reports** — the `monthlyFinanceReports` cron (3rd of the month,
  03:00 Europe/Zurich) regenerates the previous two months for every team,
  always overwriting (the journal is the source of truth). Each report carries
  a `reconciliation_check` comparing journal charge counts against the source
  collections — a mismatch means a missed webhook write; run the backfill.

## Ops requirements

- **Stripe Connect webhook endpoint must be subscribed to `payout.paid`,
  `payout.failed`, and `charge.updated`** (in addition to the existing
  charge/subscription/dispute events). `charge.updated` powers the fee-split
  healer for async payment methods (TWINT, …). Configure in the Stripe
  Dashboard → Webhooks → Connect endpoint.
- Secrets: reuses `stripe-secret-key` (the platform key) for balance-transaction
  and payout reads on connected accounts.

## Backfill / reconcile runbook

```bash
# Dry-run against staging (report only):
STRIPE_SECRET_KEY=sk_... pnpm backfill:finance --project linyup-staging --dry-run

# Apply, one team only:
STRIPE_SECRET_KEY=sk_... pnpm backfill:finance --project linyup-staging --team <teamId>

# Emulator (no Stripe calls; Connect rows get fee_source 'recorded'):
FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm backfill:finance --project demo-linyup --skip-stripe

# Upgrade rows that were written without balance-transaction fees:
STRIPE_SECRET_KEY=sk_... pnpm backfill:finance --project linyup-prod --force-fees
```

Fully re-runnable: existing rows are skipped (`create()` + ALREADY_EXISTS). The
script is also the reconcile tool whenever a report's `reconciliation_check.ok`
is false.

## CSV export

`exportFinanceReport({ teamId, month })` — callable, manager+, gated by the
**finance plugin** install state (`installed_plugins/finance` active). Returns
`{ filename, csv, rowCount, month }` inline (guard at 8 MB).

### Column schema (public contract — append, never rename/reorder)

| Column | Content |
|---|---|
| `txn_id` | Deterministic journal id, e.g. `connect:charge:pi_…` |
| `occurred_at` | ISO 8601 with Zurich offset, e.g. `2026-06-14T18:32:11+02:00` |
| `month` | `YYYY-MM` period key (Europe/Zurich) |
| `type` | `charge` \| `refund` \| `dispute` \| `dispute_reversal` \| `payout` \| `adjustment` |
| `source` | `connect` \| `byo_stripe` \| `payrexx` \| `manual` |
| `source_ref` | Rail-native reference (pi_/re_/dp_/po_ id, gateway tx id) |
| `payout_id` | Linking payout (`po_…`) when settled, else empty |
| `status` | `recorded` \| `corrected` (corrected rows are superseded by adjustments) |
| `contact_id` | Linked Linyup contact, else empty |
| `category` | `membership` \| `drop_in` \| `course` \| `product` \| `other` |
| `description` | Human label ("what was paid") |
| `currency` | Uppercase ISO 4217 |
| `gross`, `stripe_fee`, `platform_fee`, `net` | Signed decimal **major units**, 2 dp, dot separator (internal storage is integer minor units). `gross + stripe_fee + platform_fee = net` per row (except payouts). |
| `fee_source` | `balance_transaction` (authoritative) \| `recorded` (Stripe fee unknown) \| `none` (BYO/manual — fee-blind) |

Format: UTF-8, CRLF line endings, RFC 4180 quoting, header row always present,
rows ordered by `occurred_at` (charges and payouts interleave chronologically —
what an accountant reconciling a bank statement expects).

## Known limitations

1. **BYO/manual fee blindness** — Payrexx/BYO-Stripe/manual rows carry fee 0
   (`fee_source: 'none'`); `net` overstates by the gateway's fee. Workflow: book
   the gateway's monthly fee statement as a manual accounting entry (see
   accounting.md).
2. **Contact reassignment is not mirrored** — the journal keeps the contact
   known at payment time; a manager's later reassignment via
   `updatePaymentRecord` updates the payment record but not the journal row
   (the backfill re-syncs missing links from `member_payments`).
3. **`tax_code` is captured but unused** — VAT-readiness only. Codes are
   currently null; a future VAT module derives historical codes from
   `category` and stamps real codes going forward.
4. **Zero/null-amount `payment_events`** are recorded in the ledger but never
   journaled (no money moved) — a rare, benign source of `reconciliation_check`
   drift.
5. **Timezone** — period bucketing is Europe/Zurich (CH/DE/IT all share
   CET/CEST). The month-key helper is timezone-parameterized for later markets.
