---
title: Waivers — architecture
status: living
area: booking
---
# Waivers — architecture

A waiver is **a liability release a visitor accepts before they are allowed into
a room**. It is a kind of Document (`kind: 'waiver'`), it is published as an
immutable version snapshot, and a tick against it becomes a row in an
append-only ledger that outlives the contact who ticked.

Two rules decide almost everything below, and both are worth stating before the
mechanism, because the two ways this area goes wrong are reaching for machinery
it does not need and inventing a second answer to a question it already answers.

> **THE GOVERNING RULE.** A signature is **a fact about a person, not a claim on
> a scarce resource.** Nothing about a waiver is reserved, held, released or
> restored. The promo phase's whole reserve → commit → release apparatus has no
> analogue here; neither does the waitlist's single-deadline discipline. There is
> no counter but `rounds`, no price, no journal row, and no timer on any rail.

> **THE SECOND RULE.** The ledger is **append-only EVENTS plus one mutable
> CURRENT-STATE row.** Re-signing, expiry and revocation are states of the
> second, never edits to the first. Errors are fixed by new rows — the discipline
> `packages/shared/src/types/finance.ts` already states for the journal.

The pure half lives in `packages/shared/src/types/waiver.ts` (types, caps, and
every predicate — browser-safe, no crypto, no Firestore). The impure half lives
in `packages/functions/src/waivers/`, one file per job — all ten of them:
`publish.ts` (authoring), `gate.ts` (the decision), `accept.ts` (the one writer),
`requirement.ts` (the public answer), `caller.ts` (who is asking), `limits.ts`
(the abuse model), `space.ts`, `signup.ts`, `revoke.ts`, `export.ts`.

## The data model

```
documents/{documentId}                                ← StudioDocument, kind gains 'waiver'
documents/{documentId}/public_profile/{documentId}    ← world-readable mirror, gains version + bodyHash
documents/{documentId}/versions/{versionId}           ← IMMUTABLE snapshot, versionId = 'v0001'…
documents/{documentId}/acceptances/{acceptanceId}     ← APPEND-ONLY event rows
documents/{documentId}/signers/{contactId}            ← the ONE mutable current-state row
documents/{documentId}/notices/{noticeId}             ← APPEND-ONLY, declared, NO WRITER (see "notify")
teams/{teamId}/waiver_policy/current                  ← server-written; THE authorization source
```

Constants in `packages/shared/src/paths.ts`. Everything nests under `documents/`
or `teams/`, so **no `tenantData.ts` registration is needed** — the completeness
test classifies top-level `*_COLLECTION` constants only, `documents` is already
registered there, and per-team teardown uses `db.recursiveDelete`.

**Everything hangs off the DOCUMENT, not the contact, and that is deliberate.**
`purgeProvisionalContacts` hard-deletes expired provisional contacts nightly and
a per-team teardown recursively deletes contacts; a contact-scoped acceptance
subcollection would be destroyed by both. The evidence has to survive the person
it is about.

### The event row — `acceptances/{acceptanceId}`

`WaiverAcceptanceEvent`. Created with `tx.create`, never updated, never deleted
(`allow write: if false`). It holds the immutable facts: which version, the
sha256 of the exact text, who ticked and in what role, at what instant, from what
IP, in which of the four locales, and who the release is about.

The id is derived from the **event**, not from the relationship:

```
acceptanceId = 'a_' + sha256(documentId : version : contactId : intentId).slice(0,32)
```

`waiverAcceptanceId` in `types/waiver.ts`, `acceptanceIdFor` in `accept.ts`.
`intentId` is a nonce minted by `resolveWaiverRequirement` and echoed back with
the tick. It buys exactly one property — a
double-submit of the same tick writes one row — and it is not a credential:
forging one only affects whether a duplicate row is created, which is self-harm.

**Why the id is the whole design.** The previous shape keyed the row on the
*relationship* `(contact, document, version)` and wrote it with `.create()`.
That gives immutability and takes away three things at once: re-signing after a
revocation collides, renewal after expiry collides, and revocation has nowhere to
live but a parallel collection — which makes "does this signature count" have two
sources. Putting the event's own nonce in the id dissolves all three.

### The current-state row — `signers/{contactId}`

`WaiverSignerState`. Mutable, with **exactly one writer** (`accept.ts`), always
inside a transaction, and always **conditionally**:

> The event row is ALWAYS created — it is a fact, and facts are recorded. The
> signer row is updated **only when the event strictly improves it**
> (`waiverEventImprovesSigner`), evaluated against a row re-read inside the same
> transaction.

`rounds` is `read + 1`, absolute, from that transaction's own read set. **No
`FieldValue.increment` anywhere**, the same rule `bookings_count` and
`usage_count` carry. `require_resign` — the obvious place a second writer would
appear — writes **zero** signer rows.

**`accepted_at` is the instant of the TICK, captured once before the
transaction.** Not the instant the transaction commits. Firestore retries a
contended transaction: a manager revoking at 10:00:00 aborts an acceptance that
read the row at 09:59:59, the acceptance re-runs, re-stamps itself 10:00:02 and
now beats the revocation — silently undoing it, and asserting that the person
ticked two seconds after they were revoked. `planWaiverLedgerWrite` therefore
takes `nowMs` as a **required** argument with no in-transaction fallback.

### Why the acceptance ref is READ before it is created

`recordFinanceTransaction`'s idiom — `.create()`, catch gRPC 6, carry on — works
only because that helper is a standalone write **outside** any transaction.
Inside a booking commit a `tx.create()` collision does not throw at the call: it
fails the **whole commit** as a precondition violation and takes the seat with
it. Two ordinary sequences hit it — a client retrying a booking after a network
timeout, and a visitor who ticks once, books Tuesday, presses Back and books
Thursday from the same mounted flow with the same `intentId`.

So every rail `tx.get`s the acceptance ref in the transaction's **read phase** and
skips the create when it exists (`planWaiverLedgerWrite` → `plan.event === null`).
Do not copy the journal's shape into a transaction.

### The one predicate

```ts
waiverAcceptanceState(waiver, signer, nowMs)
  → 'none' | 'valid' | 'superseded' | 'expired' | 'revoked'
```

Pure, in `types/waiver.ts`, fixed decision order: no row → `none`; revoked →
`revoked`; below the document's floor → `superseded`; past `valid_until` →
`expired`; else `valid`. Only `valid` satisfies the gate. Revocation outranks
supersession because a revoked signature must never be reported as merely stale.

It is called by the gate, the public requirement callable, the roster chip, the
manifest, the Space card, the signers tab and the export. **There is no second
expression of validity** — nothing else compares `min_valid_version` or does
`validityMonths` arithmetic.

**Supersession and expiry are never stored.** A `require_resign` publish moves
one number on the document (`min_valid_version`) and the predicate derives the
rest: O(1) instead of O(signers), correct at every instant, and "un-require" is a
single field write rather than an unwind. This is the same compute-don't-sweep
rule as lazy gift-card hold expiry and lazy promo reservation expiry, and it is
why **no job, cron or sweep exists anywhere in this feature.**

