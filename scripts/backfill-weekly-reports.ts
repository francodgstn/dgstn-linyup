/**
 * RECONSTRUCT THE WEEKLY HISTORY A MIGRATED CLUB NEVER RECORDED — from the
 * facts it did.
 *
 *   pnpm backfill:weekly-reports --team <teamId> --target staging --dry-run
 *   pnpm backfill:weekly-reports --org hmd --target staging
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * HMD Basel arrives with 272 weekly reports going back to 2022, and four of the
 * dashboard's trends are blank on all of them. The reports are not empty — they
 * carry `sessions_count` and `contacts_with_active_affiliation` — but the
 * fields these trends read were never written by the old system:
 *
 *   active_contacts_count                 0 of 272
 *   contacts_count_by_stage               0 of 272
 *   bookings_count                        0 of 272
 *   contacts_count_by_subscription_type   0 of 272
 *
 * ── WHAT THIS RECONSTRUCTS, AND WHY IT IS ALLOWED TO ────────────────────────
 *
 * Only what the migrated data ACTUALLY determines for a past week:
 *
 *   active_contacts_count    a contact existed that week if `created_at` was on
 *                            or before its end and it had not been archived or
 *                            deleted by then. Every one of those stamps is a
 *                            real date carried over from the source.
 *
 *   contacts_count_by_stage  the acquisition stage is STICKY and each step has
 *                            its own timestamp (`trial_booked_at`,
 *                            `trial_attended_at`, `converted_at`), so the stage
 *                            a contact was in during a past week is a lookup,
 *                            not a guess: the latest milestone reached by then.
 *
 * ── WHAT IT REFUSES TO INVENT ───────────────────────────────────────────────
 *
 *   bookings_count           HMD recorded ATTENDANCE, not bookings — 16 of 400
 *                            migrated sessions carry a booking count at all,
 *                            while 309 carry participants. Filling a bookings
 *                            field from attendance would put a number under a
 *                            label that does not mean it, and every later
 *                            reader would believe it. The trend that needs it
 *                            (the engagement matrix) stays honest and empty.
 *
 *   subscription counts      `Contact.active_subscriptions` is a CURRENT
 *                            snapshot with no history behind it. Attributing
 *                            today's plan to 2022 would draw four years of
 *                            revenue that never happened.
 *
 * ── AND IT SAYS SO IN THE DATA ──────────────────────────────────────────────
 *
 * Every row it touches is stamped `backfilled_at` + `backfilled_fields`, and it
 * NEVER overwrites a field that already has a value — so a week the live
 * `weeklyReports` function has measured is left exactly as measured, and a
 * reader (or a later script) can always tell a reconstruction from a record.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
// See the ISO weeks note below for why this comes from shared.
import { isoWeekKey } from '@linyup/shared'

const { values } = parseArgs({
  options: {
    team: { type: 'string' },
    org: { type: 'string' },
    target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
})

const TARGETS: Record<string, { projectId: string; emulator: boolean }> = {
  emulator: { projectId: 'demo-linyup', emulator: true },
  staging: { projectId: 'linyup-staging', emulator: false },
  production: { projectId: 'linyup-prod', emulator: false },
}

const target = TARGETS[values.target ?? '']
if (!target) {
  console.error(`❌ --target must be one of: ${Object.keys(TARGETS).join(' | ')}`)
  process.exit(1)
}
if (!values.team && !values.org) {
  console.error('❌ name what to backfill: --team <teamId> or --org <orgId>')
  process.exit(1)
}

if (target.emulator) {
  const slot = Number(process.env.LINYUP_SLOT ?? 0) || 0
  process.env.FIRESTORE_EMULATOR_HOST ??= `localhost:${8080 + slot * 10000}`
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('❌ Refusing to run against a cloud project with FIRESTORE_EMULATOR_HOST set.')
  process.exit(1)
}

admin.initializeApp(
  target.emulator
    ? { projectId: target.projectId }
    : { credential: applicationDefault(), projectId: target.projectId },
)
const db = admin.firestore()

// ─── ISO weeks ────────────────────────────────────────────────────────────────
//
// `isoWeekKey` comes from @linyup/shared — the SAME function the dashboard looks
// reports up by and `format(d, "R-'W'II")` writes them under. A private copy
// here would be a third spelling of the 52/53-week rule, and the failure would
// be silent: every reconstructed row landing one week off, on a page where
// nobody can tell 2026-W07 from 2026-W08 by eye.
//
// tsconfig.scripts.json does not resolve the package's TYPES (the import is
// `any` at compile time) but it resolves fine at RUNTIME — the same arrangement
// migration/transforms/sessions.ts already relies on.
/** The Monday of an ISO week key, found by walking — never by arithmetic on the
 *  week number, which is what gets 53-week years wrong. */
function mondayOfIsoWeek(key: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return null
  // 4 January is always in ISO week 1, so start from that week's Monday.
  const jan4 = new Date(Number(m[1]), 0, 4)
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - ((jan4.getDay() || 7) - 1) + (Number(m[2]) - 1) * 7)
  // Trust nothing: confirm the date we landed on really belongs to that key.
  return isoWeekKey(monday) === key ? monday : null
}

