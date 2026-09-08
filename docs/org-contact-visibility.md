# What an organisation may see of a member studio's people — design

**Status: BUILT 2026-09-08** (Franco). A studio inside an organisation keeps its
own contacts to itself. The federation sees a person only once that person is on
its books — and "on its books" means holding an affiliation the organisation
issued, in **any** status.

Split out of `docs/studio-independent-contacts.md`, which asked when a coach
needs a second studio. This is the larger and more common question that came out
of it, and the answer is not a second studio at all.

## The case

> "In HMD Basel I have a few contacts coming into the club spot, maybe doing
> personalised activities, and contacts coming from fitness apps. In the old
> lineup those were marked 'guest' so they would not count in the total. The
> amount and frequency is not enough to justify a dedicated studio, and I do
> offer the activities under my club, but outside the HMD org — unless they take
> up more consistent participation or join HMD events." (Franco, 2026-09-08)

## The axis this separates

The product had been treating one question as two halves of the same thing. They
are orthogonal:

| Question | Answered by |
|---|---|
| **Whose business is this?** | the tenant — `teamId` |
| **Whose member are they?** | the affiliation row |

A contact can be the studio's business and not the organisation's member, and
that is the ordinary case, not an edge one. It needs **no second tenant** — which
is what `docs/studio-independent-contacts.md` would have implied if the two axes
stayed fused. That document answers a different case: the coach whose personal
training has its own money and its own data controller. Here the studio is both.

## 'Guest' is not a status any more, it is the absence of a row

The old product expressed non-membership with a `guest` MEMBERSHIP STATUS: a
person on the federation's roster, flagged as not counting. Affiliations replaced
that model — belonging is a ROW, so "not affiliated" is the absence of one and
needs no status to say it.

**So the affiliation row IS the disclosure.** Creating one — in any status,
`guest` and `requested` included — is the studio's act of putting this person on
the organisation's books. Delete it and they go back to invisible:
`onAffiliationWrite` recomputes the summary from the rows that remain, so this
reverses rather than merely stopping.

**The `guest` status is gone** (2026-09-08, second pass). It shipped described
as "No affiliation process started", which under this model is a trap: no process
started is expressed by having no row, so *creating* a `guest` row is the
opposite of what the description says — it is the disclosure. A manager picking
it to mean "not the federation's business" achieved precisely the thing they were
avoiding.

What made it removable rather than merely wrong is that **nothing had ever
written one**. Every writer already treated it as "no row": the HMD import
(`transforms/contacts.ts`, `isAffiliationStatus`) and all three seeders. A search
for a stored `status_id: 'guest'` returns nothing. It survived only as a status
DEF in the vocabulary and as a `?? 'guest'` fallback in the two rosters — a
value nobody stored, that anybody could select.

Removed from the canonical list and from both mirrors that cannot import it
(`scripts/lib/affiliations.ts`, `scripts/migration/passes/00-setup.ts` — the HMD
import was seeding it into the one org with real data). The three are held
together by `packages/functions/src/affiliations/statusVocabulary.test.ts`, which
re-derives the mirrors from source.

**`transforms/contacts.ts` still tests for `'guest'`, and must.** That reads
HMD's SOURCE data, where `org_membership_status: 'guest'` is a real stored value
meaning "on the roster, not a member" — the old model the import exists to
translate out of. Dropping the test would turn every one of those into an
affiliation row, which is the exact disclosure this design withholds. The
seeders' `status: 'guest'` fixture label is the same kind of thing: an input
meaning "give this persona no affiliation".

No backfill: there is no production data, and an org that auto-initialised its
vocabulary keeps a `guest` doc that nothing can now select into existence.

### Removal is an action, not a status

Removing `guest` needed something to take its place, because **neither roster
could un-affiliate anybody**. The status selector only ever called
`upsertAffiliation`; `removeAffiliation` existed but was wired solely to the
contact detail page. So the disclosure was one click to make and unreachable to
undo from the screen where people work.

`components/affiliations/remove.tsx` is now that action, on both rosters, behind
a confirmation — and deliberately **not** an entry in the status dropdown:

- **`expired` and deleted are different acts.** Expired keeps the record that
  this person WAS a member, which is what a federation needs when they come back
  or ask for proof. Deleting throws it away, and is right only when the row
  should not have existed. One dropdown holding both would put an irreversible
  act one mis-click from a routine one. The dialog says which is which.
