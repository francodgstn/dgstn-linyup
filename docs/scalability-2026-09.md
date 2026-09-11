# Scalability — September 2026

**The thing that does not scale here is not the database. It is the number of
surfaces.**

Linyup ships the same product through four front ends — the admin web app, the
public Space, the member mobile app, and the operator console — plus one backend.
Every member-facing feature is therefore written between two and four times, and
the cost is not the typing. It is that the copies **drift**, and drift in this
codebase has already destroyed member data.

This document has two parts. **Part 1** (§1–§7) records what the coaching build
(August–September 2026) taught about that, what has since been fixed, and what
is still owed — engineering scale, not tenant count. **Part 2** (§8–§14) is the
runtime side: the scheduled jobs, the ledgers, the cost model and the limits
that bind first as the tenant count grows. It was the first analysis of this
pass and was left out when the file was first assembled; it is restored below
with what has since been done against it.

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

25. **A shared constant for `public_profile` and for session `bookings`, then a
    sweep.** `packages/shared/src/paths.ts` names the user public profile and
    the coach-slot bookings and nothing else — so the *general* mirror
    subcollection every public surface queries, and the session bookings every
    rail writes, are hand-typed: nineteen `'public_profile'` and five
    `'bookings'` in the web, plus a local `BOOKINGS_SUB` alias, plus two in
    mobile. Not urgent because the strings are stable; worth doing because
    "stable" is exactly what every hand-copied shape in §1 was, until it was
    not.
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

## 13. Secondary limits, roughly in the order they bind

- **App Check is implemented but off** (`docs/app-check-rollout.md`) ✓. Public
  routes query Firestore directly from the browser via
  `collectionGroup('public_profile')`. Until enforcement is on, anyone can drive
  unmetered reads against the bill from a script. Cheapest risk to close, and
  the runbook exists; step 1 is a Console registration nobody can script.
- **There was no `maxInstances` on any Cloud Function** ✓ — `setGlobalOptions`
  set only the region. A trigger loop or a traffic spike scaled into the
  regional quota with no ceiling. Now capped (§14); the billing budget module is
  applied in prod terraform (`infra/environments/prod/main.tf`, `budget_amount`).
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
| 2 | App Check on + global `maxInstances` + budget alert | small | **`maxInstances: 20` DONE** (a cost ceiling, per function; a hot callable overrides locally). **Budget:** the module is applied in prod terraform — confirm `budget_amount` and the alert recipients. **App Check:** follow the runbook; step 1 (register the web app in the Firebase Console) is yours. |
| 3 | Convert the four sequential crons to Cloud Tasks dispatchers, `rollSessionSeries` as the template; `sendBookingReminders` first | ~a week | Not started. The load-bearing one for growth. |
| 4 | Decide course-video hosting before the plugin has real usage | decision | Yours. Retrofitting a CDN after members hold URLs is far worse than choosing now. |
| 5 | `sent_cumulative` as a stored counter | small | **DONE.** Carried forward from the last snapshot that has one plus the days since; seeded once from the whole ledger; a failed snapshot read yields no block rather than a wrong total. The operator console's "Emails (total)" reads it, and a studio's figure is labelled with the window it covers. |

Steps 1, 2 and 5 are small and are in. Step 3 is a week or so. None of it is
architectural — the data model is sound, and nothing here requires reshaping
collections or the tenant boundary.
