---
title: Event programs
status: living
area: booking
order: 7
---
# Event programs

An event is not just a session with a different label — it **has a program**: a
multi-day, multi-track agenda of what happens, where, and with whom. A summer camp
runs five days with a kids stream and an adults stream; a seminar runs two rooms in
parallel; a competition has weigh-in, pools, finals, ceremony. None of that fits in
`Event.start`/`Event.end`.

## The model

| Where | What |
|---|---|
| `Event.program` | `EventProgramConfig` — the days and tracks, embedded on the event doc (they are few, like `Place.rooms`) |
| `events/{id}/program_items/{itemId}` | The agenda rows. A subcollection because a five-day multi-track camp runs to hundreds |
| `teams/{teamId}/program_templates/{id}` | Reusable programs owned by a studio |
| `organizations/{orgId}/org_program_templates/{id}` | Org-wide templates, read-only for member studios |
| `events/{id}/public_profile/{id}` | The world-readable mirror, with the whole program embedded |

Types: `packages/shared/src/types/event.ts`. Pure helpers:
`packages/shared/src/utils/programTime.ts`.

## Times are wall-clock, and that is deliberate

A program item stores `startTime: 'HH:MM'` plus its day's `date: 'YYYY-MM-DD'` —
**never an absolute `Timestamp`**.

A program is a printed schedule. "09:00 breakfast" is 09:00 wherever the camp is.
Storing instants would mean a camp in Spain renders an hour off for a Swiss studio,
and a DST boundary mid-camp would shift half the agenda. Wall-clock sidesteps both.
`EventProgramConfig.timezoneLabel` is **display only** — nothing converts.

Same convention as `availability.ts`. Day arithmetic (`addDaysISO`,
`daysBetweenISO`) is done on the calendar in UTC, never via a local `Date`, so
shifting a program across a DST boundary cannot collapse two days onto one.

`endTime` earlier than `startTime` means the item **crosses midnight** — valid, not
an error.

## Tracks and plenary items

`ProgramTrack` is a free-text parallel stream — "Kids", "Adults", "Mat A". An item
with `trackId: null` is **plenary**: it spans every track (lunch, the opening
briefing). With 0–1 tracks the timeline renders a plain agenda list; with 2+ it
renders a column per track. Removing a track does **not** delete its items — they
fall back to plenary, the non-destructive reading of "remove this lane". Removing a
**day** does delete its items, and is always confirmed.

## Free text, on purpose

`locationText` and `peopleText` are strings, not links to `Place`/`Activity`/
`team_members`. Events are frequently off-site and staffed by people who are not
team members, running activities that are not in the regular schedule. Adding
optional FKs later is purely additive — the free-text fields stay as the fallback,
exactly as `Session.location` does alongside `Session.placeId`.

## Templates use a relative `dayIndex`

`ProgramTemplateItem.dayIndex` is a 0-based offset, never a date — that is what
makes a template portable to any future event. `materialiseTemplate` turns it into
real dated days counted from a chosen start; `extractTemplate` is the inverse.
Track ids are **regenerated on every apply**, so two events never share track ids.

Applying a template **replaces** the program rather than merging — merging two
multi-track schedules has no sane automatic answer.

It is **not atomic**, and cannot be: replacing a program costs
`deletes + writes + 1` operations, which at the 300-item cap reaches 601 against
Firestore's 500-per-batch limit — a single batch does not merely lose elegance,
it fails outright. The writes are chunked instead, ordered so the old items go
first and the config last: an interruption leaves a program that is visibly
*missing* rows (fix it by applying again) rather than one showing two templates'
items merged, which would look correct and not be.

Templates are edited in **`ProgramTemplateEditor`**, reached from the settings
list, and can still be produced by **apply → adjust on a real event → save
back**. The editor was added because authoring was the case the event route
served badly: a studio writing its standard camp agenda before any camp exists
had to invent an event, build on it, save, and delete the event again. It also
holds the name and description, which is why there is no rename dialog.
A studio that applies an **org** template and saves it back produces its own
**team** template — the rules refuse a club write to the organization's copy.

### Starter library + cloning

A studio need not build the first program from a blank agenda. Two shortcuts
produce a full template without authoring one on an event first:

