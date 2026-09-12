# Finance v2 — Accrual & Assets (plan)

**Status: PLAN.** Phases 1 and 3 below are not implemented. What IS shipped from
this plan: Phase 0 (`MemberSubscription.current_period_start` is persisted),
Phase 0.5 (the opening-balances wizard), and Phase 2's **register-only slice**
(the asset register + statement of assets, pulled ahead of Phase 1 on Franco's
call, 2026-09-01 — depreciation POSTINGS still wait for accrual mode) — see
"Phasing". Everything else is the recorded design for future implementation,
written down so the decisions and their reasoning survive until then. Decisions
dated 2026-08-31 were made by Franco in the planning session.

**One-line pitch:** give the accrual accounts the chart templates already seed
their automatic writers, computed from operational data Linyup already holds —
so a studio's January P&L stops lying about December's annual-membership sales,
and the fiduciary gets a clean file instead of a reconstruction job.

**The boundary:** Linyup is not an accounting tool that happens to know about
studios; it is a studio tool whose accounting layer knows things no accounting
tool can know — who has paid for what they haven't used yet, and what equipment
is on the floor. Anything a horizontal accounting suite does better stays out
(see Non-goals).

## Why this is an extension, not a build

The two layers below already exist (`docs/finance-reports.md`,
`docs/accounting.md`):

| Layer | Role | Basis |
|---|---|---|
| Finance journal (`finance_transactions`) | Immutable money facts, one writer | Cash, always — **untouched by this plan, not one field** |
| Accounting ledger (finance plugin) | Double-entry books derived from the journal | Cash today → **basis becomes a team setting** |
| Recognition layer (new) | Automatic deferral + release entries | Accrual |

The prepaid/deferred accounts are **already seeded** in all three chart
templates (ch_kmu 1300/2300, SKR04 1900/3900, IT 1500/2500) with no automatic
writer — `docs/accounting.md` limitation #1 calls that out, and
`chartTemplates.ts` names the gift-card revenue bucket "the cash-basis shadow of
the liability an accrual ledger would carry". This plan is that writer.

Market context (researched 2026-08): no studio platform (Mindbody, Glofox,
TeamUp, Momence, zingfit, Arketa, Walla) is a general ledger — all keep
operational billing + reports and feed QuickBooks/Xero (CH: Bexio/Banana/Klara)
via summarized entries. The one accrual feature the vertical ships is the
**Earned vs Deferred Revenue report pair** (Mindbody recognizes time-based
memberships per day and session packs per visit; zingfit takes the remainder to
income at package expiration). Nobody in the vertical does equipment/asset
registers. Regulatory anchor: **Art. 957 CO** — sole props/partnerships under
CHF 500k turnover may keep simplified accounting = income + expenses + a
**statement of assets** ("Milchbüchleinrechnung"); at ≥ CHF 500k or for any
AG/GmbH, full double-entry. So: serve the small studio completely in-app; be an
impeccable *feed* into the fiduciary's tool for the rest.

## Design stance

- **Recognition is derived, deterministic, replayable.** A new
  `AccountingEntrySource` member (`accrual`) with its own deterministic id
  namespaces (directionally `defer:{txn}`, `earn:{stream}:{item}:{YYYY-MM}`,
  `dep:{asset}:{YYYY-MM}`, `accrualopen:{fy}`), materialized monthly on the
  pattern the recurring-template poster already proves out
  (`manual:tpl:{id}:{YYYY-MM}`, create-only, capped catch-up), and regenerated
  by an extended `rebuildAccountingLedger`. Every recorded invariant holds: one
  writer per collection, deterministic ids, corrections-by-new-rows, replay as
  the correctness mechanism, no parallel resolvers.
- **THE ONE HARD RULE: recognition is a pure function of CAPTURED FACTS** —
  price, `credits_total`, expiry, the service period snapshotted at the sale,
  plus monthly usage facts the system records — never of mutable live counters
  (`credits_used` keeps moving after a month closes; a schedule derived from it
  cannot replay). Each deferrable sale gets a stored recognition schedule that
  replay regenerates identically. This is the plan's #1 design risk; everything
  else is bookkeeping.
