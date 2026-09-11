# HMD → Linyup SaaS Migration

Migrates all data from `hmd-lineup` (Firebase prod) into `dgstn-lineup` (Linyup SaaS).

---

## Preliminary steps (manual, do once before running the script)

**1. Get the source service account key** and place it at:

```
keys/hmd-prod-sa.json        ← hmd-lineup production service account
```

To generate the key: Firebase Console → select the `hmd-lineup` project → Project Settings → Service accounts → Generate new private key. Download the JSON and save it as `keys/hmd-prod-sa.json`.

> `keys/` is gitignored. Never commit service account files.

**2. Confirm ranking system IDs** in `scripts/migration/config.ts` (`RANKING_HMD`, `RANKING_KD`).
These map the old single `rank` field on contacts to the new `ranks` map.

The organisation document, org_admin member entry, and Firebase Auth users are all migrated automatically. The **auth-users pass** calls the Firebase Identity Toolkit API directly using the source service account, downloads all user records including password hashes and the SCRYPT hash config, then imports them into the target with `importUsers()` — so users log in with the same password they had in the source project. No manual export step needed.

**3. Grant the SOURCE service account `Firebase Authentication Admin`** on the
`hmd-lineup` project (role `roles/firebaseauth.admin`). Passwords need TWO
things, from two different APIs: the per-user hash + salt, which
`v1 …/accounts:batchGet` returns to any reader, and the project's SCRYPT signer
key, which only `v2 …/projects/{id}/config` returns and only to a caller holding
`firebaseauth.configs.getHashConfig`. Without the grant the pass falls back to
creating accounts **with no password** — every migrated owner would need a reset
link on day 0.

**Confirm it before the real run**, with the dry-run census (reads only, writes
nothing, and it is the same census the real run performs):

```bash
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json --target-creds ./keys/linyup-prod-sa.json \
  --dry-run --only auth-users --live "Basel,Ardovini"
```

It must print `hash config: SCRYPT, …` and `hashes: true`, and the last line says
how many accounts would keep their password, how many collided with an existing
target login, and how many are outside the activation list.

---

## Migrating into the local emulator (recommended first step)

Start the emulators first:

```bash
pnpm emulators:start
```
It will start all needed emulators, project `demo-linyup`.

Then run against the emulator target — no target credentials needed:

```bash
pnpm migrate:hmd \
  --source-creds ./keys/hmd-prod-sa.json \
  --target-emulator \
  --dry-run
```

Remove `--dry-run` to actually write:

```bash
pnpm migrate:hmd \
  --source-creds ./keys/hmd-prod-sa.json \
  --target-emulator
```

Inspect the result in the emulator UI at http://localhost:4000, then start the dev server and open `/contacts`, `/sessions`, and `/events` to confirm no rendering errors.

**Save the migrated state as a reusable snapshot** (while the emulators are still running):

```bash
pnpm emulators:export:hmd
```

From then on, use `pnpm emulators:hmd` to reload this snapshot instead of re-running the migration.

---

## Migrating into staging / production

**Always dry-run first:**

```bash
pnpm migrate:hmd \
  --source-creds ./keys/hmd-prod-sa.json \
  --target-creds ./keys/linyup-staging-sa.json \
  --dry-run
```

**Full migration:**

```bash
pnpm migrate:hmd \
  --source-creds ./keys/hmd-prod-sa.json \
  --target-creds ./keys/linyup-staging-sa.json
```

---

## Options

| Flag | Description |
|---|---|
| `--source-creds <path>` | Service account JSON for hmd-lineup source (required) |
| `--target-creds <path>` | Service account JSON for target project |
| `--target-emulator` | Write to local Firestore emulator instead of a real project |
| `--org-admin-email <email>` | Email of the org creator + org_admin (default: `franco.dgstn@gmail.com`) |
| `--dry-run` | Log writes without committing |
| `--overwrite` | Re-apply the current transforms to docs that already exist on the target (default: skip them) — see **Re-running over a populated target** below |
| `--only <pass>` | Run a single pass (see pass names below) |
| `--from-team <teamId>` | Resume contacts/sessions passes from a specific team |
| `--teams <a,b>` | Import only these clubs, by name or id. A **sample** for rehearsing a transform, and the **scope of a per-club catch-up** at a wave (`--only contacts --teams X --overwrite`). Never for a real project's *initial* import — see "Activation and waves" |
| `--live <a,b>` | **The activation list** — which clubs go live on this target. Everything is imported; only these clubs' members get a login (`auth-users`) and only these clubs and the org may send mail (`activation`). **Required** for a full run into a real project; **cumulative** across waves |
| `--verify` | Run verification after migration |

