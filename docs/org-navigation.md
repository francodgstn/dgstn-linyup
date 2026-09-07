# Organisation navigation — design

**Status: BUILT 2026-08-27.** Decisions taken 2026-08-25 (Franco); the chord and
the four-rows-plus-rail split confirmed 2026-08-27. Recorded before
implementation so the shape was agreed rather than discovered halfway — this
document is now the reasoning behind the code rather than a proposal.

**The chord is `Alt+O`.** `!e.ctrlKey` is load-bearing: AltGr reports as
ctrlKey + altKey on the layouts this product is built for.

**What the implementation added that the design did not anticipate:**

- **Ten org pages had no `<h1>` of their own** — the deleted tab strip was their
  only title. The layout supplies the destination heading; the two pages that
  always had one say so in the catalogue (`ownsHeader`) rather than being
  remembered.
- **The rail needed a front door, and `/org/{id}/manage` is it.** The rail
  rendered only on rail ROUTES, so from Studios or Events there was no rail and
  no link to the seven destinations behind it — eleven tabs became four rows and
  seven things that had apparently vanished ("where did all the tabs go?",
  Franco, 2026-08-27). A studio never had this problem because `/settings` is a
  real place you can go to and the rail comes with it. `manage` is a fifth
  sidebar row, and it is also what makes the rail work on a phone, where a rail
  is an INDEX and an index needs a route to be the index of.
- ~~**The mobile rail is a disclosure, not an index page.**~~ Superseded by the
  above; the disclosure existed only because that route did not exist yet.
- **(original note) The mobile rail is a disclosure, not an index page.** The studio rail can be
  an index because `/settings` is a real route that lists it. The organisation
  has no equivalent — `/org/{id}` redirects straight to the studios list — and
  inventing one would put a second "organisation home" in the reader's head for
  a scope that already has one.
- **`NavRail` was extracted** so both rails are one markup. It resolves nothing:
  labels, gates, the active rule and the pin all differ between the two, and the
  studio's pin store is keyed per studio so it has no meaning on an org row.

**Revised 2026-08-27, after Franco used it:**

- **The switcher moved to the sidebar HEADER**, replacing the studio name, and
  the separate amber indicator band is gone — its accent moved onto the trigger.
  This reverses the 2026-08-24 decision that the header row was "orientation,
  not a control". That reasoning was about reaching a second STUDIO, a rare
  account action; the scope model made "which place am I standing in" a constant
  question, and answering it at one end of the sidebar while changing it at the
  other was the split. The trigger opens a menu and does NOT navigate — as a
  link it was the topmost control in an org sidebar quietly leaving the org.
- **The header row now survives collapse.** It was `!collapsed`-only, so the
  icon rail said nothing about scope at all. That was a gap, not a decision.
- **The whole sidebar follows the scope, not just the middle.** Three things sat
  outside the gated block and stayed studio-scoped: the "⋯" menu's destinations
  (`/settings` and `/settings/plugins` — so from an org, both landed in the
  studio's), the pinned head-pair tiles (two studio destinations ABOVE the org's
  own rows), and the quick-search catalogue, which indexed destinations whose
  rows were not even on screen.
- **The QR is hidden in org scope, not repointed** — it reads a studio's public
  profile and an org has no equivalent document, so a repointed QR would be some
  arbitrary studio's.

**Revised 2026-09-07 — the scope gained a front door:**

- **`/org/{id}/dashboard` is home, and `orgLandingPath` sends an organiser
  there.** The landing was the roster, for the honest reason that nothing better
  existed: `/org/{id}/teams` was the only page ABOUT the organisation as a whole,
  and a roster answers "who is in it", never "how is it doing". Every scope in
  this product now opens on the thing that summarises it.
- **It is not the studio dashboard with a wider `where` clause**, and the reason
  is structural rather than aesthetic. A studio's dashboard is a DAY — agenda,
  queue, trends — and an organisation has no day: it runs no sessions and takes
  no bookings, its studios do. What it has is scale, composition and a queue of
  invitations, so the figures LEAD at full width (a studio's sit in a 2×2 rail
  beside the agenda) and exactly one block wears the accent frame, because a
  federation has one subject where a studio's morning has two. Same building
  blocks — `Figure`, `Panel`, `Card` — a different sentence.
- **Nothing was relaxed to build it.** Every read was already permitted; the
  page's own constraint is that a denial renders as `—` and never as `0`. See
  the module header of `apps/web/src/components/org-dashboard/data.ts` for who
  may ask what, including why the people figures are org-ADMIN only and why the
  roster reads studio names from the world-readable `public_profile` rather than
  from `teams/{id}`, which an org admin cannot read.
- **A member studio still lands on `/overview`**, which is their summary; the
  dashboard route renders a signpost for one rather than four dashes.

**Still open after the build:** `useAffiliationTerm` resolves the CURRENT TEAM's
org rather than the route's — so on an `/org/{X}` route where X is not the current
team's org, the studio sidebar's affiliation word is the wrong org's. Both are
recorded in `docs/open-defects.md`.

