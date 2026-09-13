# Tarif 595 — health-insurance reimbursement receipts (CH)

**Plugin id `tarif-595` · Coach and above, no add-on · status beta.**
Verified 2026-09-12 against the primary documents (Forum Datenaustausch XSD + CHM
reference, position list 03.06.2026, print templates and samples; Helsana Wegleitung
v3.3.2026; Qualitop FAQ; SWICA FAQ; SFGV; OneDoc; SportsNow). The research record, with
the sources and what each one settled, is the plan file this phase was built from.

## What it is

From **1 January 2027** a Swiss health-promotion provider holding an insurer label
(Qualitop, Qualicert, Fitness-Guide/SFGV, EMfit) must give its members a
**Rückforderungsbeleg** in the Forum Datenaustausch **XML 5.0 `generalInvoiceRequest`**
format with **Tarif 595** positions; self-made subscription confirmations are no longer
accepted. The member submits it to their supplementary insurer (VVG) for reimbursement.

**A receipt is an attestation, never a money event.** It states what a member bought and
when; the money moved when the member paid the studio. So the plugin writes **no finance
journal row**, prices nothing through the payment resolver, and voiding a receipt moves no
money. `packages/functions/src/tarif595/noJournal.test.ts` reads the folder and pins it.

What it is NOT: not accounts receivable (that is the sibling `qr-invoices` plugin, on the
same rails), not VAT filing, not Tarif 590 (complementary medicine), not eTG/MediData
transmission (Phase 3, only if customers ask).

## Data model (all under `teams/{teamId}`)

| Path | Type | Rules | Notes |
|---|---|---|---|
| `settings/legal_profile` | `StudioLegalProfile` | member read, owner write (existing `settings` rule) | **Shared** creditor identity: legal name, structured address, canton, IBAN, QR-IBAN?, VAT number/rate. Edited on Settings → Payments. Neither plugin owns it. |
| `tarif595_settings/config` | `Tarif595Config` | manager+ read/write | The plugin's own identifiers: biller GLN/ZSR, provider GLN/location GLN/ZSR/UID, language (de/fr/it), modus, number prefix, `offerings` map. |
| `tarif595_contacts/{contactId}` | `Tarif595ContactData` | manager+ read/write; **the contact's own session** reads its row and writes `TARIF595_CONTACT_SELF_FIELDS` (AHV number, insurer name, insured number) | AHV number (**required to issue**), insurer name/GLN, insured number, sex override, guardian. Never on `Contact`, never mirrored. **Deleted by the anonymisation sweep** with the identity. |
| `tarif595_receipts/{receiptId}` | `Tarif595ReceiptDoc` | manager+ read, **write false** | Frozen snapshot; functions only. `pending → issued → voided`. The member's copy comes through `listMyTarif595Receipts`, never a contact read arm (the row carries the manager's uid and the storage paths). **Kept on anonymisation.** |
| `tarif595_jobs/{jobId}` | `Tarif595BulkJob` | manager+ read, **write false** | Bulk-run progress: window, counts, `skips` with reasons, cursor, rounds. Only the worker writes it. |
| `counters/tarif595_receipts` | `{last, year}` | member read, write false | Absolute value written inside the allocating transaction. |
| Storage `teams/{t}/tarif595/{receiptId}/receipt.pdf\|xml` | — | excluded from the broad team rule on read AND write | Admin SDK writes; served only by `downloadTarif595Receipt` (sha256-verified, base64 inline, 6 MB cap). |

`receiptId = sha256(teamId:contactId:sourceKey:revision).slice(0, 32)`, where
`sourceKey = '{kind}:{ref}:{from}:{to}'` — the same period of the same source is the same
receipt; a retry finds it instead of taking a second number. Re-issue after void = `revision + 1`
with `replaces`.

**Offering mapping** (`Tarif595Config.offerings`, keyed `subscription:{typeId}` |
`activity:{activityId}` | `course:{courseId}`): `position`, `unit`
(`month | year | lesson | entry | flat`), optional `ptPosition`, `customName` (code 9999
only), `entries` (for `entry`). The position table is generated data
(`packages/shared/src/data/tarif595/positions.ts`, from `positions.tsv`, provenance XLSX
beside it; `pnpm tarif595:positions`) exposed on `@linyup/shared/tarif595-positions` and
imported lazily by the settings page only — never re-exported from the shared index.

## Line rules (Qualitop FAQ 3.3–3.7, Helsana §4; `lines.ts`, pure)

| Unit | Lines | Quantity | Line date |
|---|---|---|---|
| `lesson` | one per attended day | 1 | that day |
| `entry` | one | the pass size | period start |
| `month` | one per anniversary year | months of that segment (partial months round up) | segment start |
| `year` | one per anniversary year | 1 | segment start |
| `flat` | one | 1 | period start |

