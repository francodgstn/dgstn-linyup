import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { hasTeamRole } from '../utils/teams'
import { unpublishSiteForTeam, touchTeamForSurfaceRecompute, pluginIsActive } from '../utils/plugins'
import { deleteSiteI18nSidecars, translatePublishedSite } from '../translate/translateSite'
import {
  SITE_PUBLISHED_COLLECTION,
  FORMS_COLLECTION,
  ACTIVITIES_COLLECTION,
  SITE_I18N_SEPARATOR,
  SITE_PAGES_SUBCOLLECTION,
  SITE_DRAFTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_PLACES_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_PLACES_SUBCOLLECTION,
  resolveSiteSourceLocale,
} from '@linyup/shared'
import type { PublishedSite, SitePageRef, WebsiteSection } from '@linyup/shared'
import {
  readSitePages,
  translateSitePages,
  publishedRedirects,
  writeSitePages,
  pruneUnpublishedPages,
} from './publishPages'
import {
  applyFormChecks,
  asDict,
  clean,
  optStr,
  safeUrl,
  sanitizeMenu,
  sanitizePageRefs,
  sanitizeRedirects,
  dedupeSectionIds,
  sanitizeMeta,
  sanitizeSections,
  str,
  type Dict,
  type FormCheckFacts,
} from './sanitize'

// The publish sanitizers live in ./sanitize — pure, so the lead seeder publishes
// through exactly the same rules. Re-exported so ../orgWebsite and the tests keep
// importing them from here.
export * from './sanitize'

// Resolve a team's place pool (own team_places + inherited org_places) into a
// public-safe map + the team's primary place, for publish-time embedding.
async function loadPlacePool(
  fs: admin.firestore.Firestore,
  teamId: string,
  team: Dict
): Promise<{
  byId: Map<string, { id: string; name: string; address?: string; mapsLink?: string }>
  primary: { name: string; address?: string; mapsLink?: string } | null
}> {
  const byId = new Map<string, { id: string; name: string; address?: string; mapsLink?: string }>()
  const teamSnap = await fs
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_PLACES_SUBCOLLECTION)
    .get()
  const orgId = optStr((team as Dict).org_id, 64)
  const orgSnap = orgId
    ? await fs
        .collection(ORGANIZATIONS_COLLECTION)
        .doc(orgId)
        .collection(ORG_PLACES_SUBCOLLECTION)
        .get()
    : null

  const add = (id: string, data: Dict) =>
    byId.set(
      id,
      clean({ id, name: str(data.name, 200), address: optStr(data.address, 400), mapsLink: safeUrl(data.mapsLink) }) as {
        id: string
        name: string
        address?: string
        mapsLink?: string
      }
    )
  teamSnap.docs.forEach((d) => add(d.id, d.data() as Dict))
  orgSnap?.docs.forEach((d) => add(d.id, d.data() as Dict))

  const primaryDoc = teamSnap.docs.find((d) => (d.data() as Dict).isPrimary === true) ?? teamSnap.docs[0]
  const pd = primaryDoc?.data() as Dict | undefined
  const primary = pd
    ? (clean({ name: str(pd.name, 200), address: optStr(pd.address, 400), mapsLink: safeUrl(pd.mapsLink) }) as {
        name: string
        address?: string
        mapsLink?: string
      })
    : null
  return { byId, primary }
}

export type PlacePool = Awaited<ReturnType<typeof loadPlacePool>>

/**
 * Embed selected places into 'places' sections + default the Contact map from
 * the team's primary place. Mutates the sanitized sections in place.
 *
 * NEVER ASSIGN `undefined` HERE. Every section arrives from a sanitizer that
 * ran it through `clean()`, so an absent optional field has NO KEY — and
 * `s.field = undefined` puts the key back, holding a value Firestore rejects
 * outright (`Cannot use "undefined" as a Firestore value`). That is not a
 * degraded publish, it is a failed one: the whole `site_published` write
 * throws. It reached staging as `sections.N.address` from a primary place that
 * has a name but no address, which is an ordinary thing for a place to be.
 *
 * Pure and exported so the invariant is testable without a Firestore double —
 * `enrichSectionsWithPlaces` is only the loader in front of it.
 */
export function applyPlacePool(sections: WebsiteSection[], pool: PlacePool): void {
  const { byId, primary } = pool
  for (const s of sections) {
    if (s.type === 'places') {
      const resolved = (s.placeIds ?? []).map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x)
      if (resolved.length) s.places = resolved
      else delete s.places
    } else if (s.type === 'contact' && primary) {
      if (!s.address && primary.address) s.address = primary.address
      if (!s.mapQuery) {
        const q = primary.address || primary.name
        if (q) s.mapQuery = q
      }
    }
  }
}