- **A built-in starter library** — `STARTER_PROGRAM_TEMPLATES`
  (`packages/shared/src/data/programTemplates.ts`), a handful of ready-made
  programs (half-day workshop, weekend seminar, five-day camp, one-day
  competition, grading day). Each entry **is** a `ProgramTemplate` body, so it
  flows through `materialiseTemplate` and the save hook **unchanged** — no
  special-casing in the engine. A starter can be **applied straight onto an
  event** (it appears in the Apply-template picker, badged *Starter*) or
  **added to the studio's own list** ("Add" in the settings manager, which just
  saves the body as a new team/org template).
- **Clone** — any template row (in the settings manager) clones into the
  current scope: an owned one becomes a `… (copy)`, and an **inherited org**
  template clones **down** into an editable **team** copy. Cloning is a plain
  create through the same save hook and counts against `MAX_PROGRAM_TEMPLATES`.

Starter *content* (day titles, item titles, `note`) is authoring-language free
text like every other program field — see the "Never translated" list in
`docs/site-translations.md`. The surrounding UI chrome is translated; the
library entries are seeded in the source language and renamed on clone. Their
well-formedness (valid times, tracks that exist, complete day coverage, clean
materialize + round-trip) is pinned by `STARTER_PROGRAM_TEMPLATES` tests in
`packages/functions/src/events/programTime.test.ts`.

## Org events

Org-scoped events (`scope: 'org'`, `teamId` null, `orgId` set) are first-class.
Two things make that work:

- **Every program item carries a denormalised tenant stamp** (`teamId`/`orgId`/
  `scope`). Rules authorize from the stamp, so an org event — which has no
  `teamId` — works by construction.
- `ProgramTab` is **tenant-agnostic**: it reads the tenant off the `Event`
  document, never from team context, so the team and org event pages mount the
  same component.

This change also fixed a pre-existing bug: the `categories` and `attendees`
subcollection rules gated only on `belongsToUserTeam(parent)`, which can never
pass for an org event. Org admins could not manage categories or read the roster.

### Rules contract

Create pays for one `get()` on the parent event to prove the stamp matches — the
denormalised stamp is only trustworthy downstream if it was validated once. Read,
update and delete then trust it, so the hot paths stay `get()`-free. The stamp is
**immutable on update**: an item cannot be re-pointed at another studio.

Without the create-time check, a manager of *any* team could inject rows into
another studio's event carrying their own `teamId` — each write passing a
capability check against a team they legitimately manage. The rules test suite
(`packages/functions/src/events/programRules.rules-test.ts`) caught exactly this
during development. Run it with:

```
pnpm --filter @linyup/functions test:rules   # needs the Firestore emulator
```

## Publishing

**Events are private by default.** `Event.publicVisibility` (`'hidden' | 'public'`)
gates `syncEventPublicProfile`; flipping it off deletes the mirror, so the public
page 404s immediately. No existing event became public as a result of this feature.

The mirror is an **aggregate** one (like `syncPrimaryPlaceToPublicProfile`): the
whole program is embedded into the single mirror doc, so a public page is one
document read. It therefore reacts to writes on the event **and** on
`program_items` — otherwise a published agenda would silently go stale.

`internalNote` is **never mirrored**. The projection is an explicit whitelist, so a
future private field is not published by default.
`MAX_PROGRAM_ITEMS` (300) caps the embedded list so the mirror cannot approach
Firestore's 1 MB document limit.

### Public surfaces

Events are a registered `PublicSurface`: they appear in `PUBLIC_SURFACES`, can be
a bio-link page link (`SystemLinkTarget`), and have a row in the studio's
`/public-page` hub. `active_public_surfaces.events` is computed by probing the
**mirrors**, not the root collection — the same rule `documents` follows, so the
flag agrees with what a visitor would actually see. Only the team's OWN events
count: a studio whose published events are all inherited from its org still lists
them at `/public/{slug}/events`, but does not advertise the surface as a landing.

URLs come from `publicRoutes.ts` (`publicPath` / `publicSubHref`), never
hand-built, so `packages/functions` can emit the same links in email.

| Route | Shows |
|---|---|
| `/public/{slug}/events` | A studio's published events **plus its parent org's** |
| `/public/{slug}/events/{eventId}` | Event + program, as the handout |
| `/public/{slug}/events/{eventId}/print` | The printable handout |
| `/public/org/{slug}/events` | An organization's own published events |
| `/public/org/{slug}/events/{eventId}` | The same, under the organization |
| `/public/org/{slug}/events/{eventId}/print` | The organization's printable handout |