The period itself lives in the XML `treatment` element. A position is looked up **by the
line date** — the list changes every 1 January and positions expire. PT adds the PT
position as a zero-priced companion line. The official text is printed unaltered; only
9999 carries the studio's own text. VAT is contained in the gross price and rounded once
per rate group.

Unit prices: a subscription's from its history row (`unitPriceMinorFor` scales a recurrence
price to the unit); a course's from its purchase; attendance receipts take the price from
the request (the manager types it) — absent, the line is zero and the preview warns.

## The document (`xml.ts`, pure; validated against the XSD in `fixtures/`)

Tiers Garant; `body@role="other" @place="company"`; `law@type="VVG"` with the insured
number; `treatment` = the whole period, `@treatment="ambulatory"`, `@reason="prevention"`;
`transport@to` = the insurer's GLN or the schema's non-recipient constant; debitor =
the guarantor with the private-person pseudo GLN; `patient@ssn` = the AHV number;
`balance@amount_prepaid = amount`, `amount_due = 0`; `esrQRRed@subtype="esrQRRedplus"`
(pay-in slip without amount); `service` rows on tariff 595 with `unit_factor="1"`.
The generator is identified by name/version only — **Linyup needs no GLN**.

**PDF** (`render.ts`, on the shared `pdf/` rail): sheet 1 Patientenrechnung with a Swiss
QR-bill payment part without amount; sheet 2 Rückforderungsbeleg (header grid + line table
+ totals/VAT); sheets 3+ the QR-Code Blatt — the XML as raw DEFLATE → base64 → space-padded
→ ≤ 12 equal chunks, error correction M, six codes per page (`qrSheet.ts`; the encoding was
verified by decoding the Forum's own 12-code sample, which the test round-trips).

## Issuing — two phases, one resume path (`issue.ts`)

The number is inside the bytes, so files cannot precede the number and the number must not
be consumed without a document:

1. **Transaction:** read the receipt ref + counter. Voided at this id → refuse (the caller
   bumps the revision). Issued → return it (idempotent retry). Pending → resume. Else
   `allocateNumber` (absolute `{last, year}`), freeze the snapshot **including guid and
   timestamps** with `status: 'pending'`, write both.
2. **Outside:** build XML → render PDF → upload both with sha256 → `status: 'issued'`.

A crash between the phases leaves a `pending` row; the same call again computes the same
id, finds it pending, skips allocation and re-renders byte-identical files
(`render.test.ts` pins the determinism). `void` refuses `pending`.

Preview (`draft.ts`) is the same composition without the transaction; the UI renders what
it returns and computes no lines itself. **Blocking** (the server refuses): setup incomplete,
offering unmapped, source not found, period invalid, birthdate missing, sex not derivable,
address incomplete, AHV missing/invalid, position expired on the line date, no lines,
already issued. **Warnings** (shown): overlapping receipt, attendance scan truncated,
insured number missing, insurer unknown, unit price zero.

## The gate

| Callable | Gate |
|---|---|
| `previewTarif595Receipt`, `issueTarif595Receipt`, `startTarif595BulkIssue` | `assertManager` + `assertPluginInstalled('tarif-595')` — creation |
| `voidTarif595Receipt`, `emailTarif595Receipt` | `assertManager` only — consumption of an existing receipt |
| `downloadTarif595Receipt` | **two doors, decided by the token**: `assertManager`, OR the contact session (`requireContactSessionForTeam`) on a receipt whose `contact_id` is its own — any other id answers `not-found` |
| `listMyTarif595Receipts` | the contact session only — no role, no install gate (consumption); `enabled` in the answer is a read of the install state, not a gate |

`gate.test.ts` re-derives every `onCall` in the folder and classifies it (GATED /
UNGATED / CONTACT).

## Bulk issuing — the year-end run (`bulk.ts`, `bulkWorker.ts`)

"Issue for every member" on the plugin page: one receipt per subscription-history row
of a **mapped** plan that overlaps the window, for every live contact of the team, each
issued through the SAME `issueReceipt` the detail page runs — never a second
implementation. A row is clipped to the window (an open row ends at the run day):
Qualitop FAQ 3.5 allows the partial-period form, and a calendar-year receipt is what
the insurer reimburses by; the start is never moved earlier than the row's own.
Attendance and course receipts stay manual (one needs a typed price, the other is one
purchase).

The run is a **job** (`tarif595_jobs/{jobId}`) drained by **Cloud Task rounds** of
`TARIF595_BULK_BATCH` contacts — the series-teardown shape: the callable measures the
scope (a `count()` of the team's contacts), mints the job, enqueues round 1 and returns
the id; each round pages contacts by document id from the job's cursor, issues, writes
progress as **absolute values** (no `FieldValue.increment`), and re-enqueues itself
(`{jobId}-r{round}`, job-first and deterministic, so a redelivery cannot start a second
chain; `rounds >= round` makes a retried round a no-op). On an emulator without Cloud
Tasks the rounds run inline in the callable (`runsInlineForLocalDev`). Stops: drained →
`completed` / `completed_with_errors`; `TARIF595_BULK_MAX_FAILURES` contacts failed or
`TARIF595_BULK_MAX_ROUNDS` reached → `failed`. One run at a time per team; a `running`
job with no heartbeat for `TARIF595_BULK_STALE_MS` is presumed dead and closed.

**Every non-issue is recorded with its reason** — `already_issued`, the preview's own
blocking codes, and `overlapping_receipt` (a warning on the detail page, a refusal in
bulk: a job never attests a period twice) — capped at `TARIF595_BULK_SKIPS_MAX` rows
with the counter running on. The page groups them by reason with a link to each
member's Receipts segment: the point of the run is finding the missing AHV numbers
before the insurer does. A re-run after fixing them is safe by construction (same
deterministic ids, `already_issued` for the rest).

## The member's own copy (the Space)

- **Receipts tab** (`/public/{slug}/space/receipts`): `listMyTarif595Receipts` (a
  projection — number, period, total, state, date; no uid, paths or hashes; `pending`
  rows are not listed) and the contact door of `downloadTarif595Receipt`. The tab shows
  once the member has a receipt; a failed read keeps it, an empty answer hides it.
- **Health insurance section** on the Account page: the member writes their AHV number,
  insurer name and insured number to their own `tarif595_contacts` row — a direct
  Firestore write under the contact-session arm, limited to
  `TARIF595_CONTACT_SELF_FIELDS` (`selfWrite.test.ts` pins the rules literal to the
  constant). Shown only when `enabled` (the studio has the plugin), so nobody is asked
  for an AHV number by a studio that never issues receipts.
- **Anonymisation**: the nightly sweep deletes the member's `tarif595_contacts` row in
  the same batch as the identity patch; receipts are kept. The census of plugin-owned
  records is `CONTACT_PLUGIN_RECORDS` beside the field list in `utils/contactDeletion.ts`.

## Decisions

- **AHV number is required to issue** (Helsana §3.6, Qualitop FAQ 3.2, the XSD's required
  `ssn`). It lives only in the manager-only plugin subcollection. The standard's unknown-SSN
  placeholder is deliberately not emitted.
- **Provider = the studio, not the coach** (Helsana §3.1, SWICA/Qualitop FAQ): no per-staff
  identities; the provider block defaults to the biller with an optional location GLN.
- **Receipts are paid receipts only** — `amount_due = 0`, QR-bill without amount. Reminders
  and open invoices are out of scope here (see `qr-invoices`).
- **Receipts outlive contact anonymisation.** They are records of documents handed out and
  are kept; the owner's privacy-policy work names this (a data-protection call, not a coding one).
- **No certification exists.** Vendors are listed by Qualitop/insurers on request; the basis
  is the Wegleitung, the FAQ and XML 5.0. Marketing may say "Tarif 595 / XML 5.0-konform",
  never "zertifiziert".

## Not built yet

Phase 3: eTG/MediData behind a provider seam, only if customers ask. Mobile has no
receipts surface (the Space is the member's copy). Before launch: a sample PDF + XML
accepted by one insurer (the owner's external action).

## QR-bill invoices (`qr-invoices`) — the sibling plugin on the same rails

**The claim before a payment.** A studio that takes bank transfers issues a numbered
invoice with a Swiss QR-bill payment part (amount SET; QRR reference when the legal
profile carries a QR-IBAN, else an ISO 11649 `RF` reference on the plain IBAN), the
member pays, the studio marks it paid. **Mark-as-paid records the manual payment
through `writeManualPaymentEvent`** — the same writer the Record-payment dialog uses —
so entitlements and the finance journal behave exactly as for a hand-recorded payment,
keyed `invoice-{invoiceId}` so a retry is a no-op. **The invoice itself writes no journal
row** (`invoices/noJournal.test.ts`). This is the ONE recorded exception to the "no AR"
non-goal, and it stops here: no reminders, no dunning, no bank-file reconciliation.

| Path | Rules | Notes |
|---|---|---|
| `invoice_settings/config` | manager+ | prefix (default `INV`), due days (30), footer text, language |
| `invoices/{invoiceId}` | manager+ read, write false | frozen snapshot: creditor (legal profile at creation), debtor, one `PaymentLineItem`, amount, VAT, due date, reference, `status pending → open → paid \| void` |
| `counters/invoices` | member read, write false | absolute `{last, year}` |
| Storage `teams/{t}/invoices/{id}/invoice.pdf` | excluded from the broad rule | served only by `downloadInvoice` |

`invoiceId = sha256(invoice:teamId:contactId:requestKey)` from a per-attempt client key, so a
retried create resumes its own `pending` document instead of taking a second number — the
same two-phase shape as the receipts. Gate: `createInvoice` is plugin-gated; `voidInvoice`
(open only — a paid invoice is reversed through the payment, not the invoice),
`downloadInvoice`, `emailInvoice`, `markInvoicePaid` are not (`invoices/gate.test.ts`).