Pass names: `setup` · `auth-users` · `users` · `teams` · `activities` · `session-series` · `contacts` · `sessions` · `events` · `exam-checkins` · `cup-checkins` · `event-categories` · `referrals` · `team-subcollections` · `places` · `org-website` · `season-calendar` · `activation` · `affiliations` · `verify`

**Run a single pass** (e.g. after a failure mid-way):

```bash
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json --target-emulator --only contacts
```

**Resume from a specific team:**

```bash
pnpm migrate:hmd ... --only contacts --from-team <teamId>
```

---

## Activation and waves — how the federation goes to production

**The whole federation is imported at once; clubs go live one wave at a time.**
The org's events (the cup, the exams) carry check-ins from every club's contacts,
so a partial import leaves dangling references, `org_teams` shows a fraction of
the federation, and `verify` compares only what was asked for. A full import
costs nothing for a dormant club *provided nobody can act on it* — which is
what `--live` guarantees:

| | live club | dormant club |
|---|---|---|
| data (contacts, sessions, plans, check-ins) | imported | imported |
| logins (`auth-users`) | members imported, same passwords | **not imported** — nothing an owner could edit that the wave's catch-up would clobber |
| messaging policy (`activation`) | `live` | **`silent`** — no seeded automation reaches people who have never heard of Linyup |
| org (`hmd`) | `live` | — |

**Day 0** (after the staging rehearsal below):

```bash
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json --target-creds ./keys/linyup-prod-sa.json \
  --live "Basel,Ardovini" --dry-run          # census: who gets a login, which emails collide
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json --target-creds ./keys/linyup-prod-sa.json \
  --live "Basel,Ardovini" --verify
```

**A later wave** — the club's data is caught up from the source (it was dormant,
so nothing in Linyup is lost), its members get logins, and the activation list
is re-stated **with every club that is live by then**:

```bash
pnpm migrate:hmd ... --only contacts            --teams Marzella --overwrite
pnpm migrate:hmd ... --only sessions            --teams Marzella --overwrite
pnpm migrate:hmd ... --only team-subcollections --teams Marzella --overwrite
pnpm migrate:hmd ... --only auth-users          --live "Basel,Ardovini,Marzella"
pnpm migrate:hmd ... --only activation          --live "Basel,Ardovini,Marzella"
```

**The licence record stays with the old system** until the organisation's
managers move. `--only affiliations --teams "Basel,Ardovini"` re-derives every
migrated contact's affiliation rows from the source through the same transform
pass 05 used — including an archived person's coercion to `expired` and the
row's `contact_live` — and deletes a positional row the source no longer
justifies. Rows the organisation created *in Linyup* (generated ids) are never
touched; `affiliation_summary` is left to `onAffiliationWrite`, its one writer.
Run it weekly, or after every renewal batch, until the org moves.

**The org admin's login.** Every pass that writes a row in the admin's name
resolves the uid from the **target's auth first** (`migration/orgAdmin.ts`) —
on production that is the account that signed up months before this ran, and
it differs from the source uid. The source membership row is re-keyed to it
(`team_members`), the source profile document is skipped (`users`), and the
source auth account is not imported (the collision guard). Any *other* source
email already on the target under a different uid is reported as a
`COLLISION` and skipped, never duplicated.

**Staging is the dress rehearsal**, and it is run the way production will be —
a fresh import, not an overwrite:

```bash
pnpm reset:org --org hmd --target staging        # HMD only; testers' tenants untouched
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json --target-creds ./keys/linyup-staging-sa.json \
  --live "Basel,Ardovini" --verify
```

## Re-running over a populated target — read this first

**Every pass is skip-if-exists, so by default a re-run is an INSERT-MISSING
operation, not an APPLY-TRANSFORMS one.** Re-running the migration against a
target that already holds a previous run therefore delivers **none** of the
transform fixes shipped since that target was last migrated. It does not warn,
and `--verify` does not catch it: verification compares **counts**, the counts
still match, and it prints "All counts OK" over stale content.

This is not hypothetical. A full re-run against staging on 2026-08-30 reported
success while leaving 23 events typed `fighting_cup` and 1947 check-ins stamped
with it — the exact remap `mapSourceEventType` exists to perform — because pass
08's remap lives in the `else` branch of its skip guard. It cascaded: pass 09's
cup passes select their input with `where('type','==','hmd_fighting_cup')`, found
zero events, and wrote nothing, so `checkin_data.categories` stayed empty for
every cup competitor. The same run skipped all 1634 contacts, so the ranking
changes in `transforms/contacts.ts` never landed either.

**Use `--overwrite` whenever a transform has changed since the target was last
migrated.** The tell that you needed it: a pass reporting a large `skipped` count
where a fresh target reports a large `wrote` count.

```bash
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json   --target-creds ./keys/linyup-staging-sa.json --overwrite
```

