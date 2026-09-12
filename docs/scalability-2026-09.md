# Scalability — September 2026

**The thing that does not scale here is not the database. It is the number of
surfaces.**

Linyup ships the same product through four front ends — the admin web app, the
public Space, the member mobile app, and the operator console — plus one backend.
Every member-facing feature is therefore written between two and four times, and
the cost is not the typing. It is that the copies **drift**, and drift in this
codebase has already destroyed member data.

This document has three parts. **Part 1** (§1–§7) records what the coaching
build (August–September 2026) taught about that, what has since been fixed, and
what is still owed — engineering scale, not tenant count. **Part 2** (§8–§14) is
the runtime side: the scheduled jobs, the ledgers, the cost model and the limits
that bind first as the tenant count grows. It was the first analysis of this
pass and was left out when the file was first assembled; it is restored below
with what has since been done against it. **Part 3** (§15–§19) is the UI: a
census of every list the apps load, what each one grows with, which ones will
slow a real studio down, and what to do about each — including the ones that
cannot be fixed cheaply, so the expectation is set before a customer sets it.

---

## 1. The evidence: what divergence actually cost

One feature — coaching goals — was built across five lanes. Everything below was
found while building or reviewing it, and none of it was hypothetical:

- **The member app silently discarded member data.** Mobile hand-mirrored the
  `Goal` type and its copy omitted `type`, so a coach-assigned *task* rendered as
  a *goal* with a star-rating flow. The member rated it, the evaluation was
  written to Firestore, and the admin's task card had no panel that could ever
  display it. Score and note became unreachable.
- **One heuristic existed three times and one copy was wrong.** The mobile copy
  of `detectPerformanceProfile` defaulted every missing axis to `3` and always
  named a profile, so a studio with custom axes got a confident, incorrect
  reading of how a person's training was going.
- **The core loop was impossible, not merely unbuilt.** A member could not tick
  off a coach-assigned task — the only contact-session update arm required
  `created_by == 'student'`, and every task a member receives is coach-created.
  "Coach assigns homework, member marks done, coach sees completion rate" could
  never have worked.
- **A whole surface was missing.** The web Space had no coaching page at all —
  not a stub, not a flag. Members on the web portal had no path to their own
  coaching data even though the rules already permitted it.
- **The member half of a four-locale product was English-only.** `apps/mobile`
  had no i18n runtime whatsoever, in a country with four national languages.
- **A copied date formatter walked a deadline back a day per edit.** The Space's
  goal form carried its own `toDateInputValue` — a `toISOString().slice(0, 10)`
  — while the app's real one in `lib/format.ts` formats the LOCAL calendar
  date, and says in its own header exactly why the UTC slice is wrong. Read
  through the copy, a CET target of the 15th rendered as the 14th; the save
  path then wrote the 14th back. `goalIsOverdue` and the nightly sweep both ran
  off the drifted date, so coach and member disagreed about when a goal was
  due. Found by the duplication sweep in §7, a week after this document's first
  draft listed the three cases it happened to notice.

The common cause is one sentence: **a shape owned in one place and copied into
another has no mechanism that notices when the copy stops matching.**

---

## 2. Converge the contract, not the pixels

The instinct on seeing two divergent member experiences is to unify the UI. That
is the expensive half and the least valuable. Ordered by value per unit of work:

| Layer | Converge? | Why |
|---|---|---|
| **Types + logic** | **Yes, always** | Kills the entire class of bug in §1. Cheapest, highest value. |
| **Copy / i18n** | **Yes** | An untranslated surface is a defect, not a style difference. |
| **Visual components** | **No** | Two runtimes (React DOM, React Native). A cross-renderer component library is a permanent tax. |
| **Feature parity** | **No — deliberately** | The surfaces serve different populations. See §5. |

What "converge the decisions, not the components" means in practice: the same
information architecture, the same names, the same icons, the same states —
written down and reviewed — while each renderer keeps its own implementation.

### Status

- **Types + logic: DONE.** `apps/mobile` now depends on `@linyup/shared` and
  imports it. No `metro.config.js` was needed — Expo SDK 54 resolves pnpm
  workspace symlinks natively. Verified by bundling, not assumed: an Android
  export builds 1726 modules clean and shared's own code
  (`burnout_risk`, `resolveCoachingDimensions`) is present in the Hermes
  bytecode. `goalContract.ts` is now a thin re-export; `RankingSystem` and the
  coaching contract come from shared.
- **Copy: DONE for the app.** 483 keys across 21 namespaces in real
  German/French/Italian, with a switcher in the profile's account area.
- **Pixels: deliberately not converged**, and should stay that way.

---

## 3. The release model is a scalability constraint

`app.config.js` sets `runtimeVersion.policy: 'fingerprint'`. Expo hashes the
native project — dependencies with native code, config plugins, permissions — so:

- **A native change forces a store build.** Days, a review queue, and it cannot
  be un-shipped.
- **Everything above the native layer ships over the air**, reaching every
  install on the same fingerprint.

This changes how mobile work should be sequenced. **Land native surface area
early and inert; iterate behaviour over the air.** Push notifications were built
that way in September: the module, the plugin, the permission plumbing and token
registration all shipped in one store build while *nothing sends and nothing
prompts*. Every subsequent decision — when to ask permission, which events are
worth interrupting somebody for, what a tap opens — is now a JS change.

Verified rather than argued: `@expo/fingerprint` lists
`expo-notifications/android` as an `expoAutolinkingAndroid` input, so that
release genuinely could not have been an OTA.

**The inverse also matters: do not spend a store build on something that does not
need one.** Offline is the example. The Firebase **JS SDK**'s
`persistentLocalCache` requires IndexedDB, which React Native does not have, so
there is no native switch to pre-land. An app-layer read cache is pure JS and
ships OTA whenever it is wanted, at the same cost then as now. Real Firestore
offline persistence would mean migrating to `@react-native-firebase` — a project,
not groundwork, and one that would break the shared JS-SDK shapes the app now
reads from `packages/shared`.

---

## 4. Runtime rules already in force

These are per-tenant and per-collection limits the codebase already respects.
They are recorded here because each was a deliberate choice with a stated reason,
and each is easy to break by accident.

- **An attention reason must read a fact already on the contact document.**
  `contactAttentionReasons` states this in its own header. The alternative is one
  subcollection query per row of the contacts list. New reasons therefore arrive
  with a denormalized counter or not at all.
- **The attention *sort* is client-side and cannot be a Firestore query.** It is
  derived and clock-dependent — the engagement band moves with no write — so
  there is no field to index. This is the sharpest per-tenant ceiling in the
  product: the list is loaded and ordered in memory.
- **Counters are absolute, never incremented, and have ONE writer.**
  `trackGoals` recomputes from a fresh query on every goal write. That is a read
  per write, traded deliberately for a count that cannot drift.
- **A state change with no write needs a sweep.** A goal falling overdue involves
  no write of its own — the date stays put and the clock moves — so nothing would
  wake the trigger that maintains the counter. `stampOverdueGoals` supplies that
  wake-up nightly; the *recovery* is a real write, so the trigger clears it
  directly. Note the sweep is a collection-group query bounded by total goals
  **platform-wide**, not per tenant.
- **Prune what rots silently.** `sendPush` deletes tokens the vendor reports
  dead, built before anything sends, because a dead token nobody removes makes
  every later send slower and every delivery statistic a lie.
- **Firestore rules are ADDITIVE.** A more specific match does **not** override a
  broader one. The `contacts/{id}/{subcollection}/{doc}` catch-all grants staff a
  blanket write, so any field lock on an explicit subcollection match is bypassed
  unless that subcollection joins the exclusion list. This has bitten twice —
  `goals`, then `push_tokens` — and will bite again.

---

## 5. Parity is not the goal

The surfaces serve different populations by design. The Space is a **base
surface on every plan including Free**; the member app requires `member_app`
(Coach and up). So the Space must exist regardless — it is not duplicated effort
that could be deleted.

The useful division:

- **The Space is the broad portal** — billing, courses, shop, account, bookings.
- **The app should be the habitual surface** — check in, book, tick a step, get
  nudged.

Chasing feature parity makes the app a worse copy of the portal, which is the
least defensible shape either could take. Note `CLAUDE.md` still describes the
Space as "interim web surface until the mobile app ships" — the Space has since
overtaken the app in capability, so that sentence and reality have parted ways
and should be reconciled deliberately rather than by drift.

---

## 6. Parallel work is its own scaling problem

More hands on this repo hit contention before they hit compute limits.

- **`apps/web/messages/*.json` is the busiest contention point**, and the race is
  at **file** level, not key level: two agents adding keys to entirely different
  namespaces still lose one another's work, with no conflict marker and no
  failing build. The `_pending/<lane>.json` fragment scheme exists for exactly
  this; see `apps/web/messages/_pending/README.md`.
