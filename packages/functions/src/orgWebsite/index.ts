// Organization website — publish/unpublish the org-level public site snapshot.
// Mirrors ../website (the team site builder) but keyed by orgId, with org-only
// aggregate sections (clubs/locations/coaches) instead of team commerce sections.
// See @linyup/shared 'types/orgWebsite.ts' for the full doc-shape rationale.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { assertOrgAdmin, assertOrgSubscriptionLive } from '../orgs'
import { translatePublishedSite } from '../translate/translateSite'
import { asDict, clean, optStr, safeUrl, sanitizeMenu, type Dict } from '../website'
import { sanitizeOrgSection, sanitizeOrgMeta, orgSiteSourceLocale } from './sanitize'
import { unpublishSiteForOrg } from '../utils/plugins'
import {
  ORG_SITE_DRAFTS_COLLECTION,
  ORG_SITE_PUBLISHED_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_TEAMS_SUBCOLLECTION,
  TEAMS_COLLECTION,
} from '@linyup/shared'
import type { OrgPublishedSite, OrgSiteSection, OrgSiteTeamRef } from '@linyup/shared'

// The section and meta sanitizers live in ./sanitize (pure, tested).

// ─── publishOrgWebsite ──────────────────────────────────────────────────────────
// Reads the org's private draft, sanitizes it to a public-safe payload, embeds a
// snapshot of the org's active member teams, and writes org_site_published/{orgId}
// (world-readable). Also flags the draft enabled.

export const publishOrgWebsite = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const orgId = (request.data?.orgId ?? '') as string
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId is required')

  await assertOrgAdmin(uid, orgId)
  // The org site is a surface of the organisation TIER, and a lapse takes it
  // down (`lapseOrganization`). Without this the teardown is one click deep:
  // the draft survives the unpublish by design, so an admin of an expired org
  // could put the public site straight back up. Publishing asks; UNpublishing
  // never does — taking your own page down is always allowed.
  await assertOrgSubscriptionLive(orgId)

  const fs = admin.firestore()

  const draftSnap = await fs.doc(`${ORG_SITE_DRAFTS_COLLECTION}/${orgId}`).get()
  if (!draftSnap.exists) throw new HttpsError('not-found', 'No site draft to publish')
  const draft = draftSnap.data() as Dict

  const orgSnap = await fs.doc(`${ORGANIZATIONS_COLLECTION}/${orgId}`).get()
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found')
  const org = orgSnap.data() as Dict
  const slug = optStr(org.slug, 80)
  if (!slug) throw new HttpsError('failed-precondition', 'Set an organization URL (slug) before publishing')

  const name = optStr(draft.name, 200) ?? optStr(org.name, 200) ?? 'Site'

  const sections = (Array.isArray(draft.sections) ? draft.sections : [])
    // Drop sections the org admin toggled hidden — kept in the draft but never
    // reach the published site (or its nav).
    .filter((raw) => !(raw && typeof raw === 'object' && (raw as Dict).hidden === true))
    .map(sanitizeOrgSection)
    .filter((s): s is OrgSiteSection => s !== null)
    .slice(0, 30)

  // Embed a snapshot of the org's active member teams. Only branding-level fields
  // (teamId/slug/name) are embedded; per-team live data (logo, address, coaches)
  // is read at render time from each team's own world-readable public_profile.
  const orgTeamsSnap = await fs
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(orgId)
    .collection(ORG_TEAMS_SUBCOLLECTION)
    .where('status', '==', 'active')
    .get()

  const teams: OrgSiteTeamRef[] = []
  if (!orgTeamsSnap.empty) {
    const teamRefs = orgTeamsSnap.docs.map((d) => fs.collection(TEAMS_COLLECTION).doc(d.id))
    const teamDocs = await fs.getAll(...teamRefs)
    for (const teamDoc of teamDocs) {
      if (!teamDoc.exists) continue
      const t = teamDoc.data() as Dict
      const teamSlug = optStr(t.slug, 80)
      if (!teamSlug) continue // skip teams without a public URL — nothing to link to
      teams.push({ teamId: teamDoc.id, slug: teamSlug, name: optStr(t.name, 200) ?? '' })
    }
  }

  // Denormalise org social links so the published doc is self-contained for
  // footer/contact icons, same as the team site. `Organization.socialLinks` is a
  // typed field now (it was not when this was written, which is why the read
  // stayed defensive — and why the website editor's "show social links" switch
  // had nothing to show for a while).
  const socialLinksRaw = Array.isArray(org.socialLinks) ? (org.socialLinks as unknown[]) : []
  const socialLinks = socialLinksRaw
    .map((s) => {
      const d = asDict(s)
      const platform = optStr(d.platform, 32)
      const url = safeUrl(d.url)
      return platform && url ? { platform, url } : null
    })
    .filter((x): x is { platform: string; url: string } => x !== null)

  const meta = sanitizeOrgMeta(draft.meta, name)
  // The header menu, through the SAME sanitiser the team site uses — depth,
  // breadth and target shape are tenant-agnostic. Undefined when the org has
  // never edited its header, and `clean` drops it, so the renderer keeps
  // deriving the old layout.
  const menu = sanitizeMenu(draft.menu)

  // Machine-translate the sanitized published shape — same pipeline as the
  // team site, keyed by orgId. Throw-free: never fails the publish.
  const srcLang = orgSiteSourceLocale(meta, org as { language?: string | null })
  const i18n = await translatePublishedSite({
    db: fs,
    collection: ORG_SITE_PUBLISHED_COLLECTION,
    id: orgId,
    owner: { orgId },
    published: { meta, menu, sections },
    srcLang,
  })

  // Shaped to match OrgPublishedSite; typed as Dict for the Firestore write since
  // values are re-derived from sanitizers (platform strings, server timestamps).
  const published: Dict = clean({
    orgId,
    slug,
    name,
    meta,
    menu,
    sections,
    teams,
    socialLinks: socialLinks.length ? socialLinks : undefined,
    // The organization plan never shows the "Powered by Linyup" badge (that's a
    // free-team-plan affordance only) — kept explicit (not omitted) for clarity.
    showBranding: false,
    i18n,
    published_at: FieldValue.serverTimestamp() as unknown as OrgPublishedSite['published_at'],
    updated_at: FieldValue.serverTimestamp() as unknown as OrgPublishedSite['updated_at'],
  })

  await fs.doc(`${ORG_SITE_PUBLISHED_COLLECTION}/${orgId}`).set(published)
  await draftSnap.ref.set(
    { enabled: true, updated_at: FieldValue.serverTimestamp(), updatedBy: uid },
    { merge: true },
  )

  return { ok: true, slug }
})

// ─── unpublishOrgWebsite ────────────────────────────────────────────────────────
// Removes the public snapshot so /public/org/[slug] 404s, and flags the draft
// disabled.

export const unpublishOrgWebsite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const orgId = (request.data?.orgId ?? '') as string
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId is required')

  await assertOrgAdmin(uid, orgId)

  // The SAME teardown the org lapse runs — one place that knows everything an
  // org's published site consists of, so the two can never disagree about it.
  await unpublishSiteForOrg(orgId, uid)

  return { ok: true }
})