Staff print from the Program tab (**Print / PDF**), at `/events/{id}/print` or
`/org/{orgId}/events/{id}/print`. Those read the event's own documents rather
than the mirror, so they work for an unpublished event, and can include the
internal notes (off by default) for a coaches' copy.

The public list queries order by `start`. That is what makes them match the
`public_profile (type, teamId|orgId, start)` composite indexes; unordered, the
`orgId` query needed a collection-group index that does not exist, failed in
every deployed project, and was rendered as "no events" — so no published org
event appeared anywhere. The emulator does not enforce indexes, so it never
showed locally.

An org event has no `teamId`, so a studio's page runs **two queries and merges**
(own `teamId` + parent `orgId`) — mirroring what `useAllEvents` already does in the
admin calendar. `Team.org_id` is denormalised onto the team public profile so a
public surface can tell which org a studio belongs to. For a federation this is the
point: publish one event with one program, and it appears on the federation's
page *and* on every member club's page.

### Two renderers: the working view and the handout

`ProgramTimeline` is the **working** view — cards, colored track bars, edit
affordances — for the people building the agenda in the Program tab.
`ProgramSheet` is the **handout**: black on white, a time column and a rule
under each day, parallel tracks as table columns (a plenary item runs across
them), and nothing that needs a mouse. Every surface a member reads — the public
event page, the print pages, the Space links into them — renders the handout,
and so does the tab's Preview, so staff see what members will. It stays paper
in dark mode on purpose: a handout that inverts stops looking like what the
printer will produce. On a phone a multi-track day collapses to one agenda with
the track named on each row; on paper it is always the column table.

Printing is `@media print` CSS (`apps/web/src/app/globals.css`) plus
`window.print()`, not jsPDF — hand-laying a multi-day multi-track grid in jsPDF is
far more work for a worse result. The **PDF is the browser's "Save as PDF"**
destination; the button says "Print / PDF" and the page says how, and the tab
title (the event name) becomes the file name.

## Publishing an org event, and inviting to it

An org event is published from **the org event page** (Overview → the public
switch), which only org admins can flip — the rules refuse a studio manager's
write, so the studio page shows the switch read-only for an org event. Once
published it is on the organization's public events page and on every member
studio's.

Invitations go out **per studio**: `sendEventInvitations` emails the roster of
ONE studio, and a member studio invites its own members from the org event in
its own calendar (the callable takes `teamId` only for an org event). Who may
send is decided purely in `packages/functions/src/events/invitationAuthorization.ts`
— the requested studio must be linked to the event's organization, and the
caller must hold `events.manage` in it. An org admin cannot email a member
studio's contacts. Each invitation row is stamped with the studio it was sent
for; the rules let a studio read only its own rows (its list filters on
`teamId`), and the org's admins read them all.

Opening an org event from the org's own calendar or timeline goes to the org
event page (`EventPeekSheet`'s `eventHref`). It used to go to the studio page,
where "Send invitations" failed with "Event has no team".

## Duplicating an event

`duplicateEvent` (callable, `packages/functions/src/events/duplicateEvent.ts`)
copies an event's **setup** and never its **participants**.

| Copied | Reset |
|---|---|
| Settings, place, coach, fee, description | `attendees`, `invitations`, `checkins` |
| `categories` (per-event setup, not participant data) | every counter → 0 |
| The whole program, days shifted to the new start | `publicVisibility` → **`'hidden'`** |

Fields are dropped by **deny-list**, so a future setup field is inherited by
default — the safe direction. Days shift by whole **calendar** days, not by the
millisecond delta, so a camp moved across a DST boundary keeps its shape. Forcing
the copy to `'hidden'` matters: inheriting "published" would silently expose a
draft event the moment it is created.

## Deliberately not done

Per-item booking or capacity · FK links to Places/Activities/Coaches ·
org-wide invitations from the org page (each studio invites its own) ·
drag-and-drop reordering (times drive the order; `order` is only a tie-break) ·
attendee-personalized programs in Space (the `attendees` subcollection is not
readable by a contact session, so it needs a callable) · bulk time-shift ·
per-item media · duplicating across teams ·
unifying the team and org event detail pages (only the tab strip was added) ·
letting org events use plugin/custom event types.