It re-writes migrated source documents — contacts, activities, session series,
events, check-ins, referrals, team subcollections, places — so **any edit made to
one of those through the app is replaced by the source's version.** That is the
point of the flag, and the reason it is not the default.

These stay guarded even under `--overwrite`, because their target state is
authored locally and the source has no copy to give back. **This list is the
census** — `config.ts` points here rather than restating it, so a new guard is
added in one place:

- the org doc + installed plugins (pass 00)
- the **team doc** (pass 02) — it carries the Connect/payments block,
  `bookingSettings` and `plan`
- the **session doc** (pass 06) — `bookings_count` is maintained by
  `trackBookings` from the live bookings subcollection
- the org admin's `team_members` row (pass 11) and the org website draft/published
  docs (pass 13)

---

## Verification

Runs automatically at the end of a full migration. To run standalone:

```bash
pnpm migrate:hmd --source-creds ./keys/hmd-prod-sa.json --target-emulator --only verify
```

Checks doc counts (source vs target) for all top-level collections, plus spot-checks 3 contacts per team (goals + subscription_history subcollections).

---

## What is and isn't migrated

| Collection | Action |
|---|---|
| `users` | Copied as-is (Auth UIDs must match — step 4 above) |
| `teams` | Copied + `plan: 'studio'`, `organizationId: 'hmd'` added |
| `activities` | Copied + new fields (`slug`, `type`, `isActive`, `level`) |
| `session_series` | Copied + recurrence field names normalised |
| `contacts` + subcollections | Copied; `rank → ranks.hmd`; `notes` dropped; `type` → acquisition axis (`acquisition_stage`/`entry` + milestone timestamps); `type: external` → the **External lifecycle bucket** (`external: true`, `external_since` ← `created_at`, journey from attendance only — never `joined`, no tag); `acquisition.channel` → `source` (+ `source_detail`), `acquisition.acknowledged` → `lead_acknowledged`; membership fields → **affiliations** (see below) |
| `sessions` + participants/bookings | Copied + activity name/type enriched |
| `events` + invitations/attendees | Copied as `scope='org', orgId='hmd', teamId=null` |
| Global `checkins` (event check-ins) | Migrated from the top-level `checkins` collection where `event.id == eventId`; doc IDs preserved; `completed_checkins_count` set on each event doc |
| Exam check-in results (`exam-checkins`) | hmd-lineup kept the result at the TOP LEVEL (`exams.hmd_rank` / `kd_rank`, `is_graded`); Linyup reads `checkin_data.disciplines: { [systemId]: level }`. Remapped in place, `is_completed` recomputed. **Nothing is deleted** — the legacy payload is copied to `checkin_data.legacy` and also left where it was, because `is_graded` records that the award was already applied and is what stops a later rank backfill promoting somebody twice |
| Fighting-cup check-in entries (`cup-checkins`) | The same top-level drift as the exam payload: hmd-lineup stored `categories` and `weight` on the check-in itself, Linyup reads `checkin_data`. Without the remap a migrated cup entry opens EMPTY — no divisions ticked, no weight — with the competitor's entry sitting one level up in the same document. **Nothing is deleted**; the legacy fields are copied to `checkin_data.legacy` and left in place. `is_completed` is deliberately NOT recomputed here: the stored value is the source app's own record of what a grader decided, and it is a better answer than re-deriving it |
| Event type slug (`events`) | hmd-lineup's `fighting_cup` becomes Linyup's `hmd_fighting_cup` — the id the plugin declares. Plugin resolution is an exact match, so unmapped every migrated cup lost its Categories tab, its check-in form and its export, and the rank-progression engine (which matches participation on these ids) would never count a cup toward the one-camp-one-tournament-one-exam requirement. The map is `SOURCE_EVENT_TYPE_MAP` in `migration/config.ts`; the denormalised copy on each check-in is remapped with it. `traditional_cup` is deliberately NOT mapped — Linyup has no equivalent and collapsing it into `competition` would merge two things HMD tells apart |
| Fighting-cup categories (`event-categories`) | hmd-lineup kept categories in a **global** `categories` collection; Linyup keeps them per-event. Only the ids a migrated check-in actually references are copied to `events/{eventId}/categories/{categoryId}`, doc id preserved so the existing arrays resolve |
| `referrals` | Copied as-is |
| Team subcollections | Copied from source (several with a field-rename/flatten transform — see "Team subcollections pass-through" below); **canonical subscription types are seeded** (see below); `public_profile` is deliberately **not** copied — it's fully derived, see that section |
| `coach_availability` / `coach_slots` | **Skipped** — appointments were preview-only; configure fresh |
| Session-level `checkins` | **Skipped** — session-level checkins (docs without `event.id`) are not migrated; the new schema is event-level only |
| `saas_subscriptions` | **Not migrated** — create one per team manually after migration |
| `courses` (Online Courses) | **Not migrated** — net-new in Linyup; create courses in-app post-migration |
| `documents` / `waiver_policy` (Documents & Waivers) | **Not migrated** — hmd-lineup has no equivalent collection (see `firebasePaths.js`); every migrated team starts with zero documents and no waiver policy. This is a safe default, not a gap to fill: the booking gate (`packages/functions/src/waivers/gate.ts`) fails CLOSED on an absent policy, so a migrated team behaves as "no waiver required" until the studio authors one. Studio authors documents/waivers post-migration via `/plugins/documents`; `scripts/backfill-document-versions.ts` only matters once a document exists to backfill, so migration has nothing to run it against. |