**The validity rule is frozen onto each signature** (`validity_months_at_signing`,
`valid_until`), exactly as the version snapshot freezes `mayIncludeMinors`.
Changing `WaiverConfig.validityMonths` therefore governs **future** signatures
only. The alternative — computing `accepted_at + N months` at read time from the
live config — would let one field edit retroactively re-date a studio's entire
population with no version, no publish event and nothing in the export saying
when the rule changed.

## Versions, and publishing

`publishDocumentVersion` (in `waivers/publish.ts`) replaces the old client status
flip, for **every** document kind — signup consent has to be recorded against a
real version of a real terms document too. In one transaction it reads the
document, computes `version = (current_version ?? 0) + 1`, `.create()`s
`versions/v{NNNN}` with the sanitized body and its `bodyHash`, moves
`min_valid_version` **only** on `require_resign`, patches the team's waiver policy
when the document is a required waiver, and touches the team document so the
public mirror recomputes.

**The sanitize seam moved, and that ordering is load-bearing.** The rich text is
sanitized once, here, and frozen into the snapshot; `syncDocumentPublicProfile`
then **copies** that frozen string instead of re-sanitizing `body`. Two sanitize
calls with a library upgrade between them would silently break every acceptance
hash.

`requirePlan(teamId, WAIVER_MIN_PLAN)` fires only when `kind === 'waiver'` —
publishing a privacy policy is free.

### The two outcomes

| Outcome | Version doc | `min_valid_version` | Signer rows | What the studio is told |
|---|---|---|---|---|
| **Silent update** | created | unchanged | untouched | *"Existing signatures stay attached to the old wording. Nobody is told the text changed."* |
| **Require re-signing** | created | **← N** | untouched | *"Everyone must tick again before their next booking. Strongest evidence, most friction."* |

The chooser (`apps/web/src/plugins/documents/PublishDialog.tsx`) names each option
by **what happens**, never by severity ("minor / material" was rejected as a
judgement studios will get wrong), and each option carries its **evidential cost**
in one line beside the choice — stated when a studio can still act on it, not when
it needs the document. The default is `require_resign` for a waiver and `silent`
for every other kind.

### `notify` is deferred to v2 (decision D1)

A third outcome — mail every signer and record per-recipient deliverability — was
specified in full and **is not built**. `PublishOutcome` has two members, and
`publishDocumentVersion` refuses `'notify'` **by name** rather than silently
downgrading it to `silent`, which would tell a studio its members were notified
when nobody was. The chooser does not offer it, and deliberately does not offer it
*disabled* either: a greyed-out control that never becomes available is worse than
one that does not exist.

**What stayed, and must not be "simplified away".** The
`documents/{d}/notices/{noticeId}` subcollection stays in the model as
append-only, with `WaiverNoticeRow`, `WaiverNoticeDelivery`, `waiverNoticeKey` and
`WaiverSignerState.latest_notice_id` declared and **no writer**. Nothing is keyed
in a way that assumes a signer row can hold notice state, and `accept.ts`'s
full-object signer write deliberately carries `latest_notice_id` forward.
Deleting any of it would turn notify from an **addition** into a **migration** —
the reasoning is repeated on the type, on the path constant, and in the `notices`
rules block, because those are the places a future reader will be standing
when they conclude it is dead weight.

### Every published document has a version

Moving the mirror's source from `body` to `versions/{v}` is only safe once every
already-published document has one, and none did.
`scripts/backfill-document-versions.ts` (`pnpm backfill:document-versions`) is a
**deploy precondition, not an option**: dry-run by default, `--apply` to write,
re-runnable, and it imports the real `sanitizeRichHtml` and `sha256Hex` rather
than mirroring them, because the bytes must be identical — their hash is what
every acceptance pins. A version it mints carries `backfilled_at`, and the export
prints it as retroactive rather than as an ordinary publish.

The invariant is permanent, not one-off: `documents where status == 'published'
&& current_version == null` must be empty, and `scripts/verify-waiver-ledger.ts`
checks it on every run.

## The authorization source, and the display mirror

There are two lists and they have different jobs.

| | `teams/{t}/waiver_policy/current` | `TeamPublicProfile.required_waivers` |
|---|---|---|
| Written by | **only** `writePolicyAndTouchTeam` (`waivers/publish.ts`), always in the same transaction as the document write that motivates it. Its callers are enumerated at that function and nowhere else — earlier versions of this row listed them and went stale inside one phase | `syncTeamPublicProfile`, from the policy |
| Read by | the gate, `resolveWaiverRequirement` | the client, for rendering only |
| Fails | **CLOSED** | open (it skips what it cannot resolve) |
| Contains | id, slug, title, versions, hash, minors flag, validity, scope | summary only — id, slug, title, version, minors flag. **Never a body** |

Fail-open is right for a display list of consent links and catastrophic for an
authorization gate, where "silently skipped" becomes "the required waiver
vanished and the booking went through" — which is exactly what `signup_documents`
does today, by design, and why the gate never reads a mirror.

**The policy is PATCHED, never rebuilt.** Each writer reads the policy document
inside its own transaction and replaces exactly the one entry for the document it
is writing. A full rebuild would need a `teamId + kind` composite index that does
not exist, and — executed outside the transaction — would let two managers
publishing within the same second drop each other's entry, silently un-gating a
required waiver with the policy left internally consistent so no invariant check
would fire.

**The mirror is never stale by more than one sync**, because the policy write and
the team touch are the SAME function. `writePolicyAndTouchTeam` stamps
`teams/{t}.surfaces_updated_at` in the same transaction as the policy `tx.set`,
which re-fires `syncTeamPublicProfile`. (It does not call
`touchTeamForSurfaceRecompute` — that helper does its own standalone `.set()` and
cannot join a transaction; the point of folding the touch into the policy writer
is precisely that neither half can be forgotten at a new call site.) Without it,
a studio flipping Required on at 09:00 would leave the step invisible; a member
booking at 09:05 would burn their verification code, be refused by the server, and
face a three-codes-per-hour budget between them and the class.

**A required entry that cannot be resolved fails CLOSED** — `waiver_unavailable`,
and the booking is refused rather than allowed. Three invariants make that
unreachable in practice (a waiver document is callable-only, a published document
cannot be deleted, archiving removes the policy entry in the same transaction),
and the Documents page runs the cheap converse on load and shows a banner when the
policy and the documents disagree.

**Archiving a waiver writes `status: 'archived'`**, not only `archived_at`. Every
surface in the product reads archived-ness off `status` — the badge, the list
filter, and `setDocumentStatus` for every other kind — so writing only the
timestamp left an archived waiver rendering as **Published**, over a live Publish
button that `publishDocumentVersion` then refused by name (`document_archived`).
A control that is always an error is worse than no control. Archiving a waiver
remains **terminal**: there is no Restore, because a re-opened document would
claim a continuity the ledger cannot support. Its text and every signature against
it survive, and the export still finds them.

