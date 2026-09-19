---
title: Wave 3 handover
description: Wave 3 — branch handover
status: closed
area: ops
---
> ## CLOSED — archived 2026-08-24
>
> Branch `claude/fareharbor-feature-analysis-b58f2c` is **merged into `main`**, and
> the wave-3 features it hands over (gift cards, waitlist, promo codes, waivers)
> shipped and are deployed to production. The premise stated below — *"Nothing here
> is deployed"* — is no longer true; do not read it as current.
>
> **Where the live versions are:** `docs/waitlist.md`, `docs/promo-codes.md`,
> `docs/waivers.md`, `docs/plugins.md` (which now also carries this file's
> `minPlan` rule), and the open register in `docs/open-defects.md`.
>
> **Kept for one reason:** §3's *"deliberately descoped, do not assume these
> exist"* list — recipient≠purchaser gift-card emails, the outstanding-liability
> strip, the historical `'other'` → `gift_card` rewrite, and a confirmation email
> on a paid waitlist claim — is recorded nowhere else.

# Wave 3 branch — what shipped, what might break, what is still open

Branch `claude/fareharbor-feature-analysis-b58f2c`, ~280 files against `main`.
A short standing note to work from, not a record of how it was built — the
commit messages carry the reasoning, and the feature docs carry the designs.

**Nothing here is deployed.** Every item below exists in code and in the local
emulator only.

---

## 1. What shipped

### Wave 3 — four phases

| Phase | Feature | Reference |
|---|---|---|
| 0 + 1 | Gift cards without an account, desk minting, category fix | — |
| 2 | Waitlist for a full class | `docs/waitlist.md` |
| 3 | Promo codes | `docs/promo-codes.md` |
| 4 | Waivers | `docs/waivers.md` |

Each has a doc written against what was BUILT, not what was designed. The
per-phase design specs were deleted with this summary — they were working
documents, and every decision that survived is in the feature doc or in
`CLAUDE.md`.

### Wave 3.5 — plugin gating

Gift Cards and Promo Codes are now install-gated plugins. Two rules that are
easy to get backwards:

- **The gate is on CREATING, never on CONSUMING.** Selling a gift card, minting
  one, creating a code — gated. Redeeming, checking a balance, voiding,
  previewing/reserving/committing a promo — not. An outstanding gift card is
  money the studio has already taken.
- **The plan requirement lives in the manifest** (`minPlan`), not in a second
  runtime gate. `createPromoCode`'s old `requirePlan(teamId, 'studio')` is gone;
  `PROMO_CODE_LIMITS` survives as a ceiling, not a door.

`packages/functions/src/connect/pluginGate.test.ts` re-derives the call sites
from the source and fails on a creation path that forgets the gate, a
consumption path that adds one, or any new callable in those files that no
census entry classifies.

### Document links

One document can link another. **Latest by default; pinned only when the author
says so.** No publish-time freezing, no publish-time validation, no waiver
special case — all considered and cut. The stored form is a reference
(`data-document-link`), never a URL, because both halves of a URL are editable.
See `packages/shared/src/utils/documentLink.ts`.

### Defect fixes

- **`gateway_data` shape** — the SaaS webhook stored literal field names called
  `"gateway_data.subscription_id"` because `set()` takes a dotted key literally
  where `update()` reads it as a path. Eleven readers saw `undefined`: the
  billing portal, cancel, reactivate and invoices callables could not find a
  paying studio's subscription, the ops console showed a blank Stripe id, and
  the webhook's own idempotency check never matched, so **every Stripe retry was
  processed twice**.
- **Signup consent never reached the public form** — a saved selection wrote only
  to `teams/{id}/settings/documents`, which has no trigger, so the mirror the
  signup form reads stayed empty and `recordSignupConsent` wrote zero acceptance
  rows. Silent, and the missed rows are not recoverable.
- **`entry: 'manual'`** was written by `createStaffAppointment` but missing from
  `CONTACT_ENTRIES`, so the contact page showed a raw message key and the profile
  form's enum rejected its own stored value, blocking submit.
- **Waitlist queue cap** could never bind above 100 seats (the cap exceeded the
  in-transaction scan limit), and `waitlist_count` froze at that limit.
- Earlier in the session: Stripe Dahlia field moves, a Space "my courses" 403,
  and the appointment picker ignoring the signed-in contact session.

### Authoring and defaults

