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

---

## 7. Still owed

Ranked by value per unit of work.

**Easy, do now**

1. **One `GoalProgressBar`, not two.** The admin and the Space each carried a
   copy; they were structurally identical and differed only in where colours
   came from (Tailwind semantic tokens vs `useSpaceTheme`). Both are React DOM
   in the same app. This was §1 in miniature, freshly created. DONE — it lives
   at `apps/web/src/components/coaching/GoalProgressBar.tsx` with colour as an
   optional `palette` prop: absent means the app's semantic tokens, present
   means the tenant's.
2. **Mobile hardcoded path literals that `@linyup/shared` owns** — `contacts`,
   `push_tokens`, `participants`. The dependency now resolves, so these are
   simply imported. DONE.

   Two others looked like the same fix and were not: **`public_profile` and
   `bookings` have no general constant in `packages/shared` at all.** The only
   ones there are scoped to users (`USER_PUBLIC_PROFILE_SUBCOLLECTION`) and
   coach slots (`COACH_SLOT_BOOKINGS_SUBCOLLECTION`). The *web* hardcodes
   `'public_profile'` nineteen times and `'bookings'` five more, plus a local
   `BOOKINGS_SUB` alias. So mobile's two remaining literals are not a mobile
   gap — they are the visible edge of one string hand-typed across every
   surface. Fixing that is a shared constant plus a sweep of every site, which
   is a change of its own; see "Worth doing" below.
3. **`SessionPublicProfile` meant two different things.** Mobile declared its
   own with `start: Date` / `end: Date` and an `id`; shared's has `start:
   Timestamp` / `end: Timestamp` and no `id`. Both were correct — mobile's is
   the *hydrated* shape after `mapSessionPublicProfile`, shared's is the wire
   shape — but one name for two shapes would have misled someone. DONE — the
   mobile one is now `HydratedSession`, and its doc comment says why it is not
   the shared name, so it is not "fixed" back.

**Worth doing, not urgent**

4. **A shared constant for `public_profile` and for session `bookings`, then a
   sweep.** `packages/shared/src/paths.ts` names the user public profile and the
   coach-slot bookings, and nothing else — so the *general* mirror subcollection
   that every public surface queries, and the session bookings every rail
   writes, are hand-typed strings: nineteen `'public_profile'` and five
   `'bookings'` in the web alone, plus a local `BOOKINGS_SUB` alias, plus two in
   mobile. A rename of either would today be a grep-and-hope across two apps.
   Not urgent because the strings are stable; worth doing because "stable" is
   exactly what every hand-copied shape in §1 was, until it was not.
5. Push cannot deliver until an FCM V1 service account and an APNs key are
   uploaded to EAS. Recorded in the mobile-release store-submission checklist.
   Tokens registered before then are still valid; nothing is lost.
6. The emulator-backed integration suite (`test:integration`) does not run in CI
   — it needs a built `dist/` and the functions emulator. It covers the counters
   that feed contact triage, where a wrong value does not throw.
7. Org-scoped coaching dimensions; the editor is team-only.
8. `resolveAffiliationTerm` resolves its own four locales over a studio-authored
   map using the *device* locale, outside React. It is deliberately not wired to
   the app's chosen-locale system — doing so is a behaviour change, not a string
   migration.

**Decide, do not drift**

9. What the app sends. The capability exists; what is worth interrupting somebody
   for is a product judgement, and it now ships over the air.
10. Whether the app's scope should shrink to what only an app can do, rather than
   tracking the portal.
