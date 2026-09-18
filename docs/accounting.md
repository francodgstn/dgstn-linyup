---
title: Accounting
description: Accounting — double-entry ledger (finance plugin)
status: living
area: payments
order: 10
---
# Accounting

The lightweight double-entry accounting module, built on the finance journal
(see [finance-reports.md](./finance-reports.md) for the journal, monthly
reports, and CSV export). Ships inside the **`finance` plugin**: included for
Studio/Organization, a paid Coach add-on (`PLUGIN_ADDONS.finance`,
`linyup_addon_finance_monthly`), upgrade prompt for Free. `beta` on purpose —
see "Before real customers" below.

## Architecture

```
finance_transactions ──(onFinanceTransactionWrite / rebuildAccountingLedger)──→ accounting_entries
                                                                                     │
manual entries (createManualEntry) ─────────────────────────────────────────────────┤
fiscal-year close (closeFiscalYear) ─────────────────────────────────────────────────┤
                                                                                     ↓
                                                    accounting_period_summaries/{YYYY-MM}
                                                                                     ↓
                         client-side: trial balance · P&L · balance sheet · trend charts
```

- **Posting engine** (`@linyup/shared` `accounting/posting.ts`, pure): every
  journal row folds into ONE balanced entry. The generic rule expresses the
  posting as signed debits — clearing[source] `net`, fee accounts `-fees`,
  revenue[category] `-gross` — which sums to zero *by construction* thanks to
  the journal invariant. Payouts post Dr bank / Cr clearing.
- **Trigger + replay**: `onFinanceTransactionWrite` posts incrementally (single
  choke-point over all journal writers, incl. the backfill script);
  `rebuildAccountingLedger` replays the whole journal (deterministic entry ids
  ⇒ pure overwrite) and is the primary correctness mechanism. Installing the
  plugin seeds the chart + settings and runs a rebuild automatically.
- **Immutability**: entries are never edited or deleted. Corrections =
  reversal entry (`rev:{id}`) + a new entry. A reversed entry and its reversal
  both stay in the totals and cancel (the `reversed` status is display
  metadata). Firestore rules: `accounting_entries` / `accounting_period_summaries`
  are function-write-only; accounts are owner-editable but code/type/system are
  locked; the settings' template + closed-year fields are server-owned.
- **Summaries**: per-month per-account debit/credit totals, recomputed inside a
  Firestore transaction whenever a month's entries change. Reports are computed
  client-side from the summaries (`accounting/reports.ts`); the balance sheet
  sums all summaries from inception → the as-of month, with a virtual
  "current period result" equity line so it balances mid-year.

## Chart templates

Three market templates (`accounting/chartTemplates.ts`), chosen at install from
`team.country` (fallback `ch_kmu`), switchable by the owner **until the first
entry exists** (`setChartTemplate`), then locked:

| Template | Numbering | Names |
|---|---|---|
| `ch_kmu` | Swiss KMU Kontenrahmen | de / fr / it / en |
| `de_skr04` | German SKR04 (DATEV) | de / en |
| `it_standard` | Italian piano dei conti (no mandated national numbering) | it / en |

Account names are seeded in the **team's language** and stored as plain
editable strings — they are user data and deliberately don't follow later
UI-language switches. The posting engine reads account codes exclusively from
`accounting_settings.mapping` (each template ships its own defaults) — never
literals — so adding a market is seed data, not engine work.

Each template also seeds accounts for the starter entry templates: utilities
(ch_kmu 6040 / SKR04 6325 / IT 4110), federation fees (6520 / 6420 / 4620) and
an owner-loan liability (2400 / 3560 / 2700). Installs that predate an account
addition pick the new docs up on the next **Rebuild ledger** (or reinstall) —
`ensureAccountingSeeded` is create-only per doc, so re-runs never clobber a
studio's edits. The advisor-review caveat below covers these seeds too.

## Workflows

- **Opening balances** (required for a meaningful balance sheet): the
  **Opening balances wizard** (`/plugins/finance/opening`, owner-only) asks
  studio-language questions (cash, bank, money owed, unpaid bills, owner loan,
  member prepayments, free extra lines), computes the balancing equity figure
  live, and posts ONE ordinary balanced entry through the same
  `createManualEntry` path — no new posting semantics; corrections go through
  Reverse like any manual entry. Question defaults come from
  `OPENING_BALANCE_ROLE_ACCOUNTS` (shared `accounting/chartTemplates.ts`,
  pinned by its test). The raw manual entry (debit bank/cash, credit equity)
  remains valid for anyone who prefers composing it directly.