**A RENAME reaches the policy, because the entry carries the title.** The path a
`updateWaiver` takes is decided by "does `RequiredWaiverEntry` carry this field",
not by "is this content or settings". The first cut split on content-vs-settings
and so let a title edit skip the policy patch entirely: every studio-side surface
showed the new name and the consent step — which reads `entry.title` off the
policy, as does the public mirror — showed the old one, until some later publish
happened to rewrite the entry. Silent, and visible only to the people being asked
to sign. Body, summary, source and external URL are genuinely invisible to the
policy and still take the cheap path with no policy read, which is the
overwhelming majority of saves.

**A waiver document is callable-only in all THREE verbs.** `firestore.rules`
excludes `kind == 'waiver'` from create, from update *and* from delete. The
delete clause was missing at first, and the gap was not theoretical: an
*unpublished* waiver is not an empty one — `recordSignupConsent` writes under
`documents/{id}` before anything is published — so a client delete would have
left acceptance events and signer rows addressable only through a document that
no longer exists. There is
deliberately no waiver delete anywhere, in the rules or in a callable: archiving
is the retire path, and the ledger outlives the document by design.

**And no client mints a publish state, on any kind — at create as well as at
update.** The update clause pins `current_version` and `min_valid_version` and
forbids the transition into `published`; the create clause originally
constrained only `kind`, so the one write that decides a document's whole
starting state constrained none of it. A manager could `setDoc` a document
already at `status: 'published'` with no version behind it, or at a
`current_version` naming a snapshot that does not exist — which is the state the
acceptance ledger has no defence against, because an acceptance stores only the
hash and trusts the version to hold the text. Both clauses now say the same
thing, and the editor's own create (status `draft`, neither pointer) is
unaffected.

**A documentId is not an oracle.** `updateWaiver`, `setWaiverRequirement` and
`archiveWaiver` enter through `loadWaiverForManager`, which asserts
authentication **before** the document is read and membership **before** the
`kind` is spoken. They used to branch on the loaded document's kind first, so an
unauthorized caller could tell an existing id from a missing one
(`document_not_found`) and a waiver from a terms page (`not_a_waiver`) out of the
refusal alone.

**The client calls `resolveWaiverRequirement` if and only if the mirror lists at
least one required waiver.** A tenant with no waiver — every tenant on the day
this ships — pays **zero** extra round-trips on the acquisition path. The gate
itself costs one policy `get` plus one signer `get` per applicable waiver, with
the fan-out bounded by `MAX_REQUIRED_WAIVERS_PER_TEAM = 3`.

## The gate

`enforceWaiverGate` (Firestore) wraps `decideWaiverGate` (pure). Every rail calls
the former **exactly once**, and `waivers/gate.test.ts` re-derives the caller set
from the source, so a new rail that wires the gate in correctly and is never added
to the census **fails the build**.

> **The census owner is the module header of
> `packages/functions/src/waivers/gate.ts`**, together with its re-derivation
> recipe. It is not restated here and must not be copied anywhere: it was built by
> grepping the attendance **write sites**, not the callable names, because a list
> of names you already trust cannot discover the name you forgot — which is
> exactly how the first draft missed `selfCheckIn` and then `checkInContact`.

### The two ordering rules

1. **Refuse before any contact write.** A refusal leaves no contact created, no
   funnel stamp, no `trial_used_at` burned and no acceptance recorded.
   `createDropInCheckout` needed a real restructure for this: its guest contact
   create moved *below* the gate.
2. **Record with the commit.** On the free rails the acceptance event and the
   signer row are written **inside** the transaction that commits the seat, so
   neither can exist without the other. On the paid rails the acceptance is
   written **before Stripe**, in its own transaction, and is **not** conditional
   on payment — a signature is a fact about a person: they read the text and
   ticked, and that is true whether or not the card clears. It is still a
   transaction, because Firestore's optimistic-concurrency detection is the only
   thing standing between a manager's revocation and an acceptance that read the
   row a second earlier.

### Every rail refuses. There are no exceptions

Two rails used to **complete with a waiver outstanding** — the waitlist claim
(one offer per entry, ever, against a 72-hour emailed guardian link) and a
PIN-paired kiosk walk-in (a tablet with an idle timer). Both exceptions existed
for the same thing: a signature only *somebody else* could give. That mechanism
is gone (see "Minors" below), the consent step is completable by whoever is
standing in front of it, and so there is one behaviour on every door — sign, or
be refused. `WaiverGateStep` has no `defer` arm and `enforceWaiverGate` takes no
posture parameter, which is the checkable form of the sentence.

**What that cost, named rather than discovered in a diff.** The claim rail's
exception protected something real: a queue entry gets one offer and refusing
spent it. It is safe to withdraw only because the thing that could not be
completed in the window no longer exists — the claimant reads and ticks on the
screen they are already looking at. The kiosk's exception is withdrawn on the
same reasoning. `Booking.waiver_state` therefore no longer has an `outstanding`
value, and no booking anywhere commits with a required waiver unsigned.

**The kiosk's verified pairing still decides something**, and it is worth
keeping straight: it selects the booking's and the acceptance's `source`, so an
evidence record claims `kiosk` only when the device proved it was one. That is
ATTRIBUTION rather than authorization — but it is attribution on a legal record,
and the rule is unchanged: the one value a caller might want to claim is the one
value they must not be able to fake into it. `source` in the request body decides
nothing but a dashboard label.

### A version published mid-checkout

The submitted acceptance carries the version and hash the visitor was **shown**.
A `silent` publish in between records against the version they actually read; a
`require_resign` publish refuses with `waiver_version_changed` and the surface
re-presents. The hash is checked as well as the version: if the two disagree for
one version number, something impossible has happened and the server refuses
rather than recording a signature against text it cannot identify. **A booking
that already committed is never retroactively invalidated** — the floor bites at
the *next* booking.

## What the gate does NOT cover

Read this section before telling a studio "every booking is gated", because it is
not, and the exemptions are decisions rather than oversights.