**Still missing from the dashboard, and named rather than faked:** sessions,
bookings, attendance and money across the federation. All of those are
studio-scoped, no org rollup document exists, and computing one in the browser
across sixteen tenants is the fan-out that page deliberately refuses. The home
for them is a scheduled function writing an org rollup.

---

## What is wrong today

`app/[locale]/(auth)/org/[orgId]/layout.tsx` renders **eleven** destinations in
one horizontal strip:

```tsx
<nav className="flex gap-0.5 border-b">
```

No `flex-wrap`, no `overflow-x-auto`. Eleven icon+label tabs run to roughly
1100–1400px; a 1280 viewport minus the sidebar leaves about 1000. So it overflows
on an ordinary laptop and is unusable on a phone — in an app whose own porting
guidance is mobile-first.

The overflow is the visible failure. The structural one is that this is a **third
navigation paradigm**. The app already has two, both considered:

- **Sidebar sections** (`NAV_SECTIONS`: Run / Offer / Grow) for the surfaces a
  studio opens during a working day, ordered by frequency of use rather than
  alphabetically — see the long note above `NAV_SECTIONS`.
- **The settings rail** (`components/settings/SettingsRail.tsx`) for many related
  configuration destinations: grouped, searchable, a rail beside the detail pane
  on desktop and the index list itself on mobile.

The org area used neither. And its eleven tabs — Studios, Events, Program
templates, Affiliations, Ranking, Places, Website, Plugins, Members, Billing,
Settings — are not a feature area. That is an entire application's navigation
compressed into a tab strip.

## The decisions

**1. An organisation is a SCOPE you switch into, not a section beside the team.**

Nearly every org concept collides by name with a team one: Events, Places,
Website, Plugins, Members and Settings all exist at both levels. Two sidebar rows
called "Events" never stop being ambiguous, whatever they are labelled; one
unmistakable scope indicator resolves it once.

The cost is a click when moving between HMD and Basel — which the org admin who
also runs a studio will do often — so the switcher must be fast and the current
scope must be impossible to mistake.

**2. The org gets the same SHAPE a team has: a few sidebar rows, and a settings
rail for everything configurational.**

Most of those eleven destinations are opened occasionally, not during a working
day. Treating "today's events" and "billing" as equals in one flat list is what
made the strip eleven long in the first place.

## The information architecture

**Org sidebar rows** — opened while doing the organisation's work:

(The table below is the ORIGINAL design. The rows and the rail have both moved
since — Affiliations and Places came out of the rail, the rail's three groups
collapsed to one, and Dashboard was added as home. `lib/org-nav.ts` is the
catalogue and the only authority; the revision notes above say why each change
happened.)

| Row | Today |
|---|---|
| Dashboard | `/org/{id}/dashboard` — **added 2026-09-07**, and the scope's landing page |
| Studios | `/org/{id}/teams` — rename to match the product's own vocabulary (`plan: 'studio'`, "studio" throughout CLAUDE.md) |
| Events | `/org/{id}/events` |
| Program templates | `/org/{id}/program-templates` — sits by Events because it is read while creating one |
| Website | `/org/{id}/website` — authoring, exactly as the team's website is a sidebar row |

**Org settings rail** — grouped, reusing `SettingsRail`'s pattern:

| Group | Items |
|---|---|
| Standards the org sets | Ranking systems, Affiliations |
| Shared resources | Places |
| Administration | Members, Plugins, Billing, Settings |

The grouping is not cosmetic: the first group is what an organisation imposes on
its member studios (and is exactly what `Organization.ranking_systems` and the
org affiliation types already override downward), the second is what it lends
them, the third is about the organisation itself.

## What this reuses

The point of the design is that almost nothing is new:

- the sidebar shell, its section rendering, collapse mode, and mobile drawer;
- `SettingsRail`'s grouping, search, pin affordance and mobile-as-index
  behaviour;
- `TeamSwitcher` (inside `UserMenu`) becomes the scope switcher — it already
  lists the studios a user belongs to, and `useOrgLinks` already supplies the
  organisations that today render as the sidebar's "Organizations" group;
- every existing `/org/{orgId}/*` route, unchanged, so there is no redirect map
  and no link rot.

What is deleted: the eleven-tab strip and the "← Back to dashboard" link, which
frames the org as a modal detour rather than a place you work.

## Switching back — the two-scope toggle

The one real cost of making the org a scope is the click to get back, and an org
admin who also runs a studio pays it all day. So the switcher gets an **alt-tab
affordance: one control, and one shortcut, that flips to the scope you were just
in** (Franco, 2026-08-25).

**It toggles between TWO; it does not cycle N.** What makes alt-tab worth having
is the instant flip between the last two things — the part everyone finds fiddly
is holding a modifier to rotate through a list. With three or more scopes the
switcher menu is already the better tool, so this control always means "back to
the previous one" and never "next in some order".

