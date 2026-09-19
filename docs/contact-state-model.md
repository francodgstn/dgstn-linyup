---
title: Contact state model
description: How Linyup sees a contact — the contact state model
status: living
area: contacts
order: 1
---
# Contact state model

**Status: BUILT.** Designed with Franco on 2026-09-10. The External bucket shipped
the same day in [#274](https://github.com/francodgstn/dgstn-linyup/pull/274),
[#275](https://github.com/francodgstn/dgstn-linyup/pull/275),
[#276](https://github.com/francodgstn/dgstn-linyup/pull/276) and
[#277](https://github.com/francodgstn/dgstn-linyup/pull/277), tagged `v0.24.0`.

This is the design record: the four things Linyup tracks about a person, what each
value means, the seven people the model was tested against, and the names that
were weighed and dropped. The rules an agent must not break are in
CLAUDE.md → "Contact lifecycle — ONE predicate, and two questions"; this page
holds the reasoning behind them.

There is an owner-facing, interactive version:
[contact-state-model.html](./contact-state-model.html). Open it in a browser. Its
walkthrough lets you follow each person step by step, and flip between the model
as it is now and as it was before External existed. It was written to be shown to
studio owners, so it uses their words and no field names.

## Four things, tracked independently

| Owner-facing name | The one question it answers | Values (owner label) | Stored as |
|---|---|---|---|
| **Journey** | How far did they get toward joining? | Not started · Trial booked · Trial attended · Joined | `acquisition_stage` (absent = not started), plus the immutable `entry` |
| **Affiliation** | Do they belong: to the club, a federation, a governing body? | None · Requested · Under review · Almost ready · Active · Expired | `affiliations` rows (several per person), rolled up into `affiliation_summary` |
| **Plan** | What do they hold, and pay for? | None · Trialing · Active · Past due · Paused · Cancelled | `held_plans` (every holding), `active_subscriptions` (live Stripe subscriptions) |
| **Lifecycle** | Does the studio look after them today? | Lead · Active · External · Archived · Deleted | `provisional`, `external`, `archived_at`, `deleted_at`, `anonymized_at` |

Each axis has its own writers, and a value on one never implies a value on
another. Someone can be Joined with no plan, on a trial while already paying, or
archived with everything else exactly as it was. One event can move two axes:
checking in a trial lead moves her journey to Trial attended and makes her an
Active contact. But changing one axis by hand never drags another along. Buying
changes the plan, never the journey. Archiving someone, or marking them External,
changes the lifecycle, never the journey. What they did stays done.

### "Is she active?" needs a second word

Three of the four axes have a value called Active, and they mean different things:

| "Active" on the… | means | for a ClassPass drop-in |
|---|---|---|
| Journey (Joined) | she converted | usually not, but a former member keeps Joined as history |
| Affiliation | the club counts her as a member | no |
| Plan | she is paying for something | maybe: a partner-app plan is one, if the studio tracks it |
| Lifecycle | she is on the roster the studio looks after | **no**, which is what External means |

Most of the confusion this model was built to remove came from one habit: reading
the **journey** as if it said "member". Joined records a conversion that happened,
not a relationship that still holds. The roster is the lifecycle's job, the club's
member count is the affiliation's job, and "paying" is the plan's job.

## Lifecycle — does the studio look after them?

Owned by `contactLifecycle()` in `packages/shared/src/utils/contactLifecycle.ts`,
which decides in a fixed order, first match wins: **deleted → archived →
provisional → external → active**. Never test the markers inline; the census of
server seams that must tell the buckets apart is
`packages/functions/src/contacts/contactLifecycle.test.ts`.

| Value | Stored | Meaning |
|---|---|---|
| **Lead** | `provisional: true` | Not materialised yet. Covers trial bookings never attended, shop registrations awaiting their first payment, public-form leads and waitlist joiners. Shown on the Leads tab. Leads do not count toward the plan's contact cap. |
| **Active** | no marker | On the roster: everyone the studio looks after. |
| **External** | `external: true`, `external_since` | Trains here without being on the roster. |
| **Archived** | `archived_at` | Left. The record is kept for history. |
| **Deleted** | `deleted_at` / `anonymized_at` | In the bin, or anonymised. Nothing reads them. |

Two predicates sit on it, and they answer different questions:

- **`isLiveContact`**: may they book, attend, sign in, be matched by email? Leads,
  actives and externals.
- **`isRosterContact`**: does the studio look after them? Leads and actives. This
  one drives the headcount, event invitations, automation sweeps and Needs attention.

The only difference between the two is the external, and that is the whole reason
the bucket exists. Before it, a ClassPass visitor was either on the roster, where
she was nagged, counted and invited, or archived, where she could not book.

### What External does

| An external **can** | An external is **not** |
|---|---|
| book and attend classes | in the headline contact count, the Active tab, or the by-stage counts |
| be checked in, and counted in every class's attendance | invited to events |
| keep their journey, plan and affiliation history | swept by automations, including the per-contact triggers |
| hold a plan, a pack or a partner-app plan | shown under Needs attention |
| count toward the plan's contact cap: the record exists | counted as a lost trial when later archived |

An external holding a federation licence is still on the federation's books:
affiliation follows whether a person is live, not whether they are on the roster
(see [org-contact-visibility.md](./org-contact-visibility.md)).

### How the lifecycle moves

- **Lead → Active**: first attendance, a successful payment, promotion to Trial
  attended or Joined, completing the signup form, a manual plan assignment, or the
  studio's Confirm.
- **Lead removed**: shop registrations that never pay, and waitlist joiners who
  never claim, are hard-deleted after their expiry. That is the only automatic
  removal. Stale trial leads are not deleted. The opt-out trial clean-up automation
  archives them.
- **Active ↔ External**: the studio marks someone External on the contact page or
  as a bulk action. The studio brings them back, or completing the public signup
  form does, because that form is the one act that says "I'm joining". **A purchase
  never clears External**: a partner-app plan is a purchase.
- **→ Archived → Deleted → anonymised**: the studio's decisions. Archiving moves no
  other axis.

## Journey — how far toward joining

`ACQUISITION_STAGES` in `packages/shared/src/types/contact.ts`: Trial booked →
Trial attended → Joined. It is a high-water mark: it only moves forward on its own,
and stepping someone back is logged as a correction, not a move.

How people arrive (`CONTACT_ENTRIES`, set once and never changed):

| Entry | Lands on |
|---|---|
| `booking`, books a trial | Trial booked (as a Lead) |
| `walk_in`, checked in at the door | Trial attended |
| `signup`, completes the signup form | Joined |
| `import`, migrated | Joined, except HMD externals (see Giulia below) |
| `shop`, `form`, `waitlist`, `manual` | **no stage**: not on the journey yet |

The off-journey entries are deliberate. A purchase or a captured lead is not a
funnel step. Joining a waitlist is not a trial booking: the stage is stamped when
the person claims a seat. And a coach typing in a name is not something the
prospect did. These people join the journey later, when they book a trial or sign up.

| Move | Caused by |
|---|---|
| → Trial booked | their first trial booking |
| Trial booked → Trial attended | the studio checks them in |
| → Joined | they complete the signup form, or the studio marks them Joined. Counted as a conversion |
| a purchase | moves the plan, never the journey |
| archiving, marking External | moves the lifecycle, never the journey |

Reserved and deliberately unbuilt: `enquired` upstream, and `left` / `won_back`
downstream.

## Plan — what they hold

A contact holds a **list** of plans: Stripe subscriptions, credit packs and plan
grants, mirrored into `held_plans` by one writer. See
[multi-plan-holdings.md](./multi-plan-holdings.md). The status values in the table
above are the roll-up of a Stripe subscription. **Trialing** is a free period on a
paid plan, never a trial class. The plan is the only axis that pauses: a summer
break suspends billing, not belonging.

Some studios do not track plans at all. For those, the axis simply reads None, and
nothing else depends on it.

**"Subscribed" means one of the studio's own plans.** A partner-app plan
(`SubscriptionType.source: 'aggregator'`, shown as "partner": ClassPass, FitPass…)
earns the studio a payout per visit. It is not a membership the studio sold, so it
is counted apart, as "Via a partner app". Every subscriber headcount asks
`holdsOwnPlan` / `holdsPartnerPlan` in `packages/shared/src/utils/subscriptionSource.ts`.
Per-type breakdowns keep every type by name.

## Affiliation — does the club count them

A contact may hold several affiliations at once, each its own record with its own
status and validity. The issuers (`AFFILIATION_ISSUERS` in
`packages/shared/src/types/affiliation.ts`) are:

- the studio itself, for a club membership;
- an organisation the studio belongs to, for a federation licence;
- an external governing body that the studio only tracks.

A studio that tracks none never sees the axis, so do not present it to those owners
as a fourth column. An organisation may define its own statuses. Only a status with
`countsAsActive` (built-in: Active) counts as a member. The old `guest` status was
removed: no affiliation is simply None. What a federation may see of a studio's
people is decided by affiliation, in any status. See
[org-contact-visibility.md](./org-contact-visibility.md).

## The seven people it was tested against

Each person was picked to test a different rule. The three whose story External
never touches (Marco, Elena, Anna) matter as much as the ones it changes: they show
the bucket isn't over-applied.

| Person | Path | Ends as (Journey · Lifecycle · Plan) | What it proves |
|---|---|---|---|
| **Lea**, via ClassPass | books a trial, comes once, goes quiet | Trial attended · **External** · None, or her partner plan | the bucket's reason to exist; see her branches below |
| **Marco**, walks in and joins | walk-in → twice more → signup form → monthly plan → licence | Joined · Active · Active | the ordinary story. External never appears |
| **Elena**, trial no-show | books → no-show → archived | Trial booked · Archived · None | counted as a lost trial, rightly. External leaves her alone |
| **Anna**, member who lapses | Joined and paying → cancels → stops coming → archived | Joined · Archived · Cancelled | a lapsed member **should** be chased. External is for people who were never the studio's to keep, not members it is losing. `left` / `won_back` are her future, not External |
| **Tom**, member who drifts to dropping in | cancels, keeps paying per class → marked External | Joined · External · Cancelled | Joined stays as history and his conversion still counts. A later purchase leaves him External until the studio brings him back |
| **Sofia**, buys a 10-pack, comes monthly | shop → first booking → attends → monthly | Trial attended · External · 10-pack | paying and External go together. Her credits keep working: the door checks what she holds, not the roster. A pack is not a subscription, so she is never counted as a subscriber |
| **Giulia**, migrated from hmd-lineup as `external` | import → attends | Trial attended, or none · External · None | the old word maps to the same word. Her journey records only what she did, never Joined, and she carries no tag |

**Lea's branches**, the ones the design turned on:

1. **Books through ClassPass**: a Lead at Trial booked, with her app noted on her
   profile. Needs attention: *trial pending*.
2. **Attends**: checking her in makes her an Active contact at Trial attended, in
   the class's attendance.
3. **Weeks pass**: before External, she showed *gone quiet* and *check-in lapsed*,
   a prospect the studio was failing to convert. Now the studio marks her External
   once. She is off the roster and still bookable.
4. From there, one of:
   - **Archived in a tidy-up**: not counted as a lost trial. Only people on the
     roster can be. (Before External, she was counted as one.)
   - **Back next year**: still External. Booking and attending move neither her
     lifecycle nor her journey. Before External, she was stuck at Trial attended
     for good: a booking never restamps a stage, and attending only advances from
     Trial booked.
   - **Buys a membership**: her plan becomes Active, and she stays External. The
     studio brings her back and marks her Joined, which counts as a conversion.
     Completing the signup form does both.
   - **A studio without a federation that tracks ClassPass as a partner plan**:
     the plan lets her in and earns the per-visit payout. She is counted under
     "Via a partner app", not as a subscriber. Before
     [#277](https://github.com/francodgstn/dgstn-linyup/pull/277), she read as a
     paying member in the studio's own numbers.

## Decisions, and the alternatives dropped

**The bucket is a lifecycle value, not a journey stage.** The first design added a
lateral journey stage (`casual`, then `visitor`) beside Trial attended. It would
have quieted the funnel, but the person would still have been lifecycle Active,
which means invited, swept and counted. Franco's requirement was "out of the active
basis", and only the lifecycle can say that. The journey version also cost more: it
split `ACQUISITION_STAGES` into a vocabulary and a ladder, and taught every reader
that ranks stages about a value beside the ladder. The lifecycle version left the
journey untouched.

**Not Provisional.** Reusing Lead/Provisional was the tempting shortcut. But a
provisional contact carries an expiry, is hard-deleted by the nightly purge (which
would destroy a real visitor's attendance), sits on the Leads tab as someone to
confirm, and is exempt from the contact cap. A new meaning under an old name is a
new value in disguise.

**Names, and why each loser lost.** Each candidate was checked against what the
word already means inside the product:

| Candidate | Why not |
|---|---|
| Guest | already a pricing persona ("a guest, a member, or a specific plan") and the "new guest form" on booking. French *Invité* collides with event invitations |
| Visitor | already means the anonymous person on the public pages, in shipped copy |
| Casual | a journey-stage candidate. Fine as a word, but it named a stage the design no longer has |
| Occasional | names frequency, which engagement already measures. It would wrongly exclude a weekly ClassPass regular and wrongly include a busy member |
| **External** ✓ | used only for things (external link, external body), never a person state. It is the word HMD clubs already use for these people. *Esterno · Extern · Externe* translate cleanly |

**Axis names for owners: Journey · Affiliation · Plan · Lifecycle.** The code
calls the first one acquisition, which is a marketing word. *Record* was too
generic to explain to coaches, and *Presence* was imprecise. *Lifecycle* tells a
coach the axis has a beginning and an end.

**Reduced data capture is the book form's job.** "Registering all the data for
someone I'll see once is wasted" is solved by the per-activity contact fields on
the book form (CLAUDE.md → "Book-form fields — a QUESTION is about the booking, a
FIELD is about the person"). It is not a lifecycle concern. A funnel position
should never gate a form.

**"Members" for the Active tab: parked.** With the tabs reading *Active · Leads ·
External · Archived*, "Active" means the roster by contrast. "Members" would
collide with the affiliation's "active members" for a federation studio, and read
as "has a plan" for a standalone one.

## Not built

- The reserved journey values `enquired`, `left` and `won_back`.
- Marking someone External automatically. The automation engine has no "came
  through a partner app" condition (`Contact.acquisition_partner_app` is recorded,
  but no rule reads it) and no "mark external" action. Marking is manual, by design
  for now: the partner app is a fact, while External is the studio's judgement.
- An owner-facing home for the interactive page. The two options discussed were
  the in-app How-to and a public docs site. `apps/docs` is internal and never
  deployed, so it isn't that home.

## Where it lives in code

- `packages/shared/src/utils/contactLifecycle.ts`: the lifecycle and its two predicates
- `packages/shared/src/types/contact.ts`: journey stages, entries, and the marker fields with their rules
- `packages/shared/src/utils/subscriptionSource.ts`: own vs partner plans
- `packages/shared/src/utils/heldPlans.ts`: the plans a contact holds
- `packages/shared/src/types/affiliation.ts`: affiliation statuses
- `packages/shared/src/utils/contactFilter.ts`: `contactAttentionReasons`, which returns nothing for an external
- `apps/web/src/lib/liveContacts.ts`: why `archived_at` / `deleted_at` are always present and `provisional` / `external` only when true
- `packages/functions/src/contacts/contactLifecycle.test.ts`: the census of server seams
- `scripts/migration/transforms/contacts.ts`: where HMD's `type: external` lands