- **It has to be a delete, not a flag.** The row IS the disclosure, so hiding
  someone again means the row goes. `onAffiliationWrite` recomputes the summary
  from what remains, so the contact drops out of `org_ids` and the rule stops
  admitting the org on the next evaluation.

The rosters' `?? 'guest'` fallbacks became a `NO_AFFILIATION` sentinel that is
never a `status_id` and never selectable, plus a "Not affiliated" filter pill
that does what the `Guest` pill used to. An unknown status id now renders `—`
rather than being silently relabelled.

## What changed

### 1. The rule — `orgAdminMayReadContact`

The contact read admitted `isOrgAdminOfTeam(resource.data.teamId)`: an
unconditioned grant over every contact of every member studio. Belonging to a
federation meant handing it your address book.

It now additionally requires the team's organisation to appear in the contact's
`affiliation_summary.org_ids`.

**`org_ids`, not `active_org_ids`.** An expired, revoked or merely requested
licence still means the organisation knows this person, and renewing or
reviewing them is exactly what an administrator opens the roster to do.
`active_org_ids` answers "is it valid now", which is a FIGURE and not a
permission; narrowing to it would hide the very people the federation needs to
chase.

**It costs what it replaced.** The team's `org_id`, then the caller's
`org_members` row — the array test is a field already on the document,
denormalised by `onAffiliationWrite` for exactly this (its `AffiliationSummary`
comment names Firestore rules as a reader). No backfill: `org_ids` is
non-optional and has been written since the summary existed, unlike its
`active_` sibling. A contact with no summary at all reads as `[]` and is
therefore HIDDEN — the safe direction.

**The read now agrees with the write, which it never did.** `upsertAffiliation`
opens with `assertManager(uid, teamId)` on the STUDIO, so an org admin who is not
also a manager there has never been able to create a contact's first affiliation.
The permission to *see* every contact was always wider than the permission to
*do* anything with them.

**It names `active_org_ids` too, and that arm grants nothing.** It is the `active`
subset of the rows that build `org_ids`, so it admits no contact the first arm
does not. It is there because Firestore checks a QUERY against the rule
**statically** — an aggregation has no documents to evaluate one at a time — so a
count constrained on `active_org_ids` cannot be proved to satisfy a rule naming
only `org_ids`. Without it the dashboard's affiliation figure was
`permission-denied` for every studio the caller was not personally a member of.
One `array-contains` per query is a hard Firestore limit, so the query cannot
carry both clauses instead.

That defect shipped in the first pass and **every single-document test passed**.
It took opening the page. The suite now exercises the query shapes the product
actually issues — both counts, the roster list, and the unfiltered list that must
be refused — and the numerator case was verified to fail against the old rule
before being kept.

Held by `packages/functions/src/orgs/orgContactVisibility.rules-test.ts`, whose
last case is the one that matters most: the studio still reads every one of its
own. Nothing here narrows what a tenant sees of itself.

### 2. The federation's headcount is gone

The org dashboard counted every live contact of every member studio and called it
`people`. Two things were wrong with it and they pointed in opposite directions:
it made the organisation look bigger than it is, and it scored a studio DOWN on
"coverage" for serving anyone outside the federation. The second is a perverse
incentive — it rewards a studio for not taking on the very clients this design
exists to protect.

`onBooks` (`org_ids`, any status) replaces it as both the figure and the
denominator; `affiliated` (`active_org_ids`) stays as the numerator. The ratio
therefore now reads **renewal health** — how many of our members are current —
rather than **market penetration** — what share of these studios' customers are
ours, which is a question the member studios never agreed to answer.

The figure can never describe more people than the page could name, because it
counts exactly the set the rules let an admin read.

### 3. The org's Affiliations roster is filtered

It downloaded every live contact of every member studio with no affiliation
filter at all, and rendered anyone without a row as status `guest` — the old
model, alive in the UI. It now asks for `org_ids` array-contains the org. Under
the new rule this is not a courtesy: without it the query is denied document by
document.

### 4. The studio is told what the organisation cannot see

A guarantee nobody can observe is worth very little, so the studio's Affiliations
page states the number: *"N contacts are yours alone. {org} cannot see them. Add
a {term} when someone should be on its records."* Computed in memory from
contacts the page already holds — no query, no permission, no field.