- **`i18n:check` now guards two catalogues** — web and mobile — and names the app
  in every problem. The member app went English-only for months precisely
  because nothing was watching it, and a second unguarded catalogue would have
  repeated that. A catalogue with no messages directory is skipped, so removing
  one stays correct.
- **One agent per app tree.** Two lanes editing `apps/mobile` concurrently will
  collide. Sequence them.
- **A cross-boundary test must assert STRUCTURE, never COPY.** `deadEnds.test.ts`
  pinned the English sentence `'Failed to book session. Please try again.'` and
  the verbs `'book'` / `'check in'` in mobile source. Translation moved those
  words into the catalogue and both guards broke — correctly, but for a reason
  unrelated to what they protect. They now pin the *key* and the call shape.
  Whether a key resolves to real copy in four locales is `i18n:check`'s job; the
  overlap is what made them brittle.
- **A test that reads another app's source is only as honest as the tree it
  reads.** During this work a lane reported a failure as "pre-existing,
  reproduced on main" — its control run had stashed its *own* changes while a
  concurrent lane's edits stayed on disk. The literal was on `main` and was gone.
  When two lanes are live, `git stash` is not a control.
- **A generated finding is a lead, not a fact.** The duplication sweep below
  was right about twenty-one of twenty-three items and wrong about two in ways
  that would have produced a bad commit: it reported one shared default accent
  where `defaultAccent` is a per-preset field (the Space *matched* the default
  preset; the "drift" was inverted), and it counted a triplicated constant as
  a pair. Both were caught only because every claim was read at source before
  being acted on. The cost of that reading was minutes; the cost of the
  inverted fix would have been a wrong accent on every member portal.

---

## 7. The duplication ledger

A deliberate sweep of the three front ends against `packages/shared` — hand-
copied functions, shadowing types, hardcoded paths, twinned components,
twice-declared vocabularies — found twenty-three duplications beyond the
three the first draft had noticed. Twelve had **already drifted**, meaning
behaviour differed between surfaces today; eleven had not yet, meaning the next
edit to one copy would make them drift silently. What follows is the ledger,
ranked drifted-first, then by cost. Everything marked DONE was verified at
source before being changed.

### Done in this pass

| # | What | Where it now lives |
|---|---|---|
| 1 | One `GoalProgressBar` for admin and Space, colour as an optional palette | `apps/web/src/components/coaching/` |
| 2 | Mobile imports every path constant shared owns — `contacts`, `push_tokens`, `participants`, and then `goals`, `evaluations`, `performance_checkins`, `contact_alerts`, `contact_weekly_reports` (fourteen literal sites) | `@linyup/shared` paths |
| 3 | Mobile's hydrated session type renamed `HydratedSession`, with a comment saying why it is not the wire shape's name | `apps/mobile/src/types` |
| 4 | **Drifted, corrupting.** The Space goal form's UTC `toDateInputValue` copy (§1) replaced by the app's local-date one | `@/lib/format` |
| 5 | **Drifted.** The member app never called `sortSteps`, so a goal's steps read in reverse there — the fix this document's own `sortSteps` header described as landed "on both surfaces" had missed the third | `sortSteps` via `goalContract` |
| 6 | **Drifted.** The app showed a lapsed flat plan grant ("2 months included") as the member's current plan; it never called `planGrantIsCurrent`, which the admin and the Space both do. Three tests now pin the asymmetry: the date bites only on the fallback arm, never on a live subscription | `planGrantIsCurrent` |
| 7 | **Drifted.** The leaderboard's trial-anonymisation rule was inline on both member surfaces with different fallbacks (`'?'` vs `'Unknown'`) and, on mobile, untyped stage comparisons — so a renamed stage would have de-anonymised trials in the app alone | `leaderboardDisplayName`, `isTrialStage` |
| 8 | The archived-goal cascade — hide the goal AND its steps, or the steps surface as loose General to-dos — was hand-derived on all three surfaces, one of them re-spelling the predicate as `!!archived_at` | `visibleGoals` |
| 9 | `ALL_STATUSES` was declared three times (the sweep counted two; the Space's evaluation dialog was the third) | `GOAL_STATUSES` beside the type |

### A finding that was not one

The sweep reported "two default accents for the same studio" — the Space's
`DEFAULT_ACCENT` (`#6366f1`) against a shared `#7c3aed`. Read at source,
`defaultAccent` is a **per-preset** field: `#6366f1` belongs to `paper`, the
default preset, and `#7c3aed` to `violet`. The Space *matches* the default. The
`#7C3AED` in mobile is its Paper chrome colour, a different concept from the
tenant accent, which mobile resolves through the same preset registry. Nothing
to do, and worth recording so nobody "fixes" it into being wrong.

### Drifted — closed (2026-09-10), each with its care taken

These had already parted in behaviour. Each was read at source on every
surface before the shared owner was written, and the tests pin the rule the
surfaces now share rather than the copy either one had.

10. **DONE — `primaryRank`** (`packages/shared/src/utils/rankingSystems.ts`),
    the web's rule: a flagged primary, else the first CONFIGURED system the
    contact holds a rank in; an orphaned value shows the nearest level at or
    below and says so (`orphaned`). The web's `getPrimaryRank` and mobile's
    `resolvePrimaryRank` are gone; the app's rank badges position on
    `level.value`, so an orphan sits where it is drawn. A member ranked only in
    a studio's second scale now has the same belt in the app as on the coach's
    screen.
11. **DONE — `resolveAffiliationTerm`** in shared: the reader's language →
    English → any FILLED translation → "Affiliation", and a blank string is
    not a translation at any step (the web's `??` chain would have printed an
    empty noun for a cleared `de`). The web imports it; the app keeps a
    one-line wrapper whose only contribution is the DEVICE-locale default —
    item 29, still separate.
12. **DONE — `buildPerformanceCheckin` + `sameDayCheckin` / `localDayBounds`**
    (`shared/utils/performanceCheckins.ts`): one payload (trimmed notes → null,
    the profile heuristic run once) and one same-day predicate. The app keeps
    its range query, over the shared bounds; the Space asks the shared
    predicate of the rows it already holds; the coach's tab now dedupes too —
    a second 1:1 check-in on the same day overwrites the first, as the member
    surfaces already did for theirs. `taken_at`'s source still differs per
    writer, on purpose, and the module header says why the day window
    tolerates it.
13. **DONE — `usePublicFormat`** (`[slug]/usePublicFormat.ts`, beside the
    team provider so any public surface can use it): the reader's UI language
    over the studio's regional settings, which now ride the public profile
    (`TeamPublicProfile.regional`, mirrored by `syncTeamPublicProfile`). Every
    `toLocale*` call in the Space is gone. Two things found on the way: the
    leaderboard's month label is now built from a mid-month noon-UTC instant,
    because a studio-zone formatter given local midnight on the 1st can land
    on the neighbouring month; and the Account page's birthdate field carried
    a second `toISOString().slice(0, 10)` copy of the item-4 bug.
14. **DONE — `shared/utils/color.ts`**: the WCAG pair (`relativeLuminance`,
    `contrastRatio`, `contrastText`, `isLightColor`) and the hex helpers,
    moved whole from the app. The YIQ copies — the bio-link's text colour, the
    site hero's, and a `contrastTextColor` nothing called — are retired;
    mid-tones now get the same answer on every surface.
15. **DONE — one ISO-week generator.** `apps/web/src/lib/isoWeek.ts` keeps
    only its date-fns LABELS: `dateToIsoWeek` is shared's `isoWeekKey`, and
    `buildWeekKeys` a thin offset wrapper over `isoWeekKeysBack`, so the
    dashboard's trend windows come from the generator the reports are written
    with. The cards' own per-week count maps were already dense (they map over
    the window), so `densifyWeeklyCounts` stays where the sparse rows are.
16. **DONE — the app shows the `default` profile** in its check-in history,
    as the portal and the coach's tab do; it already had the copy and hid it
    on one line.

### Not yet drifted, cheap — closed before they could (2026-09-10)

Each of these was taken while the copies still agreed, which is the cheap
moment. Every claim was read at source first; the sweep's descriptions held for
all eight, and the site count on 21 was low.

17. **DONE — Star ratings.** The two DOM copies are one `RatingStars`
    (`apps/web/src/components/coaching/`), read-only or interactive, with the
    same optional-colour split as `GoalProgressBar`. The admin's filled star
    is now amber-500 — the hex the member app already used. The aria label
    moved to `Common`, since the component belongs to neither surface. Mobile
    keeps its Paper renderer: a different toolkit is not a duplicate.
