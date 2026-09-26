/**
 * One-time backfill: `activityType` on activity public-profile mirrors.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `activityType` ('class' | 'appointment') was added to the activity mirror when
 * coaching was folded into appointments. The mirror is rewritten ONLY on an
 * activity write, and no backfill ran — so any activity untouched since then
 * still has a mirror with no `activityType` at all.
 *
 * Every public reader treats a missing value as a CLASS, because that is the
 * safe default for the ninety-nine per cent. The consequence is narrow and
 * unpleasant: an appointment activity whose mirror predates the field routes a
 * visitor to the class slot picker instead of the appointment picker — the exact
 * dead end that "an appointment-only studio never reached the picker" was about,
 * arriving by a different road and surviving that fix.
 *
 * Recorded in docs/open-defects.md as "`pnpm backfill:activity-type-mirrors` has
 * not been run anywhere". Unverified because it needs real data
 * to see; this script is how you look, and `--apply` is how you fix it.
 *
 * ── WHY IT PATCHES THE MIRROR RATHER THAN TOUCHING THE ACTIVITY ─────────────
 * Touching each activity would make `syncActivityPublicProfile` rewrite the
 * whole mirror, which is tempting and wrong here: that trigger also rewrites
 * `order`, `tags`, `image_url` and the rest from the activity document as it
 * stands today, so a stale-but-deliberate mirror field would be silently
 * replaced along the way. Patching the one field states exactly what is being
 * changed, and a mirror already carrying the right value is left alone entirely.
 *
 * The activity document is the source of truth for the value, exactly as the
 * trigger reads it: `type === 'appointment' ? 'appointment' : 'class'`.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other backfills.
 *
 * Usage:
 *   pnpm backfill:activity-type-mirrors --project linyup-staging [--apply]
 *
 * Without --apply it only reports what it would change.
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'

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

/** The trigger's own rule, reproduced so the two cannot disagree. */
function expectedActivityType(activityType: unknown): 'class' | 'appointment' {
  return activityType === 'appointment' ? 'appointment' : 'class'
}

async function main() {
  console.log(
    `\n🔧 Activity mirror activityType backfill on '${values.project}' ${
      values.apply ? '(APPLY)' : '(dry-run)'
    }\n`
  )

  const activities = await db.collectionGroup('activities').get()
  console.log(`   ${activities.size} activity document(s) found\n`)

  let missing = 0
  let wrong = 0
  let ok = 0
  let noMirror = 0
  let batch = db.batch()
  let pending = 0

  for (const activity of activities.docs) {
    // The mirror is `activities/{id}/public_profile/{id}` — same id, which is
    // what makes this a direct get rather than a query.
    const mirrorRef = activity.ref.collection('public_profile').doc(activity.id)
    const mirror = await mirrorRef.get()
    if (!mirror.exists) {
      // Deliberately NOT created here. An absent mirror means the activity is
      // inactive or deleted (the trigger deletes it), and minting one would
      // publish something the studio took down.
      noMirror += 1
      continue
    }

    const expected = expectedActivityType(activity.data().type)
    const actual = mirror.data()?.activityType

    if (actual === expected) {
      ok += 1
      continue
    }

    if (actual === undefined) missing += 1
    else wrong += 1

    console.log(
      `   ${values.apply ? 'patch' : 'would patch'} ${mirrorRef.path}: ` +
        `${actual === undefined ? '(absent)' : String(actual)} → ${expected}` +
        `  [${activity.data().name ?? '?'}]`
    )

    if (values.apply) {
      batch.update(mirrorRef, { activityType: expected })
      pending += 1
      if (pending === 400) {
        await batch.commit()
        batch = db.batch()
        pending = 0
      }
    }
  }

  if (values.apply && pending > 0) await batch.commit()

  console.log(
    `\n   absent: ${missing}   disagreeing: ${wrong}   already correct: ${ok}   no mirror: ${noMirror}`
  )
  if (!values.apply && missing + wrong > 0) {
    console.log('\n   Re-run with --apply to write.')
  }
  console.log(values.apply ? '\n✅ Done.\n' : '\n✅ Dry-run complete.\n')
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err)
  process.exit(1)
})
