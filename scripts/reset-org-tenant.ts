/**
 * Tear down ONE ORGANIZATION and its member studios — and nothing else.
 *
 * Built for the HMD refresh: staging carries the federation's migrated data
 * ALONGSIDE the seeded demo tenants that testers are signed into, so
 * `staging:reset` (which deletes every document and every auth user) is the
 * wrong instrument. This removes an org's own subtree, every studio that belongs
 * to it, and all of their tenant data, leaving every other tenant untouched.
 *
 *   pnpm reset:org --org hmd --target emulator --dry-run
 *   pnpm reset:org --org hmd --target staging
 *
 * ── IT IS AN ALLOW-LIST, AND THE SANDBOX RESET IS A DENY-LIST ───────────────
 * `reset-sandbox-db.ts` deletes everything EXCEPT the tenants it recognizes, so
 * a collection nobody classified gets WIPED — the safe default when the whole
 * project is disposable. This script runs against an environment other people
 * are using, so it inverts that: a document is deleted only if it can be shown
 * to belong to the org, and anything unrecognised is LEFT ALONE. The two
 * defaults look like a style difference and are not; copying the deny-list shape
 * here would delete other tenants' data the first time somebody registered a
 * collection without telling this file.
 *
 * ── WHICH IS WHY IT CHECKS ITS OWN WORK ────────────────────────────────────
 * The cost of the safe default is that a missed collection leaves ORPHANS
 * rather than making noise. So the run ends with a RESIDUE SCAN: every
 * top-level collection is swept for documents that still name the org or one of
 * its studios. An enumeration I got wrong is then visible in the output of the
 * run that got it wrong, instead of being discovered months later by somebody
 * wondering why a deleted federation still has events.
 *
 * A hit in a PLATFORM collection is EXPECTED and is reported as a count rather
 * than a warning — `users/{uid}` survives on purpose, and HMD's team ids are
 * their owners' uids, so the first version of this scan reported three
 * "leftovers" on a perfectly clean run. A check that cries wolf every time is
 * one nobody reads, which costs more than it was ever going to catch.
 *
 * ── AUTH USERS ARE DELIBERATELY NOT TOUCHED ────────────────────────────────
 * An identity can belong to more than one tenant, testers are signed in right
 * now, and the migration is already idempotent over them (pass 0b reports
 * "imported 0, skipped 52" against existing users). Deleting them buys nothing
 * and risks exactly the people this script exists to protect. `users/{uid}`
 * profile documents are left for the same reason — they are PLATFORM data in
 * the shared manifest, and the migration rewrites them.
 */

import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import * as path from 'node:path'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { TENANT_DATA_COLLECTIONS, PLATFORM_COLLECTIONS } from '@linyup/shared'
import { requireConsentExport } from './lib/exportConsentLedger'

// tsconfig.scripts.json does not resolve @linyup/shared's types (the import is
// `any` at compile time though it resolves fine at runtime), so the manifest is
// annotated rather than inferred — same as reset-sandbox-db.ts.
type TenantCollection = {
  collection: string
  match: { by: 'field'; field: string } | { by: 'docId' }
}
const TENANT_COLLECTIONS: TenantCollection[] = TENANT_DATA_COLLECTIONS

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'no-consent-export': { type: 'boolean', default: false },
  },
})

const ORG_ID = values.org
const TARGET = values.target
const dryRun = values['dry-run']
const skipPrompt = values.yes
const skipConsentExport = values['no-consent-export']

if (!ORG_ID) {
  console.error('❌ --org <orgId> is required (e.g. --org hmd)')
  process.exit(1)
}

// PRODUCTION IS NOT A TARGET. Not because the operation is wrong there, but
// because it has never been rehearsed there and the flag would be one typo from
// deleting a real federation. Add it deliberately, with its own review, if the
// day comes.
const TARGETS: Record<string, { projectId: string; emulator: boolean }> = {
  emulator: { projectId: 'demo-linyup', emulator: true },
  staging: { projectId: 'linyup-staging', emulator: false },
  sandbox: { projectId: 'linyup-sandbox', emulator: false },
}
const target = TARGET ? TARGETS[TARGET] : undefined
if (!target) {
  console.error(`❌ --target must be one of: ${Object.keys(TARGETS).join(' | ')}`)
  if (TARGET) console.error(`   got '${TARGET}'. Production is deliberately absent.`)
  process.exit(1)
}

// The slot model, so a worktree tears down ITS OWN emulator rather than the main
// checkout's (see .claude/skills/local-env). Set before initializeApp, because
// firebase-admin reads these once, globally.
if (target.emulator) {
  const slot = Number(process.env.LINYUP_SLOT ?? 0) || 0
  process.env.FIRESTORE_EMULATOR_HOST ??= `localhost:${8080 + slot * 10000}`
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('❌ Refusing to run against a cloud project with FIRESTORE_EMULATOR_HOST set.')
  console.error('   Unset it, or pass --target emulator if local is what you meant.')
  process.exit(1)
}

