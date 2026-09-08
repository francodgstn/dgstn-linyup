# A coach's own contacts, beside the studio's — design

**Status: DECIDED, NOT BUILT (2026-09-08, Franco).** A coach who belongs to an
organisation and also works for themselves gets **a second studio**, not a
private partition inside the first. Recorded before implementation so the shape
is agreed rather than discovered halfway. Nothing below is built; the two seams
in "What we owe it later" are the roadmap, and one of the three defects in
"What is wrong today" exists whether or not any of it ships.

## The scenario

An HMD coach runs a studio inside the federation. The same person also does
personal training on their own account — their own clients, their own invoices,
their own tax return. Where do those clients live?

## The question is not "one studio or two"

It is **whose business the personal training is**, and there are three answers.
Only one of them is hard:

| | Who owns the client relationship | Shape |
|---|---|---|
| The club's business | HMD invoices, HMD's liability, the coach delivers | One studio. Already built. |
| The coach's business, entangled | The coach invoices, but same room, same people, adjacent brand | The hard case — this document |
| A separate business | Own name, own clients, own tax | Two studios. Never in doubt. |

The first case is finished work: `Activity.type: 'appointment'`, availability,
priced durations, and the **own-scoped coach** (`callerOwnsContact` /
`assigned_coach_ids`, `firestore.rules:272`) which already stops one coach
reading another's book inside a single studio. It deliberately does not stop the
studio owner or the org admin, because in that case they are entitled to it.

## The decision