- **Ordinary web links in the document editor.** StarterKit already carried the
  `link` mark, so pasted URLs became links — there was just no way to write one
  with your own words. `http(s)` only.
- **Activity `level` is optional.** It was mandatory only because the legacy
  import always had a value; the type and the list badge already treated it as
  absent-able. Forcing a choice made studios pick "All levels" to mean "not
  applicable" — two statements collapsed into one.
- **New-activity defaults changed** to `accessTier: 'members'` and
  `autoConfirm: true`. `resolveAutoConfirm` was deliberately NOT touched: it
  answers what a STORED doc means, and flipping its fallback would silently
  reinterpret every existing class that never set the field.
- **Access-tier copy corrected.** "Open to everyone" now says it means free
  (`resolvePaymentOptions` short-circuits `open` to `covered`), and both gated
  tiers now say a newcomer can still take a trial — the old copy claimed
  members-only meant "no trial accounts", which the trial toggle contradicts.

### Waitlists are now opt-in per studio

`BookingSettings.waitlistEnabled` (Settings → Booking, off by default) controls
whether the per-activity waitlist toggle is shown at all. It is a VISIBILITY
switch: turning it off never closes an existing queue or strips an activity's
stored flag, exactly like the plan gate on the same control. A dashboard tip is
the main way anyone discovers the feature, since the control is hidden until
asked for.

### Sidebar

Top of the sidebar is now: Linyup → the studio's name with its QR → search plus
plugins/settings/how-to as icons → Dashboard as the first menu row. Search is a
mini-input that opens a portalled overlay (⌘K/Ctrl+K also opens it). The QR
dialog offers every public surface the team actually has live, from
`active_public_surfaces`.

---

## 2. What might break

Ordered by how much it would cost to find out the hard way.

1. **Deploy order for `gateway_data`.** Ship the code first. Reads tolerate both
   shapes, so nothing breaks either way, but running the backfill before the
   writer fix means new events immediately re-create the old shape.
2. **Seeded tenants and the new plugin gates.** A tenant with gift-card data but
   no `gift-cards` install shows an empty Payments tab and no shop offer. The
   seeders were updated, but **datasets seeded before this branch are already in
   that state** — including any live sandbox or lead tenant. Reseed, or install
   the plugin by hand, before a prospect demo.
3. **`firestore.rules` grew by ~270 lines** (waivers, promo, waitlist, the
   `{path=**}/purchases` collection-group block). Deploy rules and indexes
   BEFORE functions, per the existing staging note.
4. **Documents stopped being a plugin** earlier in this line of work, and its
   signup-consent config moved to `teams/{id}/settings/{settingId}` — a path that
   had no rule until this branch added one. A tenant whose data predates that
   move reads through a dual-path resolver; nothing rebuilds it.
5. **`scripts/backfill-document-versions.ts` is a deploy precondition** for
   waivers: every already-published document needs a v1 to copy from.
6. **The search overlay is portalled to `document.body`.** If a future layout
   wraps the app in a transformed ancestor, `fixed` positioning inside the portal
   still behaves — but anything that renders above `z-50` on body will now cover
   it rather than being covered.

---

## 3. Known and NOT fixed

The full register with evidence is `docs/open-defects.md`. In short:

- **`pnpm backfill:gateway-data` has not been run anywhere.** Cleanup, not a live
  defect — readers understand both shapes.
- **The pinned document-version read path is half-verified.** The client side was
  exercised in a browser; the callable itself never ran, because the emulator
  predates it and registering it needs a restart.
- **Stripe webhook handler params are typed `any`.** Root cause of three shipped
  defects; typecheck would have caught all three. Retyping is the durable fix.
- **A BYO studio can double-count its own recurring revenue**; nothing tells it
  which webhook events to subscribe to; Stripe endpoint drift on staging; the
  subscription-lifecycle backfill has not been run.
- **Deliberately descoped, do not assume these exist:** recipient≠purchaser
  gift-card emails, the outstanding-liability strip, the historical `'other'` →
  `gift_card` category rewrite, a confirmation email on a paid waitlist claim,
  and the `notify` waiver publish outcome (refused by name, v2).

**Not verified anywhere:** none of this has been exercised against staging or
production, and the only browser testing was against the local emulator with
seeded data. The recorded history on this project is that integration-boundary
defects survive the test suite and multi-lens review and are found by clicking —
three were found that way in this session alone, and two more (a raw i18n key on
the QR button, an overlay rendering behind the settings page) were found the same
way while building the sidebar.
