/**
 * HMD → Linyup SaaS data migration
 *
 * See scripts/MIGRATE-HMD.md for full instructions.
 *
 * Usage:
 *   pnpm migrate:hmd --source-creds <path> --target-creds <path> [options]
 *   pnpm migrate:hmd --source-creds <path> --target-emulator       [options]
 *
 * Options:
 *   --org-admin-email <email>  Email of the user who becomes org creator + org_admin (default: franco.dgstn@gmail.com)
 *   --dry-run                  Log writes without committing
 *   --overwrite                Re-apply current transforms to docs that already exist on the
 *                              target (default: skip them). Needed whenever a transform has
 *                              changed since the target was last migrated — see MIGRATE-HMD.md.
 *   --only <pass>                 Run a single pass (see pass names below)
 *   --teams <a,b>                 Import only these clubs (a SAMPLE for rehearsal, or the scope of
 *                                 a per-club catch-up: --only contacts --teams X --overwrite)
 *   --live <a,b>                  THE ACTIVATION LIST — which clubs go live on this target. Everything
 *                                 is imported; only these clubs' members get a login and only these
 *                                 clubs (and the org) may send mail. REQUIRED for a full run into a
 *                                 real project; cumulative across waves. See MigrationConfig.live.
 *   --from-team <teamId>          Resume contacts/sessions from a specific team
 *   --verify                      Run verification after migration
 *
 * Passes: setup | auth-users | users | teams | activities | session-series | contacts | sessions | events | exam-checkins | cup-checkins | event-categories | referrals | team-subcollections | places | org-website | season-calendar | activation | affiliations | verify
 *
 *   activation    — part of every full run that has --live; alone, to flip a club live at its wave
 *   affiliations  — never part of a full run; the licence re-sync while the old system stays master
 */

import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { getApp } from 'firebase-admin/app'
import { initApps, assertTargetEmulatorReachable, DEFAULT_ORG_ADMIN_EMAIL } from './migration/config'
import { acquireMigrationLock } from './migration/lock'
import type { MigrationConfig } from './migration/config'
import { pass00Setup, recheckBundleMembers } from './migration/passes/00-setup'
import { pass00AuthUsers }          from './migration/passes/00-auth-users'
import { pass01Users }              from './migration/passes/01-users'
import { pass02Teams }              from './migration/passes/02-teams'
import { pass03Activities }         from './migration/passes/03-activities'
import { pass04SessionSeries }      from './migration/passes/04-session-series'
import { pass05Contacts }           from './migration/passes/05-contacts'
import { pass06Sessions }           from './migration/passes/06-sessions'
import { pass08Events }             from './migration/passes/08-events'
import { pass09ExamCheckins }       from './migration/passes/09-exam-checkins'
import { pass09CupCheckins }        from './migration/passes/09-cup-checkins'
import { pass09EventCategories }    from './migration/passes/09-event-categories'
import { pass10Referrals }          from './migration/passes/10-referrals'
import { pass11TeamSubcollections } from './migration/passes/11-team-subcollections'
import { pass12Places }             from './migration/passes/12-places'
import { pass13OrgWebsite }         from './migration/passes/13-org-website'
import { pass14SeasonCalendar }     from './migration/passes/14-season-calendar'
import { pass15Activation }         from './migration/passes/15-activation'
import { pass16Affiliations }       from './migration/passes/16-affiliations'
import { verify }                   from './migration/verify'