18. **DONE — `GoalStateChips`** is one component, same directory. The words
    come from the caller as a small `labels` object, because the two surfaces
    translate from different namespaces and format dates differently (item
    13); the component owns the three facts and the say-nothing rule.
19. **DONE — Badge thresholds.** `DEFAULT_BADGE_THRESHOLDS` and
    `mergeBadgeThresholds` sit beside the type in shared; the admin editor, the
    member app (which spread the five sections by hand, twice) and the Space
    all resolve through it. The Space also gained the override path it lacked:
    it reads the studio's thresholds off the public mirror, so a raised
    "Dedicated" shows the same number on the portal, in the app and in the
    editor, and a switched-off group disappears on both member surfaces.
20. **DONE — `BeltBadge`** takes the shared `RankBadge` and switches on
    `kind`; mobile's `resolvePrimaryRank` now returns that badge from
    `rankLevelBadge` instead of four loose fields. Item 10 (*which* system is
    primary) is untouched and still owed.
21. **DONE — `personInitials` / `nameInitials`** in shared, every hand-written
    copy replaced (the sweep's eleven were thirteen), including the two mobile
    ones that had no `'?'` fallback; `avatarColor` in `@/lib/colors` (Tailwind
    classes, so web-only).
22. **DONE, with one deliberate remainder — colour maps.** `GOAL_STATUS_COLORS`
    and `PERFORMANCE_PROFILE_COLORS` are in shared; mobile, the admin's profile
    badge and the admin's evaluation rows (which carried the same four hexes
    inline) read them. The admin's status *pill* keeps Tailwind light/dark
    class pairs (`components/coaching/goalStatusStyles.ts`) derived by colour
    family, because one hex cannot also carry a dark-mode text contrast; the
    file says so and names its owner. The *label* maps stay per surface: they
    are i18n keys in three namespaces, and moving them is a copy migration,
    not a dedupe.
23. **DONE — Shadowing types.** The admin gamification page's form type is
    `Required<StoredGamificationSettings>`, a shared type that now describes
    the whole stored bag (public slice + scoring); the functions scorer's
    defaults derive from `DEFAULT_GAMIFICATION_SCORING` too. `LeaderboardEntry`
    and `TeamLeaderboard` are in shared — mobile's hydrated envelope extends
    them the way `HydratedSession` does, the Space picks two fields — and the
    leaderboard path is three constants in `paths.ts` used by the writer and
    both readers. `ShownSubscription` is a `Partial<Pick<…>>` of
    `ActiveSubscriptionSummary`, and the cast is gone.
24. **DONE — Goal and evaluation dialogs.** One `GoalDialog` and one
    `EvaluationDialog` (`components/coaching/`), with capability props rather
    than a merge: the admin declares description + both dates + a parent
    picker on a step; the Space declares description + target date on a goal
    and a title-only step, and offers the status control only on the member's
    own goal. Both surfaces now use the app's `DatePicker`, which retires the
    string round-trip that item 4 fixed. The words come from the caller, as
    with 18.

### Worth doing, not urgent

25. **DONE for the web and the app — `PUBLIC_PROFILE_SUBCOLLECTION`,
    `SESSION_BOOKINGS_SUBCOLLECTION`, and three more the sweep turned up
    (`ORG_TEAM_ACCESS_REQUESTS_SUBCOLLECTION`, `WEBHOOK_ENDPOINTS_SUBCOLLECTION`,
    `CONTACT_FILTER_PRESET_PINS_DOC`).** The sweep was wider than the entry:
    every string a `collection()` / `doc()` / `collectionGroup()` call was
    handed that `paths.ts` already named — a hundred and forty of them, in
    sixty-three web files, plus the two local `BOOKINGS_SUB` aliases; the app
    had none left. The one deliberate exception is a plugin id that happens
    to equal a collection name (`installed_plugins/documents`), now a named
    constant of its own. **Not swept: `packages/functions`**, which holds
    several hundred more on the Admin SDK's `db.collection('…')` shape — the
    same rule below is ready for it, but that is its own pass.
26. Push cannot deliver until an FCM V1 service account and an APNs key are
    uploaded to EAS. Recorded in the mobile-release store-submission checklist.
    Tokens registered before then are still valid; nothing is lost.
27. The emulator-backed integration suite (`test:integration`) does not run in
    CI — it needs a built `dist/` and the functions emulator. It covers the
    counters that feed contact triage, where a wrong value does not throw.
28. Org-scoped coaching dimensions; the editor is team-only.
29. `resolveAffiliationTerm` resolves over a studio-authored map using the
    *device* locale, outside React. Rewiring it to the app's chosen locale is
    a behaviour change, not a string migration — separate from item 11.

### Tripwires — so the ledger does not regrow (2026-09-11)

Two of the patterns above were swept by hand more than once. Both are now lint
errors, so the next copy fails CI rather than waiting for the next sweep:

- **A Firestore path segment typed as a string where `paths.ts` names it**
  (item 25) — `no-restricted-syntax` on every string handed directly to
  `collection()`, `doc()` or `collectionGroup()`, in the web and the app. The
  forbidden set is **read from `@linyup/shared`'s build**
  (`apps/web/eslint.firestorePaths.mjs`, shared by both configs), never listed
  in the rule, so adding a constant to `paths.ts` is what extends it. Lint runs
  after `^build` under turbo, so the file is always there.
- **A bare `toLocale*String()` on a public route** (item 13) — scoped to
  `src/app/*/(public)/**`. The twenty-five sites still there (kiosk, booking
  form, waitlist, manage-booking, appointments, the event programme print, the
  invitation token page) went through `usePublicFormat` first; two day-key
  displays moved to noon so a studio-zone formatter cannot land on the
  neighbouring day. **Out of scope, on purpose:** the admin tree (`useTeamFormat`
  exists; a hundred-plus sites, its own pass) and the member app (thirty-one
  sites; it can now read `TeamPublicProfile.regional`, so adopting
  `createRegionalFormatter` there is the natural next step).

### Decide, do not drift

30. What the app sends. The capability exists; what is worth interrupting
    somebody for is a product judgement, and it now ships over the air.
31. Whether the app's scope should shrink to what only an app can do, rather
    than tracking the portal.

---

# Part 2 — Runtime, cost and operations

> The first analysis of this pass, written before the surfaces work above and
> restored here on 2026-09-11 after the file had drifted from it. Claims marked
> ✓ were re-verified at source that day; the cost figures are estimates and are
> labelled as such. Section 14 records what has been done against it.

## 8. Bottom line

The data model scales fine — the tenant boundary is `teamId`, and nearly every
composite index leads with it, so index ranges shard per tenant and Firestore
will carry tens of thousands of studios. Firestore's own cost is genuinely
small (roughly $0.50 per studio per month at the profile in §12).

The problems are elsewhere, and there are three real ones: **the scheduled jobs
are single-instance sequential scans over all tenants**, **the append-only
ledgers had no retention at all**, and **course video egress on Firebase
Storage is the cost bomb** — bigger than Firestore, Functions and hosting
combined.

## 9. The hard wall: scheduled fan-out jobs (breaks around 300–800 tenants)

Every cron is one instance with `timeoutSeconds: 300` (three at 540) and
`memory: '512MiB'` ✓, and loops tenants sequentially with `await` inside the
loop:

| Job | Schedule | Work per run | Wall |
|---|---|---|---|
| `runScheduledRules` | daily | `collectionGroup('automation_rules')` globally, then all contacts of every team loaded into memory | reads = Σ contacts across tenants, sequential |
| `weeklyReports` (analytics/index.ts) | weekly | for every team: all active contacts + a week of sessions | same |
| `sendBookingReminders` | hourly | global sessions scan over a 15-day window (`MAX_OFFSET_HOURS = 14*24` + 24 h catch-up), then an N+1 bookings fetch per session | the worst one — runs 24×/day |
| `markNoShowBookings` | daily | global sessions where `end` in the last 7 days + per-session bookings | N+1 |
| `capturePlatformMetrics` | daily | all teams + a `count()` per team | cheap-ish (aggregations) |
| `monthlyFinanceReports` | monthly | for every team: two months of journal + payments | **missed by this table when it was written** — same shape, found on 2026-09-11 |

None of these has a budget or a cursor. At ~500 tenants × 300 contacts,
`runScheduledRules` is ~150k sequential reads and `weeklyReports` is worse —
both blow 300 s, and the failure mode is silent: the job dies partway, some
tenants get their reminders and rules and some do not, with no signal.

`rollSessionSeries` is the one done right — `MAX_SESSIONS_PER_RUN = 2000`, a
per-series budget, a stable scan order, resumable. That is the template. And the
machinery to fix the rest already exists: `onTaskDispatched` Cloud Tasks queues
are in use for `executeDelayedRule` and `runSeriesTeardown` ✓. The fix is to
make each cron a **dispatcher that enqueues one task per tenant**, which gives
parallelism, per-tenant retries, and isolation of one tenant's failure.

