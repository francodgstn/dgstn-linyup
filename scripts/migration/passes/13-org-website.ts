import { FieldValue } from 'firebase-admin/firestore'
import type { MigrationConfig } from '../config'
import { targetDb, ORG_ID, ORG_NAME } from '../config'

// Pass 13 — seed a showcase ORGANIZATION WEBSITE for HMD.
//
// Creates a minimal org site (hero + about + clubs directory + contact) at
// org_site_drafts/{ORG_ID} and org_site_published/{ORG_ID}. The published doc is
// world-readable and serves the public route /public/org/{slug}. The clubs block
// reads each member team's live public_profile at render time, so the directory
// stays fresh; only the embedded team list is a snapshot (rebuilt on re-publish).
//
// Path/type names are inlined (the @linyup/shared package isn't importable under
// tsconfig.scripts.json — same convention as the other passes). Idempotent AND
// non-destructive: if a published site already exists we only refresh the embedded
// team snapshot, so a hand-edited site built in the org builder is never clobbered.

const ORG_SITE_DRAFTS_COLLECTION = 'org_site_drafts'
const ORG_SITE_PUBLISHED_COLLECTION = 'org_site_published'
const ORG_TEAMS_SUBCOLLECTION = 'org_teams'

interface TeamRef {
  teamId: string
  slug: string
  name: string
}

function showcaseSections(orgName: string) {
  return [
    {
      id: 's-hero',
      type: 'hero',
      headline: orgName,
      subheadline: 'One organization, many clubs — find your place to train.',
      align: 'center',
      overlay: 45,
    },
    {
      id: 's-about',
      type: 'content',
      heading: `About ${orgName}`,
      body:
        `<p>${orgName} brings together our member clubs under one roof. ` +
        `Explore the clubs below to find locations, coaches, and how to get started.</p>`,
      imageSide: 'left',
    },
    {
      id: 's-clubs',
      type: 'clubs',
      heading: 'Our clubs',
      subheading: 'Every club in the organization, with its home location.',
      columns: 3,
      showAddress: true,
    },
    {
      id: 's-coaches',
      type: 'coaches',
      heading: 'Our coaches',
      subheading: 'The people who lead our sessions across the clubs.',
      columns: 3,
    },
    {
      id: 's-contact',
      type: 'contact',
      heading: 'Get in touch',
      showSocial: false,
    },
  ]
}

function showcaseMeta(orgName: string) {
  return {
    title: orgName,
    theme: 'light',
    accentColor: '#6366f1',
    font: 'sans',
    seo: {
      title: orgName,
      description: `${orgName} — our clubs, locations and coaches.`,
    },
    header: { showNav: true },
    footer: { showSocial: false },
  }
}

export async function pass13OrgWebsite(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 13: org website (showcase)')
  const tgt = targetDb()
  const orgRef = tgt.collection('organizations').doc(ORG_ID)

  const orgSnap = await orgRef.get()
  if (!orgSnap.exists) {
    console.warn(`  WARN: organizations/${ORG_ID} does not exist — run pass 'setup' first; skipping`)
    return
  }
  const org = orgSnap.data() ?? {}
  const slug = String(org.slug ?? ORG_ID)
  const name = String(org.name ?? ORG_NAME)

  // Build the member-team snapshot from active org_teams (doc id === teamId).
  const orgTeamsSnap = await orgRef.collection(ORG_TEAMS_SUBCOLLECTION).get()
  const teams: TeamRef[] = []
  for (const d of orgTeamsSnap.docs) {
    const status = d.data().status
    if (status && status !== 'active') continue
    const teamId = d.id
    const teamSnap = await tgt.collection('teams').doc(teamId).get()
    if (!teamSnap.exists) continue
    const t = teamSnap.data() ?? {}
    if (!t.slug) continue // no slug ⇒ not resolvable publicly; skip
    teams.push({ teamId, slug: String(t.slug), name: String(t.name ?? teamId) })
  }
  console.log(`  ${teams.length} member team(s) in the clubs snapshot`)

  if (cfg.dryRun) {
    console.log(`  [dry-run] would seed ${ORG_SITE_DRAFTS_COLLECTION}/${ORG_ID} + ${ORG_SITE_PUBLISHED_COLLECTION}/${ORG_ID} (slug=${slug})`)
    return
  }

  const meta = showcaseMeta(name)
  const sections = showcaseSections(name)

  // Draft — created only if absent (never clobber a builder-edited draft).
  const draftRef = tgt.collection(ORG_SITE_DRAFTS_COLLECTION).doc(ORG_ID)
  if ((await draftRef.get()).exists) {
    console.log(`  ${ORG_SITE_DRAFTS_COLLECTION}/${ORG_ID} already exists — leaving draft as-is`)
  } else {
    await draftRef.set({
      orgId: ORG_ID,
      slug,
      name,
      enabled: true,
      meta,
      sections,
      updated_at: FieldValue.serverTimestamp(),
      updatedBy: 'migration',
    })
    console.log(`  created ${ORG_SITE_DRAFTS_COLLECTION}/${ORG_ID}`)
  }

  // Published — if it exists, only refresh the embedded team snapshot; otherwise
  // seed the full showcase so /public/org/${slug} is live immediately.
  const pubRef = tgt.collection(ORG_SITE_PUBLISHED_COLLECTION).doc(ORG_ID)
  if ((await pubRef.get()).exists) {
    await pubRef.set({ teams, updated_at: FieldValue.serverTimestamp() }, { merge: true })
    console.log(`  ${ORG_SITE_PUBLISHED_COLLECTION}/${ORG_ID} exists — refreshed clubs snapshot only`)
  } else {
    await pubRef.set({
      orgId: ORG_ID,
      slug,
      name,
      meta,
      sections,
      teams,
      showBranding: false,
      published_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })
    console.log(`  published ${ORG_SITE_PUBLISHED_COLLECTION}/${ORG_ID} → /public/org/${slug}`)
  }
}
