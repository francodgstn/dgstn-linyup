import { FieldValue } from 'firebase-admin/firestore'
import type { MigrationConfig } from '../config'
import { sourceDb, targetDb, ORG_ID, ORG_NAME, HMD_ORG_RANKING_SYSTEMS, EXPECTED_HMD_MODULES } from '../config'
import { resolveOrgAdmin } from '../orgAdmin'

/** The bundle container HMD installs at org level. Its members are EXPECTED_HMD_MODULES. */
const CONTAINER_PLUGIN_ID = 'hmd'

// Path constants + default statuses mirror @linyup/shared (not importable under
// tsconfig.scripts.json). The org-level 'club' affiliation type + the reused org
// membership statuses back the migration's org-issued affiliations.
const AFFILIATION_TYPES_SUBCOLLECTION = 'affiliation_types'
const ORG_AFFILIATION_STATUSES_SUBCOLLECTION = 'affiliation_statuses'

// NO 'guest' — the migration used to seed it, and seeding it was how the old
// model survived the import. HMD's source data DOES carry
// `org_membership_status: 'guest'`, and `transforms/contacts.ts` maps it to NO
// affiliation row (`isAffiliationStatus`), which is correct and stays. But the
// import then wrote a `guest` STATUS DEF into the org's vocabulary, so the
// federation's status picker offered "Guest" — a value that, if anyone chose it,
// creates the very row whose absence is what "guest" was supposed to mean.
// See `docs/org-contact-visibility.md`.
const DEFAULT_ORG_AFFILIATION_STATUSES = [
  { id: 'requested',    label: 'Requested',    description: 'Member has submitted a request, awaiting review.',  color: 'yellow', order: 0, isBuiltIn: true, countsAsActive: false, isFinal: false },
  { id: 'under_review', label: 'Under review', description: 'Documents are being reviewed by the organisation.', color: 'blue',   order: 1, isBuiltIn: true, countsAsActive: false, isFinal: false },
  { id: 'almost_ready', label: 'Almost ready', description: 'Review complete, awaiting final confirmation.',     color: 'purple', order: 2, isBuiltIn: true, countsAsActive: false, isFinal: false },
  { id: 'active',       label: 'Active',       description: 'Valid membership, recognised by the federation.',    color: 'green',  order: 3, isBuiltIn: true, countsAsActive: true,  isFinal: false },
  { id: 'expired',      label: 'Expired',      description: 'Membership period has ended. Renewal required.',     color: 'red',    order: 4, isBuiltIn: true, countsAsActive: false, isFinal: true },
] as const

const ORG_CLUB_AFFILIATION_TYPE = {
  id: 'club', key: 'club', label: 'Club membership', default_issuer: 'org', org_id: ORG_ID, active: true, order: 0,
}

export async function pass00Setup(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 0: org setup')
  const src = sourceDb()
  const tgt = targetDb()

  // The TARGET's login for that email first, the source user second — see
  // orgAdmin.ts for the production case this order exists for.
  const adminUid = (await resolveOrgAdmin(cfg)).uid

  if (cfg.dryRun) {
    console.log(`  [dry-run] would create organizations/${ORG_ID} and org_members/${adminUid}`)
    return
  }

  // HMD IS COMPED, AND THE MIGRATION IS WHERE THAT BECOMES TRUE.
  //
  // `Organization.plan` and `plan_status` are declared NON-optional on the type,
  // and this pass wrote neither — so `organizations/hmd` did not satisfy its own
  // interface, and every reader that asks "what is this org paying?" got
  // `undefined`. It happened to be harmless only because the trial sweep selects
  // `plan_status == 'trial'` and a missing field is excluded by Firestore. That
  // is luck, not a design, and the first writer to set a status would end it.
  //
  // `flags.comped` is the RECORD of why there is no subscription, and it is what
  // three separate mechanisms read: the trial sweep and `lapseOrganization` both
  // refuse an exempt tenant, the MRR reducer leaves it out of revenue while
  // keeping it in usage, and the Connect fee waiver reads it — for the ORG — to
  // decide that no platform fee is taken on any payment at any HMD studio. That
  // last one is why it belongs here rather than on the 16 team documents: the
  // waiver reads through to the organisation, so a 17th studio opened next year
  // inherits the comp by construction instead of by somebody remembering.
  //
  // Written on re-run too. The comp is not a one-time seed but a standing fact,
  // and a re-run that silently dropped it would restore the platform fee on
  // every HMD payment with nothing to notice.
  const COMP = {
    plan:        'organization' as const,
    plan_status: 'active' as const,
    flags: {
      comped:        true,
      comped_reason: 'Founding organisation — migrated from hmd-lineup, billed nothing indefinitely',
      comped_since:  FieldValue.serverTimestamp(),
    },
  }

  // Create/update the org document with ranking systems (always merge so re-runs are safe)
  const orgRef = tgt.collection('organizations').doc(ORG_ID)
  const orgSnap = await orgRef.get()
  if (orgSnap.exists) {
    // Always update ranking_systems even if org already existed
    await orgRef.set({ ranking_systems: HMD_ORG_RANKING_SYSTEMS, ...COMP }, { merge: true })
    console.log(`  organizations/${ORG_ID} updated — ranking systems + comp applied`)
  } else {
    await orgRef.set({
      name:             ORG_NAME,
      slug:             ORG_ID,
      createdBy:        adminUid,
      created:          FieldValue.serverTimestamp(),
      ranking_systems:  HMD_ORG_RANKING_SYSTEMS,
      ...COMP,
    })
    console.log(`  created organizations/${ORG_ID} with ${HMD_ORG_RANKING_SYSTEMS.length} ranking systems (comped)`)
  }

  // Seed the org membership statuses (reused as affiliation statuses) + the
  // org-level 'club' affiliation type that backs org-issued affiliations.
  for (const st of DEFAULT_ORG_AFFILIATION_STATUSES) {
    await orgRef.collection(ORG_AFFILIATION_STATUSES_SUBCOLLECTION).doc(st.id).set(st)
  }
  await orgRef
    .collection(AFFILIATION_TYPES_SUBCOLLECTION)
    .doc(ORG_CLUB_AFFILIATION_TYPE.id)
    .set(ORG_CLUB_AFFILIATION_TYPE)
  console.log(`  seeded ${DEFAULT_ORG_AFFILIATION_STATUSES.length} membership statuses + org 'club' affiliation type`)

  // Create the org_admin member doc (idempotent)
  if (adminUid) {
    const memberRef = orgRef.collection('org_members').doc(adminUid)
    const memberSnap = await memberRef.get()
    if (memberSnap.exists) {
      console.log(`  org_members/${adminUid} already exists — skipping`)
    } else {
      await memberRef.set({
        userId:  adminUid,
        email:   cfg.orgAdminEmail,
        role:    'org_admin',
        joined:  FieldValue.serverTimestamp(),
      })
      console.log(`  created org_members/${adminUid} (org_admin)`)
    }
  }

  // Pre-install the HMD plugin CONTAINER at org level (idempotent).
  //
  // The container ONLY. Its members (today: hmd-fighting-cup) are materialized
  // by the `onOrgBundleInstallChange` trigger from `config.modules` — writing
  // them here would make this script a second writer of member installs, which
  // the bundle census test forbids and which would drift from the reconciler's
  // idea of what the container owns (no `installedByBundle` stamp, so the
  // reconciler would never clean them up).
  const pluginRef = orgRef.collection('installed_plugins').doc(CONTAINER_PLUGIN_ID)
  const pluginSnap = await pluginRef.get()
  if (pluginSnap.exists) {
    console.log(`  installed_plugins/${CONTAINER_PLUGIN_ID} already exists — skipping`)
  } else {
    await pluginRef.set({
      pluginId:    CONTAINER_PLUGIN_ID,
      orgId:       ORG_ID,
      installedAt: FieldValue.serverTimestamp(),
      installedBy: 'migration',
      status:      'active',
      // Empty: an absent module reads as ON, so every member ships enabled and a
      // module added later reaches this org without a data edit.
      config:      {},
    })
    console.log(`  created installed_plugins/${CONTAINER_PLUGIN_ID} (org-level container, migration)`)
  }

  // The members are the reconciler's job, and it only runs if the functions are
  // deployed against this target. Say so loudly rather than leaving a migration
  // that looks like it worked and left HMD without its Fighting Cup.
  await pollBundleMembers(orgRef, CONTAINER_PLUGIN_ID, EXPECTED_HMD_MODULES, { soft: true })
}