const { values } = parseArgs({
  options: {
    'source-creds':    { type: 'string' },
    'target-creds':    { type: 'string' },
    'target-emulator': { type: 'boolean', default: false },
    'org-admin-email': { type: 'string', default: DEFAULT_ORG_ADMIN_EMAIL },
    'dry-run':         { type: 'boolean', default: false },
    'overwrite':       { type: 'boolean', default: false },
    'only':            { type: 'string' },
    'teams':           { type: 'string' },
    'live':            { type: 'string' },
    'reset':           { type: 'boolean', default: false },
    'from-team':       { type: 'string' },
    'verify':          { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

const targetEmulator = values['target-emulator'] ?? false

if (!values['source-creds']) {
  console.error('Error: --source-creds is required')
  process.exit(1)
}
if (!targetEmulator && !values['target-creds']) {
  console.error('Error: provide --target-creds <path> or --target-emulator')
  process.exit(1)
}

const cfg: MigrationConfig = {
  sourceCredsPath: values['source-creds']!,
  targetCredsPath: values['target-creds'],
  targetEmulator,
  orgAdminEmail:   values['org-admin-email'] ?? DEFAULT_ORG_ADMIN_EMAIL,
  dryRun:          values['dry-run'] ?? false,
  overwrite:       values['overwrite'] ?? false,
  only:            values['only'],
  fromTeam:        values['from-team'],
  teams:           values['teams']
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  live:            values['live']
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean),
}

// ── --live: a real project never gets a full import without an activation list ──
// Everything is imported, and the target's env default for messaging is `live`,
// so a full run without `--live` would put thirteen dormant clubs' contacts in
// front of every seeded automation and hand every club's owner a login. The
// emulator and a dry run are exempt: nothing there can reach a person.
const isFullRun = !values['only']
if (isFullRun && !targetEmulator && !(values['dry-run'] ?? false) && !cfg.live?.length) {
  console.error(
    'Error: a full import into a real project needs --live <club,...> — the clubs that go live.\n' +
      '       Every other club is imported dormant (no logins, messaging silent) until its wave.\n' +
      '       See MigrationConfig.live and scripts/MIGRATE-HMD.md → "Activation and waves".'
  )
  process.exit(1)
}

// ── --reset: start from an empty target ────────────────────────────────────
// EMULATOR ONLY, and refused otherwise rather than guarded by a confirmation.
// The flag exists for the sample loop — change a transform, wipe, re-import
// three clubs, look — and a wipe of a real project is not a faster version of
// that, it is a different and unrecoverable act. `--target-creds` has no reason
// to reach this code path at all.
const wantsReset = values['reset'] ?? false
if (wantsReset && !targetEmulator) {
  console.error(
    'Error: --reset wipes the target and is allowed only with --target-emulator.\n' +
      '       To clear a real project use the dedicated reset scripts, which ask first.'
  )
  process.exit(1)
}

async function resetEmulator(): Promise<void> {
  const { EMULATOR_FIRESTORE_HOST, EMULATOR_PROJECT_ID } = await import('./migration/config')
  const url =
    `http://${EMULATOR_FIRESTORE_HOST}/emulator/v1/projects/` +
    `${EMULATOR_PROJECT_ID}/databases/(default)/documents`
  if (cfg.dryRun) {
    console.log(`[dry-run] would wipe every document at ${EMULATOR_FIRESTORE_HOST}`)
    return
  }
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Emulator reset failed: ${res.status} ${await res.text()}`)
  console.log(`🧹 Wiped Firestore at ${EMULATOR_FIRESTORE_HOST}`)
}

async function enableEmailPasswordSignIn(): Promise<void> {
  if (cfg.targetEmulator) return
  if (cfg.dryRun) { console.log('[dry-run] would enable email/password sign-in'); return }
  const sa = JSON.parse(readFileSync(cfg.targetCredsPath!, 'utf-8')) as { project_id: string }
  const projectId = sa.project_id
  const app = getApp('target')
  const credential = app.options.credential as { getAccessToken(): Promise<{ access_token: string }> }
  const token = await credential.getAccessToken()
  const url =
    `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/config` +
    `?updateMask=signIn.email.enabled,signIn.email.passwordRequired`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': projectId,
    },
    body: JSON.stringify({ signIn: { email: { enabled: true, passwordRequired: true } } }),
  })
  if (!res.ok) throw new Error(`Failed to enable email/password sign-in: ${res.status} ${await res.text()}`)
  console.log('✓ Email/password sign-in enabled')
}

/** Which database this run writes to — the thing two runs must not share. */
async function targetKey(): Promise<string> {
  if (cfg.targetEmulator) {
    const { EMULATOR_FIRESTORE_HOST, EMULATOR_PROJECT_ID } = await import('./migration/config')
    return `emulator-${EMULATOR_PROJECT_ID}-${EMULATOR_FIRESTORE_HOST}`
  }
  const sa = JSON.parse(readFileSync(cfg.targetCredsPath!, 'utf-8')) as { project_id: string }
  return sa.project_id
}

async function run() {
  // Fail fast if --target-emulator is set but the emulators aren't running —
  // before reading source creds or touching any data.
  if (cfg.targetEmulator) await assertTargetEmulatorReachable()

  // A dry run writes nothing, so it can neither corrupt a live run nor be
  // corrupted by one — leave the "just look at what it would do" path free.
  if (!cfg.dryRun) acquireMigrationLock(await targetKey())

  initApps(cfg)
  if (cfg.dryRun) console.log('=== DRY RUN — no writes will be committed ===')
  if (cfg.overwrite) {
    console.log('=== OVERWRITE — existing target docs are re-written from the source ===')
    console.log('    App-side edits to migrated contacts/sessions/events/check-ins will be replaced.')
    console.log('    The org doc, the org admin team_members row and the org website are NOT touched.')
  }
  console.log(`Org admin: ${cfg.orgAdminEmail}`)

  if (wantsReset) await resetEmulator()

  await enableEmailPasswordSignIn()
  const only = cfg.only
  if (cfg.teams?.length) {
    console.log(`Sample import — clubs: ${cfg.teams.join(', ')}`)
  }

  if (!only || only === 'setup')               await pass00Setup(cfg)
  if (!only || only === 'auth-users')          await pass00AuthUsers(cfg)

  let teamIds: string[] = []
  if (!only || only === 'users')               await pass01Users(cfg)
  if (!only || only === 'teams')               teamIds = await pass02Teams(cfg)

  if (only && only !== 'teams' && teamIds.length === 0) {
    const { targetDb, matchesTeamSample } = await import('./migration/config')
    const snap = await targetDb().collection('teams').get()
    // The SAMPLE applies here too. Without this a `--only contacts --teams X`
    // run would resolve every club already on the target and import the lot —
    // the opposite of what was asked for, after the flag appeared to work.
    teamIds = snap.docs
      .filter((d) => matchesTeamSample(cfg.teams, d.id, String(d.data().name ?? '')))
      .map((d) => d.id)
    console.log(`Loaded ${teamIds.length} teamIds from target for pass '${only}'`)

    // RESOLVING FEWER CLUBS THAN WERE NAMED IS A FAILURE, not a smaller run.
    // `verify` then checks the clubs it found and prints "All counts OK" for a
    // migration that is missing one — which is exactly what happened: a club
    // whose team document had lost its `name` matched nothing here, and two of
    // three clubs were verified under a green banner.
    if (cfg.teams?.length && teamIds.length !== cfg.teams.length) {
      console.error(
        `\n❌ --teams named ${cfg.teams.length} club(s) but only ${teamIds.length} ` +
          `resolved on the target.\n` +
          `   Verifying the ones that matched would report success for an incomplete\n` +
          `   migration. Check that each named club exists AND still has its 'name'\n` +
          `   field — a trigger-resurrected stub has no name and matches nothing.\n`
      )
      process.exit(1)
    }
  }

  let activityMap = new Map<string, { name: string; type: string }>()
  if (!only || only === 'activities')          activityMap = await pass03Activities(cfg, teamIds)
  if (!only || only === 'session-series')      await pass04SessionSeries(cfg, teamIds)

  if (only === 'sessions' && activityMap.size === 0) {
    const { targetDb } = await import('./migration/config')
    const snap = await targetDb().collection('activities').get()
    for (const d of snap.docs) {
      activityMap.set(d.id, {
        name: String(d.data().name ?? ''),
        type: String(d.data().type ?? 'class'),
      })
    }
  }

  if (!only || only === 'contacts')            await pass05Contacts(cfg, teamIds)
  if (!only || only === 'sessions')            await pass06Sessions(cfg, teamIds, activityMap)
  // teamIds only when SAMPLING — a full run passes undefined and copies everything.
  if (!only || only === 'events')              await pass08Events(cfg, cfg.teams?.length ? teamIds : undefined)
  // Both read the check-ins pass08 has just written, so they follow it.
  if (!only || only === 'exam-checkins')       await pass09ExamCheckins(cfg)
  if (!only || only === 'cup-checkins')        await pass09CupCheckins(cfg)
  if (!only || only === 'event-categories')    await pass09EventCategories(cfg)
  if (!only || only === 'referrals')           await pass10Referrals(cfg)
  if (!only || only === 'team-subcollections') await pass11TeamSubcollections(cfg, teamIds)
  if (!only || only === 'places')              await pass12Places(cfg, teamIds)
  if (!only || only === 'org-website')         await pass13OrgWebsite(cfg)
  if (!only || only === 'season-calendar')     await pass14SeasonCalendar(cfg)
  // Activation closes every full run that has a --live list, and runs alone to
  // flip a club live at its wave. It iterates the SOURCE club list, so `--only
  // activation` needs no teamIds and never touches a non-HMD tenant.
  if ((!only && cfg.live?.length) || only === 'activation') await pass15Activation(cfg)
  // The licence re-sync is never part of a full run — pass 05 writes the same
  // rows on import; this exists for the weeks the old system stays master.
  if (only === 'affiliations')                 await pass16Affiliations(cfg, teamIds)

  if (!only || only === 'verify' || values['verify']) await verify(teamIds, !!cfg.teams?.length)

  // The bundle members, asked once more now that minutes have passed. Pass 0
  // cannot answer this — see `recheckBundleMembers`.
  if (!cfg.dryRun) await recheckBundleMembers()

  console.log('\nMigration complete.')
}

run().catch((e) => { console.error(e); process.exit(1) })
