'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage, functions } from '@/lib/firebase'
import { stripUndefinedDeep, useDraftSitePages, saveDraftSitePages } from '@/lib/sitePagesClient'
import { ORG_SITE_DRAFTS_COLLECTION, ORG_SITE_PUBLISHED_COLLECTION } from '@linyup/shared'
import type { OrgSiteDraft, OrgPublishedSite, OrgSiteSection } from '@linyup/shared'

// Mirrors apps/web/src/plugins/website/hooks.ts (the team site builder) but keyed
// by orgId instead of teamId, against the org_site_drafts / org_site_published
// collections and the publishOrgWebsite / unpublishOrgWebsite callables.

// ─── queries ────────────────────────────────────────────────────────────────

/** Private working copy (org_site_drafts/{orgId}) — builder reads/writes. */
export function useOrgSiteDraft(orgId: string | null) {
  return useQuery<OrgSiteDraft | null>({
    queryKey: ['org-site-draft', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const d = await getDoc(doc(db, ORG_SITE_DRAFTS_COLLECTION, orgId!))
      return d.exists() ? (d.data() as OrgSiteDraft) : null
    },
  })
}

/** An org site's other pages (org_site_drafts/{orgId}/pages) — the same reader
 *  the team builder uses (lib/sitePagesClient). */
export function useOrgSitePageDocs(orgId: string | null) {
  return useDraftSitePages<OrgSiteSection>(ORG_SITE_DRAFTS_COLLECTION, orgId, 'org-site-pages')
}

/** Persist every page's sections and delete the pages removed this session. */
export async function saveOrgSitePages(
  orgId: string,
  userId: string,
  pages: { id: string; sections: OrgSiteSection[] }[],
  removedPageIds: string[]
): Promise<void> {
  await saveDraftSitePages({
    draftCollection: ORG_SITE_DRAFTS_COLLECTION,
    id: orgId,
    owner: { orgId },
    userId,
    pages,
    removedPageIds,
  })
}

/** Public snapshot (org_site_published/{orgId}) — for "is it published?" status. */
export function useOrgPublishedSite(orgId: string | null) {
  return useQuery<OrgPublishedSite | null>({
    queryKey: ['org-published-site', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const d = await getDoc(doc(db, ORG_SITE_PUBLISHED_COLLECTION, orgId!))
      return d.exists() ? (d.data() as OrgPublishedSite) : null
    },
  })
}

// ─── mutations ────────────────────────────────────────────────────────────────

/** Persist the draft (full overwrite — the draft is the complete document). */
export async function saveOrgSiteDraft(
  orgId: string,
  userId: string,
  draft: OrgSiteDraft
): Promise<void> {
  // EVERY FIELD OF OrgSiteDraft MUST APPEAR HERE — see saveSiteDraft
  // (plugins/website/hooks.ts) for what a forgotten one costs. Typed against
  // the document's shape so a new field fails tsc until it is carried.
  const fields: { [K in keyof Omit<Required<OrgSiteDraft>, 'orgId' | 'updated_at' | 'updatedBy'>]: OrgSiteDraft[K] } = {
    slug: draft.slug,
    name: draft.name,
    enabled: draft.enabled,
    meta: draft.meta,
    sections: draft.sections,
    // Absent until the org first edits its header — `stripUndefinedDeep` drops
    // it, and an absent menu still derives, so no existing org site changes.
    menu: draft.menu,
    // The page index and the old-URL redirects — omitted here, a save would
    // delete them (see saveSiteDraft).
    pages: draft.pages,
    redirects: draft.redirects,
  }
  const payload = stripUndefinedDeep(fields)
  await setDoc(doc(db, ORG_SITE_DRAFTS_COLLECTION, orgId), {
    orgId,
    ...payload,
    updated_at: serverTimestamp(),
    updatedBy: userId,
  })
}

/** Publish via Cloud Function (sanitizes the draft into the public snapshot). */
export async function publishOrgSite(orgId: string): Promise<{ slug: string }> {
  const res = await httpsCallable(functions, 'publishOrgWebsite')({ orgId })
  return res.data as { slug: string }
}

/** Remove the public snapshot (and flag the draft disabled) via Cloud Function. */
export async function unpublishOrgSite(orgId: string): Promise<void> {
  await httpsCallable(functions, 'unpublishOrgWebsite')({ orgId })
}

/** Upload an org site image to Storage and return its public download URL. */
export async function uploadOrgSiteImage(
  orgId: string,
  sectionId: string,
  file: File
): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const key = `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`
  const sRef = storageRef(storage, `organizations/${orgId}/site/${sectionId}/${key}.${ext}`)
  await uploadBytes(sRef, file)
  return getDownloadURL(sRef)
}