admin.initializeApp(
  target.emulator
    ? { projectId: target.projectId }
    : { credential: applicationDefault(), projectId: target.projectId }
)
const db = admin.firestore()

const CONSENT_EXPORT_DIR = path.resolve(process.cwd(), 'exports', 'consent-ledgers')

const FIELD_BY_COLLECTION = new Map<string, string>(
  TENANT_COLLECTIONS.flatMap((c) => (c.match.by === 'field' ? [[c.collection, c.match.field]] : []))
)
const DOCID_COLLECTIONS = TENANT_COLLECTIONS.flatMap((c) =>
  c.match.by === 'docId' ? [c.collection] : []
)

/** Fields a top-level document uses to name its organization. */
const ORG_FIELDS = ['orgId', 'org_id', 'organizationId'] as const

/**
 * Top-level documents keyed BY the org id. Subcollections of
 * `organizations/{orgId}` are not listed — the recursive delete of the org
 * document takes them.
 */
const ORG_DOCID_COLLECTIONS = [
  'org_site_drafts',
  'org_site_published',
  // An org buys its plan like a team does; the doc id is the ORG id.
  'saas_subscriptions',
  // Operator-set delivery policy — the manifest notes the doc id may be a
  // teamId, an orgId or 'system'. Per-team teardown never reaches the org one.
  'messaging_policies',
]

type Group = { label: string; refs: admin.firestore.DocumentReference[] }

/** Every studio that belongs to the org, from BOTH directions. */
async function resolveTeamIds(): Promise<string[]> {
  const ids = new Set<string>()

  // The roster the org keeps.
  const roster = await db.collection('organizations').doc(ORG_ID!).collection('org_teams').get()
  for (const d of roster.docs) ids.add(d.id)

  // …and the stamp each team carries. Asked BOTH ways on purpose: a studio whose
  // org_teams row was never written still holds the org's data, and a roster row
  // for a team already deleted is harmless. Trusting one direction is how a
  // studio gets left behind holding a federation's contacts.
  for (const field of ['org_id', 'organizationId']) {
    const snap = await db.collection('teams').where(field, '==', ORG_ID).get()
    for (const d of snap.docs) ids.add(d.id)
  }
  return [...ids].sort()
}

/** Firestore `in` accepts 30 values; chunk anything keyed off the team list. */
function chunk<T>(xs: T[], n = 30): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

async function plan(teamIds: string[]): Promise<Group[]> {
  const groups: Group[] = []

  // 1. The tenant sweep, per the shared manifest — never a hand-copied list.
  for (const entry of TENANT_COLLECTIONS) {
    const refs: admin.firestore.DocumentReference[] = []
    if (entry.match.by === 'docId') {
      for (const id of teamIds) {
        const ref = db.collection(entry.collection).doc(id)
        if ((await ref.get()).exists) refs.push(ref)
      }
    } else {
      const field = entry.match.field
      for (const part of chunk(teamIds)) {
        const snap = await db.collection(entry.collection).where(field, 'in', part).get()
        for (const d of snap.docs) refs.push(d.ref)
      }
    }
    if (refs.length) groups.push({ label: entry.collection, refs })
  }

  // 2. ORG-SCOPED DOCUMENTS THAT MATCH NO TEAM. The federation's own events have
  //    `teamId: null`, so the sweep above cannot see them — the single easiest
  //    thing to leave behind, and the reason for the residue scan below.
  for (const field of ORG_FIELDS) {
    for (const col of ['events', 'checkins']) {
      const snap = await db.collection(col).where(field, '==', ORG_ID).get()
      const refs = snap.docs.filter((d) => !d.get('teamId')).map((d) => d.ref)
      if (refs.length) groups.push({ label: `${col} (org-scoped, ${field})`, refs })
    }
  }

  // 3. Top-level documents keyed by the org id.
  const orgKeyed: admin.firestore.DocumentReference[] = []
  for (const col of ORG_DOCID_COLLECTIONS) {
    const ref = db.collection(col).doc(ORG_ID!)
    if ((await ref.get()).exists) orgKeyed.push(ref)
  }
  if (orgKeyed.length) groups.push({ label: 'org-keyed documents', refs: orgKeyed })

  // 4. The studios themselves, and then the organization. LAST, because the
  //    roster inside it is how step 1 found them: delete it first and a failed
  //    run cannot be resumed.
  const teamRefs = teamIds.map((id) => db.collection('teams').doc(id))
  if (teamRefs.length) groups.push({ label: 'teams (subtree)', refs: teamRefs })

  const orgRef = db.collection('organizations').doc(ORG_ID!)
  if ((await orgRef.get()).exists) {
    groups.push({ label: 'organizations (subtree)', refs: [orgRef] })
  }
  return groups
}

/**
 * What still names the org after the run. See the header: the allow-list's cost
 * is silence, and this is what buys it back.
 *
 * ── PLATFORM HITS ARE EXPECTED, AND MUST NOT WARN ──────────────────────────
 * A `users/{uid}` profile survives on purpose, and HMD's team ids ARE their
 * owners' uids — so a naive scan reports three "leftovers" on a perfectly clean
 * run, every run. A check that cries wolf is one nobody reads, which costs more
 * than it was ever going to catch. So a hit inside a PLATFORM collection (the
 * shared manifest's own classification, not a list kept here) is counted and
 * named, and only a hit OUTSIDE one is a warning.
 */