**A second studio — a second `teamId` — outside the organisation.** The coach
sees both in the switcher (`TeamSwitcher.tsx:311`, which already offers "Create
studio") and switches between them; the two tenants share nothing but the
person.

Two arguments settle it, and neither is about preference.

**Money settles it harder than privacy.** One team is one Connect account is one
payout destination (`connect_accounts/{acct}.teamId`; CLAUDE.md: *one account
backs exactly one team*). Inside HMD's tenant, the coach's personal-training
revenue lands in **HMD's bank account**. That is not a privacy annoyance, it is
the club collecting income that is not theirs. Any "private book inside the
club" design has to invent a sub-merchant concept before it can even be honest
about where the money goes.

**Controllership is the second.** A self-employed coach's clients sit under a
different data controller from the club: their own privacy notice, their own
lawful basis for health data, their own subject-access obligations. Contacts in
a tenant an org admin can read are contacts the organisation is processing with
no basis to.

And worth stating plainly, because the product should not pretend otherwise:
**this is a conflict of interest, not only a data model.** If the coach leaves,
two tenants means the personal-training business is untouched; one tenant means
their clients are in the club's database. The club's interest and the coach's
point in opposite directions. The design's job is to make the choice explicit
and visible to both parties at the moment it is made — see the invitation defect
below.

## Why not the alternatives

**A private partition inside one studio** (`owner_uid` on contacts, narrowing
the org read) fails on the money above, and fails again on honesty: a "private"
flag inside a tenant that the studio owner, the org admin and the platform all
administer is a **policy, not a boundary**. It would claim a separation that does
not structurally exist. Narrowing `isOrgAdminOfTeam` is also not a local change —
it is an unconditioned read disjunct wherever a member studio's data is exposed
to its organisation in `firestore.rules` (grep it; contacts are one of several),
and the organisation's own roster figures read through it.

**A second studio that joins the organisation** ("the org sponsors its coaches'
personal studios") is the genuinely interesting variant and is **deferred, not
rejected**. It would fix the economics — org tier, 0.5% take rate, shared places
(`Place.scope: 'team' | 'org'` already exists), shared plugins — while keeping a
real tenant boundary. It needs an explicit, consented posture at link time,
because `org_id ⇒ plan 'organization'` (UX-35) means the organisation would be
paying for a studio it cannot read. Revisit it as an org-tier product feature; do
not arrive at it by accident, which today is exactly what could happen.

## What the market does

Nobody solves the middle case well, which is itself the finding.

- **Mindbody, Arketa, Glofox and the franchise platforms** run one shared client
  database with a home-location attribute and role-based access. That is the
  private-partition model, and it is viable there only because a franchise's
  locations are the same business with the same controller and the same
  merchant.
- **TeamUp** gives a customer one login across N businesses and a picker. That
  is this decision, on the member side — and Linyup already has it (below).
- **SportsEngine** models org > club > team and puts private lessons *inside*
  the club. They answer the first case and do not model this one.
- **General SaaS** — Stripe accounts under one login with an organisation for
  roll-up, Shopify stores plus a Plus organisation, Xero's N orgs — consistently
  puts a **person-level layer above tenants** and never a private compartment
  inside one. Google Workspace, Notion and Slack all give the owner reach;
  Slack's answer to "keep it separate" is a separate workspace.

## What already works, and costs nothing

Three of the four costs Franco named against this option are already paid:

- **Creating the second studio.** The switcher offers it today.
- **The member side is already cross-tenant.** `selectLoginCandidates`
  (`packages/functions/src/auth/loginCandidates.ts`) matches a verified email
  across *every* team when the code was not requested for one, and the member app
  has a contact switcher. A client who trains with both HMD and the coach gets a
  picker, not two apps and not two logins.
- **Splitting an existing book.** `moveContacts`
  (`packages/functions/src/contacts/index.ts`) moves contacts between two teams
  the caller manages.

What genuinely costs: a second plan, the worse take rate (1.5% coach vs 0.5%
organization, `CONNECT_TAKE_RATE`), a second Stripe onboarding, a second
configuration, and no roll-up. The first is a pricing answer, not an
architectural one. The last two are the seams below.

## The seam that already exists — and is the reason this is not free

**The coach is already a global identity; only the data is tenant-scoped.**
`providerId` on availability and sessions is a uid, and `assigned_coach_ids` is a
uid list. Every cross-tenant convenience worth building hangs off that one fact,
because it is the only identifier that legitimately crosses the boundary.

## What is wrong today

Three defects, all reachable now, all independent of whether the seams get
built. Each is stated with what was verified.

### The provider's calendar does not span their studios

`listAvailability`'s busy check is
`where('teamId','==',…).where('providerId','==',…)`
(`packages/functions/src/appointments/window.ts:318-335`). A client can book a
personal-training slot at 18:00 while the coach is teaching an HMD class at
18:00. This is a defect **the moment any coach owns a second studio**, whatever
is decided here.

Half of it is prevented by accident and the accident is worth knowing about: the
appointment session doc id is `apt_${providerId}_${start}` (`window.ts:594`) —
**no `teamId` in it**. So an identical start instant across two tenants already
collides and the overlap transaction refuses. That backstop only catches exact
matches (an 08:30–09:30 class and a 09:00 appointment collide in reality and not
in the id), and when it does fire it refuses a booking because of a session the
caller cannot see. Keep it as a backstop; do not mistake it for the fix.

### The organisation invitation does not say what the organisation will see

`acceptOrgInvitation` requires the **team owner** — which the coach is, for their
own studio — and the accept page (`app/[locale]/org-invite/[orgId]/[invId]`)
renders a **"Select your team" dropdown listing every studio they own**. The
`OrgInvite` copy in `messages/en.json` says only "You have been invited to join
your team to …". Nothing states that accepting hands the chosen studio's entire
contact book to the organisation's admins via `isOrgAdminOfTeam`, nor that it
moves that studio's billing.

So the exact outcome this design exists to prevent is **two clicks away, framed
as a free upgrade, with the wrong studio one line above the right one in a
select**. The neighbouring `OrgMemberInvite.scopeNote` already does the right
thing for the other invitation ("This invitation is for you personally. It does
not change anything about a studio you may run, and it does not affect
billing."); the studio invitation has no equivalent.

Fixing the copy is small and should not wait for anything else here.

### There is no way to tell the two studios apart at a glance

Switching scope is a click, and the org navigation work already established that
"which place am I standing in" is a constant question worth answering loudly
(`docs/org-navigation.md`). A coach alternating between the federation studio and
their own all day is the same problem with higher stakes — a contact created in
the wrong tenant is a data-protection error, not a nuisance. Whatever the
switcher does for organisations should reach personal studios too.

## What we owe it later

Two seams. They are **conveniences over a boundary that stays intact** — neither
may become a way to read another tenant's data.

### 1. A schedule controller across the studios a provider works in

Subtract the provider's busy time in their *other* teams when computing
availability. Design constraints, each of which is a way to get it wrong:

- **Subtract, never refuse.** The slot should not appear, rather than appearing
  and failing at booking with an error about a session the booker cannot see.
- **It is a side-channel, and must be designed as one.** A public visitor on the
  personal-training booking page would learn when the coach is busy at HMD — and
  in reverse, a private appointment would show as a hole in HMD's public
  availability that anyone can probe. The check therefore returns **busy or
  free and nothing else**: never the reason, never the other tenant's name,
  never a title. This is what a calendar free/busy API is, and for the same
  reason.
- **Opt-in per team, by the coach.** They are the only person who is a member of
  both tenants, so they are the only one who may consent to the leak. Off by
  default.
- **Server-side only.** The client has no rules path to another tenant's
  sessions and must not get one; the query belongs inside `listAvailability`
  over the Admin SDK, authorised from `team_members/{uid}` in each team.

### 2. A person-level dashboard across the studios someone owns

High-level figures from every team the signed-in **uid** owns, in one place.

- **It cannot be a client query.** Every read is pinned to
  `getUserCurrentTeam()` (`belongsToUserTeam`, `firestore.rules:254`), so a
  browser can only ever hold one tenant at a time. Two viable mechanisms: a
  callable that authorises per team over the Admin SDK, or a per-uid rollup
  document written by a scheduled function. `docs/org-navigation.md` already
  identifies the same missing machinery for organisations ("the home for them is
  a scheduled function writing an org rollup") — this is that, keyed by uid.
- **Scope it by ROLE, not by membership.** "Owned" is the right word and it must
  be enforced: a coach-role membership in HMD must not put HMD's revenue on a
  personal dashboard. Start at `owner` only; widen deliberately if ever.
- **It aggregates, it does not federate.** Figures, not records. The moment it
  lists contacts or bookings it has become a cross-tenant reader and the whole
  boundary is decorative.

### Nice, and clearly after those

Cloning settings from an existing studio at creation; a "this person is also a
contact at your other studio" hint shown **only** to someone who is a member of
both teams (which is the coach, so it discloses nothing they cannot already
see); second-studio pricing.

## Open points

- **Is the middle case real in the tenant base**, or are HMD's coaches all
  running the club's business? The seams are only worth their cost if it is
  real.
- **Second-studio pricing.** The one named cost with no architectural answer.
  A discount, a cheap enough coach tier, or the sponsored variant above.
- **Whether "the coach can leave with their clients" is advertised.** It is the
  most persuasive argument to a coach and the least welcome one to a federation
  buying seats for its studios. It is a positioning decision, not a technical
  one, and it should be made on purpose.
