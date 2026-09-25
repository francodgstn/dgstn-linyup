---
title: Staging review 2026-08
description: "Staging manual review, 2026-08-24 — the 29 findings"
status: record
area: ops
---
# Staging review 2026-08

Franco ran a manual review against **staging** and came back with 29 findings
across Schedule, Booking, Subscriptions, Activities, Ops, and signup/onboarding.
This file is the record: what each one actually was against the code, what was
decided, and what must happen at deploy time.

It is a WORK LIST, not a status board — delete an entry when it is no longer
useful, and if a fix turns out to be wrong, correct the entry rather than adding
a second one beside it.

## STATUS — all 29 shipped in one pass

`pnpm typecheck` (6/6), `pnpm typecheck:seeds`, `pnpm test` (1966 passing, 0
failing), `pnpm lint` (0 errors) and `pnpm i18n:check` (6557 keys, four locales
in parity) are green. Nothing here is deployed.

## Four decisions taken up front (Franco, 2026-08-24)

1. **Bookings list axis** — sessions-first fan-out, not a denormalised
   `session_start`. The list ranges on the CLASS date by default, with an
   explicit "Class date / Booking date" toggle, and reaches into the future.
2. **Locale settings** — all four (timezone, week start, date format, time
   format) live on the TEAM. The user's UI language stays per-user on top.
   Defaults are Swiss and apply when the field is ABSENT, so no migration.
3. **Activity tags** — free-form per activity. `Activity.level` is dropped and
   its stored values are DISCARDED, not migrated.
4. **Fitness-app field** — options derive from the studio's own
   `source: 'aggregator'` subscription types, and the answer is now STORED on
   the contact. Publishing partner-app names on the world-readable team profile
   was accepted as part of this.

## Three reports that did not survive contact with the code

Recorded because the wrong diagnosis is what a future reader will otherwise
re-derive.

- **"Trial bookings are missing from the list pages" (B1).** They are not, and
  no predicate discriminates a trial. Reproduced end-to-end against the local
  emulator: a real `bookSession` trial booking came back FIRST from the studio
  list's exact query under enforced rules, and `getMyBookings` returned it too.
  What produces that exact signature is a booking written **without
  `joinedAt`** — Firestore silently drops any document lacking the `orderBy`
  field, and the ONE writer that omitted it was the staff "Add contact" dialog,
  a direct client write with no server seam. The session roster is the only one
  of the four surfaces that does not order on `joinedAt`, which is why it alone
  showed the seat.
  The drop-in half is a LOCAL-DEV artefact: a paid seat sits at
  `payment_status: 'required'` until the Connect webhook flips it, and
  `bookingIsLiveForMember` excludes that state deliberately. Without
  `pnpm stripe:listen` forwarding, it never flips.
- **"An abandoned subscription form ticks two setup steps" (G8).** Nothing is
  written on form open, so nothing can tick. What happened is that the first
  activity was created with drop-in enabled, and a priced drop-in satisfies the
  `pricing` step's OR by design. That OR is deliberate and was left alone —
  changing it would retroactively un-tick studios that are already done.
- **"Login passes user/pass in the URL query string" (G9).** Not in normal
  operation. But the form had no non-JS fallback, so a submit BEFORE hydration
  performed a native GET carrying the password, and PostHog captured that query
  string verbatim. Both halves are fixed.

## The bug class this round kept finding

**A sparse index plus a writer that skips the field.** Firestore excludes any
document missing the `orderBy` field, with no error. It bit three times:

- `bookings` ordered on `joinedAt`, not written by the staff add-contact door
  (B1 — live, and the reported symptom);
- `participants` ordered on `joinedAt`, while `buildParticipantDoc` writes
  `checkedInAt` — and only the SEEDERS wrote `joinedAt`, so demo data masked it.
  Latent, because the hook that runs that query was already dead code at HEAD;
- the same shape is what makes a missing composite index in staging
  indistinguishable from an empty list, since the bookings page rendered a
  FAILED query as "No bookings yet". That is now a real error state.

The census test built to prevent exactly this (`myBookings.test.ts`) walked only
`packages/functions/src`, so it structurally could not see a web-side write. It
now spans both roots.

## Deploy preconditions — in this order