/** Sunday 23:59:59.999 of the week that Monday opens. */
function isoWeekEnd(monday: Date): Date {
  const end = new Date(monday)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return end
}

const ms = (v: unknown): number | null => {
  const t = (v as { toMillis?: () => number } | null | undefined)?.toMillis
  return typeof t === 'function' ? (v as { toMillis(): number }).toMillis() : null
}

// ─── the reconstruction ───────────────────────────────────────────────────────

interface ContactFacts {
  created: number | null
  gone: number | null // archived or deleted, whichever came first
  trialBooked: number | null
  trialAttended: number | null
  joined: number | null
}

/** The stage this contact was in at `at`, or null if not yet on the journey. */
function stageAt(c: ContactFacts, at: number): string | null {
  if (c.joined !== null && c.joined <= at) return 'joined'
  if (c.trialAttended !== null && c.trialAttended <= at) return 'trial_attended'
  if (c.trialBooked !== null && c.trialBooked <= at) return 'trial_booked'
  return null
}

async function backfillTeam(teamId: string, dryRun: boolean): Promise<void> {
  const reports = await db.collection('teams').doc(teamId).collection('team_weekly_reports').get()
  if (reports.empty) {
    console.log(`  ${teamId}: no weekly reports — nothing to backfill`)
    return
  }

  const contactsSnap = await db.collection('contacts').where('teamId', '==', teamId).get()
  const contacts: ContactFacts[] = contactsSnap.docs.map((d) => {
    const v = d.data() as Record<string, unknown>
    const archived = ms(v.archived_at)
    const deleted = ms(v.deleted_at)
    return {
      created: ms(v.created_at),
      gone: archived !== null && deleted !== null ? Math.min(archived, deleted) : (archived ?? deleted),
      trialBooked: ms(v.trial_booked_at),
      trialAttended: ms(v.trial_attended_at),
      joined: ms(v.converted_at) ?? ms(v.signup_completed_at),
    }
  })

  let written = 0
  let skipped = 0
  let batch = db.batch()
  let ops = 0

  for (const doc of reports.docs) {
    const data = doc.data() as Record<string, unknown>
    const week = String(data.iso_week ?? doc.id)
    const monday = mondayOfIsoWeek(week)
    if (!monday) { skipped++; continue }
    const at = isoWeekEnd(monday).getTime()

    const patch: Record<string, unknown> = {}
    const filled: string[] = []

    // NEVER overwrite what was measured — only a field with no value at all.
    if (data.active_contacts_count === undefined || data.active_contacts_count === null) {
      patch.active_contacts_count = contacts.filter(
        (c) => c.created !== null && c.created <= at && (c.gone === null || c.gone > at),
      ).length
      filled.push('active_contacts_count')
    }
    const byStage = data.contacts_count_by_stage as Record<string, number> | undefined
    if (!byStage || Object.keys(byStage).length === 0) {
      const counts: Record<string, number> = {}
      for (const c of contacts) {
        if (c.created === null || c.created > at) continue
        if (c.gone !== null && c.gone <= at) continue
        const s = stageAt(c, at)
        if (s) counts[s] = (counts[s] ?? 0) + 1
      }
      if (Object.keys(counts).length > 0) {
        patch.contacts_count_by_stage = counts
        filled.push('contacts_count_by_stage')
      }
    }

    if (filled.length === 0) { skipped++; continue }
    patch.backfilled_at = admin.firestore.FieldValue.serverTimestamp()
    patch.backfilled_fields = filled

    if (!dryRun) {
      batch.set(doc.ref, patch, { merge: true })
      ops++
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0 }
    }
    written++
  }
  if (!dryRun && ops > 0) await batch.commit()
  console.log(`  ${teamId}: ${written} report(s) ${dryRun ? 'would be ' : ''}filled, ${skipped} left as they are (${contactsSnap.size} contacts)`)
}

async function main() {
  const teamIds: string[] = []
  if (values.team) teamIds.push(values.team)
  if (values.org) {
    const roster = await db.collection('organizations').doc(values.org).collection('org_teams').get()
    roster.docs.forEach((d) => teamIds.push((d.data().teamId as string) ?? d.id))
  }

  console.log(`Weekly-report backfill — ${teamIds.length} team(s) on ${target.projectId}${values['dry-run'] ? ' (dry run)' : ''}`)
  console.log('  reconstructs: active_contacts_count, contacts_count_by_stage')
  console.log('  never invents: bookings_count, subscription counts — see this file\'s header')

  if (!values['dry-run'] && !values.yes && !target.emulator) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nType '${target.projectId}' to write: `)
    rl.close()
    if (answer.trim() !== target.projectId) {
      console.error('Aborted.')
      process.exit(1)
    }
  }

  for (const teamId of teamIds) await backfillTeam(teamId, values['dry-run'] ?? false)
  console.log('Done.')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