---

## Canonical subscription types (pass 11)

Pass 11 (`team-subcollections`) seeds five canonical subscription types into every team's
`subscription_types` subcollection. These are written with `set()` (no skip-if-exists) on
each run, so running `--only team-subcollections` again will refresh them to the latest
prices without touching other existing subscription types.

Seeded types (source: HMD Basel published pricing, confirmed from
`hmdbasel-website-astro/src/content/pricing-plans/en/`):

| id | Name | Prices |
|---|---|---|
| `essential` | Essential | CHF 60/month, CHF 600/year |
| `students` | Students | CHF 70/month, CHF 660/year |
| `unlimited` | Unlimited | CHF 85/month, CHF 840/year |
| `intro_offer` | Intro Offer | CHF 100 one-time (2 months included) |
| `one_time_class` | One-time Class | CHF 25 one-time (1 month included) |

## Subscription contact matching (pass 05, HEURISTIC — validate after run)

During pass 05 (`contacts`), each contact's `subscription_type_name` from the source is
matched to a canonical type by case-insensitive keyword:

- Contains "intro" → `intro_offer`
- Contains "one", "single", or "drop" → `one_time_class`
- Contains "unlimited" → `unlimited`
- Contains "student(s)" → `students`
- Contains "essential" → `essential`

On match, `subscription_type_id`, `subscription_type_name`, `subscription_price_id`,
`subscription_amount`, and `subscription_recurrence` are rewritten to canonical values.
If the source `subscription_recurrence` contains "annual" or "year", the annual price is
used; otherwise monthly. One-time types always use their single price.

If no keyword matches, the contact's subscription fields pass through unchanged.

**The matching is heuristic.** Pass 05 logs matched vs. unmatched counts per team.
Review those counts against the real source data and adjust `KEYWORD_MAP` in
`scripts/migration/transforms/subscriptions.ts` if needed before migrating to staging.

---

## Team subcollections pass-through (pass 11) — verified

Pass 11 copies `team_members`, `subscription_types`, `subscription_transitions`,
`outreach_templates`, `automation_rules`, `team_invitations`, `contact_requests`,
`team_alerts`, `alert_presets`, `leaderboard`, `activity_log`,
`team_weekly_reports` (list: `scripts/migration/passes/11-team-subcollections.ts`).
`public_profile` is deliberately excluded from this list — see its own section
below. Every remaining subcollection has now been checked field-by-field
against a current Linyup reader (a component in `apps/web`/`apps/mobile`, a
callable in `packages/functions`, or `firestore.rules`), following the same
source-vs-target read `subscription_types` and `automation_rules` got in an
earlier session.