| Not covered | Why | What happens instead |
|---|---|---|
| **Staff adding a participant** to a session from the admin UI | It is a direct client write to `sessions/{id}/participants/{contactId}` with **no server seam**. Gating it needs a new `bookParticipant` callable and a rules narrowing on a path coaches use daily | The add-participant dialog warns, and the roster chip shows the outstanding state permanently |
| **`checkInContact`** — a coach scanning a member's QR | Structurally identical to `selfCheckIn`, decided the other way on the axis of **who is acting**: a coach at the door has *chosen* to admit this person, and refusing stops a queue over a document the coach cannot resolve from that screen. The same coach can write the same row by hand from the same page | Admitted; roster chip |
| **`createStaffAppointment`** | The manual-override tool by design — a coach booking a client by phone must not be stopped by a document the client has not opened | Admitted; roster chip |
| **Event attendance** (`handleEventInvitationResponse`, `addEventCheckin`) | An **Event is a different primitive**: it is not a `Session`, it has no `Activity`, and `WaiverApplies` has no arm that can name one. Gating it would mean either applying every `all_bookings` waiver to every event — silently changing the meaning of a setting studios configured for classes — or adding a third scope arm plus an events surface, chip and report. That is a phase, not a row | **Nothing.** A studio running a Saturday open mat collects no waiver through the event rails |
| **`rebookSession`** | A rebook MOVES an existing seat and creates no new attendance relationship. Gating it would be stricter on the reversible operation than on the irreversible one, and neither of its callers (the studio’s bookings list, the public manage-booking link) has a waiver step to send anyone to | Unchanged |
| **`joinWaitlist`** | Joining a queue is not a booking; a signature taken there belongs to a class the person may never be offered | The claim takes it |
| **Shop purchases** — memberships, products, courses, gift cards | Buying is not attendance. A membership implies *future* attendance, and the waiver is taken at the first booking | Nothing |
| **The mobile app** | `apps/mobile` mirrors shapes locally rather than depending on `@linyup/shared`, so a consent step there is a port, not a call-site edit | Refusals are mapped to a legible sentence naming the document (`apps/mobile/src/utils/waiverRefusal.ts`) on **every** rail the app can be refused on — the QR scanner and both class-booking surfaces (`SessionAgendaCard`, `AttendanceCalendar`) — and `selfCheckIn` attaches a `signUrl` into the member's Space so the app does not have to guess a web origin it has no way to know |

The mapper takes the rail as a parameter (`'checkin' | 'booking'`) and it is not
cosmetic: the booking surfaces collapsed every refusal into *"Failed to book
session. Please try again."* until they were wired, which is an instruction that
can never work — a member retrying forever over a document they were never
shown — and the scanner's own wording (*"before you can check in"*) is the wrong
sentence under a **Book** button. There is still no consent step on mobile; what
there is, everywhere, is a sentence that names the document and says where to
sign.

### Space is the way out, so it has to cover everything

`selfCheckIn` and the mobile scanner **refuse** and send the member to
`/public/{slug}/space`. That makes Space the one surface a person standing at a
door can complete on their phone — and it therefore answers for **every** waiver
the studio requires, including one scoped to a single activity, and every row it
shows must be one the member can finish there.

It did not, and the consequence was a closed loop: `signWaiverInSpace` resolved
`applicableWaivers(policy, null)`, which deliberately EXCLUDES an
`activities`-scoped waiver (the right answer for a gate with no activity in hand,
because "we could not tell which activity" must never widen a requirement a studio
scoped narrowly). So the document refusing a member at the door was neither shown
nor signable at the address they were sent to, and no other route existed — they
need never have opened a booking form at all.

It also carried two rows a member could *see* and not *finish*: a date-of-birth
question, and rows reading "a parent or guardian must sign this one" with no
control beside them. Both left with the guardian machinery, and the panel's
invariant is now flat: every outstanding row offers Review-and-sign.

Widening is sound **because Space is not a rail**: it books nothing, admits
nobody and refuses no attendance. Which waivers a BOOKING requires is still
decided by the gate, from the policy, against the activity in hand; signing early
can satisfy a requirement, never impose one. The requirement callable takes
`surface: 'space'` for the same set, honoured for a caller holding a contact
session.

**It writes for its own tenant only, asserted on the snapshot it writes from.**
`requireContactSessionForTeam` already compares the contact's `teamId` — but
`signWaiverInSpace` then reads the contact document a second time and copies
every field of the acceptance out of *that* snapshot while stamping the row with
the `teamId` from the request. The assertion has to be made about the read the
write is built from, so it is made there too, before the policy is loaded: a
cross-tenant row in a compliance ledger is not a display bug, it is a false
record.

## Asking somebody to sign, and finding out who has not

Making a document mandatory does nothing for the people already on the books: the
requirement binds at their next booking, where they meet it as a refusal, on the
acquisition path, with no warning. Two additions close that, and both are
deliberately small.

**`requestWaiverAcceptance` (`packages/functions/src/waivers/request.ts`)** — a
manager-only callable that emails people the **existing Space link**. It is a
REQUEST, not a gate change: no acceptance row, no signer row, no `waiver_policy`
edit, no counter, so it is in neither census (it puts nobody in a room and it
writes no ledger row). Single and bulk are one shape (`contactIds: string[]`,
capped at `MAX_WAIVER_REQUEST_RECIPIENTS`), the mail goes out **as the studio**
(`sendEmail({ teamId })`, so suppressions, messaging policy and the mail ledger
all apply), and each recipient comes back with one of five outcomes —
`sent`, `already_signed`, `no_email`, `not_delivered`, `skipped`. A contact with
no address is REPORTED rather than dropped: it is the one case the studio has to
handle itself, at the door.

Two properties are worth keeping:

- **It covers required waivers only, and refuses the rest by name.** Space
  presents the waiver policy, so a document that is merely *shown at signup* has
  no page to send anybody to; `document_not_required` says so and the surfaces
  point at the one switch that changes it. Inventing a second signing surface
  would mean a second answer to "does this tick count".
- **Safe to call twice, still able to remind.** The `mail_sends` key carries the
  document, the **version**, the contact and the **calendar day**: a double-click
  or an overlapping bulk selection sends one mail, and next week's genuine
  reminder is not swallowed. Keying it on the relationship alone is the waitlist
  notifier's recorded bug; keying it on nothing makes the button a way to mail a
  member forty times. Anyone whose signature is `valid` at send time is skipped.

**The `consent` dimension on `ContactFilter`** — `documentId` × the five states,
computed by `waiverAcceptanceState` and never by a second state machine. Because
it is a dimension of the ONE contact predicate
(`packages/shared/src/utils/contactFilter.ts`), it is simultaneously a filter
chip, a saved preset, a dynamic group and an automation condition.

`matchesFilter` is pure and reads what the caller already holds, and a signature
is not on the contact document — so the ledger is loaded **once per document**
(`ContactFilterContext.consent`, a single subcollection query bounded by how many
people signed that document) and the same map answers every contact, every group
count and every automation scan. There is no per-contact fan-out anywhere. A
document whose ledger was not loaded matches **nobody**: the dimension fails
CLOSED, so a caller that forgets shows an empty list rather than everybody.

**`waiver_accepted` / `waiver_revoked`** land on the contact's activity feed under
a `consent` chip. Their one writer is `trackWaiverAcceptances`, a trigger on the
append-only `acceptances` subcollection — every rail writes there, so no rail
needed a `logActivity` call bolted on, and the next one will not either.

## Minors, and the one thing the product can honestly do about them

**`WaiverConfig.mayIncludeMinors` — "participants may be minors". OFF by
default.** Setting it does exactly two things:

1. the consent step shows a second **required** choice — *I am the participant*
   vs *I am signing as a parent or guardian*, with an optional name;
2. every booking taken against that waiver carries a chip on the roster and on
   the printed manifest, so the studio checks at the door.

It asks for no date of birth, computes no age, emails nobody, and **refuses
nothing**. Whichever answer a visitor gives, the booking goes through.