`sendBookingReminders` additionally wants a narrower scan — bound the window to
the largest offset any team has actually configured rather than the theoretical
14-day ceiling, and skip the per-session bookings fetch when
`bookings_count === 0`.

### DONE 2026-09-11 — all four, plus both narrowings

`packages/functions/src/utils/tenantFanOut.ts` is the shared machinery and its
header carries the reasoning. Each job is now a dispatcher that lists the
tenants and enqueues one task each; the work lives in a `…ForTeam(teamId)`
function that BOTH the task worker and the dispatcher's local-dev inline path
call, so there is one implementation and not two. The workers are four separate
handlers (`dailyTasks/tenantWorkers.ts`) and therefore four queues: the hourly
reminder flood never sits behind Monday's reports, and each gets retry and
concurrency settings that suit its own work.

| Job | Dispatcher enqueues into | Per-tenant work |
|---|---|---|
| `sendBookingReminders` (hourly) | `remindersForTeam` | `sendBookingRemindersForTeam` |
| `markNoShowBookings` (daily) | `noShowsForTeam` | `markNoShowBookingsForTeam` |
| `runScheduledRules` (daily) | `scheduledRulesForTeam` | `runScheduledRulesForTeam` |
| `weeklyReports` (weekly) | `weeklyReportForTeam` | `weeklyReportsForTeam` |
| `monthlyFinanceReports` (monthly) | `financeReportForTeam` | `monthlyFinanceReportsForTeam` |

Both narrowings landed with the reminders: the scan window is now the team's
OWN longest configured offset plus the catch-up (a studio with no steps, or
reminders off, reads no sessions at all), and a session whose `bookings_count`
is zero costs no subcollection read — in `markNoShowBookings` too.

Three properties make at-least-once delivery safe, and each is the JOB's own
rather than something the dispatcher asserts: per-step `reminders_sent` markers,
a weekly report that refuses to overwrite an existing week, and a no-show pass
that only ever flips a `pending` booking. The deterministic task id
(`{teamId}-{runId}`, tenant first — a run id is the most sequential prefix
available, and Cloud Tasks degrades on those) is a cheap first line of defence
on top, never the guarantee. `utils/tenantFanOut.test.ts` pins all of it.

**A bug found while wiring it, worth its own paragraph.** The obvious tenant
list is `teams where archived_at == null` — which three jobs already used. But a
Firestore `== null` filter matches an **explicit null and not a missing field**,
and on `teams` that field is missing: nothing writes it on create and `Team`
does not declare it. So the clause matches almost no studio, and a dispatcher
built on it would enqueue nothing for nearly everybody while reporting a clean
run — the exact silent half-run this conversion exists to end. The fan-out
projects the field and filters in memory, where an absent marker correctly reads
as "not archived". `weeklyReports` carried the clause and is fixed by the
conversion.

**`monthlyFinanceReports` was the worst case of it, and is now fixed too
(2026-09-11).** That job had the clause and nothing else — no second tenant
source, no fallback — so it has been writing almost no monthly finance reports
for as long as it has existed, while logging a clean `0 team-months written`.
It is converted onto the same fan-out, which fixes the listing by construction
and removes a fifth instance of this section's own problem. Its months now come
from the RUN SLOT rather than the worker's clock, so a task retried hours or
days later still regenerates the pair the schedule fired for.

**A studio that ran on this needs its history regenerated**: the job overwrites
by design (the journal is the source of truth), so re-running it is the repair
— but only the two most recent months are in scope on any given run. Older
months have no report and no job that will produce one.

