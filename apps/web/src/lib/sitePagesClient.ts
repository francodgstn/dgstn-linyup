'use client'

// A site's PAGES as the builder reads and writes them — the same for a team
// site (site_drafts/{teamId}/pages) and an organisation site
// (org_site_drafts/{orgId}/pages). Each builder's hooks file wraps these with
// its own collection and owner field; nothing here knows which tenant it is.

import { useQuery } from '@tanstack/react-query'
import { collection, doc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { SITE_I18N_SEPARATOR, SITE_PAGES_SUBCOLLECTION } from '@linyup/shared'
import type { SitePageDoc } from '@linyup/shared'

/** Firestore rejects `undefined`; drop it recursively before writing. */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefinedDeep(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefinedDeep(v)
    }
    return out as T
  }
  return value
}

/**
 * A site's other pages — keyed by pageId, each value its `sections`. Skips
 * translation sidecar ids (SITE_I18N_SEPARATOR) defensively: the draft side
 * never writes one, only the published side does, but a listing that isn't
 * defensive here is the one that breaks first if that ever changes.
 */
export function useDraftSitePages<S>(draftCollection: string, id: string | null, queryKey: string) {
  return useQuery<Record<string, S[]>>({
    queryKey: [queryKey, id],
    enabled: !!id,
    queryFn: async () => {
      const snap = await getDocs(collection(db, draftCollection, id!, SITE_PAGES_SUBCOLLECTION))
      const out: Record<string, S[]> = {}
      for (const d of snap.docs) {
        if (d.id.includes(SITE_I18N_SEPARATOR)) continue
        out[d.id] = (d.data() as SitePageDoc<S>).sections ?? []
      }
      return out
    },
  })
}

/**
 * Persist every page's sections (one `set` per page doc, full overwrite — the
 * page doc is the complete document) and delete the pages removed this
 * session, all in one batch.
 */
export async function saveDraftSitePages<S>(args: {
  draftCollection: string
  id: string
  owner: { teamId: string } | { orgId: string }
  userId: string
  pages: { id: string; sections: S[] }[]
  removedPageIds: string[]
}): Promise<void> {
  const { draftCollection, id, owner, userId, pages, removedPageIds } = args
  const batch = writeBatch(db)
  for (const page of pages) {
    const payload = stripUndefinedDeep({ ...owner, pageId: page.id, sections: page.sections })
    batch.set(doc(db, draftCollection, id, SITE_PAGES_SUBCOLLECTION, page.id), {
      ...payload,
      updated_at: serverTimestamp(),
      updatedBy: userId,
    })
  }
  for (const pageId of removedPageIds) {
    batch.delete(doc(db, draftCollection, id, SITE_PAGES_SUBCOLLECTION, pageId))
  }
  await batch.commit()
}
