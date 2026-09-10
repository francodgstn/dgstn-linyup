# Scalability — September 2026

**The thing that does not scale here is not the database. It is the number of
surfaces.**

Linyup ships the same product through four front ends — the admin web app, the
public Space, the member mobile app, and the operator console — plus one backend.
Every member-facing feature is therefore written between two and four times, and
the cost is not the typing. It is that the copies **drift**, and drift in this
codebase has already destroyed member data.

This document records what the coaching build (August–September 2026) taught
about that, what has since been fixed, and what is still owed. It is about
engineering scale, not tenant count; where per-tenant limits are relevant they
are called out under "Runtime rules already in force".

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

### Drifted, still owed — each needs care, not a sed

10. **Primary rank resolves differently.** Web's `getPrimaryRank` picks the
    first system the contact *holds a rank in* and, for an orphaned value, the
    nearest lower level; mobile's `resolvePrimaryRank` picks the first
    *configured* system and shows nothing for an orphan. A member ranked only
    in a studio's second scale has a belt in admin and none in the app. Belongs
    in `packages/shared/src/utils/rankingSystems.ts`; the return shapes differ.
11. **`resolveAffiliationTerm` has two fallback chains.** Web falls through to
    the first *filled* translation so a studio that entered only German gets it
    everywhere; mobile falls straight to the English word "Affiliation". The
    device-vs-chosen locale question is item 18; the missing fallback arm is a
    plain bug regardless of it.
12. **"One check-in per day per author" is implemented three ways.** Mobile
    runs a real range query; the Space scans the ten most recent in memory;
    the admin does not dedupe at all, so a coach can leave several 1:1
    check-ins on one day. The timestamp source differs too (client clock,
    server timestamp, caller-supplied), which is precisely what the day-window
    compares. The payload builder and the same-day predicate are pure and
    belong in shared; the query strategy can legitimately differ.
13. **The Space never uses the regional formatter.** Twelve bare
    `toLocaleDateString()` calls, which `lib/format.ts` warns against in its
    own header — an en-US browser shows US dates and 12-hour times inside a
    German portal. Mobile pins `hour12: false` in seven places; the Space omits
    it. The same goal reads "15 Sep 2026" on the coach's tab and in the app,
    and "9/15/2026" on the member's portal. `createRegionalFormatter` is
    already in shared; the Space needs a `useSpaceFormat` built on the public
    team's regional settings.
14. **The luminance formula exists four times with two thresholds** — three
    YIQ copies (`> 0.5`, `> 0.5`, `>= 0.6`) deciding black-vs-white text on the
    same studio accent, plus a fourth, correct WCAG pair in
    `apps/mobile/src/utils/color.ts` that disagrees with the other three for
    mid-tones. Promote the WCAG pair to shared; retire the rest.
15. **Two ISO-week key generators.** `apps/web/src/lib/isoWeek.ts` (UTC
    midnight) and shared's `isoWeeks.ts` (UTC noon, "to avoid DST edges") emit
    the same key grammar today. The shared one also carries
    `densifyWeeklyCounts`, whose absence is the exact "flat, healthy sixteen-
    week line" bug its header documents — and the dashboard trend cards still
    build sparse windows by hand.
16. **The `default` performance profile is shown on two surfaces and hidden on
    the third.** A member whose check-in matched no pattern sees an
    explanatory card on the portal and nothing in the app. A copy decision;
    the vocabulary map is the thing to share (item 22).

### Not yet drifted, cheap — the next edit to any of these drifts it

17. **Star ratings, three implementations.** Two are React DOM in the same app
    and differ only in where the empty-star colour comes from — the identical
    situation `GoalProgressBar` was in. The `value: 0 means unset` invariant is
    restated in all three headers.
18. **`GoalStateChips` twice, both DOM.** The Space's own header calls it "the
    admin's twin". Same palette-prop shape as `GoalProgressBar`.
19. **Badge thresholds, the same nine numbers in three files** — and the
    Space's flat `BADGE_DEFINITIONS` has no override path. One edit in the
    admin editor away from a studio seeing one set on the portal and another
    in the app. `DEFAULT_BADGE_THRESHOLDS` beside the type it already owns.
20. **`BeltBadge` re-derives the precedence `rankLevelBadge` exists to own**,
    from four loose colour/emoji/image props. Its own header names the shared
    function it is re-implementing.
21. **`initials()` is written out eleven times** across web and mobile;
    `avatarColor` + its palette twice, byte-for-byte, in `apps/web`.
22. **Colour and label maps for `GoalStatus` and `ProfileKey`, each declared
    two or three times** — the mobile hexes are the resolved values of the
    admin's Tailwind classes. Wants one hex map both derive from.
23. **Shadowing types.** The admin gamification page declares its own
    `GamificationSettings` — same name as shared's, different shape, in an app
    that imports shared everywhere else. `Leaderboard`/`LeaderboardEntry`
    exist in mobile and again as `SpaceLeaderboard*` with a nullability
    difference. `ShownSubscription` casts away `status` from shared's
    `ActiveSubscriptionSummary` rather than extending it.
24. **Goal and evaluation dialogs twice, both DOM.** The field sets genuinely
    differ (a member cannot set a start date or reparent), so this wants one
    form with capability props rather than a merge. Item 4 came from here.

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