- **BYO gateway fees**: Payrexx / own-Stripe journal rows are fee-blind, so
  clearing overstates by the gateway's fee. Book the gateway's monthly fee
  statement manually: debit the payment-fees account, credit the gateway's
  clearing account.
- **Entry templates & recurring entries**: owner-managed presets for common
  manual entries (`teams/{id}/accounting_entry_templates`, starter set seeded at
  install: rent, utilities, equipment, federation fees, owner loan in/out).
  Deliberately foolproof — ONE amount, exactly TWO accounts (Dr X / Cr Y),
  balanced by construction; "Use" on the entries page posts through the normal
  `createManualEntry` path. A template with a **fixed amount** can be made
  **recurring** (monthly/yearly, day 1–28): the `materializeRecurringEntries`
  daily task (02:00 UTC) auto-posts it with the deterministic id
  `manual:tpl:{templateId}:{YYYY-MM}` (create-only ⇒ re-runs are no-ops, capped
  catch-up of 12 occurrences). Occurrences that fail validation (closed fiscal
  year, deactivated account) are skipped-but-advanced and surfaced on the
  template as `last_error`; archived teams / uninstalled plugins are skipped
  without advancing. Pure helpers + starter defs: `@linyup/shared`
  `accounting/templates.ts`.
- **Corrections**: reverse the entry (creates the compensating entry), then
  post it correctly. Never edit.
- **Fiscal-year close**: owner-only, years close **in sequence** starting from
  the earliest year with entries; the close entry (`close:{year}`) zeroes every
  P&L account into retained earnings. Reversing the most recent close entry
  reopens the year.
- **Rebuild ledger**: the overview page's button (or plugin re-install) —
  replays the journal, recomputes all summaries, reports foreign-currency
  skips. Never touches manual/reversal/close entries.

## Limitations (v1)

1. **Cash-basis only** — entries mirror money events; no deferred revenue or
   accruals. Receivables/payables/RA accounts are seeded for MANUAL use only.
   The plan that lifts this — an opt-in accrual basis with automatic writers
   for those accounts, plus an asset register — is `docs/finance-accrual.md`.
2. **VAT schema-only** — `tax_code`/`tax_rate_bp` fields exist and each
   template seeds its VAT-payable account (2200 MWST / 3800 USt / IVA a
   debito), but nothing computes or reports VAT. Not a substitute for
   MWST/USt/IVA filing. Note the low registration thresholds in DE (§19 UStG)
   and IT (regime forfettario) — VAT-liable studios there need the future VAT
   module; journal rows already carry `tax_code` so history will be tagged.
3. **Single-currency ledger** — only base-currency journal rows post; foreign
   rows are skipped, counted in `last_rebuild.skipped_foreign_currency`, and
   surfaced on the overview page. No FX, no consolidation.
4. **Not statutory bookkeeping** — management accounting: no sequential
   journal numbering (relevant for German GoBD) and no DATEV-format export
   yet; both are roadmap alongside the VAT module.
5. **Owner-only manual entries** — bookkeepers with a manager role need the
   owner; a capability-system grant is a candidate follow-up.
6. **Opening balances are yours to state** — the wizard guides the entry (see
   Workflows) but nothing is computed from pre-Linyup data; the module never
   pretends pre-Linyup completeness, and history starts at your opening entry.
   Computing the member-obligation side from live operational data is the
   accrual activation flow planned in `docs/finance-accrual.md`.

## Before real customers rely on it

- **A fiscal advisor / accountant must review the three chart-template seeds
  and the posting map per market** — wrong seeded defaults are worse than
  none. This is why the plugin ships as `beta`.
- Confirm the Coach add-on price (`PLUGIN_ADDONS.finance`, suggested CHF
  12/month) and run `pnpm stripe:sync` to provision
  `linyup_addon_finance_monthly`.
- The Stripe Connect webhook endpoint must be subscribed to `payout.paid` +
  `payout.failed` (see finance-reports.md).