| Subcollection | Verdict | Evidence |
|---|---|---|
| `team_members` | **SAFE** | HMD writes exactly `{userId, teamId, role, joined, addedBy}` (`hmd-lineup/functions/src/utils/teams.js:219-241`, `addTeamMember`) — a strict subset of Linyup's `TeamMember` (`packages/shared/src/types/team.ts:497-519`). Pass 11 already denormalizes `capabilities`/`scope` via `memberCapsFor` (`scripts/lib/roles.ts`) for every HMD role (`owner`/`manager`/`viewer` ⊂ Linyup's `TeamRole`). `is_coach?`/`roleUpdatedAt?` are optional with documented absent-means-default. |
| `subscription_types` | **SAFE** | Unchanged from the earlier session's finding — see below this table. |
| `subscription_transitions` | **SAFE** | HMD's `onContactSubscriptionChange` writes `{contact_id, from_subscription_type_id, from_subscription_type_name, to_subscription_type_id, to_subscription_type_name, recurrence, changed_at, termination_reason, team_id}` (`hmd-lineup/functions/src/onContactSubscriptionChange/index.js:122-133`) — a strict subset of Linyup's port (`packages/functions/src/sync/onContactSubscriptionChange.ts:123-135`, which adds `subscription_price_id`/`amount`). No client anywhere reads this collection today (grepped `apps/web`, `apps/mobile`) — it's a write-only analytics log for a dashboard not yet built — so even the two added fields being absent on migrated rows is inert. |
| `outreach_templates` | **SAFE** | HMD's default/created shape is `{name, subject, body, body_mode: 'text', type: 'general', language: 'en', active: true}` (`hmd-lineup/src/routes/TeamSettings/components/OutreachTab/OutreachTab.js:265-273`, `DEFAULT_TEMPLATE`). Linyup's `OutreachTemplate` (`apps/web/src/app/[locale]/(auth)/settings/emails/TemplateEditor.tsx:47-56`) is `{id, name, subject, body, body_mode?, language, active, system_key?}` — every HMD field is present under the same name; the extra `type` field is unread, harmless. `system_key` absent on a migrated template correctly sorts it as "custom" (`SettingsEmailsPage`, `settings/emails/page.tsx:59-62`), which is the honest classification — an HMD template is not one of Linyup's canonical stock templates. `sendOutreachEmail` (`packages/functions/src/outreach/index.ts:82-88`) reads `template.active`/`.subject`/`.body`/`.name` — all present. |
| `automation_rules` | **One confirmed break, fixed; one confirmed gap, flagged, not fixed.** | Unchanged from the earlier session's finding — see "Automation rules" below. |
| `team_invitations` | **BROKEN, fixed** (`scripts/migration/transforms/team-invitations.ts`) | HMD writes `{email, role, token, status:'pending', message, sentAt, sentBy, sentByName, expiresAt, teamId, teamName}` (`hmd-lineup/functions/src/sendTeamInvitation/index.js:202-214`). Linyup's port (`packages/functions/src/teams/sendTeamInvitation.ts:75-86`) renamed three of those fields: `sentAt`→`created`, `sentBy`→`invitedBy`, `expiresAt`→`expires_at`. Three concrete failures from the mismatch: (1) the members list orders `orderBy('created', 'desc')` (`apps/web/src/app/[locale]/(auth)/settings/members/page.tsx:429`) — Firestore excludes docs missing the ordered field, so a migrated pending invite never appears in the list; (2) `acceptTeamInvitation` reads `invitation.expires_at` to refuse an expired link (`packages/functions/src/teams/acceptTeamInvitation.ts:20`) — absent, so `undefined < new Date()` is always `false` and expiry never fires (fails open); (3) the same callable passes `invitation.invitedBy` straight into `addTeamMember`'s `addedBy` (line 35 → `packages/functions/src/utils/teams.ts:264`, `.set({…, addedBy})`) — `addedBy: undefined` is rejected by the Admin SDK's default `.set()` (no `ignoreUndefinedProperties` configured anywhere in `packages/functions`), so **accepting a migrated invitation throws an uncaught internal error** instead of completing. Fixed by renaming the three fields; `status` was already written under the same name on both sides. |
| `contact_requests` | **SAFE** | HMD's `requestContactUpdate` and Linyup's port write and read an identical shape: `{contact_id, contact_name, contact_email, team_id, request_type, submitted_data, note, status, requested_at}` (`hmd-lineup/functions/src/requestContactUpdate/index.js:261-271` vs `packages/functions/src/contacts/requestContactUpdate.ts:138-148`); `manageContactUpdateRequest.ts:79-95` reads exactly those field names. |
| `team_alerts` | **SAFE** | The only writer on either side is the same ported function (`requestContactUpdate`'s `contact_request`-type alert), with an identical shape: `{teamId, message, schedule:{type,value}, alert_type, request_id, contact_id, contact_name, created_at, archived_at}` (`hmd-lineup/functions/src/requestContactUpdate/index.js:288-301` vs `packages/functions/src/contacts/requestContactUpdate.ts:159-169`). No client reader exists on either side (grepped `apps/web`, `apps/mobile`) — `firestore.rules:495,1297` grants read access but nothing queries it yet. |
| `alert_presets` | **BROKEN, fixed** (`scripts/migration/transforms/alert-presets.ts`) | Same bug class as `contact_alerts` (already fixed in pass 05). HMD's `AlertPresetsTab` writes `{name, description, schedule:{type, value}, message, show_in_app}` (`hmd-lineup/src/routes/TeamSettings/components/AlertPresetsTab/AlertPresetsTab.js:63-72`). Linyup's `AlertPreset`/`AlertPresetRecord` (`apps/web/src/app/[locale]/(auth)/settings/team/page.tsx:127-135`, `apps/web/src/app/[locale]/(auth)/contacts/[id]/page.tsx:753-760`) is flat: `schedule_type`/`schedule_value`, no nested `schedule`. `applyPreset` (`contacts/[id]/page.tsx:3909-3926`) reads `preset.schedule_type`/`.schedule_value` directly and writes them into a new `contact_alerts` doc via the client SDK's `addDoc` — with a migrated preset, `schedule_type` is `undefined`, which the client SDK also rejects on write, so **applying a migrated preset throws** instead of creating the alert. Fixed by flattening `schedule.{type,value}` → `schedule_type`/`schedule_value`, mirroring pass05's `contact_alerts` transform. |
| `leaderboard` | **BROKEN, fixed** (`scripts/migration/transforms/leaderboard.ts`) | **Not dead weight** — it has no `packages/shared/src/paths.ts` constant only because nobody added one; it's actively written by `packages/functions/src/utils/leaderboard.ts`'s `updateTeamLeaderboard` (called from `onSessionUpdate`, the `recalculateScores` callable, and the scores-rebuild job) and read by the mobile app (`apps/mobile/src/services/firestore.ts`'s `getTeamLeaderboard` → `apps/mobile/src/screens/ProfileScreen.tsx`). HMD's writer denormalizes the retired `type` field onto each entry (`hmd-lineup/functions/src/utils/leaderboard.js:49-56`); Linyup's port denormalizes `acquisition_stage` instead (`packages/functions/src/utils/leaderboard.ts:24-35`), a direct consequence of the `Contact.type` → acquisition-axis change. `ProfileScreen.tsx:729-734` reads exactly `entry.acquisition_stage` to anonymize a still-trial contact's name on the leaderboard — a migrated entry has `type` but never `acquisition_stage`, so a trial contact's real name is shown to every team member and every other contact of the team (`firestore.rules:826-835` grants both read) until the cache is next regenerated, which is **not guaranteed to happen soon** (nothing fires on session/participant create or a check-in — only a session's start/activityId being edited, a manual "Recalculate scores," or the monthly reset). Fixed by mapping `type: 'trial'` → `acquisition_stage: 'trial_attended'` (never `'trial_booked'`, since every entry here already has `current_month_score > 0` by the writer's own query filter — the same "hasAttended" signal `transforms/contacts.ts` uses for that exact distinction) and `'student'`/`'external'` → `'joined'`, mirroring `transforms/contacts.ts`'s own mapping — not a new guess. |
| `activity_log` | **BROKEN, fixed** (`scripts/migration/transforms/activity-log.ts`) | Every hmd-lineup `logActivity(...)` call site (`trackContacts`, `trackBookings`, `trackSessionParticipants`, `trackEventAttendees`, `verifyMembershipCode`, `dailyTasks/tasks/anonymizeDeletedContacts.js`, both `dailyTasks/tasks/send*AutomationEmails.js` — 8 files checked) stamps the timestamp field as `date`, never `created_at`. Linyup's `ActivityLogEntry` requires `created_at`, and its one reader, `useContactActivityLog` (`apps/web/src/app/[locale]/(auth)/contacts/[id]/page.tsx:585-608`), both orders (`orderBy('created_at', 'desc')`) and filters (`where('created_at', '>=', …)`) on it — Firestore silently excludes any doc missing the field, so **a migrated contact's entire historical activity feed is invisible**, not an error. `event` and `refs.{contact,session,user}` are written under the same names/shapes on both sides (checked `trackContacts.js`, `trackBookings.js`, `trackEventAttendees.js`) — not touched. An `event` value with no `EVENT_META` entry (e.g. HMD's `event_checkin_add`/`event_checkin_delete`) already renders with a graceful fallback icon (`contacts/[id]/page.tsx:3377`), so that mismatch was not worth a mapping decision. Fixed by renaming `date` → `created_at`. |
| `team_weekly_reports` | **SAFE** (re-verified) | The existing transform (`scripts/migration/transforms/team-weekly-reports.ts`, applied since before this session) already documents every kept/derived/omitted field. Re-checked this session: both HMD (`hmd-lineup/functions/src/utils/users.js`) and Linyup (`packages/functions/src/utils/users.ts:80-86`) write `created_at`/`iso_week` under the same names, and the one reader, `useDashboardData.ts` (`apps/web/src/hooks/useDashboardData.ts`), queries `orderBy('iso_week', 'asc')` and reads exactly the field names the transform keeps (`active_contacts_count`, `contacts_count_by_stage`, `sessions_count`, `sessions_count_by_type`, `bookings_count`, `bookings_count_by_type`, `trial_conversions_count`, `trial_dropouts_count`). No new gap found. |
| `public_profile` | **BROKEN — not fixed via transform; excluded from the pass instead** | See "public_profile is not migrated" below. |

## Automation rules (pass 11) — one confirmed fix, one confirmed manual-review item

`automation_rules` gets one targeted fix
(`scripts/migration/transforms/automation-rules.ts`), because it was checked
against the source app and the failure mode is silent:

- **Renamed**: HMD's `{ type: 'portal_booking_no_show', delay_days }` condition
  → `bio_link_booking_no_show`. Without this, the rule is dispatched down the
  wrong path in `automationEngine.ts` (`hasBookingCondition` never matches) and
  then fails the evaluator's fail-closed default case — the rule migrates,
  looks normal in the UI, and never fires again. Confirmed against
  `hmd-lineup/src/routes/TeamSettings/components/OutreachTab/{OutreachTab,systemDefaults}.js`.
- **Flagged, not fixed**: `contact_type` and `membership_status` conditions
  (both retired from Linyup along with `Contact.type` / `membership_*`) have no
  safe automatic mapping and are left in place — the rule keeps failing closed
  rather than firing to a guessed audience, matching `automationEngine.ts`'s
  own documented reasoning for that default. The pass logs a `WARN` naming
  every rule this affects; **HMD's own `SYSTEM_RULES` (`sys_rule_noshow_1d`,
  `sys_rule_noshow_5d`, …) ship `contact_type` alongside the no-show condition**,
  so expect this warning on real data. Rebuild the flagged rules by hand with
  today's condition types (`acquisition_stage`, `has_affiliation`,
  `affiliation_type`) after migration.

---

## `public_profile` is not migrated

Pass 11 does **not** copy `teams/{teamId}/public_profile/{teamId}` — it was
removed from `TEAM_SUBCOLLECTIONS` in `scripts/migration/passes/11-team-subcollections.ts`
rather than given a transform. This is deliberate, not an oversight:

**Everything on it is a computed mirror, not source data.** Every field is
derived by the live `syncTeamPublicProfile` trigger
(`packages/functions/src/sync/syncTeamPublicProfile.ts`) from the team doc
(already migrated and transformed by `transforms/teams.ts`) plus a handful of
other already-migrated collections. There is nothing on `public_profile` that
is unique source data needing preservation — unlike `team_members` or
`subscription_types`, which store real assignments/config nothing else holds.

**A raw copy is not merely stale, it is query-breaking.** hmd-lineup's shape
(`hmd-lineup/functions/src/syncTeamPublicProfile/index.js`) predates Linyup's
public-surface model entirely — nested `settings.bookingFlowType` instead of a
top-level `bookingSettings`, `portalColors`/`legalLinks`/`consentTexts` that no
longer exist, no `active_public_surfaces`/`default_public_surface` at all — but
the one fact that actually breaks something is smaller than any of that: hmd-lineup
stamps `doc_type: 'team'` on the doc (`syncTeamPublicProfile/index.js:155`),
**never `type`**. Every `/public/{slug}/*` route resolves the team via
`PublicTeamProvider.tsx:49-52`'s `collectionGroup('public_profile').where('type',
'==', 'team')`. A raw hmd-lineup copy never matches that query, so **the
studio's entire public surface — bio-link, booking, signup, space, events,
appointments — 404s with "Team not found"** for as long as the raw doc stands.

**Why skipping is the fix, not a transform.** Reproducing the trigger's
computation in the migration script (link `target` derivation, `active_public_surfaces`'s
several async existence probes, the kiosk-config-minus-PIN mirror, `noShowPolicy`
via `resolveNoShowPolicy`, …) would mean re-implementing a few hundred lines of
business logic a second time, which is exactly the kind of duplication this
codebase's own conventions (see CLAUDE.md → "A cancellation is a RECORD, not a
boolean" and the Stripe-fields-move rule) warn is how two copies of one
computation quietly drift. Not writing the doc at all costs nothing a transform
would have saved: on staging/production, Cloud Functions are deployed and
`syncTeamPublicProfile` fires the moment pass02 writes the team doc — its own
`.set(publicProfile, {merge: true})` (`syncTeamPublicProfile.ts:395`) creates the
correct doc from scratch, independent of whether pass11 wrote anything there
first. On the recommended **local emulator** workflow
(`firebase emulators:start --only auth,firestore,storage` — no functions, see
CLAUDE.md → "Firebase emulators"), the trigger never runs either way, so a
migrated team's `/public/{slug}` 404s whether pass11 copies hmd-lineup's raw
doc or writes nothing — skipping just avoids seeding a world-readable doc with
a decade-old shape and dead fields that a merge-only writer would otherwise
never clean up.

**To smoke-test public pages against the local emulator**, start the Functions
emulator too (`firebase emulators:start --only auth,firestore,storage,functions`)
so `syncTeamPublicProfile` runs at least once after pass02 writes each team doc,
or manually re-save the team's General settings post-migration to trigger it.

**One field the trigger does NOT backfill, either way: `bookingSettings`.**
It is written exclusively by the `updateBookingSettings` callable
(`packages/functions/src/booking/bookingSettings.ts`) — a manager action, not a
sync — so a migrated studio's actual booking preferences (flow type, window,
cutoff, contact CTA) do not carry over automatically even once the trigger has
run; every booking-flow read falls back to its own sane default (`windowMonths
?? 2`, `showPhone !== false`, etc. — `apps/web/src/app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx:382-413`),
so this degrades soft rather than breaking, but a studio that had a non-default
booking configuration in hmd-lineup should revisit Settings → Booking after
migration.

---

## Affiliations (pass 00 + pass 05)

Phase 2 replaced the single-valued membership fields on the contact doc with a
multi-valued **affiliation** set (`contacts/{id}/affiliations`). The migration no
longer writes any of the removed fields (`membership_status`, `membership_active`,
`membership_expiration`, `org_membership_status`, `org_membership_active`,
`org_membership_expiration`).

Mapping (`scripts/migration/transforms/contacts.ts`):

| Source field (non-`guest`) | → Affiliation |
|---|---|
| `membership_status` | **`issuer: 'org'`, `org_id: 'hmd'`**, type `club` (the org-level type seeded in pass 00), `status_id` = the value, `active` = (`active`-status), `contact_live` = not archived/deleted, `valid_until` ← `membership_expiration` |
| `guest` / none | no affiliation — and therefore invisible to the organisation (`orgAdminMayReadContact`) |

`membership_status` is the **federation card**, not a club-level membership: hmd-lineup's
Membership route lists it across every club with the org's own vocabulary, and the org's
managers move it. Until 2026-09-11 the transform wrote it as a *team*-issued row with no
`org_id`, which under the org-visibility model of #259 would have hidden every HMD member
from HMD. There is no `org_membership_status` in hmd-lineup — the field an earlier version
mapped "in case" never existed on any document; it is deleted from the contact doc if
present and never read.

**Partner-app plans.** hmd-lineup had no notion of a plan's source. Pass 11 stamps a copied
`subscription_types` doc whose name matches `isPartnerSourceType` (Fitpass, ClassPass,
SportPass, Urban Sports…) with `source: 'aggregator'`, and the contact transform writes
its holder a live `active_subscriptions` row (amount 0, no recurrence) — so the booking
gate can match the plan, the weekly report counts them "via a partner app" rather than as
subscribers, and the External tab shows the plan that lets them through the door. Not for
an archived or binned contact. Instructor / Free stay name-only.

Soft-deleted **and archived** contacts (`deleted_at != null` or `archived_at != null`)
are coerced to `status_id: 'expired'` so they never count as active — HMD does
not clear the membership field when a club archives somebody, and Basel's
pre-migration audit found every affiliation the transform would have marked
active belonged to an archived person. The same `isGone` test withholds the
`active_subscriptions` row: the plan stays on the record as history, nothing
claims it is live. The transform derives the affiliation docs and
attaches them under the reserved `__affiliations` key; **pass 05** peels that off
and writes each into `contacts/{id}/affiliations/{id}-aff-N`, then persists the
contact doc without the key. A best-effort `affiliation_summary` is set on the
contact (the live `onAffiliationWrite` trigger recomputes it).

Catalog + statuses: **pass 00** seeds the org-level `club` affiliation type and
the reused `membership_statuses` (`DEFAULT_ORG_MEMBERSHIP_STATUSES`) under
`organizations/hmd`. **Pass 05** seeds a team-local `club` affiliation type per
team and flags each team `affiliations_enabled: true` (the `org_id` /
`organization_ids: ['hmd']` link is set in pass 02).

---

> **Online Courses / public Space:** courses don't exist in hmd-lineup, so there is nothing
> to migrate. The web Space + course gating only depend on already-migrated contact fields —
> `email` and `subscription_type_id` — so contacts can log in and unlock gated courses. The
> verify pass already spot-checks contacts; confirm migrated contacts have a non-empty
> `email` (required for the passwordless contact login).

> **Documents / Waivers:** hmd-lineup has no `documents` collection and no waiver
> concept at all, so the migration writes none — this is the correct, honest state
> for a tenant whose source never had it, not a pass waiting to be written. Do
> **not** "fix" this by fabricating placeholder documents (a real customer's
> liability waiver is not something a script should author) or by adding
> `waiver_policy` to pass 11's `TEAM_SUBCOLLECTIONS` (there is nothing in the
> source to copy from). It is also inert rather than broken: `enforceWaiverGate`
> fails CLOSED only on a policy that *requires* a document, so an absent policy
> means "nothing required," never a silently-skipped requirement. The studio
> authors their first document (and, if desired, a waiver policy) from
> `/plugins/documents` after migration; `scripts/backfill-document-versions.ts`
> is a precondition for *that* publish, not for this migration.