async function enrichSectionsWithPlaces(
  fs: admin.firestore.Firestore,
  teamId: string,
  team: Dict,
  lists: WebsiteSection[][]
): Promise<void> {
  // Every page of the site, one pool read — and none when no page reads it.
  if (!lists.some((sections) => sections.some((s) => s.type === 'places' || s.type === 'contact'))) return
  const pool = await loadPlacePool(fs, teamId, team)
  for (const sections of lists) applyPlacePool(sections, pool)
}

/** Loads the forms and activities that form sections point at — one `getAll`,
 *  and none when no page has a form — then lets `applyFormChecks` decide. */
async function checkFormSections(
  fs: admin.firestore.Firestore,
  teamId: string,
  lists: WebsiteSection[][]
): Promise<void> {
  const formSections = lists.flat().filter((s): s is Extract<WebsiteSection, { type: 'form' }> => s.type === 'form')
  if (formSections.length === 0) return
  const formIds = [...new Set(formSections.map((s) => s.formId))]
  const activityIds = [...new Set(formSections.flatMap((s) => (s.next ? [s.next.activityId] : [])))]
  const snaps = await fs.getAll(
    ...formIds.map((id) => fs.collection(FORMS_COLLECTION).doc(id)),
    ...activityIds.map((id) => fs.collection(ACTIVITIES_COLLECTION).doc(id))
  )
  const facts: FormCheckFacts = { forms: new Map(), activities: new Map() }
  snaps.forEach((snap, index) => {
    if (!snap.exists) return
    const data = snap.data() as Dict
    if (index < formIds.length) (facts.forms as Map<string, Dict>).set(snap.id, { teamId: data.teamId, status: data.status })
    else (facts.activities as Map<string, Dict>).set(snap.id, { teamId: data.teamId, type: data.type })
  })
  const removed = applyFormChecks(lists, teamId, facts)
  if (removed.length) {
    console.warn(`[publishWebsite] team ${teamId}: dropped form section(s) ${removed.join(', ')} — form missing, not this team's, or not published`)
  }
}

// ─── publishWebsite ─────────────────────────────────────────────────────────────
// Reads the team's private draft, sanitizes it to a public-safe payload, and
// writes site_published/{teamId} (world-readable). Also flags the draft enabled.

