/**
 * One-off migration: retire the org-level "membership" naming in favor of
 * "affiliation" for any ALREADY-DEPLOYED data.
 *   - subcollection  organizations/{id}/membership_statuses → affiliation_statuses
 *   - org doc field  membership_term      → affiliation_term
 *   - org doc field  lock_org_membership  → lock_affiliation
 * Docs/values are copied to the new location, then the old ones are removed.
 * Idempotent: re-running after a successful run finds nothing to do.
 *
 * Orgs are barely used pre-launch, so most environments have nothing to migrate;
 * staging can simply be reseeded instead of running this.
 *
 * Usage:
 *   pnpm tsx scripts/rename-org-membership-to-affiliation.ts --emulator [--dry-run]
 *   pnpm tsx scripts/rename-org-membership-to-affiliation.ts --creds ./sa.json [--dry-run]
 *
 * Run order per env: deploy the renamed rules+indexes first, then this, then the app deploy.
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const emulator = args.includes('--emulator')
const credsPath = args[args.indexOf('--creds') + 1]

const OLD_SUB = 'membership_statuses'
const NEW_SUB = 'affiliation_statuses'
const FIELD_RENAMES: [oldName: string, newName: string][] = [
  ['membership_term', 'affiliation_term'],
  ['lock_org_membership', 'lock_affiliation'],
]

if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080'
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-linyup' })
} else if (credsPath && args.includes('--creds')) {
  initializeApp({ credential: cert(credsPath) })
} else {
  console.error('Provide --emulator or --creds <serviceAccount.json>')
  process.exit(1)
}

const db = getFirestore()
db.settings({ ignoreUndefinedProperties: true })

async function run() {
  const tag = dryRun ? '[DRY RUN] ' : ''
  console.log(`${tag}Migrating org ${OLD_SUB} → ${NEW_SUB} and renaming org fields`)

  let orgsTouched = 0
  let statusesMoved = 0
  let fieldsRenamed = 0

  const orgs = await db.collection('organizations').get()
  for (const org of orgs.docs) {
    let touched = false

    // 1. Subcollection: membership_statuses → affiliation_statuses
    const snap = await org.ref.collection(OLD_SUB).get()
    if (!snap.empty) {
      touched = true
      for (const d of snap.docs) {
        statusesMoved++
        if (!dryRun) {
          await org.ref.collection(NEW_SUB).doc(d.id).set(d.data())
          await d.ref.delete()
        }
      }
      console.log(`  org ${org.id}: ${snap.size} status def(s) → ${NEW_SUB}`)
    }

    // 2. Org doc fields
    const data = org.data()
    const patch: Record<string, unknown> = {}
    for (const [oldName, newName] of FIELD_RENAMES) {
      if (data[oldName] !== undefined) {
        patch[newName] = data[oldName]
        patch[oldName] = FieldValue.delete()
        fieldsRenamed++
        touched = true
        console.log(`  org ${org.id}: field ${oldName} → ${newName}`)
      }
    }
    if (Object.keys(patch).length && !dryRun) await org.ref.update(patch)

    if (touched) orgsTouched++
  }

  console.log(
    `\n${tag}${dryRun ? 'would migrate' : 'migrated'} ${statusesMoved} status def(s) and ` +
      `${fieldsRenamed} field(s) across ${orgsTouched} org(s).`,
  )
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