/**
 * Wait for the bundle reconciler to materialize a container's members.
 *
 * ── WHY THIS IS ASKED TWICE ────────────────────────────────────────────────
 * At pass 0 the question is not yet answerable. `--reset` deletes every
 * document first, and each delete is a Firestore event: on a target holding a
 * previous import that is thousands of them, and the container's own create
 * event queues behind the lot. The members then appear a minute later, long
 * after any poll a migration can afford to sit through — so the pass-0 check
 * saw them missing and printed "deploy the Cloud Functions and re-run", on a
 * run where the functions were deployed and nothing was wrong.
 *
 * A warning that is wrong on ordinary runs is worse than no warning: it teaches
 * the reader to scroll past the one time it is real. So pass 0 only looks (and
 * says it will look again), and `recheckBundleMembers` — called at the END of
 * the run, minutes later — is the one that gets to conclude.
 *
 * Still a warning and not a throw, at both points: the emulator target
 * frequently runs without the functions emulator, and failing a two-hour data
 * migration over a document that one deploy will create is the wrong trade. But
 * saying nothing is worse — the container looks installed while the feature it
 * packages is absent.
 */
async function pollBundleMembers(
  orgRef: FirebaseFirestore.DocumentReference,
  containerId: string,
  expected: readonly string[],
  { soft }: { soft: boolean },
): Promise<void> {
  const deadline = Date.now() + 15_000
  let missing: string[] = []
  do {
    const snaps = await Promise.all(
      expected.map((id) => orgRef.collection('installed_plugins').doc(id).get()),
    )
    missing = expected.filter((_, i) => !snaps[i].exists)
    if (missing.length === 0) {
      console.log(`  bundle '${containerId}' reconciled — members: ${expected.join(', ')}`)
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  } while (Date.now() < deadline)

  if (soft) {
    console.log(
      `  bundle '${containerId}': ${missing.join(', ')} not there yet — ` +
        `the reconciler is behind the reset's delete events. Re-checked at the end.`,
    )
    return
  }

  console.warn(
    `\n⚠️  bundle '${containerId}' never materialized ${missing.join(', ')}.\n` +
      `    The onOrgBundleInstallChange trigger is what creates these. Deploy the\n` +
      `    Cloud Functions against this target (or start the functions emulator) and\n` +
      `    re-run pass 'setup' — the container install alone gives HMD nothing.\n`,
  )
}

/**
 * The conclusive check — run once, at the end of a migration. See above for why
 * the answer at pass 0 does not count.
 */
export async function recheckBundleMembers(): Promise<void> {
  const orgRef = targetDb().collection('organizations').doc(ORG_ID)
  if (!(await orgRef.get()).exists) return // pass 0 never ran (a --only run)
  await pollBundleMembers(orgRef, CONTAINER_PLUGIN_ID, EXPECTED_HMD_MODULES, { soft: false })
}