1. **Rules and indexes BEFORE functions**, per the standing order.
   `firestore.index.json` gained **10** indexes: `bookings (teamId, joinedAt
   DESC)`, `bookings (teamId, booking_reference)`, `participants (contactId,
   checkedInAt DESC)`, and seven `mail_sends` combinations for the per-tenant and
   platform mail counters. The booking-reference lookup and every operator-console
   mail figure fail without them, and they fail in a way that looks like "no
   results" rather than like an error.
2. **`pnpm backfill:booking-joined-at`** (new, `scripts/backfill-booking-joined-at.ts`).
   Dry-run by default, `--apply` to write. Every seat a studio has already hand-added
   stays invisible on the list pages until this runs.
3. **`pnpm backfill:partner-apps`** (new, `scripts/backfill-partner-apps.ts`) after the
   functions deploy. Existing tenants have no `partner_apps` on their public profile, so the
   fitness-app question stays hidden for a live studio that sells through a partner until
   something writes it. **The previous note here was wrong**:
   `backfill-public-subscription-types.ts` does NOT materialize `partner_apps` — it is guarded
   (`!isActiveAggregator || alreadyPublic → continue`), so it writes nothing for a team whose
   aggregator types are already `public`, or that has none, and is a total no-op where
   everything is already public. The new script writes `partner_apps` with the SAME resolver
   the sync uses (`resolveTeamPartnerApps`), unconditionally, dry-run by default.
   *Mitigating fact:* `syncTeamPublicProfile` also writes `partner_apps` on ANY `teams/{teamId}`
   write, so a studio self-heals the next time it edits its settings — the data gap is
   transient; the wrong precondition was the durable problem.

   ⚠️ Separately, do NOT run `backfill-public-subscription-types.ts --apply` **blind**. Its
   `--apply` applies pre-2026-06-11 semantics the code has since reversed and can publish a
   studio's legacy partner types (with their `payoutPerVisit` terms) into its world-readable
   shop. Dry-run against each env and read the per-document list first; `--apply` only if every
   named type is one the studio actually sells.
4. **Re-bootstrap the emulator snapshots.** The seeders changed: participant rows
   now carry `checkedInAt`, and the public-profile mirrors now carry
   `partner_apps`. Existing snapshots predate both.

## Not done, and deliberately

- **The remaining ~150 raw `toLocaleDateString` call sites.** Franco scoped the
  locale work explicitly: "not too deep on the UI refinement, just a quick scan
  and fix of the most exposed areas." The settings model, the one resolver and
  the highest-exposure surfaces are in. The rest is a follow-up pass, listed in
  the locale lane's report rather than left implicit.
- **The business-logic `Europe/Zurich` constants** (appointments, recurrence,
  finance, usage windows) are untouched and must stay that way. They are
  wall-clock invariants, not a display preference, and conflating the two is how
  that area breaks. `DEFAULT_TIMEZONE` in `utils/dateFormatting.ts` was
  decoupled from the display default for exactly this reason.
- **`outreachEmail.ts`'s `{{date}}`** still renders English-only in the function
  runtime's zone. The editor preview was matched to that shape rather than made
  to contradict it; routing it through `formatDateShort` is a one-line change for
  whoever owns that file.
- **A `switchTeam` callable.** The team switcher writes `users/{uid}.currentTeam`
  from the client. That grants no data access — every read is separately
  membership-gated — but a crafted client could render the app shell for a team
  the user is not in. A thin `onCall` wrapping the existing `setUserCurrentTeam`
  (which already refuses a non-member) would close it.
- **Runtime verification.** None of this was exercised against a running
  emulator except B1's reproduction. The claims here are argued from source.

## One thing that changed shape under multi-studio (G11), and was fixed

`provisionTeam` slugified the team name and wrote it with **no uniqueness
check**. Two studios sharing a slug make `/public/{slug}` resolve ARBITRARILY,
because every public route resolves through
`collectionGroup('public_profile').where('slug','==',slug).limit(1)` — so the
collision is silent, not loud. That was survivable while one login meant one
studio; the switcher makes it likely, which is why it was fixed in the same pass
(`resolveTeamSlug` / `slugIsFree`, `apps/web/src/lib/provisioning.ts`).

The trap worth keeping: the settings editor's `isSlugAvailable` CANNOT be reused
for this. It queries the `teams` collection, which the rules only let a MEMBER
read, so it fails for exactly the case it must detect — a slug held by a studio
you are not in. The check runs against the world-readable `public_profile`
collection group instead.