**A third instance, found by sweeping for the rest of the class.**
`syncTeamPublicProfile`'s forms probe asked `forms where status == 'published'
and archived_at == null`, and no form document has ever carried that field —
`Form.archived_at` is declared optional, `createForm` does not write it, and
nothing archives a form at all. So `formsActive` was false for every studio, and
a published form never appeared in `active_public_surfaces` — which is what the
public tenant root and the site menu read to decide a surface is live. Fixed the
same way, in memory.

(The identical clause against `contacts` is correct and must be left alone —
contact writers always set the field explicitly, which is what
`apps/web/src/lib/liveContacts.ts` exists to guarantee. Those, plus the fixed
sites, are the whole class: `handleTrialLifecycle` queries teams narrowly with
its own cap and is not of this shape.)

## 10. Write amplification per booking

One member booking one class costs roughly five document writes and ~12 reads:

1. the booking write fires `trackBookings` and `onBookingWrite`;
2. `trackBookings` reads the session, then every booking in that session to
   recount — correct (the absolute-counter rule, §4) but O(N) per booking and
   so O(N²) to fill a class — then writes the session doc and an
   `activity_log` row;
3. that session write fires `syncSessionPublicProfile`, `trackSessions` and
   `onSessionWrite`;
4. `onBookingWrite` and `onSessionWrite` each run `fireEventRules`, which
   re-queries `automation_rules` and the team doc per event.

Fine at current volume, and not worth restructuring the counter. Two cheap wins:
cache the team doc and its active rules (they change rarely), and have
`fireEventRules` bail before the rules query when the team has none — today
every booking in the system pays for a rules lookup whether or not the studio
uses automations.

## 11. Housekeeping — the ledgers had no retention

`dailyTasks` already purges the transient collections well
(`purgeVerificationCodes`, `purgeCheckoutAttempts`, `purgeProvisionalContacts`,
`purgeUnverifiedSignups`, `expirePendingBookings`, `purgeScheduledTeams`,
`anonymizeScheduledContacts`). Nothing touched the ledgers:

| Collection | Growth | Retention (before) | Now |
|---|---|---|---|
| `teams/{id}/activity_log` + `contacts/{id}/activity_log` | every booking, contact, session, payment event | none | **18 months**, TTL |
| `mail_sends` | every email + SMS, 12 composite indexes | none | **90 days**, TTL; suppressions live elsewhere and never expire |
| `teams/{id}/automation_logs` | one per rule per run per team | none | **90 days**, TTL |
| `contact_weekly_reports` / `team_weekly_reports` | N contacts × 52/year | none | policy call, open |
| `monthly_scores`, check-ins, `subscription_history` | linear with activity | none | policy call, open |
| `platform_metrics` | 1/day forever | none | fine, tiny |

**Firestore TTL policies are the right tool, and none was in use** — all
eighteen `fieldOverrides` in `firestore.index.json` said `"ttl": false` ✓. A
TTL on an `expires_at` field costs nothing to run, needs no job, and deletes
are billed like ordinary deletes. Strictly better than writing purge tasks.

A second, specific thing in the same place: `capturePlatformMailMetrics`
aggregated the **entire** `mail_sends` collection with no date bound every
single day for `sent_cumulative` ✓ — O(all history forever), daily, and once
the ledger ages out, silently wrong. It now carries a running total forward.

## 12. Cost model (estimates)

Unit rates are Google's list prices for standard regions; `europe-west6`
(Zurich) carries a regional premium, so multiply by roughly 1.4–1.5 and verify
in the calculator. Both Firestore and Storage are pinned to `europe-west6` in
`infra/environments/prod/variables.tf` and are immutable after first apply, so
this is already decided.

Assumed "average" studio: 200 active contacts, ~130 sessions/month, ~1,500
bookings/month, 2 staff on the dashboard daily, members using Space/mobile.

| Line | Per studio/month | × 1,000 studios |
|---|---|---|
| Firestore reads (~350k — dashboards + contact lists dominate, not bookings) | ~$0.21 | ~$210 |
| Firestore writes (~30k) | ~$0.05 | ~$55 |
| Firestore storage + index overhead | ~$0.04, compounding | ~$40/mo, +$40 each year |
| Cloud Functions (~50k invocations) | ~$0.15 | ~$150 |
| App Hosting (Cloud Run, `maxInstances: 10`) | — | ~$100–300 |
| Brevo email (~2,500 sends: reminders + automations) | ~$2.50–4 | ~$2,500–4,000 |
| Storage egress — course video | ~$10 | ~$10,000 |

Two things jump out. **Firestore is not the scaling risk** — a rounding error
even at a thousand tenants; the fixes in §9 are about correctness under load,
not cost. **Course video is.** Storage rules cap uploads at 50 MiB, and media is
served straight out of the Firebase Storage bucket with no CDN in front. One
studio with 30 video lessons and 200 members watching ~10 lessons a month is
~80 GB of egress ≈ $9.60 — more than everything else on that studio's bill
combined. Worth solving before the online-courses plugin gets real usage: put
Cloudflare Stream or R2 behind it (zero egress fees, and Cloudflare workers
already run from `infra/workers/`), or Cloud CDN in front of the bucket. A
secondary issue in the same place: `contactMayReadCourseMedia` in
`storage.rules` does up to three `firestore.get()`/`exists()` calls per object
request, each a billed read with latency — worth confirming how often that path
is hit versus tokenised download URLs.

**Brevo scales linearly with activity and is the second-biggest line.** Nothing
wrong with it — budget it as a real per-tenant COGS, and note that if SMS
reminders get adopted the per-message cost in CH is 30–50× email.

**Decided 2026-09-11: video is embed-only, on every plan.** The cost driver is
egress, not storage, so a storage quota would have capped nothing — 5 GB stored
and watched by 200 members is a terabyte out of the bucket. `storage.rules` now
refuses `video/*` uploads under a team (the kiosk's standby media is the one
exception: it loops on a single tablet, cached), and the course editor offers a
video lesson only YouTube, Vimeo or a link — `MediaSource` had those from the
start, and an unlisted YouTube video delivers for free, which is what every
entry-level course tool does. A lesson stored with an uploaded video before the
rule still plays; whether any exist in production is a bucket scan owed before
the rule deploys. **Audio uploads stay** (a 30-minute lesson is ~15–30 MB, the
same problem an order of magnitude smaller) and are the known residual.
**Hosted video, if it ever comes, is a paid add-on on zero-egress
infrastructure** — Cloudflare Stream (per-minute stored + delivered, so the COGS
is meterable per tenant and priceable above it) or R2 + HLS — never this bucket
under any quota.

### Where the cost numbers actually come from (added 2026-09-12)

The figures above are ESTIMATES from list prices. What the platform now measures,
on the operator console's **Providers** page, is whatever each vendor will
actually tell us — and that is three vendors out of nine:

| Vendor | What it reports | How |
|---|---|---|
| Google Cloud | month-to-date money vs the budget | the billing budget's Pub/Sub notification (`handleBudgetNotification`) |
| Brevo | credits remaining, per plan line | `GET /v3/account` on the existing key |
| DeepL | characters used vs the key's cap | `GET /v2/usage` |

Recorded onto the daily `platform_metrics/{date}` snapshot, so the page shows
history rather than a spot reading, and every block carries the instant it was
obtained.

**Three rules this follows, each of which is the reason it is worth trusting:**

- **Nothing is normalised into one "spend" number.** Money, credits and
  characters are not comparable, and adding them would invent precision the
  inputs do not have.
- **An absent block means "not measured", never zero** — the same contract
  `PlatformMailMetrics` already has. A vendor call that failed, a key that is not
  configured, and a genuine zero are three different facts; a cost screen is the
  one place a confident wrong number does real damage. Pinned by a test that
  refuses a `?? 0` on any of these fields.
- **Google needs no cost API, and there isn't one anyway.** `cloudbilling`
  returns account metadata and the price catalogue, not consumption; the
  alternative is a BigQuery billing export (opt-in, delayed, billable). The
  budget already evaluates several times a day and its notification carries the
  cost, so the alarm and the feed are one mechanism.

**Stripe is deliberately absent.** Connect processing fees are the STUDIO's cost,
not Linyup's, so a single "Stripe fees" total would conflate two parties' money
and overstate platform COGS. Adding it means first deciding whether the page
shows Linyup's own cost only or splits platform-vs-studio explicitly.
**Cloudflare, PostHog and EAS expose nothing usable**, and the two store portals
report revenue rather than cost — each of those cards says so in place of a
number, because an unexplained blank on a cost page invites the reader to assume
zero.

## 13. Secondary limits, roughly in the order they bind

- **App Check is implemented but off**, deferred by decision
  (`docs/app-check-rollout.md` → "Why it is still off") ✓. Public routes query
  Firestore directly from the browser via `collectionGroup('public_profile')`,
  so a script can drive unmetered reads against the bill. **Correction:
  enforcement as built does NOT close that** — `enforceAppCheck` guards
  CALLABLES, while direct browser reads need App Check enforced on the Cloud
  Firestore API, a per-API Console toggle that is **blocked until the member app
  ships native attestation** (the Expo app reads Firestore directly and cannot
  attest, and that toggle cannot distinguish callers). So the callable flip
  answers the fraud axis; this cost axis waits on the mobile native build either
  way.
- **There was no `maxInstances` on any Cloud Function** ✓ — `setGlobalOptions`
  set only the region. A trigger loop or a traffic spike scaled into the
  regional quota with no ceiling. Now capped (§14); the billing budget module is
  applied in prod terraform (`infra/environments/prod/main.tf`, `budget_amount`),
  and note a budget ALERTS, it does not cap — `maxInstances` is the actual
  ceiling.
- **`apps/web` prod is `maxInstances: 10` × `concurrency: 80` ≈ 800 concurrent
  requests.** Fine for a long time; just know the number.
- **158 composite indexes** ✓ (152 at the time of the analysis), 23 on
  `contacts` and 19 on `sessions`. Index storage will exceed document storage,
  and every contact write updates all of them. Worth an audit for unused
  indexes before adding more.
- **One genuine index hotspot:** `mail_sends` has indexes leading with
  `channel` (two values) then `created_at` — a low-cardinality prefix followed
  by a monotonically increasing value, which caps that index range at ~500
  writes/sec. That is 43M messages/day, so a marker not a worry, but it is the
  one index that is not tenant-sharded.
- **Hot-document contention is low.** Booking writes are transactional on the
  session doc, and a class holds tens of bookings, not thousands — well under
  the ~1 write/sec/document sustained limit except for a genuinely viral
  drop-in.

## 14. What to do, in order — and where each stands (2026-09-11)

| # | Step | Size | Status |
|---|---|---|---|
| 1 | TTL policies on `mail_sends`, `automation_logs`, `activity_log` | hours | **DONE.** `LEDGER_RETENTION_DAYS` (shared) is the one policy; every writer stamps `expires_at` (`utils/ledgerRetention.ts`; the analytics module's own `logActivity` copy included); three `ttl: true` overrides in `firestore.index.json`, pinned against the policy by `ledgerRetention.test.ts`; `pnpm backfill:ledger-ttl` stamps the backlog. **Deploy order matters** and is in the script's header: functions first, one nightly capture, then the backfill, then the index overrides. |
| 2 | App Check on + global `maxInstances` + budget alert | small | **`maxInstances: 20` DONE** (a cost ceiling, per function; a hot callable overrides locally). **Budget: the alert PATH is fixed** (2026-09-12) — the budget carried no `all_updates_rule` at all, so alerts fell back to GCP's implicit billing-admin default and never reached the `alert_email` the error and uptime alerts use; they now route to that same channel with the billing-admin default kept on top. Every threshold was also `CURRENT_SPEND` (money already gone), so a `FORECASTED_SPEND` rule was added — the only kind that arrives in time to stop a runaway. `terraform output budget_alerts_named_recipient` is the honest answer, and one `alert_email` now fixes errors, uptime and budget together. **`budget_amount` remains a judgement call**: the 500 CHF default puts the first alert at 250 CHF spent, which detects nothing while the real bill is small. Set it from the last full month's Google spend (`infra/README.md` → "Picking `budget_amount`"), and note it sees the GOOGLE bill only — Brevo, the second-largest COGS line in §12, is a separate vendor and invisible to it. **App Check: DEFERRED by decision** (2026-09-12), not pending. reCAPTCHA Enterprise is a third-party provider with its own billing, and the web-flagged callables (grep them — see the runbook's Scope) are already IP-rate-limited (30/IP/hour, `submitForm` 10/form/IP/hour) behind a `payments_enabled` gate that fails closed — App Check adds defence against an attacker who defeats IP keying, and nothing else. Nothing is half-adopted: no key, flags false, key slot and both Google APIs commented out. The triggers and the provider-free alternative for the gift-card oracle are in `docs/app-check-rollout.md` → "Why it is still off". The rollout wiring it needed (the key's deployment slot, the BUILD-availability trap, the Enterprise provider swap) is done, so the flip is a cold start whenever wanted. |
| 3 | Convert the four sequential crons to Cloud Tasks dispatchers, `rollSessionSeries` as the template; `sendBookingReminders` first | ~a week | **DONE 2026-09-11** — all four, plus both of the reminder narrowings, on shared machinery (`utils/tenantFanOut.ts`). See §9 for the table and for the `archived_at` bug the wiring turned up. |
| 4 | Decide course-video hosting before the plugin has real usage | decision | **DECIDED and DONE: embed-only** (§12). Rules refuse video uploads except the kiosk's standby media; the editor offers a video lesson YouTube / Vimeo / link only; the rules test pins both. Owed before deploy: a bucket scan for already-uploaded video. Hosted video later = paid add-on on zero-egress infra. |
| 5 | `sent_cumulative` as a stored counter | small | **DONE.** Carried forward from the last snapshot that has one plus the days since; seeded once from the whole ledger; a failed snapshot read yields no block rather than a wrong total. The operator console's "Emails (total)" reads it, and a studio's figure is labelled with the window it covers. |

Steps 1, 3, 4 and 5 are done, and step 2 is done but for two open items,
neither of which is code: **choosing the prod budget's amount** (its alert path
is fixed; the number wants one look at last month's bill) and **App Check, which
is deferred by decision rather than outstanding** — see the row above and the
runbook's "Why it is still off". None of it was
architectural — the data model is sound, and nothing here
required reshaping collections or the tenant boundary.

One consequence worth stating for whoever deploys: the four scheduled jobs now
depend on Cloud Tasks, so their IAM and quota matter where they did not before.
The two pre-existing task functions (`executeDelayedRule`, `runSeriesTeardown`)
already prove the service account can enqueue. A dispatcher that cannot enqueue
ANY tenant throws rather than reporting a clean run, so the failure is visible
in the scheduler rather than silent. Locally, `firebase emulators:start` does
not run Cloud Tasks unless asked, and the dispatchers fall back to running the
tenants inline so a developer's machine still exercises them.

---

# Part 3 — UI lists: census and plan

> Asked for on 2026-09-11: "as soon as the studios start to get real
> transactions, this might really break and slow down the UI. A risk we cannot
> take — if somewhere we cannot do anything to improve, we should know it in
> advance so we can set the right expectations, rather than having a client
> complaining." Every claim below was checked at source that day; the file
> paths are the pointers, and the line numbers deliberately are not.

## 15. Method — and the question that actually matters

A scan over `apps/web`, `apps/mobile` and `apps/admin` for every read site
(`getDocs`, `onSnapshot`, `getCountFromServer`, `useInfiniteQuery`, and the
operator console's server-side `.get()`) found **323 read sites, 218 of them
with no `limit`, no range clause and no cursor** on the day of the scan. That
number is nearly useless on its own, because "has a limit" is the wrong
question. The right one is **what does the list grow with**, and there are
four answers:

| Axis | Grows with | Examples | Client-side OK? |
|---|---|---|---|
| **CONFIG** | the studio's authoring | activities, plans, places, templates, rules, event types, documents, courses, promo codes, integrations | **Yes.** Tens of rows, bounded by somebody's patience. Never a problem. |
| **PER-ENTITY** | one entity's size | bookings per session, attendees per event, items per programme, lessons per course | **Yes.** Bounded by capacity or by the event; the multiplier is what to watch (see §17 C). |
| **ROSTER** | people | contacts, subscriptions, signers, affiliations | **Up to a size** — and that size is the expectation to set. Hundreds to low thousands per studio. |
| **LOG** | time | notifications, payments, submissions, referrals, events, exceptions, activity | **No.** Every unbounded LOG read is a defect at some date; the only question is which date. |

The large majority of the 218 are CONFIG or PER-ENTITY and are correct as they
are. What follows is the rest: the ROSTER lists (whose ceiling has to be
stated), the LOG lists (each of which needs a window or a page), and the
fan-outs (a bounded list that costs one read per row).

## 16. Already right — the patterns to copy, not reinvent

These are the shapes the fixes in §19 reuse. Each was found working at source.

| Surface | List | Bound | Pattern |
|---|---|---|---|
| Schedule / calendar | sessions | `useSessionsRange(from, to)` — the window is in the cache key | **Range keyed** — two views asking for the same window share one fetch |
| Bookings page | bookings | `useBookingsWindow` — `MAX_WINDOW_SESSIONS`, `MAX_WINDOW_BOOKINGS`, and a `tooWide` refusal | **Honest truncation** — the page says the window is too wide rather than silently dropping rows |
| Payments | member payments, BYO ledger, partner visits | `useMemberPayments(pageLimit, sinceMs)` + load more; `usePaymentEvents` the same; partner visits current month only | **Time window + page** |
| Finance plugin | journal, entries | `useFinanceJournal` since + `limit(500)`; `useEntries` per accounting period | **Window + hard cap** |
| Dashboard | weekly reports, monthly revenue | reports by trend weeks; revenue since the start of last month | **Window** |
| Contact detail | bookings, recent sessions, weekly reports, activity | `CONTACT_BOOKINGS_LIMIT` with a `truncated` flag; recent sessions by `count`; 16 weeks; activity `PAGE_SIZE` | **Cap + truncated flag** |
| Activity schedule sheet | upcoming sessions | `start >= now` + `PREVIEW_LIMIT` | **Forward window + cap** |
| Day sheet, kiosk | sessions | one day | **Window** |
| Org events print, org dashboard | events | 12-month window; upcoming `limit(UPCOMING_EVENTS_SHOWN)` | **Window / cap** |
| Space bookings | my bookings | `useInfiniteQuery` over `getMyBookings`' cursor (`MY_BOOKINGS_SCAN_PAGE`) | **The ONE cursor pattern on the web** — reuse it |
| Contacts roster, affiliation tables (2026-09-11) | long client-side lists | `useWindowedList` — `@tanstack/react-virtual` on the window, spacers hold the height, inert under 120 rows | **DOM windowing** — the read and every derivation untouched; only the rows near the viewport are mounted |
| Archived contacts, form responses, referrals (2026-09-11) | paged client reads | `usePagedQuery` — the last document is the cursor, `limit(pageSize)` appended, pages flattened | **The cursor pattern for a DIRECT read**, ending in `LoadMoreFooter`, which states what is loaded (of how many, when there is a count) and offers the rest |
| Mobile | upcoming sessions, check-ins, leaderboard, agenda, attendance calendar | 3 months + `limit(200)`; `limit(10)`; top 50; ±7 days; one month | **Window + cap** |
| Operator console | account payments | `limit(1000)` | **Cap** |

## 17. The census — every list that grows without a bound

Sizes are estimates. "Risk" is what happens at a real studio: 1,500 live
contacts, 40 classes a week, three years of history. Fix column vocabulary:
**window** (a range clause), **cap + more** (`limit` plus a load-more that
pages on a cursor), **status filter** (query only the live rows), **count**
(`getCountFromServer` instead of loading rows), **DOM window** (render only the
visible rows), **server list** (a callable or an index-backed cursor list),
**expectation** (cannot be fixed cheaply — say so).

### A. ROSTER — grows with contacts

| # | Surface | List (owner) | Today | Risk | Fix | Size |
|---|---|---|---|---|---|---|
| A1 | **Contacts page** | `useActiveContacts` — the whole live roster; filter presets, dynamic groups, attention sort and search all run over it in memory; **every row is rendered** (`contacts/page.tsx`, no windowing) | correct to ~2,000; the page is sub-second there | at 5,000 the render is the cost, not the read: seconds per filter change, and a 5,000-doc fetch per cache miss (2 min) | **DOM window** now (the one dependency to add: `@tanstack/react-virtual`, not yet in the tree); **materialized attention score** later (§18) | half a day / a week — **DONE 2026-09-11.** The list is DOM-windowed (`useWindowedList`, rows measured) above 120 rows; the read, the filters, the attention sort and the selection are untouched. The materialized score stays Phase 4. |
| A2 | Contacts page, search panel | `useArchivedContacts` — all archived, grows with churn and never shrinks; also read by the command palette once armed | fine for years | a studio's archive outgrows its roster after ~3 years | **cap + more** ordered `archived_at desc`; search stays over the cached page | small — **DONE 2026-09-11.** The TAB pages (`useArchivedContactsPage`, the count from an aggregation) and says how many of how many are loaded; the sidebar SEARCH keeps the whole read, deliberately (UX-21): a search that only found the recently archived would have quietly stopped answering the question it exists for. |
| A3 | Contacts page | Deleted tab — all deleted-not-yet-anonymised | shrinks when `anonymizeScheduledContacts` runs | bounded by the anonymisation delay; fine | none — record that the bound is the nightly job | — |
| A4 | **Dashboard** | `usePreviewContacts` — the whole live roster on the landing page of every login, for the contacts card, demographics and the attention queue; **its own cache key**, so it is a second roster fetch beside A1's | two roster fetches per session, and more below | the roster is fetched once per distinct key: A1's hook, the dashboard, the session-detail / contact-groups / check-in trio, the affiliations page and the referrals page each hold their own copy | **one key** — every roster read goes through `useActiveContacts`, so a session holds ONE copy; **count** for the headcount and a materialized attention queue later | small / with A1 — **DONE 2026-09-11.** The dashboard reads `useActiveContacts` on the contacts page's cache entry, with the same coach scope; its own query is gone. A count aggregation was NOT added: every card derives from the roster (engagement bands, the attention queue), so a count would be a read on top of the read. |
| A5 | Session detail, check-in panel | add-participant dialog + gated-roster badges — whole live roster, on open / when gated | fetched only when opened; a key of its own, shared with the contact-groups page and the check-in panel but not with A1 | fine at the expectation size | route through `useActiveContacts` (A4's one-key fix); a **server list** (prefix search) only if A1's ceiling moves | with A4 — **DONE 2026-09-11.** Both session-detail queries and the check-in panel read `useActiveContacts`; the three-segment key they shared among themselves is gone. |
| A6 | Payments | `useActiveContacts` for the contact picker | shares A1's key | same as A5 | none | — |
| A7 | Contact groups | whole live roster for member counts + dynamic-group evaluation (its own query, A5's key) | inherent to lazy derivation (Part 1) | fine at the expectation size | **count** for manual groups; dynamic groups evaluate on A1's cached roster | small — **DONE 2026-09-11.** Reads `useActiveContacts`. No count aggregation, for the same reason as A4 — the dynamic groups and the member list are derived from the held roster by design. |
| A8 | Gamification | all contacts by `current_month_score`; renders all | correct | 3,000 rows for a leaderboard nobody scrolls | **cap + more** (`limit(100)`) | tiny — **DONE 2026-09-11.** `limit(50)` per ranked field, each on its own index; the copy already said top 50. |
| A9 | Referrals plugin | ALL contacts (**no `deleted_at` filter**) + all referrals ever | reads deleted people back into memory | roster + a LOG, both unbounded | contacts → `liveContactConstraints()` and only the ids the shown referrals name; referrals → **cap + more** by `created_at desc` | small — **DONE 2026-09-11.** Referrals paged with the status filter in the query; the names come by id (`useContactsByIds`), so an archived referrer still resolves. |
| A10 | Affiliations | all non-deleted contacts (its own key), sorted in memory, `filtered` rendered whole | correct | same shape as A1 without the attention sort | **DOM window**; status filter in the query; A4's one key | small — **DONE 2026-09-11.** DOM-windowed tables (`useWindowedList`, uniform rows, no measuring). It keeps its OWN read, deliberately: it needs the archived too (a person who left may still hold a federation affiliation, and its notice reasons over every lifecycle), so `useActiveContacts` would be the wrong set. |
| A11 | **Org affiliations** | all live contacts with an org affiliation **across every member studio** (`teamId in` chunks of 30) | correct for a 3-studio org | a 30-studio federation lists tens of thousands of people on one page | **expectation** — an org never lists a roster; it gets **counts** per studio and status (`getCountFromServer`) and drills down into one studio's page | a day, and a product decision — **Tables DOM-windowed 2026-09-11**; the counts + per-studio drill-down stay the Phase 4 decision. **The counts + per-studio drill-down landed 2026-09-11** — see §18.2. |
| A12 | Documents plugin | `WaiverSigners` — all signers per document | correct | one row per member who ever signed; equals the roster | **cap + more** by `accepted_at desc` + search by contact | small — **DONE 2026-09-11.** DIFFERENTLY: the READ stays whole — the evidence line is a count over the whole signed population that no cheap query reproduces, and it is roster-scale — while the TABLE pages a hundred rows at a time. |
| A13 | Payments | `useMemberSubscriptions` — every subscription incl. cancelled; the hook's own header names the fix | correct, and roster-like by design | headcount **plus churn**: after three years the ended rows outnumber the live | **status filter** — live statuses by default, "show ended" pages the rest | small — **DONE 2026-09-11.** `status in` the live set (`LIVE_SUBSCRIPTION_STATUSES`, now on the hook); the page never listed an ended row, so only the read changed. |

### B. LOG — grows with time

| # | Surface | List (owner) | Today | Risk | Fix | Size |
|---|---|---|---|---|---|---|
| B1 | **Every authenticated page** | `useTeamNotifications` — **all notifications ever**, `created_at desc`, refetched by the bell and the dashboard banner (stale 60 s); only `status == 'unread'` is rendered | small today | the one LOG read on EVERY page load; a busy studio writes several a day | **status filter** (`unread`) + `limit(50)` for the bell; a history view pages; and **retention** — add `notifications` to `LEDGER_RETENTION_DAYS` (Part 2 §11), 90 days | small — **DONE 2026-09-11.** `unread` + `limit(50)`, with the bell saying when the page is full; `notifications` joined `LEDGER_RETENTION_DAYS` (90 days) with its TTL override, writer stamp and backfill field. |
| B2 | **Schedule / calendar** | team events + org events — **no time bound**, ordered `start asc` (the sessions beside them are windowed) | fine for a year | every event ever, on every calendar open | **window** — reuse `useSessionsRange`'s shape keyed on the visible range, with a back-margin on `start` for multi-day events | small — **DONE 2026-09-11.** `useEventsInRange`, keyed on the visible window like the sessions beside it, with a 31-day back-margin on `start` for a camp that opened last month. |
| B3 | Appointments manager | availability exceptions — all time-off ever, rendered whole | fine for a year | one row per holiday per provider, forever | **window** `end >= today − 30d`; past rows are history nobody edits | tiny — **DONE 2026-09-11.** `end >= today − 30 d` on a new (`teamId`, `end`) index, and a caption under the list saying so. |
| B4 | Contacts page | contact requests — all ever, `requested_at desc` | small | a LOG; each signup form / update request adds a row | **status filter** (`pending`) in the query; history pages | tiny — **DONE 2026-09-11.** `status == 'pending'` on the index that already existed for it; every writer stamps a status. |
| B5 | Custom forms | submissions — all per form, rendered whole, **and the CSV export reads the same array** | correct | a lead form with 5,000 submissions renders 5,000 rows and builds the CSV in the browser | **cap + more** on the list; export moves to a callable that streams | small / half a day — **DONE 2026-09-11.** Paged at 50 with the footer; the export reads the whole set ITSELF, on the click — §18 point 4, built together. |
| B6 | Space (member portal) | `listMyContactPayments` — reads **all** of the contact's `member_payments`, sorts in memory, slices 100 | per person, so slow | a five-year member with a weekly drop-in habit is 250 reads for a 100-row answer | `orderBy('created_at','desc') limit(100)` with the composite index (`contactId`, `created_at`) | tiny — **DONE 2026-09-11.** `orderBy created_at desc limit 100` on a new (`contactId`, `created_at`) index; the emulator will not miss it, so the index declaration is the test. |
| B7 | Contact detail (web), Space, mobile | per-contact logs: alerts, notes, affiliations, goals + evaluations, documents, credit grants, subscription history | all unbounded, all per person | years of one person's history are hundreds of rows, not thousands | **accept** — record it; cap if a real contact ever proves otherwise | — |
| B8 | **Operator console** | `loadAccounts` — every team + org + SaaS subscription, then **one count aggregation per team**; signup allow-list all; feedback all | fine at tens of tenants | grows with TENANTS, the same axis as Part 2 §9: 1,000 studios = 1,000 aggregation queries per page view | contact counts from the nightly `platform_metrics` snapshot (or a per-team stored counter); the accounts table pages; allow-list and feedback **cap + more** | a day — **DONE 2026-09-11.** The per-tenant `count()` is gone: the console reads `teams/{id}/counters/contacts`, batched. `trackContacts` applies deltas (ONE rule, `liveContactCountDeltas` in shared, so a studio move is two deltas and not one), and the nightly job — which already computes the authoritative number — writes it back ABSOLUTE, so drift lasts at most a night. A missing counter is unknown, never zero, and the overview names how many tenants are uncounted rather than quietly reporting a smaller platform. `pnpm backfill:contact-counts` closes the window after deploy. The allow-list is capped and says so; feedback was already capped at 100. **The accounts TABLE still loads every tenant** — see below. |

### C. PER-ENTITY fan-outs — bounded, but with a multiplier

| # | Surface | Fan-out | Multiplier | Fix | Size |
|---|---|---|---|---|---|
| C1 | **Mobile** attendance calendar + training chart | `getContactAttendance`: one `participants/{me}` **read per session in the window** — the sessions come from one query, then one `getDoc` each | a month at a busy studio ≈ 150–200 reads per calendar open, per member; the chart adds the same over its weeks | a **`getMyAttendance` callable** (mirror of `getMyBookings`), or a collection-group query on `participants` where `contactId == me` with a `checkedInAt` range — the (`contactId`, `checkedInAt`) index the web's `useContactRecentSessions` already uses, and a contact session may read its own rows. Kills the fan-out outright | a day — **DONE 2026-09-11.** The `getMyAttendance` callable answers it in one collection-group query over her own rows plus one batched session read. The WINDOW is on the session's clock and the SCAN on the row's (`checkedInAt` ± 90 days), because a row confirmed from a booking is stamped BEFORE its session and a retroactive confirm after it; a scan that hits its cap says so. `myAttendance.test.ts` derives the set of member-app functions that touch a participant document and pins it by name, so the fan-out cannot return quietly. |
| C2 | Mobile profile agenda | `getSessionsWithParticipation` — same per-session check for the PAST half of ±7 days | ~20 reads per open | same fix as C1 | with C1 — **DONE 2026-09-11.** Same call — the agenda's past half comes from `getContactAttendance` rather than a read per past session. |
| C3 | Bookings page | per-session `bookings` fetch inside the window | already capped by `MAX_WINDOW_SESSIONS` | none | — |
| C4 | Session detail / peek, event people lists, check-in panel | participants + bookings per session; attendees + invitations per event | bounded by capacity / by the event; a 500-person camp renders 500 rows | none now; **DOM window** if a camp ever complains | — |
| C5 | Org teams page | per member studio: one `getDoc` + one members query | bounded by studio count | none | — |

## 18. What cannot be fixed cheaply — set the expectation now

These are the four places where a `limit` is not a fix, because the feature
*is* the whole set. The right move is to state the ceiling in the plan copy and
the onboarding conversation before a customer finds it.

1. **The roster pages are client-side by design, and that is the right
   design up to a size.** Filter presets, dynamic groups, the attention sort,
   the command palette's search — every one of them answers its question from
   a position that already holds the data (Part 1 recorded why for groups). At
   **≤ 3,000 live contacts per studio** this is a sub-second page and nothing
   in it is wrong. Past that, the attention sort is the first thing to go:
   it is *derived* (lapsed subscription, missed classes, unsigned waiver),
   so a server-driven list needs a **materialized attention score** — a
   nightly field on the contact plus an index — and the page becomes a
   server list with a search box. **That is a week, not a limit.** The
   expectation to set: the free, coach and studio tiers are for studios of up
   to about 3,000 live contacts; larger studios are an organisation-tier
   conversation, and an organisation lists per studio (next point).

   **Still open after Phase 4, and deliberately — it has a precondition.** A
   nightly field means a nightly pass over every live contact of every tenant,
   which is a NEW instance of the single-instance sequential scan Part 2 §9
   names as the load-bearing problem, added before §14 step 3 (the Cloud Tasks
   dispatchers) has fixed the ones already there. Building it now would put the
   week of work on the foundation this document says breaks first.

   There is also a design that needs NO sweep, and it is written down here so
   that when the ceiling arrives the week is a week of typing rather than a week
   of deciding. Of the reasons `contactAttentionReasons` returns, only two move
   with the clock (`gone_quiet`, `checkin_lapsed`); the other seven change only
   on a write, which `trackContacts` already sees. So: store the write-driven
   score on the contact (fixed-point guard, as `onEmbedWidgetsWritten` does), and
   express the two clock reasons as RANGE queries on the timestamps they already
   compare — `last_session_at` and `last_checkin_at`. The list is then three
   bounded queries merged, with the exact reasons recomputed on the ≤3N documents
   loaded, so it is not an approximation of the client answer but the same
   answer. What it costs is a SECOND roster path beside the client one, which is
   Part 1's whole subject — so it is worth building once, late, and not twice.
2. **An organisation never lists a roster.** A11 is the only page that does,
   and at federation scale it cannot: the org level gets counts per studio and
   status, and drills into one studio's page. This is a product decision as
   much as a fix, and it should be made before the first 20-studio org signs.

   **DONE 2026-09-11.** The studio picker now scopes the QUERY rather than
   filtering rows the page already downloaded, so choosing a studio reads that
   studio's people and nobody else's. Above `ORG_ROSTER_CAP` people on the
   federation's books, "all studios" is refused — with a route, never silently:
   the page shows one row per member studio with its count, and each row is the
   way in. The counts are one `count()` per studio, bounded by the studio count
   inside one organisation rather than by the contact count.

   Per studio and NOT per studio × status, which is the one deviation from the
   sentence above: the status lives on the affiliation document rather than the
   contact, so a status breakdown would be an aggregation per pair — the very
   fan-out this replaces. The breakdown appears once a studio is chosen, from
   the affiliations that view already holds.
3. **Firestore has no text search.** Contact search is a client-side scan of
   the loaded roster, which is exactly right at the ceiling above and wrong
   beyond it. The answer past it is an external index (Algolia / Typesense)
   fed by a sync trigger — real money and real drift surface (Part 1 §6), so
   **not before a customer needs it**, and the ceiling above is what makes
   that safe to defer.
4. **Client-side exports read the loaded array.** The forms CSV (B5) is
   correct only while the list is whole. The moment a list is paged, its
   export has to become a callable — build the two together, or the export
   silently ships the first page. The same rule binds any export added later
   to a list in §17.

   **DONE 2026-09-11, and it was mostly already true.** The three exports over
   unbounded sets — contacts, the finance report, a member's consent history —
   were callables before this pass; the forms CSV was fixed in Phase 1; every
   remaining browser-built CSV reads one entity's rows or one period's. What was
   missing was the GATE, since the forms case proves the rule is easy to break
   silently: `contacts/exportSites.test.ts` enumerates every CSV the web app
   builds and the reason each is bounded, and a new one fails the build until it
   is justified or moved to a callable.

## 19. The plan, in order

| Phase | What | Rows | Size |
|---|---|---|---|
| **1 — bound the LOGs** | notifications `unread` + `limit(50)` + retention; events on the schedule windowed like sessions; availability exceptions from today; contact requests `pending`; form submissions cap + more; referrals cap + more and names by id; gamification `limit(50)`; waiver signers paged; archived tab cap + more; Space payments `orderBy + limit`; member subscriptions live-status default | B1 B2 B3 B4 B5 B6 A2 A8 A9 A12 A13 | **DONE 2026-09-11**, a day as sized. Two deviations, each recorded on its row: A2's sidebar search keeps the whole read; A12's read stays whole and its table pages. |
| **2 — one roster read, windowed** | every roster read goes through `useActiveContacts` (the dashboard, session detail, check-in, contact groups, affiliations and referrals each fetch their own copy today); `@tanstack/react-virtual` on the contacts, affiliations and org-affiliations tables; `getCountFromServer` for the dashboard headcount and manual-group counts | A1 A4 A5 A7 A10 | **DONE 2026-09-11**, under the two days. Two decisions, each on its row: the count aggregations were not added (A4, A7 — the pages hold the roster anyway, so a count is a read on top of the read, not instead of it); the affiliations page keeps its own read (A10 — it needs the archived). |
| **3 — kill the fan-outs** | `getMyAttendance` callable for the mobile calendar, chart and agenda; operator console counts from a stored per-team counter + a paged accounts table | C1 C2 B8 | **DONE 2026-09-11**, except the accounts table (below). |
| **4 — when a customer approaches the ceiling** | materialized attention score + server-driven roster list; org-level counts + per-studio drill-down; export callables | §18 1, 2, 4 | **PARTLY DONE 2026-09-11.** §18.2 (org counts + drill-down) and §18.4 (exports, plus the gate that keeps them honest) shipped. §18.1 is the one left, and it stays left: it needs an all-tenant nightly pass, which is §14 step 3's job to make safe first. Its no-sweep design is written down in §18.1 so the wait costs nothing. |

**Deferred out of Phase 3, with the reason: the operator console's accounts
table.** The plan said page it. Paging it saves nothing while the OVERVIEW on
the same request needs every tenant to compute the platform metrics — the table
would page and the read behind it would not. What actually made that page cheap
was the per-team counter (B8), which removed the aggregation per tenant; what
remains is one document read per tenant, which is the same axis as §9's
scheduled jobs and wants the same answer. Page the table when the overview
stops summing rows — i.e. when it reads the nightly snapshot instead — and do
the two together rather than shipping the half that looks like progress.

Two rules for the work, both learned in Part 1:

- **Honest truncation over silent truncation.** Every cap ships with the
  `tooWide` / `truncated` posture the bookings page and contact detail already
  have: the page says when it is not showing everything. A bare `limit` that
  hides rows without saying which is the one shape not to add (the header of
  `useMemberSubscriptions` says why in the money context, and it generalises).
- **A tripwire, so the census does not rot — landed with Phase 1.**
  `scripts/census-reads.mjs` (`pnpm census:reads`, in CI's Lint job beside the
  locale check) names the LOG collections, scans every direct `getDocs` /
  `onSnapshot` in the web and member apps, and fails on a read of one that
  carries no `limit`, cursor or range and is not acknowledged in the script
  with a reason — a stale acknowledgement fails too, so a bound added later
  retires its own exemption. The same shape as the path-literal tripwire in
  Part 1 §7. What it cannot see: a query built in a helper far from its read,
  and anything behind a callable — §17 stays the census a person keeps.