async function residueScan(
  teamIds: string[]
): Promise<{ unexpected: string[]; platform: Map<string, number> }> {
  const unexpected: string[] = []
  const platform = new Map<string, number>()
  const isPlatform = new Set<string>(PLATFORM_COLLECTIONS)
  const teamSet = new Set(teamIds)

  for (const col of await db.listCollections()) {
    const snap = await col.get()
    for (const d of snap.docs) {
      const data = d.data()
      const namesOrg = ORG_FIELDS.some((f) => data[f] === ORG_ID)
      const namesTeam =
        teamSet.has(d.id) ||
        [...FIELD_BY_COLLECTION.values(), 'teamId', 'team_id'].some((f) =>
          typeof data[f] === 'string' ? teamSet.has(data[f] as string) : false
        )
      if (!namesOrg && !(namesTeam && !DOCID_COLLECTIONS.includes(col.id))) continue
      if (isPlatform.has(col.id)) {
        platform.set(col.id, (platform.get(col.id) ?? 0) + 1)
      } else {
        unexpected.push(`${col.id}/${d.id}${namesOrg ? '  (names the org)' : '  (names a studio)'}`)
      }
    }
  }
  return { unexpected, platform }
}

async function main() {
  console.log(`\n🧨 Org teardown — '${ORG_ID}' on ${target!.projectId} (${TARGET})`)
  console.log('   Every other tenant is preserved. Auth users are never touched.')
  if (dryRun) console.log('   🔎 --dry-run: nothing will be deleted.')

  const teamIds = await resolveTeamIds()
  console.log(`\n   ${teamIds.length} studio(s) belong to '${ORG_ID}'`)
  for (const id of teamIds) {
    const name = (await db.collection('teams').doc(id).get()).get('name') ?? '(no name)'
    console.log(`     ${id}  ${name}`)
  }

  console.log('\nScanning…')
  const groups = await plan(teamIds)
  const total = groups.reduce((n, g) => n + g.refs.length, 0)

  console.log('\n   ┌──────────────────────────────────────┬──────────┐')
  console.log('   │ what                                 │ deleting │')
  console.log('   ├──────────────────────────────────────┼──────────┤')
  for (const g of groups) {
    console.log(`   │ ${g.label.slice(0, 36).padEnd(36)} │ ${String(g.refs.length).padStart(8)} │`)
  }
  console.log('   └──────────────────────────────────────┴──────────┘')
  console.log(`\n   ${total} document subtree(s) to delete.`)

  if (dryRun) {
    console.log('\n🔎 Dry run — nothing was deleted.\n')
    return
  }
  if (total === 0) {
    console.log('\n✅ Nothing to delete.\n')
    return
  }

  if (!skipPrompt) {
    if (!process.stdin.isTTY) {
      console.error('\n❌ Refusing to run non-interactively without --yes.')
      console.error('   Re-run with --yes, or --dry-run to preview.\n')
      process.exit(1)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nType '${ORG_ID}' to confirm: `)
    rl.close()
    if (answer.trim() !== ORG_ID) {
      console.error('❌ Confirmation did not match — aborted. Nothing was deleted.\n')
      process.exit(1)
    }
  }

  // Deleting a studio destroys every signature it collected, and a liability
  // release is the one artefact that matters AFTER the data is gone. Written to
  // disk before the first delete; a failure here refuses the whole run.
  await requireConsentExport(db, teamIds, CONSENT_EXPORT_DIR, { skip: skipConsentExport })

  console.log('\nDeleting…')
  for (const g of groups) {
    process.stdout.write(`   ${g.label}: ${g.refs.length}… `)
    for (const ref of g.refs) await db.recursiveDelete(ref)
    console.log('done')
  }

  console.log('\nResidue scan…')
  const { unexpected, platform } = await residueScan(teamIds)

  for (const [col, n] of [...platform].sort()) {
    console.log(`   · ${n} ${col} document(s) kept — platform data, never tenant-scoped.`)
  }

  if (unexpected.length === 0) {
    console.log('   ✅ nothing outside the platform collections still names it.')
  } else {
    console.warn(`\n   ⚠️  ${unexpected.length} document(s) still reference it:\n`)
    for (const line of unexpected.slice(0, 40)) console.warn(`     ${line}`)
    if (unexpected.length > 40) console.warn(`     … and ${unexpected.length - 40} more`)
    console.warn(
      '\n   These were NOT deleted, and they are not platform data — so this script\n' +
        '   is missing a collection. Add it above rather than deleting them by hand,\n' +
        '   so the next run gets it right.'
    )
  }

  console.log(`\n✅ '${ORG_ID}' torn down. Other tenants untouched.\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Teardown failed:', err)
    process.exit(1)
  })
