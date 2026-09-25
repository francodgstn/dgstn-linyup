/**
 * DB reset for the **linyup-sandbox** Firebase project (demo playground).
 *
 * Wipes the /try demo data — Firestore documents (recursively, including
 * subcollections) and Firebase Auth users — then prints a summary.
 *
 * LEAD TENANTS ARE PRESERVED BY DEFAULT. The sandbox project hosts two kinds of
 * data that look alike but are not: the disposable `/try` playground, and the
 * `lead-*` tenants we demo to real prospects. Refreshing the former must never
 * take out the latter, so everything belonging to a `lead-…` team is skipped
 * unless you pass --include-leads. To tear down ONE lead tenant, don't use this
 * script at all — use `pnpm lead:seed --lead <id> --reset`, which is scoped to
 * that tenant.
 *
 * Auth: uses gcloud Application Default Credentials (ADC) — same as seed-sandbox.
 *
 * Usage:
 *   pnpm sandbox:reset                    # prompts you to type the project id
 *   pnpm sandbox:reset --dry-run          # show what WOULD be deleted, delete nothing
 *   pnpm sandbox:reset --yes              # skip the prompt (CI / non-interactive)
 *   pnpm sandbox:reset --include-leads    # ALSO wipe lead-* tenants (rarely what you want)
 *
 * Safety:
 *   - Hard-codes the project to `linyup-sandbox` and refuses to run if the
 *     ambient project says otherwise, so it can never hit staging/production.
 *   - Preserves lead tenants unless --include-leads.
 *   - Requires an interactive typed confirmation; --yes is the non-interactive
 *     escape hatch and is the ONLY way it runs without a TTY.
 */

import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { requireConsentExport } from './lib/exportConsentLedger'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { TENANT_DATA_COLLECTIONS } from '@linyup/shared'

const PROJECT_ID = 'linyup-sandbox'
/** Team-id prefix that marks a prospect demo tenant (scripts/leads/*). */
const LEAD_PREFIX = 'lead-'

// Guard: never allow this destructive script to target anything but the sandbox.
const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
if (envProject && envProject !== PROJECT_ID) {
  console.error(`❌ Refusing to run: ambient project '${envProject}' != '${PROJECT_ID}'.`)
  process.exit(1)
}

// Guard: this script has no emulator mode — it always hits the cloud project.
// A stray emulator host env var means the caller thinks they're working locally.
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('❌ Refusing to run with an emulator host set — this script only targets the')
  console.error('   real cloud project. Unset FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST.')
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'include-leads': { type: 'boolean', default: false },
    // Q13's escape hatch. It has to be TYPED, and it is echoed rather than
    // silently honored: the console output of a destructive run is its only
    // record, and this flag is the one that throws away the artefact a studio
    // most needs after the relationship ends.
    'no-consent-export': { type: 'boolean', default: false },
    // Back-compat with the old flag; same meaning as --yes.
    confirm: { type: 'boolean', default: false },
  },
})
const dryRun = values['dry-run']
const includeLeads = values['include-leads']
const skipPrompt = values.yes || values.confirm
const skipConsentExport = values['no-consent-export']

admin.initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })

const db = admin.firestore()
const auth = admin.auth()

/** Where the pre-teardown consent ledgers land. Under `exports/`, which is
 *  gitignored: they carry names, addresses and IP addresses. */
const CONSENT_EXPORT_DIR = path.resolve(process.cwd(), 'exports', 'consent-ledgers')

// Which docs belong to a tenant — taken STRAIGHT from the shared manifest
// (packages/shared/src/tenantData.ts), never hand-copied. That file has a
// completeness test, so a newly-registered tenant collection is automatically
// understood here; a local copy would silently go stale and start deleting
// preserved lead data (exactly what happened to `availability_exceptions`).
// Structural type for the imported manifest: tsconfig.scripts.json doesn't
// resolve the @linyup/shared types (the import is `any` at compile time even
// though it resolves fine at runtime), so annotate rather than infer.
type TenantCollection = {
  collection: string
  match: { by: 'field'; field: string } | { by: 'docId' }
}
const TENANT_COLLECTIONS: TenantCollection[] = TENANT_DATA_COLLECTIONS

const FIELD_BY_COLLECTION = new Map<string, string>(
  TENANT_COLLECTIONS.flatMap((c) => (c.match.by === 'field' ? [[c.collection, c.match.field]] : []))
)
const DOCID_COLLECTIONS = new Set<string>(
  TENANT_COLLECTIONS.flatMap((c) => (c.match.by === 'docId' ? [c.collection] : []))
)

const isLeadTeamId = (id: unknown) => typeof id === 'string' && id.startsWith(LEAD_PREFIX)
/** Auth uids seed-lead.ts creates: staff `{teamId}-…` + logins `contact:{teamId}:…`. */
const isLeadUid = (uid: string) =>
  uid.startsWith(LEAD_PREFIX) || uid.startsWith(`contact:${LEAD_PREFIX}`)

/** Decide whether one document belongs to a lead tenant (⇒ preserve it). */
function belongsToLead(collectionId: string, doc: admin.firestore.QueryDocumentSnapshot): boolean {
  if (collectionId === 'teams') return isLeadTeamId(doc.id)
  if (DOCID_COLLECTIONS.has(collectionId)) return isLeadTeamId(doc.id)
  const field = FIELD_BY_COLLECTION.get(collectionId)
  if (field) return isLeadTeamId(doc.get(field))
  // `users/{uid}` profile docs are keyed by auth uid, not team id.
  if (collectionId === 'users') return isLeadUid(doc.id)
  // Anything else is global/demo state (app_settings, mail_sends, …) — not lead
  // data, so it goes. A NEW tenant-scoped collection that nobody adds to the
  // manifest above lands here and would be wiped: keep the manifest current.
  return false
}