**It is a self-declaration, and every surface says so.** The choice lands on the
acceptance as `signer_role` (`'self' | 'guardian'`) with `signer_name`; the
signers tab prints *self-declared — not verified* beside a guardian row; the
export's honest paragraph names it as a declaration made on the consent step.
Nothing in this product verifies a stated relationship, and no copy anywhere may
imply that it does.

### Why the emailed-guardian machinery was removed (Franco, 2026-08-16)

The previous design was a one-time link emailed to a guardian's own address, with
the signature bound to that address: `guardian.ts` + `guardianRequests.ts` +
their tests (~2,500 lines), a `guardian_requests` subcollection, three public
callables, a public signing page, a mail template, four rate-limit counters, a
bounce fan-out, two deferring rails, and a date-of-birth question on the
acquisition path. It was referenced by 52 files, and three of the four blockers
found across three verification rounds were inside it.

It was removed for one reason, and the reason survives the code: **an emailed
link proves control of a mailbox, not parenthood.** A teenager holding a parent's
phone defeats it. Everything above bought evidence barely stronger than a
checkbox, and it bought it by making a public, unauthenticated,
studio-branded mail sender part of the booking path.

**The studio is the party with the legal exposure and the only party that can
actually verify** — they see the child at the door. So the product's job is to
make that check easy and PROMPTED, which is what the flag and the chip are.

What that gives up, stated rather than discovered: a studio can no longer point
at a mailbox-bound artefact for a minor's consent. What it never had is the
thing it looked like it had.

### What the chip says, and when

| Booking stamp | Means | Chip |
|---|---|---|
| absent | no required waiver applied, or the booking predates waivers | nothing |
| `ok` | signed, and nothing about it asks anyone to look | nothing |
| `guardian_declared` | somebody ticked declaring they are a parent or guardian | **Guardian** |
| `check_participant` | a `mayIncludeMinors` waiver applied and the signer said they ARE the participant | **Check age** |

`Booking.waiver_state` is the snapshot the printed sheet reads — right for a
sheet describing the booking as taken, and imprecise on a repeat booking riding
on a signature given months ago, which stamps `check_participant` rather than
`guardian_declared`. The prompt is the same either way. The **roster** chip on
the session page is the precise one: it reads `signer_role` off the live signer
row (`useWaiverRoster`), so a revocation or a `require_resign` publish since the
booking is visible there.