export const publishWebsite = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const teamId = (request.data?.teamId ?? '') as string
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  if (!(await hasTeamRole(uid, teamId, 'manager'))) {
    throw new HttpsError('permission-denied', 'Manager access required')
  }

  const fs = admin.firestore()

  // Defense in depth: the Website plugin must be installed & active. The install
  // flow already gates by plan/add-on; this stops publishing without the plugin.
  // Through the ONE resolver, so an ORG-level install counts.
  if (!(await pluginIsActive(teamId, 'website'))) {
    throw new HttpsError('failed-precondition', 'The Website plugin is not active for this team')
  }

  const draftSnap = await fs.doc(`${SITE_DRAFTS_COLLECTION}/${teamId}`).get()
  if (!draftSnap.exists) throw new HttpsError('not-found', 'No site draft to publish')
  const draft = draftSnap.data() as Dict

  const teamSnap = await fs.doc(`${TEAMS_COLLECTION}/${teamId}`).get()
  if (!teamSnap.exists) throw new HttpsError('not-found', 'Team not found')
  const team = teamSnap.data() as Dict
  const slug = optStr(team.slug, 80)
  if (!slug) throw new HttpsError('failed-precondition', 'Set a team URL (slug) before publishing')

  const name = optStr(team.name, 200) ?? 'Site'
  // Hidden sections omitted, unpublishable ones dropped — see ./sanitize.
  // ── PAGES ──────────────────────────────────────────────────────────────
  // Everything about pages is shared with the organisation site — see
  // ./publishPages. What is the team's own runs between reading and writing.
  const { pageRefs, sections, pageSections, lists } = await readSitePages({
    fs,
    draftCollection: SITE_DRAFTS_COLLECTION,
    id: teamId,
    draft,
    sanitizeList: sanitizeSections,
    logTag: 'publishWebsite',
  })
  // Embed selected places into 'places' sections + fill the Contact map from the
  // team's primary place. Done after sanitizing (needs Firestore reads).
  await enrichSectionsWithPlaces(fs, teamId, team, lists)
  // A form section may only embed this team's published form (needs reads too).
  await checkFormSections(fs, teamId, lists)

  // Denormalise social links (already public via team.public_profile) so the
  // published doc is self-contained for footer/contact icons.
  const socialLinks = (Array.isArray(team.socialLinks) ? team.socialLinks : [])
    .map((s) => {
      const d = asDict(s)
      const platform = optStr(d.platform, 32)
      const url = safeUrl(d.url)
      return platform && url ? { platform, url } : null
    })
    .filter((x): x is { platform: string; url: string } => x !== null)

  const plan = optStr(team.plan, 32) ?? 'free'
  const menu = sanitizeMenu(draft.menu)
  const meta = sanitizeMeta(draft.meta, name)

  // Machine-translate the SANITIZED published shape (never the raw draft) into
  // the tenant's other supported locales. Throw-free: a translation failure
  // degrades to fewer/no locales, never to a failed publish. See
  // translate/translateSite.ts.
  // The WEBSITE's own language when the studio set one — a studio may work in
  // one language and publish its site in another. Else the team’s.
  const srcLang = resolveSiteSourceLocale({ language: meta.language ?? (team.language as string | undefined) })
  const i18n = await translatePublishedSite({
    db: fs,
    collection: SITE_PUBLISHED_COLLECTION,
    id: teamId,
    owner: { teamId },
    published: { meta, menu, pages: pageRefs, sections },
    srcLang,
  })

  const pageI18n = await translateSitePages({
    fs,
    publishedCollection: SITE_PUBLISHED_COLLECTION,
    id: teamId,
    owner: { teamId },
    pageRefs,
    pageSections,
    srcLang,
  })

  // Shaped to match PublishedSite; typed as Dict for the Firestore write since
  // values are re-derived from sanitizers (platform strings, server timestamps).
  const published: Dict = clean({
    teamId,
    slug,
    name,
    meta,
    sections,
    // Absent ⇒ the renderer derives the old two-run header, so a site that has
    // never opened the menu editor publishes exactly what it published before.
    menu,
    // Absent ⇒ a one-page site, exactly as before pages existed.
    pages: pageRefs.length ? pageRefs : undefined,
    // Old-site redirects, kept only when they lead somewhere published.
    redirects: publishedRedirects(draft.redirects, pageRefs),
    socialLinks: socialLinks.length ? socialLinks : undefined,
    showBranding: plan === 'free' ? true : undefined,
    i18n,
    published_at: FieldValue.serverTimestamp() as unknown as PublishedSite['published_at'],
    updated_at: FieldValue.serverTimestamp() as unknown as PublishedSite['updated_at'],
  })

  // ORDER: page docs first, then the site doc that indexes them, then orphans —
  // a reader follows the index, so it never meets an entry whose page is missing.
  await writeSitePages({
    fs,
    publishedCollection: SITE_PUBLISHED_COLLECTION,
    id: teamId,
    owner: { teamId },
    pageRefs,
    pageSections,
    pageI18n,
  })
  await fs.doc(`${SITE_PUBLISHED_COLLECTION}/${teamId}`).set(published)
  await pruneUnpublishedPages({ fs, publishedCollection: SITE_PUBLISHED_COLLECTION, id: teamId, pageRefs })

  await draftSnap.ref.set(
    { enabled: true, updated_at: FieldValue.serverTimestamp(), updatedBy: uid },
    { merge: true },
  )

  // The published site now exists but lives outside the team doc — nudge it so
  // syncTeamPublicProfile recomputes active_public_surfaces.site → live.
  await touchTeamForSurfaceRecompute(teamId)

  return { ok: true, slug }
})

// ─── unpublishWebsite ───────────────────────────────────────────────────────────
// Removes the public snapshot so /site/[slug] 404s, and flags the draft disabled.

export const unpublishWebsite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const teamId = (request.data?.teamId ?? '') as string
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  if (!(await hasTeamRole(uid, teamId, 'manager'))) {
    throw new HttpsError('permission-denied', 'Manager access required')
  }

  // Delegate core teardown to shared helper (also used by plugin-status trigger
  // and plan downgrade). We additionally record the uid of who triggered it.
  await unpublishSiteForTeam(teamId)
  // Stamp the user who initiated unpublish onto the draft (non-critical; merge).
  const fs = admin.firestore()
  await fs.doc(`${SITE_DRAFTS_COLLECTION}/${teamId}`).set(
    { updatedBy: uid },
    { merge: true },
  )

  // Site snapshot is gone — recompute so active_public_surfaces.site → not live.
  await touchTeamForSurfaceRecompute(teamId)

  return { ok: true }
})