**Neutral, never a warning.** Having unaffiliated contacts is the normal,
supported state and the entire reason the boundary exists. Styling it as a
problem would push managers to affiliate people who should not be, which is the
outcome the design is there to prevent. It reports, and names the action without
demanding it.

It counts `org_ids`, not `has_active` — the filter chips above it already answer
"is their affiliation current", and this is the different question of whether the
organisation knows the person at all. A lapsed member is inactive but very much
on the books, and counting them here would tell a manager the federation cannot
see somebody it can.

## What the organisation gives up, knowingly

**It can no longer state its own reach.** "How many people are in our member
studios" is a real federation question — insurance, grant applications, reporting
to a national body — and there is now no number in the product that answers it.
That is the deliberate trade: the federation's size is the people who joined it,
not the customers of the clubs that joined it.

If it turns out to matter, the clean answer is a studio OPTING IN to publish a
headcount — a number, never people. Not built; do not add it by widening a read.

## What was already right and is untouched

- **The affiliations collection group** already scoped the org to rows it issued
  (`isOrgAdminOfOrg(resource.data.get('org_id', null))`) — never a studio's
  internal club membership (`issuer: 'team'`), never a governing body it merely
  tracks (`issuer: 'external'`). That boundary was correct before this change;
  only the contact document was not.
- **Contact subcollections** (notes, goals, subscription history) gate on
  `canAccessContact`, which has no org branch at all. The federation never saw
  them.
- **Org event check-ins and program items** still name participants. That is not
  a hole: attending the organisation's event is itself a disclosure, and it is
  the second of the two triggers Franco named — "more consistent participation
  and/or join HMD events".
- **The status strip** counts affiliation DOCUMENTS through the collection group,
  which was already scoped by issuer. Unchanged.

## Deploy notes

- `firestore.index.json` gains one composite index —
  `teamId, deleted_at, archived_at, affiliation_summary.org_ids CONTAINS` —
  mirroring the `active_org_ids` one. Additive; deploy it before the web app or
  both new queries fail on a missing index.
- **No backfill.** `org_ids` is non-optional and has always been written. The
  `active_org_ids` backfill (`pnpm backfill:affiliation-active-orgs`) remains a
  precondition for the numerator, as it already was.
- Rules and app should ship together. Rules first is safe (the org roster shows
  fewer people than it could); app first is also safe (the queries simply return
  what the old rule already allowed). Neither order breaks a studio.

## Open

### The dashboard status strip is denied, and it needs a decision

**Found merging `main` on 2026-09-08, and it is the one thing here that is
currently WRONG rather than merely unbuilt.**

`#249` moved the org dashboard's per-status counts off the affiliations
collection group and onto the CONTACT, filtering
`affiliation_summary.org_status_ids` with an `org:status` key — so that the
counts compose with `archived_at` and stop counting people who had left.
`orgAdminMayReadContact` admits a contact by `org_ids` / `active_org_ids`.

Firestore matches a query against a rule **by value**: the rule's expression is
evaluated and compared to the query's filter. A query for `fed:active` is
provable only by a rule naming `fed:active`, and the status half is
tenant-configurable — so it cannot be enumerated in a rule, and the query cannot
carry a second `array-contains` to prove the first (one per query, hard limit).

Every document that query would return is one the organisation may read. Only
the proof is missing. So the counts come back `permission-denied` and the strip
renders `—` on every studio the caller is not personally a member of. Visible
and safe rather than silently wrong, but wrong.

Two ways out, each losing something real:

- **Move the strip back to the affiliations collection group**, where
  `isOrgAdminOfOrg(org_id)` already proves it. This gives up `#249`'s
  correctness unless a contact-write trigger propagates `archived_at` onto each
  affiliation row — new machinery plus a backfill.
- **Widen the rule back toward the team.** Cheapest, and it gives up the
  boundary this whole document exists to draw. Not recommended.

Pinned by the one skipped case in
`packages/functions/src/orgs/orgContactVisibility.rules-test.ts`, which is the
assertion that says which option landed. Un-skip it when one does.

### Smaller

- **A studio's own opt-in headcount**, if a federation ever needs its reach back.
- **Aggregate inference**: an org admin can see a studio's on-books count but not
  its total, so it cannot compute what it is not being shown. Deliberate, and
  worth not eroding.