- **One basis setting per team (Cash default / Accrual), not parallel books.**
  Accrual ON means deferral/release entries post into the ledger and every
  existing report (trial balance, P&L, balance sheet, trends) becomes accrual
  automatically — zero new report machinery, no second resolver, no dual
  statements. Cash mode gains ONE informational card — "Obligation to members:
  CHF X", computed from operational data — which doubles as the activation
  preview and the upgrade funnel. Rejected: always-available dual-basis
  statements (that is the horizontal-tool trap and the strategy doc's
  "over-complex reporting" non-goal).
- **Mid-life switch:** activation picks an effective date (default next
  fiscal-year start; any month start allowed). History before it stands as cash
  forever; one computed opening entry books the deferred position; recognition
  runs from then on. Deactivation only at a fiscal-year boundary — a serious,
  semi-one-way decision, presented as one.
- **Packaging (decided 2026-08-31): accrual is a Studio/Organization-tier
  capability inside the existing `finance` plugin.** No new SKU, no second
  plugin through one ledger. The Coach add-on keeps cash basis **plus the asset
  register** — deliberately, because the statement of assets is what the
  *smallest* Swiss entities legally need (Art. 957 simplified regime), so
  gating it to Studio would invert the compliance logic. The ladder: Coach +
  finance add-on = complete simplified accounting (income + expenses + asset
  statement); Studio/Org = accrual basis, deferred revenue, depreciation
  postings, earned-revenue reporting.

## Recognition policy per revenue stream

Two principles: **materiality over purity** (spread only where cash timing and
service period diverge by more than a month; every policy must be explainable
to a studio owner in one sentence) and **monthly granularity** (the ledger's
only period key is `month`; recognition is straight-line per month, sale month
= first tranche — deliberately not Mindbody's per-day precision, which a
monthly ledger cannot honestly carry).

