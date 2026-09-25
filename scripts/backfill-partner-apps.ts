/**
 * One-time backfill: materialize `TeamPublicProfile.partner_apps` for every team.
 *
 * partner_apps is written by two live rails — `syncTeamPublicProfile` (on any
 * write to `teams/{teamId}`) and `syncSubscriptionTypesToPublicProfile` (on any
 * write to a subscription type). But a team that predates the field, and has had
 * no qualifying write since, carries NO partner_apps at all — so
 * `BookingForm.tsx` hides the fitness-app question for it, even when the studio
 * actually sells through a partner (ClassPass / FitPass / …).
 *
 * `backfill-public-subscription-types.ts` does NOT fix this, despite the
 * precondition doc that says it does: it is guarded
 * (`!isActiveAggregator || alreadyPublic → continue`), so it writes NOTHING for a
 * team whose aggregator types are already `public: true`, or that has none — and
 * where everything is already public, it is a total no-op. This script closes the
 * gap directly.
 *
 * It computes the list with the SAME resolver the sync uses
 * (`resolveTeamPartnerApps`), so it can never write the reversed pre-2026-06-11
 * semantics the buggy backfill's `--apply` would, and writes ONLY partner_apps
 * (merge) to each team's EXISTING public_profile mirror — the empty `[]` case
 * included, which is correct: a team with no partner apps should carry an
 * explicit empty list, not an absent field. Teams with no public_profile at all
 * are skipped (they are unpublished; their mirror is built whole on the first
 * team write) and reported, so a partial mirror is never created here.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other backfills.
 *
 * Usage:
 *   pnpm backfill:partner-apps --project linyup-staging          # dry run (default)
 *   pnpm backfill:partner-apps --project linyup-staging --apply  # write
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { resolveTeamPartnerApps } from '../packages/functions/src/sync/syncTeamPublicProfile'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error('❌ --project is required (e.g. --project linyup-staging)')
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })
const db = admin.firestore()

function sameList(a: string[] | undefined, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
}

async function main(): Promise<void> {
  console.log(
    `\n🔧 partner_apps backfill on '${values.project}' ${values.apply ? '(APPLY)' : '(dry-run)'}\n`
  )

  const teams = await db.collection('teams').get()
  let written = 0
  let withApps = 0
  let noProfile = 0

  for (const team of teams.docs) {
    const teamId = team.id
    const partnerApps = await resolveTeamPartnerApps(db, teamId)
    if (partnerApps.length) withApps += 1

    const ppRef = db.doc(`teams/${teamId}/public_profile/${teamId}`)
    const pp = await ppRef.get()
    if (!pp.exists) {
      noProfile += 1
      continue
    }

    const current = pp.get('partner_apps') as string[] | undefined
    if (sameList(current, partnerApps)) continue

    written += 1
    console.log(
      `   ${values.apply ? 'write' : 'would write'} ${teamId}: [${partnerApps.join(', ')}]` +
        (current === undefined ? ' (was absent)' : '')
    )
    if (values.apply) await ppRef.set({ partner_apps: partnerApps }, { merge: true })
  }

  console.log(
    `\n✅ ${values.apply ? 'Wrote' : 'Would write'} partner_apps for ${written} team(s); ` +
      `${withApps} team(s) have ≥1 partner app; ${noProfile} unpublished team(s) skipped.`
  )
  if (!values.apply) console.log('   Re-run with --apply to write.\n')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Backfill failed:', err)
    process.exit(1)
  })