**~~A button, not only a shortcut.~~ REVERSED 2026-08-27.** The original
argument stands on its own terms — a bare chord is undiscoverable, and the
Ctrl+K note in `(auth)/layout.tsx` makes the same point about search losing
discoverability behind an icon — but it lost to the row it had to live on. The
scope identity is what that row exists to say, and a button naming the *other*
scope competed with it for the same few pixels; the switcher, one click away,
already reaches every scope including the previous one.

So **Alt+O is a chord with no visible affordance**. That is a real cost, not a
free simplification: until the planned shortcuts list advertises it, nobody will
find it who was not told. Accepted knowingly (Franco), and stated in
`ScopeFlip.tsx` so the next reader inherits the trade rather than the
conclusion.

**Write the chord as a Ctrl chord** (Franco, 2026-08-27). The design is
Windows-first: the primary keyboards here are Swiss, German and French, and the
reference machine is Windows. So the chord is chosen to survive *those*
constraints, and the hint is rendered through the **existing `modKeyLabel()`
helper** in `(auth)/layout.tsx` — the same one the search hint uses, which
prints `Ctrl+` and adapts on its own for anyone who opens the app on a Mac. The
handler accepts either modifier, exactly as the Ctrl+K handler already does.
Nothing here is authored as a Mac chord. (The Windows key itself is not
available: the OS claims it, and a web page never receives it.)

**Not Ctrl+Shift+O.** An earlier draft suggested it. It is taken: Ctrl+Shift+O
opens the bookmark manager in Chrome and Edge and the Library in Firefox, on the
very platform this design is written for. Most of the Ctrl+Shift+letter space is
similarly spoken for — DevTools, private window, reopen-closed-tab, hard reload —
and a few of those the browser will not surrender to `preventDefault()` at all.

**Two chords survive, and the pick is a judgement call.** Both are free in
Chrome, Edge and Firefox on Windows, and both are letters, which matters:

| Chord | For | Against |
|---|---|---|
| **`Alt+O`** *(recommended)* | Follows the app's own precedent — `layout.tsx:2195` already reaches for Alt in exactly this situation, with the note "Alt rather than ⌘/Ctrl: ⌘S is Save in every browser". One modifier is a faster flip, which is the whole reason this control exists. | Alt alone reveals the menu bar in Firefox, so the keypress has to be consumed cleanly. |
| **`Ctrl+Shift+L`** | Stays the same shape as Ctrl+K, so the app's two shortcuts read as a family. | Three keys for a control whose entire justification is speed. |

**Not `Alt+S`**, which would have been the obvious pick: the search panel
already binds it (`layout.tsx:2195`, "always show this destination"). It is the
only `altKey` binding in `apps/web` today — the other two hits guard *against*
Alt rather than claiming it — so `Alt+O` is unclaimed.

**One guard is not optional on this audience's keyboards.** On Swiss, German and
French layouts `AltGr` produces `@`, `#`, `~` and `|`, and the browser reports
`AltGr` as **`ctrlKey` and `altKey` together**. An `e.altKey` handler with no
further condition therefore fires while somebody is typing an email address. The
handler must require `e.altKey && !e.ctrlKey`.

`Alt+Tab` itself belongs to the OS and was never available. The backtick idiom
(``Ctrl+` ``) is out for a harder reason than collision: backtick is a **dead
key** on those same three layouts, so it is precisely wrong here. Letters
survive every layout.

Three details decide whether it feels right:

- **Remember the previous scope per viewer**, so the toggle survives a reload.
  It is a per-viewer convenience that nothing else depends on, so browser storage
  is the right home and an empty read is a normal state, not an error.
- **No previous scope, no control.** In a first session the button is absent
  rather than present-and-guessing; a toggle that lands somewhere arbitrary is
  worse than no toggle at all.
- **A remembered scope can stop being reachable** — the studio was left, the org
  membership revoked. Resolve it against the scopes the user currently has and
  drop it silently, rather than navigating them into a permission error.

## Risks and open points

- **Scope ambiguity is the whole risk.** The indicator has to be persistent and
  visually distinct, not just the org's name where the studio's name used to be.
  Worth a different accent, not only different text.
- **`OrgProvider` currently wraps only the org layout.** A scope that owns the
  sidebar needs org context resolved higher up, or the sidebar cannot render org
  rows before the org route mounts.
- **Deep links across scopes must switch scope, not merely navigate.** There is
  already one such link, and it is already broken: `settings/team/page.tsx` sends
  an org-managed studio to `/org/{orgId}/settings` for ranking, which has no
  ranking UI (the editor is `/org/{orgId}/ranking`). Under this design that link
  should switch scope and land on the rail's Ranking item. See "The org-managed
  ranking banner links to a page with no ranking UI" in `docs/open-defects.md`.
- **Nav search does not index org destinations.** The sidebar search groups
  pages and settings; org pages should join it once they are real nav items,
  otherwise the switcher becomes the only way in.
- **Multiple organisations** are allowed by the model though HMD is the only one
  today. The switcher handles this by construction; the sidebar-section
  alternative would not have.
- **Mobile.** The rail already knows how to be an index on small screens. The org
  sidebar rows inherit the existing drawer. Neither needs new mobile design —
  which is most of the argument for reusing both patterns.