type Plan = { collection: string; deleting: number; preserving: number; refs: admin.firestore.DocumentReference[] }

async function planFirestore(): Promise<Plan[]> {
  const collections = await db.listCollections()
  const plans: Plan[] = []
  for (const col of collections) {
    const snap = await col.get()
    const refs: admin.firestore.DocumentReference[] = []
    let preserving = 0
    for (const doc of snap.docs) {
      if (!includeLeads && belongsToLead(col.id, doc)) preserving++
      else refs.push(doc.ref)
    }
    plans.push({ collection: col.id, deleting: refs.length, preserving, refs })
  }
  return plans
}

async function planAuthUsers(): Promise<{ deleting: string[]; preserving: number }> {
  const deleting: string[] = []
  let preserving = 0
  let pageToken: string | undefined
  do {
    const page = await auth.listUsers(1000, pageToken)
    for (const u of page.users) {
      if (!includeLeads && isLeadUid(u.uid)) preserving++
      else deleting.push(u.uid)
    }
    pageToken = page.pageToken
  } while (pageToken)
  return { deleting, preserving }
}

async function main() {
  console.log(`\n🧨 Reset target: ${PROJECT_ID}`)
  console.log(
    includeLeads
      ? '   ⚠️  --include-leads: lead-* tenants WILL be destroyed too.'
      : '   Lead tenants (lead-*) are PRESERVED.'
  )
  if (dryRun) console.log('   🔎 --dry-run: nothing will be deleted.\n')
  else console.log('')

  console.log('Scanning…')
  const plans = await planFirestore()
  const users = await planAuthUsers()
  const totalDeleting = plans.reduce((n, p) => n + p.deleting, 0)
  const totalPreserving = plans.reduce((n, p) => n + p.preserving, 0)

  console.log('\n   ┌────────────────────────────────┬──────────┬───────────┐')
  console.log('   │ collection                     │ deleting │ preserving│')
  console.log('   ├────────────────────────────────┼──────────┼───────────┤')
  for (const p of plans.filter((p) => p.deleting || p.preserving)) {
    console.log(
      `   │ ${p.collection.slice(0, 30).padEnd(30)} │ ${String(p.deleting).padStart(8)} │ ${String(p.preserving).padStart(9)} │`
    )
  }
  console.log(
    `   │ ${'(auth users)'.padEnd(30)} │ ${String(users.deleting.length).padStart(8)} │ ${String(users.preserving).padStart(9)} │`
  )
  console.log('   └────────────────────────────────┴──────────┴───────────┘')
  console.log(
    `\n   ${totalDeleting} top-level docs + ${users.deleting.length} auth users to delete` +
      (totalPreserving || users.preserving
        ? ` · ${totalPreserving} docs + ${users.preserving} auth users preserved`
        : '')
  )

  if (dryRun) {
    console.log('\n🔎 Dry run — nothing was deleted.\n')
    return
  }
  if (totalDeleting === 0 && users.deleting.length === 0) {
    console.log('\n✅ Nothing to delete.\n')
    return
  }

  if (!skipPrompt) {
    if (!process.stdin.isTTY) {
      console.error('\n❌ Refusing to run non-interactively without --yes.')
      console.error('   Re-run with --yes (CI), or --dry-run to preview.\n')
      process.exit(1)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nType '${PROJECT_ID}' to confirm deletion: `)
    rl.close()
    if (answer.trim() !== PROJECT_ID) {
      console.error('❌ Confirmation did not match — aborted. Nothing was deleted.\n')
      process.exit(1)
    }
  }

  // ── EXPORT BEFORE TEARDOWN (Q13) ────────────────────────────────
  // Deleting a team destroys every signature it ever collected — the acceptance
  // events, the immutable version snapshots their hashes point at, and the
  // signer rows — and a liability release is the ONE artefact a studio needs
  // AFTER the relationship ends. So the ledger is written to disk BEFORE the
  // first delete, and a failure here refuses the whole run.
  const teamIdsBeingDeleted = (plans.find((p) => p.collection === 'teams')?.refs ?? []).map(
    (r) => r.id
  )
  await requireConsentExport(db, teamIdsBeingDeleted, CONSENT_EXPORT_DIR, {
    skip: skipConsentExport,
  })

  console.log('\n1/2  Firestore…')
  for (const p of plans) {
    if (!p.deleting) continue
    process.stdout.write(`   deleting ${p.deleting} from '${p.collection}'… `)
    for (const ref of p.refs) await db.recursiveDelete(ref)
    console.log('done')
  }

  console.log('\n2/2  Auth users…')
  let usersDeleted = 0
  for (let i = 0; i < users.deleting.length; i += 1000) {
    const batch = users.deleting.slice(i, i + 1000)
    const res = await auth.deleteUsers(batch)
    usersDeleted += res.successCount
    for (const err of res.errors) {
      console.warn(`   WARN failed to delete uid=${batch[err.index]}: ${err.error.message}`)
    }
  }

  console.log('\n✅ Reset complete.')
  console.log('   ┌──────────────────────────────┬───────────┐')
  console.log('   │ Firestore top-level docs      │ ' + String(totalDeleting).padStart(9) + ' │')
  console.log('   │ Auth users deleted            │ ' + String(usersDeleted).padStart(9) + ' │')
  console.log('   │ Docs preserved (leads)        │ ' + String(totalPreserving).padStart(9) + ' │')
  console.log('   └──────────────────────────────┴───────────┘\n')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Reset failed:', err)
    process.exit(1)
  })