| Stream | Policy | Needs / gap |
|---|---|---|
| Monthly, weekly, biweekly subscriptions | Recognize at charge (cash month ≈ service month) | — |
| Quarterly subscriptions | Straight-line over 3 months | Service period per charge — **Phase 0, SHIPPED** |
| Annual subscriptions | Straight-line over 12 months — the headline case | Same |
| `one_time` + `included_months` prices | Straight-line over the included months | Snapshot months + amount at charge, linked to the journal row |
| Credit packs | Defer at sale; release per credit used (price ÷ `credits_total`) from monthly usage facts; **breakage**: remaining balance → revenue in the `expires_at` month, under a written policy, default ON. No-expiry packs stay liability indefinitely; dormancy release OFF pending advisor input | Monthly usage-facts capture (Phase 1) |
| Gift cards | Defer at sale to a liability account; release to the redeemed category at redemption — the reclass pair exists, accrual mode repoints the posting map exactly as the `chartTemplates.ts` comment anticipates. No breakage in v1 (cards don't expire) | Posting-map change only |
| Courses | At charge — lifetime entitlement is point-in-time delivery of access | — |
| Drop-ins, paid trials, appointments, policy fees | At charge (immaterial timing) | — |
| Products | At sale; COGS only if retail stock ever ships (out of scope here) | — |
| Intro offers / promo codes | Nothing — the smaller charge IS the money event; discounts are never booked as contra-revenue (same rule as the journal: `docs/promo-codes.md`) | — |
| Manual/offline payments | Same policy as their recurrence; the capture UI gains OPTIONAL "period covered" fields, absent which recognition degrades to at-charge — graceful, no forced admin | Small capture-UX addition |
| Manager-assigned memberships (no payment row) | **Recognize nothing.** No money event → nothing to defer; never fabricate journal rows. Shown memo-only in the obligation drill-down | — |
| BYO fee-blind rails | No special handling — fee-blindness distorts fees/clearing, never gross revenue by category | — |
| Partner/aggregator visits | Never journaled → never recognized (stated, not silent) | — |

**Refunds:** recognition is separable from the refund policy (which deliberately
has no pro-rata — `docs/payment-contact-studio.md`). Engine rule, one sentence:
*a refund unwinds the unrecognized part first* — reduce the item's remaining
deferred balance, and only the excess hits revenue as negative. No refund-UX
change, and the deferred balance of a pack is NOT a refund entitlement.

## Expense side

- **IN — prepaid-expense spreading:** a "spread over N months" option on entry
  templates / manual entries (Dr prepaid at payment, 1/N released monthly via
  the existing materializer pattern). Annual insurance, federation fees,
  prepaid rent. The highest value-per-effort item in the plan.
- **OUT — accrued expenses as a subsystem.** No bills entity, no AP, no due
  dates. One narrow exception: the fiscal-year-close assistant (Phase 3) asks
  "any bills for this year you'll pay next year?" and books a guided accrual
  (Dr expense / Cr deferred) flagged **auto-reversing on day 1 of the new
  year** — the accountant's year-end Abgrenzung without importing AP culture.
  Payroll accrual stays out entirely (no payroll model exists; personnel
  expense remains a manual/template target).

## Assets — and what "inventory" means

The word splits in two, and the halves land in different places (decided
2026-08-31):

1. **Asset register → its OWN plugin (`asset-register`); the STATEMENT of
   assets and the depreciation postings stay in finance** (revised 2026-09-01,
   Franco).

   *Superseded reasoning, kept because it explains the shape:* the register was
   originally scoped as a finance-plugin FEATURE, on the grounds that
   depreciation must post into a ledger with one writer and that Art. 957 makes
   the asset statement an accounting concern of the smallest customers.

   Both of those argue for finance owning the **posting** and the **statement**
   — not the register. The register answers an OPERATIONAL question (what do we
   own, how many, where, in what condition), which is the boundary this document
   already states one paragraph below: *operational plugins own operational
   truth; the finance plugin owns every ledger posting.* Equipment was the one
   exception to that rule and no longer is; finance READS the register exactly
   as it reads subscriptions, credit packs and gift cards.

   The dependency therefore runs **finance → asset-register**
   (`PLUGIN_REQUIREMENTS`), which keeps the statement always reachable for an
   accounting user while leaving the register installable on its own. The
   register is included from **Coach** with no add-on: it costs nothing to
   serve, posts nothing, and a solo coach owns kit too.
2. **Retail stock / COGS → a separate future track on the products plugin**
   (the Glofox-style stock counter). It shares nothing with the register except
   the word. Not part of this initiative.

**Interaction boundary — ONE rule:** operational plugins own operational truth;
the finance plugin owns every ledger posting, derived one-directionally through
its single posting engine. If retail stock ever ships and an accrual studio has
material stock, finance READS counts/costs and posts stock-value/COGS lines —
the same relationship it has with subscriptions, packs and gift cards. A later
operational equipment layer (maintenance, loan-out, QR labels) builds ON TOP of
the finance-owned register records — extra fields and screens, never a second
asset list.

**Register scope (deliberately small):** name, category (equipment / leasehold
improvements / vehicles / IT / other) with default useful lives, acquisition
date, cost, optional photo (insurance documentation is a free side-benefit),
location for multi-club orgs. Straight-line to zero; no residual values, no
component accounting, no revaluation.

**SHIPPED (2026-09-01, register-only slice):** `/plugins/asset-register`, its
own Coach+ plugin with an "Assets" nav row (it shipped for one day at
`/plugins/finance/assets` as a finance feature — see the revision above); `Asset` type (`shared/types/asset.ts`,
minor-unit cost, `acquired_at` drives the schedule), pure `assetBookValue`
(`shared/accounting/assets.ts`, whole-month UTC, floor-rounding that lands
exactly on cost — unit-tested); statement-of-assets export with an
active-assets totals row; dispose (sold/scrapped + proceeds, RECORDED ONLY);
data at `teams/{id}/asset_register`, owner+manager client-writes / manager
reads per rules (the accrual phase routes writes through callables before postings depend
on these fields). The register is the statement's data source — one feature,
two views.

**Policy:** immediate-expense threshold, default CHF 1'000, owner-adjustable
(Sofortabschreibung is common and tax-accepted Swiss practice — many small
entities rightly expense everything). Below the threshold: expensed at
purchase, exactly today's behavior (`tpl_equipment` → maintenance & equipment).
Above: capitalize and depreciate monthly via the recurring-poster pattern
(`dep:{assetId}:{YYYY-MM}`). Disposal is a guided flow (sold for X / scrapped)
producing the derecognition entry and gain/loss.

**REGISTRATION ≠ PURCHASE.** An asset record carries an *acquisition date*
distinct from record-creation time, and the date drives the schedule. Existing
equipment registered later enters at **net book value as of the
opening/effective date** — accumulated depreciation to that date is computed
and the consumed portion never touches the P&L; fully-depreciated gear enters
at zero, register-only — via an opening/carry-in entry, NEVER a purchase entry
dated "today". A purchase entry originates only from an actual money event or
an explicit record-purchase step.

**Two modes, matching the packaging ladder:**

- **Cash mode (Coach+): register-only.** Adding equipment posts NOTHING — on a
  cash basis the purchase already hit the books as an expense at purchase time,
  and a posting on registration would double-count it or retroactively
  capitalize it (which IS the accrual move). The register computes *indicative*
  straight-line book values for its page and the statement-of-assets report
  only — never ledger entries. That is precisely the Art. 957 simplified shape:
  expenses stay expenses, plus a maintained asset LIST with values. Nothing is
  lost for later: the same records feed the accrual activation's NBV carry-in.
- **Accrual mode (Studio+):** capitalization above the threshold, monthly
  depreciation postings, book values on the balance sheet, disposal entries.

Deliberately NO "cash everywhere except assets" half-mode — a ledger whose
basis varies by account is unreasonable for owner and fiduciary alike. A
cash-mode owner who wants balance-sheet assets enables accrual, or hand-posts
manual entries as always.

Chart consequence: fixed-asset and accumulated-depreciation accounts join the
three templates via the create-only `ensureAccountingSeeded` re-run pattern,
and join the advisor-review scope.

## Opening balances & activation — the differentiator

Every accountant reconstructs a studio's deferred revenue annually by
interrogating the owner about packs and running memberships. **Linyup holds the
operational truth** — this is where the data advantage becomes visible money.

**Shipped now (Phase 0.5): the opening-balances wizard**
(`apps/web/src/app/[locale]/(auth)/plugins/finance/opening/`) — a guided
interview replacing "compose a balanced journal entry yourself" (the former
limitation #6 of `docs/accounting.md`). Studio-language questions — cash on
hand, bank balance, money owed to you, unpaid bills, owner loan, "services
members have paid for but not yet used" — plus free asset/liability lines, with
the balancing equity figure computed live. It posts ONE ordinary balanced entry
through the EXISTING owner-only `createManualEntry` callable: same validation,
same closed-year guard, one-writer rule intact, corrections via the entries
page's Reverse. Zero new server surface. Default account codes per question
come from `OPENING_BALANCE_ROLE_ACCOUNTS` (`@linyup/shared`
`accounting/chartTemplates.ts`, pinned by `chartTemplates.test.ts`); the owner
can re-pick any active account. **File import: DISCARDED** (2026-08-31) —
guided interview only; mapping arbitrary trial-balance files is where
horizontal-tool effort hides. Revisit only on real demand.

**Planned (Phase 1): the "Switch to accrual" activation flow**, reusing the
wizard as its shell: (1) pick the effective date → (2) Linyup COMPUTES the
opening obligation from live data — paid-but-unelapsed subscription coverage
(`subscription_history` spans + period snapshots), unexpired pack credits ×
per-credit value (`CreditGrant`), outstanding gift-card balances — as an
itemized, member-level, reviewable list the owner can exclude or adjust →
(3) optionally register pre-existing assets (Phase 2 adds this step: cost +
acquisition date → NBV carried in) → (4) one deterministic opening accrual
entry → (5) automatic from then on. The same computation powers the cash-mode
obligation card, so studios see the number — and what activation means — long
before they switch.

**Aligning with existing books is possible TODAY**, wizard or not: post the old
books' closing balances as the opening entry (the seeded receivable / payable /
deferred-income / owner-loan accounts are exactly for this), and hand-roll
monthly releases or depreciation with custom accounts + recurring templates if
wanted. This plan AUTOMATES and COMPUTES that; it does not newly enable it.

**Migrated tenants (HMD):** the migration carries the subscription catalogue
and each contact's plan — NOT paid-until dates or credit balances. So a
migrated tenant's pre-migration obligations enter the computed opening as
manual adjustment lines (the flow supports that by design). Optional lever,
not decided: extend the migration to carry paid-until dates if a computed HMD
opening is wanted.

## Reports — add these and nothing more

| Report | Mode |
|---|---|
| **Earned vs Cash revenue** — monthly series per category, earned (revenue accounts) vs collected (journal). The vertical's flagship. One page | Accrual |
| **Obligation to members** — deferred balance by source (subscriptions / packs / gift cards) with operational counts and member-level drill-down | Card in cash mode; full report in accrual |
| **Statement of assets** — cost, accumulated depreciation, book value. Art. 957 + insurance | All finance users (indicative in cash mode) |
| Balance-sheet enrichment — fixed assets at NBV appear once postings exist | Accrual |
| **Month soft-close** — blocks backdated manual entries, lists automatic entries that landed after close; owner-unlockable. FY close stays the hard close | Accrual (optional in cash) |

Reconciliation stance: after activation the ledger's obligation balance is
authoritative and the operational drill-down is its detail view; drift surfaces
as a health check — never two silently disagreeing numbers.

NOT adding: cash-flow statement, dual-basis parallel statements, budget vs
actual, custom report builder, per-member profitability, cross-ledger org
consolidation, AR aging (nothing to age).

## Non-goals

- **AR / invoicing / dunning** — no invoice-now-pay-later culture in this
  product; manual rows keep covering offline money. Receivable/payable accounts
  stay manual-use. The Tarif 595 plugin (`docs/tarif-595.md`) is not an
  exception: a health-insurance reimbursement receipt is an attestation of a
  purchase already paid and writes no journal row.
- **VAT computation/filing** — schema readiness stays (`tax_code`,
  `tax_rate_bp`), nothing computes. The DE/IT low-threshold caveat in
  `docs/accounting.md` stands.
- **Payroll accounting** — personnel expense remains a manual/template target.
- **Bank reconciliation / open-item matching** — the fiduciary's tool's job.
- **Multi-currency ledger** — the single-currency limitation stands.
- **Statutory export formats** (DATEV/GoBD, sequential numbering) — stays on
  the existing roadmap note beside the VAT module.
- **Retail stock / COGS** — separated to the products-plugin track (above).
- **Statutory-correctness claims** — see Posture below.
- **Custom recognition rules** — the policy set above is closed in v1.

**Accountant-export posture (the cheap 80%):** one accounting-entries CSV
(date, entry id, Dr/Cr account codes, amount, source, memo; month range or FY)
under the same append-only public-CSV contract as `docs/finance-reports.md`.
Standard ch_kmu numbering + a complete entries file IS the Bexio/Banana/Klara
integration story. No connectors until demand proves otherwise. Position: "an
impeccable feed, not a filing tool."

## Posture — management accounting, CH-first (decided 2026-08-31)

The copy stays "management accounting — designed to align with Swiss practice;
review with your fiduciary" until per-market advisor sign-off. The
already-mandated pre-GA advisor review (`docs/accounting.md` → "Before real
customers rely on it") grows to bundle: the recognition policies, the breakage
defaults, the chart additions (fixed assets, accumulated depreciation), and the
statement-of-assets format. Sequencing: accrual GA on `ch_kmu` first;
`de_skr04` / `it_standard` accrual stays beta until their market reviews
happen. Marketing must not say "compliant bookkeeping" before that — and for
DE/IT, not after either (GoBD gap).

## Phasing

| Phase | Packages (relative effort S/M/L) | Blocking gaps |
|---|---|---|
| **0 — SHIPPED 2026-08-31** | `MemberSubscription.current_period_start` persisted by the Connect webhook, backfillable via `backfill:subscription-lifecycle` (S) — service-period data accumulates from now on | — |
| **0.5 — SHIPPED 2026-08-31** | Opening-balances wizard: guided interview over `createManualEntry` (S/M). File import discarded | — (independent of accrual) |
| **1 — Accrual revenue core** | Basis setting + activation flow reusing the wizard, with the computed opening obligation (M) · recognition engine: annual/quarterly/`included_months` spreading (M), pack per-credit release + expiry breakage (M), gift-card liability repoint (S) · monthly usage-facts capture for packs (M) · Earned-vs-Cash report + obligation card (M) · rebuild extended to replay recognition — the correctness heart (M) | usage-facts capture; optional manual-row period fields (degradable) |
| **2 — Assets & statement of assets** | **Register-only slice SHIPPED 2026-09-01** (pulled ahead of Phase 1): register UI + "Equipment" nav (`/plugins/finance/assets`, data `teams/{id}/asset_register`), indicative valuations (`assetBookValue`), statement-of-assets export, dispose recorded-only + photo + location. **Remaining:** threshold/capitalization + monthly depreciation postings + disposal gain/loss entries (M) · opening-asset import into the activation flow (S) · fixed-asset/accumulated-depreciation chart additions via seeded re-run (S) | *Postings* need Phase 1's accrual mode; writes may then route through callables |
| **3 — Expense polish & close hygiene** | Prepaid spreading on templates (S) · month soft-close (S) · FY-close assistant incl. the guided auto-reversing accrued-expense step (M) · accounting-entries CSV (S) | — |

## Timing vs launch

**Nothing in Phases 1–3 is a launch blocker — accrual is post-launch adoptable
by design.** The effective-date switch means history stays cash; the opening
obligation derives from LIVE state (remaining credits, gift-card balances,
`current_period_end` minus the recurrence length for subscription coverage), so
no historical capture is required; the ledger is replayable and additive; and
the value grows with real studios (the obligation card becomes a concrete
Studio upsell, the advisor review gets real books). Launching cash-only matches
the entire market. The one cheap-now/expensive-later item was Phase 0 — a few
lines at the webhook vs. a later Stripe backfill that is blind for BYO/manual
rails and approximate around pauses/proration — which is why it shipped with
this plan rather than with Phase 1. Independent of all this: the advisor review
of the CASH chart seeds gates the finance plugin's own GA; do not conflate the
two.

## Proposed defaults (veto in review)

Pack breakage ON at expiry under a written in-product policy · gift cards no
breakage in v1 (no expiry) · no-expiry-pack dormancy release OFF pending
advisor input · monthly subscriptions never spread (materiality) · activation
at any month start, deactivation only at a FY boundary · manager-assigned
memberships memo-only in the obligation drill-down · CHF 1'000
immediate-expense threshold, owner-adjustable.

## Risks

1. **Replay correctness vs mutable operational state** — mitigated by the
   captured-facts rule; this deserves the most design attention in Phase 1.
2. **Advisor findings after teams enable accrual** — mitigated by the CH-first
   beta cohort and corrections-by-new-rows (a policy fix replays cleanly).
3. **Support burden** — accrual questions are accountant questions; every
   automatic entry carries a "why does this entry exist" explanation linking
   the policy text.
4. **Scope creep toward horizontal** — mitigated by the closed policy set and
   this document's Non-goals section being part of the shipped docs.

## Recorded decisions

| Date | Decision |
|---|---|
| 2026-08-31 | Accrual = Studio/Org-tier capability inside the `finance` plugin; no separate SKU. Coach add-on keeps cash + asset register (Franco) |
| 2026-08-31 | Asset register + depreciation live in the finance plugin; retail stock/COGS is a separate future products-plugin track — the evaluated "inventory extension" is re-scoped accordingly (Franco) |
| 2026-09-01 | **Revised:** the REGISTER becomes its own Coach+ plugin (`asset-register`); only the statement of assets and the depreciation postings are finance artifacts. Finance REQUIRES the register (`PLUGIN_REQUIREMENTS`) — a new relation, not a bundle. Named "asset register", not "equipment", which reads as one kind of asset (Franco) |
| 2026-08-31 | Posture: CH-first management accounting; advisor review bundles recognition policies + breakage + chart additions; ch_kmu accrual GA first (Franco) |
| 2026-08-31 | Sequencing: revenue recognition first, assets second; Phase 0 persistence shipped immediately (Franco) |
| 2026-08-31 | Opening-balances wizard ships now, guided interview only — the file-import path is discarded (Franco) |
| 2026-08-31 | Registration ≠ purchase: existing assets enter at NBV from their real acquisition date, never as a purchase dated today; cash-mode registration posts nothing (Franco) |

## Sources (market & regulatory appendix)

- Mindbody Earned Revenue report (support.mindbodyonline.com, article 203257223)
  — per-day recognition for time-based memberships, per-visit for session packs.
- zingfit "Earned vs. Deferred vs. Accrued Revenue" (support.zingfit.com) —
  earned series revenue per class redeemed; remainder recognized at expiration.
- Momence reports (help.momence.com) — sales on cash basis AND earned-revenue
  basis.
- Bookkeep × Mindbody (bookkeep.com/integrations/mindbody) — the
  summarized-journal-entries-into-QBO/Xero integration pattern.
- Glofox store setup (support.glofox.com) — retail stock = quantity + wholesale
  + retail price, auto-decrement on sale; what "inventory" means in this
  vertical.
- Swiss Confederation, compulsory accounting for SMEs (kmu.admin.ch) — Art. 957
  CO: simplified accounting (income, expenses, assets) below CHF 500k turnover
  for sole props/partnerships; full double-entry above, and for legal entities.