**Two sources, one vocabulary.** Both go through the same pair of derivations in
`types/waiver.ts` — `waiverDoorCheckFor` (live signer row) and
`waiverDoorCheckFromBookingState` (the booking's stamp) — rather than each
restating the rule, and `gate.test.ts` asserts they land on the same word for the
same facts. They are allowed to differ in PRECISION, never in meaning: a desk
told two different things about one person is worse than a desk told nothing.

A studio that never flags a waiver gets `null` from both derivations, on every
booking, and so sees neither chip anywhere, ever — which is what keeps all of
this off the adults-only case entirely.

## What a signature here is worth

This is not decoration. The same words appear in the publish chooser, in the
export's header, and here.

**Click-wrap is the lightest signature this design could have chosen** — a
checkbox, picked deliberately for the lowest conversion cost, because it sits on
the path to every booking. It is well established as an acceptance mechanism and
carries no drawn mark, no typed name and no second factor.

**`silent` is the lightest renewal.** Stacked, they are the weakest combination
here, and a studio should know it before it clicks: a long-standing member's
record can be one tick years ago against wording that no longer exists. For a
*liability release* that is weaker than the same combination would be for terms of
service, which can lean on continued use — a release cannot lean on continued use
to establish comprehension of a hazard, and a risk added in version 4 and shipped
`silent` was never put in front of anyone who signed version 3.

`signer_email_verified_by` is the whole strength axis, and it has four honest
values:

| Value | What was actually shown | Where |
|---|---|---|
| `emailed_link` | control of that mailbox at that moment | **RETIRED** — the emailed-guardian path. Old rows carry it; nothing writes it |
| `verified_code` | control of **that specific address**, minutes ago, via a six-digit code | the OTP branch, and the signup rail's code path |
| `session` | control of *an* address on the contact's login allow-list at some point in the last 7 days — it identifies the CONTACT, not the person at the keyboard | a contact session |
| `none` | somebody typed an address into a form | a guest booking |

**`verified_code` is a claim about a MAILBOX, so the address beside it must be
the mailbox that was proved — not the subject's.** On the OTP rails the two are
routinely different people: a parent verifies with their own address, selects
their 14-year-old from the matched list, and books. Taking `signer_email` from
the contact would print a mailbox-proved signature by a child who never touched
the keyboard. So `bookSession`, `bookAppointment` and `createAppointmentCheckout`
each pass the address the six-digit code was actually mailed to
(`booking_verification_codes.email`), and the ledger records the SIGNER there
while `subject_email` and the identity key stay the subject's — which is what
keeps a parent's row from merging with a child's. The other three gated rails
(the drop-in checkout, the waitlist claim, `selfCheckIn`) never see a code, so
the subject's own address is the only one there is and is what gets recorded.

**The signers tab shows WHO SAID they signed, and says that nobody checked.**
`signer_role` is copied onto the signer row alongside `signer_name`,
`signer_email` and `signer_email_verified_by`, because the tab reads the signer
row and never the event subcollection — a fact that stops at the event is a fact
the studio is never shown. Beside a `guardian` row the tab prints *self-declared
— not verified*, and the export says the same thing in a sentence. The role and
the verification word are two different axes and neither is the other: a
mailbox proof says nothing about a relationship, and a declared relationship
proves nothing at all.

Three further limits, stated rather than discovered:

- **A declared relationship is a declaration.** Nothing verifies `signer_role`,
  and no surface may imply otherwise. The studio checking at the door is the
  mechanism; the chip is the prompt.
- **Images are not covered by a version's immutability.** The snapshot freezes the
  HTML, which references Storage objects; replacing one changes what a reader sees
  without changing `body_hash`. Storage rules also make document images
  world-readable regardless of the document's status. The editor warns when a
  waiver body contains an image.
- **An `external_link` waiver snapshots the URL, not the content.** Whatever is at
  that URL can change freely. The chooser says so and recommends rich text.
- **Two fields on the row come from the caller, and both are bounded.** The
  optional **guardian name** is cleaned and clamped by `cleanWaiverName`
  (control characters stripped, 120 chars) at `declarationFor`, before it ever
  reaches the ledger writer; `locale` is bounded at the writer itself.
  Everything else on the row is derived, read off the request, or copied from a
  contact document, a prior ledger row or the rail's resolved subject. `locale`
  was stored exactly as
  sent, unbounded and unshaped, by two rails — a field in an evidence record that
  can hold anything of any length is not evidence of anything. It now passes
  `normalizeWaiverLocale` at the ledger writer (the one place every row is
  built, so a new rail cannot forget it) and anything that is not a plausible
  BCP-47 tag is stored as null, which the field already models honestly.

**And the accumulating weakness is surfaced, not only recorded.** The gate treats
a signer whose version was superseded by a `silent` publish as `valid`, and the
roster chip renders nothing for `valid` — so the waiver's **signers tab carries a
standing line**: *"31 members' signatures predate a change they were never asked to
accept."* Computed from each signer's `accepted_version` against every later
`silent` version. It is where the product answers *how good is my evidence
right now* — nothing else does.

**None of this is legal advice, and the product says so where it matters.**

## The export, and the checker

`exportContactConsentHistory({ contactId, format })` — one member's complete
consent history as a self-contained artefact: the studio, the contact, the export
instant, the honest paragraph above, then per document every version that ever
existed with its outcome and its `backfilled_at` marker, every acceptance and
revocation event with the **full materialised text**, the stored hash and an
explicit **match verdict**.

**Both queries always run for an operator, and they render differently.** The
primary one is `acceptances where contactId == …`; the second is
`identity_key == …` and it is **mandatory, not optional**. One human routinely
holds several contact ids here, because the guest match requires email **and**
name — Anna books in March as "Anna Müller", a phone drops the umlaut in June, and
a second contact is created. Exporting from the second and getting June only is an
artefact headed with her name that omits the version she actually signed under.

But the two are **never merged**: `identity_key` is sha256(normalised email), and
a shared family mailbox gives a mother and her child the same one. The second
query's rows are printed in their own section, headed *"other records for this
email address"*, each carrying its `contactId`, `subject_name` and `signer_role`.
Over-inclusion is harmless for a redemption cap and is a **fabrication** in a
consent artefact. **The member's own download from Space omits that section
entirely** — it would show them somebody else's records — and the **server**, not
the client, decides which of the two artefacts it is producing.

**And both are scoped to ONE TEAM.** A collection group spans every tenant, so an
unscoped `identity_key` pass hands studio A its neighbours' signature rows the
moment two studios share a member — names, addresses and consent history, printed
under the wrong studio's letterhead. `loadEvents` therefore takes `teamId` as a
**required parameter** (taken from the contact document that authorization was
checked against, never from the request), filters on it first, and passes the
result through a pure `keepOwnTeam` guard so the property is asserted by a
fixture rather than assumed. Consequence for the reader of the artefact, and it
is stated in the artefact itself: the second section is *other records at **this
studio*** for that address. A person's history at another studio is not this
studio's to print.

**One block per document this person has EVENTS on, and no others.** The
candidate list was that set unioned with every waiver document the team holds,
because a ticked-but-unredeemed emailed guardian request produced no acceptance
row and would otherwise have gone unprinted. That mechanism is gone and nothing
under `documents/{d}` names a contact except through an event, so the union
would now only grow empty sections in an artefact a lawyer reads.

**A printed hash mismatch names the repair path**, not just the fault: an artefact
that tells a lawyer the evidence is broken and stops there is worse than one that
never checked. And a verdict is only worth reading if it can say *match*: the
other-records section was rendered against an empty version map, so every row in
it was stamped `version_missing` — an integrity alarm, fired unconditionally by
the export's own shortcut, in the artefact a studio hands a lawyer. A section of
false alarms teaches its reader to ignore the one that is real. Those documents'
versions are loaded too now; only the TEXT stays unmaterialised there, which was
always deliberate.

### `scripts/verify-waiver-ledger.ts` — `pnpm verify:waiver-ledger`

Read-only, exit-code-bearing, per team or global, no collection-group query and
therefore no new index. The finance journal's precedent has a checker and an
alarm; append-only-by-convention-over-the-Admin-SDK is an intention, not an
enforcement.

| Check | Why it can fail despite the rules |
|---|---|
| `body_hash === sha256(bodyHtml)` for every version | the Admin SDK bypasses `allow write: if false`; a migration or a console edit is the realistic cause |
| `current_version` points at a snapshot that exists | — |
| every signer row is backed by an `accepted` event, at the version it claims, for that contact | a signer write that landed while its event create was skipped |
| a revoked row carries `revoked_at` | without it, a later acceptance would silently undo the revocation |
| policy ↔ document agreement, in **both** directions (orphaned, stale, missing) | "they always agree" is an assertion until something checks it |
| no document has `status: 'published' && current_version == null` | the backfill's precondition, permanently |

Cadence is **pre-release plus on demand**: adding a scheduled entry would be the
first one this feature has, and there is no corruption vector until somebody runs
an Admin-SDK migration. `waiverPolicyEntryFor` is shared by the writers and the
checker so they cannot disagree by two people implementing the same paragraph.

### Deleting a tenant exports its ledger first

`TENANT_DATA_COLLECTIONS` sweeps `documents` by `teamId` and per-team teardown
uses `recursiveDelete`, so deleting a team destroys **every signature it ever
collected**. A liability release is the one artefact a studio needs *after* the
relationship ends, and the window is measured in years rather than in account
lifetime. So `scripts/lib/exportConsentLedger.ts` is wired into both teardown
paths (`pnpm sandbox:reset`, `pnpm lead:seed --reset`) **before the first delete**,
and refuses the run on failure. `--no-consent-export` is the escape hatch, and it
has to be typed.

## Plan tier, and what survives a downgrade

`WAIVER_MIN_PLAN = 'studio'`, with `WAIVER_LIMITS` expressing the same statement
as data (`free`/`coach`: 0, `studio`: 5, `organization`: 20) so the client can
render "0 of 5" without a second rule. The waiver kind is offered **visible and
locked** below Studio with the upgrade modal — hiding a lever teaches nobody it
exists.

**Gates control creation and REQUIRING; never retiring.** On a team downgraded to
Free with a live required waiver:

| Operation | Still works? |
|---|---|
| The gate blocks a booking | **yes** — an in-flight requirement survives a downgrade |
| A visitor signs it | **yes** |
| The export, the ledger checker, revoking an acceptance | **yes** |
| Turning the requirement **off**, or archiving the waiver | **yes** — a team must always be able to stop gating its own bookings |
| Editing a waiver's **settings** (`mayIncludeMinors`, `validityMonths`, `scope`) | **yes** |
| Editing a waiver's **text**, publishing a new version, creating a waiver | **no** — `plan_required`. Text edits are authoring |
| Turning the requirement **on** | **no** — `plan_required` |

> **The asymmetry on `setWaiverRequirement` is the point.** Turning a requirement
> **on** is the switch that converts a published document into a gate on every
> booking. Left ungated, a studio could subscribe for one month, create a waiver,
> publish v1, leave `required` off, cancel to Free and then turn it on — a fully
> working Studio-tier feature running indefinitely on Free, with no new object
> created for anything to refuse.

Both refusals are reachable only from the admin surface, so a visitor never sees
`requirePlan`'s English billing prose.

## Documents stopped being a plugin

Waivers extend Documents, and Documents was gated behind a plugin install that
**Free and Coach teams could not perform at all** (`minPlan: 'free'` routed them to
a client-side install the rules deny). Worse, uninstalling — which
`downgradeTeamToFree` triggers for every install — batch-deleted every public
document mirror for the team. Under a waiver gate that means: downgrade a team,
and the gate points at content that no longer resolves while the signup consent
links empty in the same beat. So the plugin is gone, the teardown arm is gone, and
`deleteAllDocumentPublicProfiles` was deleted with it.

**The surface stays dark until content exists.** `active_public_surfaces.documents`
is computed from the existence of a public_profile **mirror**, not from the root
`documents` collection — a downgraded team still *has* its documents, only its
mirrors were deleted, so a document-collection probe would flip the surface live
on the next unrelated team write and offer an empty page as a default landing
surface. `scripts/audit-document-visibility.ts` names what would go live;
`scripts/backfill-document-mirrors.ts` publishes it, opt-in per team with a typed
confirmation, because the teardown left no marker and only a human can tell "never
had a mirror" from "had one, deleted".

The signup-consent selection moved from `installed_plugins/documents.config` to
`teams/{teamId}/settings/documents`, with a **single shared dual read**
(`resolveSignupDocumentIds`) used by both the panel that writes it and the sync
that denormalises it — two hand-written `new ?? old` reads is how two locations
start disagreeing mid-migration, invisibly. An *empty* new selection is
authoritative: clearing the list must not resurrect the retired one.

### Indexability is gated; existence is not (decision D2)

De-gating completely hands **every** signup a public publishing surface on a
Linyup domain, which is an SEO-spam and reputation vector. The mitigation gates
**indexability, not existence**: public document pages render identically for
everyone and stay shareable by link and QR, and carry `noindex` until somebody is
paying. Nothing has to be withdrawn later, which is the property that made the
decision safe.

`publicPagesIndexable({ plan, plan_status })` in `packages/shared/src/types/plan.ts`
→ denormalised as `TeamPublicProfile.public_pages_indexable` → read server-side by
`generateMetadata` on both public document routes.

Three implementation facts, each of which is a way to build this and have it not
work:

1. **A trial is not a paid tier.** Self-service signups are provisioned
   `plan: 'studio', plan_status: 'trial'`, so the obvious predicate
   (`plan !== 'free'`) would hand every throwaway account 30 days of indexable
   pages — and a page only has to be crawled once. The predicate requires
   `plan_status === 'active'` and refuses `expired` explicitly, because a lapsed
   trial reports its stored plan until the nightly cron rewrites it.
2. **It fails CLOSED to `false`.** Every mirror written before the flag existed
   reads as not-indexable. A crawled spam page cannot be un-crawled; the repair in
   the other direction is one team write.
3. **The tag is emitted by `generateMetadata` on a SERVER page**, which is why both
   public document routes are now a server shell around their existing client
   component. A robots tag written by client JavaScript is not a mechanism. The
   read is Firestore **REST**, not the web SDK, for the reason `site/page.tsx`
   already records — inside the Next server runtime the SDK's streamed query
   responses come back empty, and *"we could not tell"* must not read as
   *"indexable"*.

## Refusals

Every refusal carries `details.reason`, and every reason has a translated string
in the `Waiver` namespace of `apps/web/messages/{en,de,fr,it}.json`, keyed
`reason_{code}`. The client's table is `WAIVER_REFUSAL_REASONS`
(`apps/web/src/lib/waiver.ts`); `packages/functions/src/waivers/waiverReasons.test.ts`
asserts that every reason the **server source** raises appears in it and has
non-empty copy in all four locales, and that the four files have identical key
sets.

| Reason | Means | The surface does |
|---|---|---|
| `waiver_required` | a required waiver has no valid acceptance for this caller | fetch the requirement and render the step |
| `waiver_version_changed` | a `require_resign` publish landed between the tick and the submit | re-render with the new text; one extra tick |
| `waiver_unavailable` | the policy names a waiver whose version cannot be read | a generic "temporarily unavailable"; the studio sees a banner |
| `rate_limited` | the resolve's `waiver-check` counter in `waivers/limits.ts` | a visitor behind a busy studio's NAT must NOT be told the document is invalid — the step keeps its Retry |

Those are the PUBLIC refusals. The studio-facing ones — the authoring callables'
`details.reason` values — map to copy in `waiverCallableError`
(`apps/web/src/plugins/documents/hooks.ts`), and the ones a manager can act on
each have an arm: the empty body, the version cap, a concurrent publish, the
plan gate, the required-waiver cap, the deferred `notify` outcome, the external
URL, the archived document, the not-yet-published waiver and the unreadable
version. `document_not_found` and `not_a_waiver` are deliberately left on the
generic string: nothing a studio types produces them, and inventing copy would
tell a manager to fix something that is not theirs.

### Two client rules that keep a refusal from becoming a dead end

Both live in `apps/web/src/hooks/useWaiverGate.ts`, and both were shipped wrong
in a way that reads as harmless in a diff and is not.

**An empty requirement list is TWO different answers.** "Resolved, and nothing is
required" and "we could not resolve it" both leave the list empty, and
`[].every(…)` is `true` — so the error screen rendered with a live **Confirm**,
and pressing it re-entered the submit, got the same `true` from the gate's second
pass, and sent a booking the rail refused a moment later. The gate now carries
`resolved` (a server answer was stored) separately from `error` (the last attempt
failed); `ready` and `deferredReady` are false unless the first is true and the
second is null, and the step's error state carries a **Retry**. A blocking message
with no next step is still a defect on a booking path.

**The mirror is a hint; the server is the authority.**
`TeamPublicProfile.required_waivers` is what makes the whole feature free for the
tenants that require nothing, and it can be briefly stale-**empty**. When it is,
`applies` is false, `ensure()` answers "clear", and the rail refuses
`waiver_required`. The surfaces' recovery branch used to call `ensure()` again —
which returned "clear" again — and print a sentence with no step behind it. They
call `gate.recover(err, identity)` instead: a waiver refusal from the server is
proof the mirror is wrong, so the gate is **forced live for that tenant** and
resolves properly. `recover()` deliberately survives `reset()`, because it is a
fact about the team and not about the person — the next walk-in at the same
kiosk should not have to be refused once to rediscover it.

**`resolveWaiverRequirement` does not trust a body `contactId`.** Honouring one
would turn a public callable into an oracle over a compliance fact — *has contact
X signed the release?*, one call per guessed id. It accepts the rails' own proofs
in the rails' own order: a contact session; or `authenticatedContactId` +
`verificationCodeId` validated **read-only** (never marked used — it must not
spend a credential the rail is about to need, against a three-per-hour budget); or
email **and** name through the shared guest predicate; or the conservative answer.

**Caller resolution is email AND name, from the same helper the rails use.** Email
alone is a real divergence, not a paraphrase: Sabine and her son Nils share a
household address, an email-only lookup matches Sabine, computes age 41 and
returns "nothing to sign", and then the gate matches email+name, resolves Nils and
refuses — after the verification code was already spent. Where an email resolves to
several contacts and no name narrows it, the callable returns the **conservative**
answer (`none` / `sign_self`), never a candidate's state. Asking someone to tick
again costs a tick; not asking costs the gate.

## Operations

| | |
|---|---|
| Abuse limits | **One model, stated once, in `packages/functions/src/waivers/limits.ts`** — read it before changing any counter here. Bound what costs something, on the axis that pays for it, and never let a stranger spend an entitled caller's quota. **Enumeration** is not rationed but withdrawn: the requirement callable's answer to an unproven caller is identical whether the address they typed addresses a whole family here or nobody. **Volume** on the requirement callable is 600/hour per IP, charged only for an uncredentialed caller asking about a person — sized for a doorway (200 walk-ins an hour) rather than for a probe, because that read is a precondition for booking. The mail counters left with the emailed-guardian mint they bounded; **no waiver path sends mail at all** |
| Who is exempt | A caller presenting a credential **we** minted for **this** team — a live contact session, or a kiosk tablet paired through `unlockKiosk` — pays no per-IP counter. Checked from token claims, so it costs no read |
| Buckets | `'waiver-check'` (the requirement callable) — the only one. `'waiver-guardian'` and its three derived prefixes went with the mint |
| Caps | `MAX_REQUIRED_WAIVERS_PER_TEAM` 3 · `MAX_DOCUMENT_VERSIONS` 200 · `MAX_WAIVER_BODY_CHARS` 50000 (**the one definition**; the web editor's limits file delegates to it) · `MAX_WAIVER_NAME_CHARS` 120 (the optional guardian name — a caller-supplied string on a legal record) |
| Indexes added | **two** composite, both `acceptances` COLLECTION_GROUP (`contactId ASC, accepted_at DESC` and `identity_key ASC, accepted_at DESC`). Every other waiver read is a document `get` or a subcollection list |
| Scripts | `pnpm backfill:document-versions` (deploy precondition) · `pnpm verify:waiver-ledger` · `pnpm audit:document-visibility` · `pnpm backfill:document-mirrors` |
| Emails | **none.** No waiver path sends mail, on any rail, at any moment |

## Known gaps, and deliberately not built

Two decisions were made against the recommendation (D1 notify, D2 complete
de-gating); each carries a consequence that became a requirement rather than an
accepted risk, and each is written up in its own section above. D3 —
`guardianRequired` defaulting to `never` — is moot: the whole guardian rule was
withdrawn (see "Minors"). The remaining open questions proceeded on their
recorded recommendation:

| # | Question | Decision | The cost, stated |
|---|---|---|---|
| Q1 | A `Guardian[]` type on the contact | **Narrowed out**, and doubly so after the guardian machinery was withdrawn: the ledger snapshots the signer, and a freely-editable array would be a second source of truth for a question the ledger already answers | Nothing pre-fills a repeat guardian's name; they type it, or leave it |
| Q2 | Acceptance **inside** the booking commit rather than after it | **Inside.** Post-commit is the zone where the partner ledger and the contact alert swallow their own failures | One extra single-document read in the transaction |
| Q3 | The publish chooser's default | **`require_resign` preselected** for a waiver, labelled *recommended*; `silent` for every other kind | Friction on the booking path by default — deliberate, because it is the option most studios will never change |
| Q4 | The kiosk when the walk-in is a **minor** | **Superseded.** It admitted with a chip because the only way past a guardian requirement was an emailed link and a tablet cannot wait for one. The tablet now takes the whole signature, so the kiosk refuses like every rail | Nothing outstanding anywhere. The `mayIncludeMinors` chip still prompts the desk |
| Q5 | Age of majority | **Withdrawn.** No age is asked, computed or stored anywhere in this feature | The studio decides who is a minor, at the door, prompted by the chip |
| Q6 | Staff-initiated attendance (add-participant, `checkInContact`) | **Accepted, not closed.** Surfaced loudly on the roster | "We have a waiver gate" is not literally true. If a `bookParticipant` callable is ever built, the honest version gates the staff scanner with it |
| Q8 | Should a guardian's signature complete the booking? | **Moot.** There is no separate guardian signature to wait for — the person at the keyboard completes the step and declares who they are | The declaration is unverified, which is stated everywhere it is shown |
| Q9 | Forbid images in a waiver body? | **Warn in v1** | The version freezes the HTML, not the image files it references |
| Q10 | The Documents route move | **Moved** to `/documents`, with redirect shims at both old paths | A default feature under `/plugins/` read as a bug |
| Q11 | Member self-revocation | **Manager only in v1.** Space shows the state and a "contact the studio" line | — |
| Q12 | Is `validityMonths` a launch feature? | **The field ships; the admin control does not** | The mechanism was what was required. Note the constraint the field now carries: the rule in force is frozen onto each signature, so changing the number governs future signatures only. Re-dating existing ones would have to be a publish outcome with its own version, never a field edit |
| Q13 | The ledger when a studio leaves | **Export before teardown**, adopted | Both teardown paths refuse to run if the export fails |
| Q14 | Do EVENTS want a waiver? | **Exempt in v1**, and this document says so in the studio's own words rather than letting anyone infer coverage | A studio running a Saturday open mat hits it immediately. It is a third `scope` arm plus an events surface, chip and report — a phase, not a row |
| Q15 | Delete `SignupForm`'s birthdate field? | **Kept, and now unrelated to waivers** — no waiver path reads or writes a birthdate | It is an existing optional profile field studios may rely on; removing it is a data decision, not a waiver one |
| Q16 | Who runs the ledger verifier? | **Pre-release plus on demand**, adopted | No scheduled entry, so no alarm until somebody runs it |
| Q18 | Is three required waivers coherent? | **Cap stays 3, the step is built for ONE** — additional waivers render as sequential sub-steps with a "1 of 3" affordance | Three 50k-character documents on a phone between "details" and "confirm" is the worst case, and nobody has costed the *reader's* side of it |

Also deliberately absent, each for a reason stated where it matters: any waiver
arm in `resolvePaymentOptions` (a waiver has no price — `git diff` on
`paymentOptions.ts` is empty for this whole phase); a reserve → commit → release
lifecycle; any sweep for expiry or supersession; drawn or typed signatures,
second factors and ID checks; any age check, date-of-birth question or
verification of a declared relationship; a PDF renderer for the export; a mobile
consent step; and **any mail, SMS or push fired by a waiver EVENT** — no "your
waiver expired" notification exists, nothing is sent when a publish supersedes a
signature, and the `notify` publish outcome is still deferred (D1). The one mail
this feature sends is `requestWaiverAcceptance`, which a **manager** triggers by
hand; nothing in the system mails anybody on its own.

One accepted consequence worth knowing before somebody discovers it: a visitor who
signs and then abandons a paid checkout leaves an acceptance attached to a
provisional contact that the nightly purge may later delete. The **event row
survives** — it is evidence and must — and the signer row is orphaned. Orphans are
small, bounded by the abandonment rate, and deliberately not swept: sweeping needs
a collection-group scan and risks deleting the row of a contact that still exists.
