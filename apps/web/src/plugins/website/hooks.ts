'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc, getDocs, collection, setDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage, functions } from '@/lib/firebase'
import {
  SITE_DRAFTS_COLLECTION,
  SITE_PUBLISHED_COLLECTION,
  EMBED_WIDGETS_COLLECTION,
  SITE_PAGES_SUBCOLLECTION,
  SITE_I18N_SEPARATOR,
} from '@linyup/shared'
import type {
  SiteDraft,
  SitePageDoc,
  PublishedSite,
  EmbedWidget,
  EmbedWidgetSet,
  SocialLink,
  WebsiteSection,
} from '@linyup/shared'

// ─── queries ────────────────────────────────────────────────────────────────

/** Private working copy (site_drafts/{teamId}) — builder reads/writes. */
export function useSiteDraft(teamId: string | null) {
  return useQuery<SiteDraft | null>({
    queryKey: ['site-draft', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const d = await getDoc(doc(db, SITE_DRAFTS_COLLECTION, teamId!))
      return d.exists() ? (d.data() as SiteDraft) : null
    },
  })
}

/** Public snapshot (site_published/{teamId}) — for "is it published?" status. */
export function usePublishedSite(teamId: string | null) {
  return useQuery<PublishedSite | null>({
    queryKey: ['published-site', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const d = await getDoc(doc(db, SITE_PUBLISHED_COLLECTION, teamId!))
      return d.exists() ? (d.data() as PublishedSite) : null
    },
  })
}

/** A team's other pages (site_drafts/{teamId}/pages) — keyed by pageId, each
 *  value its `sections`. Skips translation sidecar ids (SITE_I18N_SEPARATOR)
 *  defensively — the draft side never writes one, only the published side
 *  does, but a listing that isn't defensive here is the one that breaks first
 *  if that ever changes. */
export function useSitePageDocs(teamId: string | null) {
  return useQuery<Record<string, WebsiteSection[]>>({
    queryKey: ['site-pages', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, SITE_DRAFTS_COLLECTION, teamId!, SITE_PAGES_SUBCOLLECTION)
      )
      const out: Record<string, WebsiteSection[]> = {}
      for (const d of snap.docs) {
        if (d.id.includes(SITE_I18N_SEPARATOR)) continue
        out[d.id] = (d.data() as SitePageDoc).sections ?? []
      }
      return out
    },
  })
}

/** Public standalone embed widgets (embed_widgets/{teamId}) — builder reads/writes. */
export function useEmbedWidgets(teamId: string | null) {
  return useQuery<EmbedWidgetSet | null>({
    queryKey: ['embed-widgets', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const d = await getDoc(doc(db, EMBED_WIDGETS_COLLECTION, teamId!))
      return d.exists() ? (d.data() as EmbedWidgetSet) : null
    },
  })
}

// ─── mutations ────────────────────────────────────────────────────────────────

/** Persist the draft (full overwrite — the draft is the complete document). */
export async function saveSiteDraft(teamId: string, userId: string, draft: SiteDraft): Promise<void> {
  const payload = stripUndefinedDeep({
    teamId,
    slug: draft.slug,
    name: draft.name,
    enabled: draft.enabled,
    meta: draft.meta,
    sections: draft.sections,
    // The menu editor's tree. Leaving it out of this full overwrite wiped every
    // menu edit on save. Absent until first edited — `stripUndefinedDeep` drops
    // it, and an absent menu still derives, so no existing site changes.
    menu: draft.menu,
    // The page index. Same rule as `menu` — an omitted field on this
    // full-overwrite doc is WIPED, not left alone, so a save from a builder
    // that hadn't loaded `pages` yet would delete every other page's listing
    // (its own doc under the `pages` subcollection survives, but nothing would
    // point at it any more). Absent ⇒ a one-page site, so nothing existing
    // changes.
    pages: draft.pages,
  })
  await setDoc(doc(db, SITE_DRAFTS_COLLECTION, teamId), {
    ...payload,
    updated_at: serverTimestamp(),
    updatedBy: userId,
  })
}

/** Persist every page's sections (one `set` per page doc, full overwrite —
 *  same "the doc is the complete document" rule as `saveSiteDraft`) and
 *  delete any pages removed this session, all in one batch. */
export async function saveSitePages(
  teamId: string,
  userId: string,
  pages: { id: string; sections: WebsiteSection[] }[],
  removedPageIds: string[]
): Promise<void> {
  const batch = writeBatch(db)
  for (const page of pages) {
    const payload = stripUndefinedDeep({
      teamId,
      pageId: page.id,
      sections: page.sections,
    })
    batch.set(doc(db, SITE_DRAFTS_COLLECTION, teamId, SITE_PAGES_SUBCOLLECTION, page.id), {
      ...payload,
      updated_at: serverTimestamp(),
      updatedBy: userId,
    })
  }
  for (const id of removedPageIds) {
    batch.delete(doc(db, SITE_DRAFTS_COLLECTION, teamId, SITE_PAGES_SUBCOLLECTION, id))
  }
  await batch.commit()
}

/** Persist the team's standalone embed widgets (full overwrite — there's no
 *  draft/publish split; the doc IS the public config, so "save = live").
 *  `i18n` is carried forward from the currently-loaded doc by the caller —
 *  a full overwrite with no `i18n` would wipe the onEmbedWidgetsWritten
 *  trigger's machine translations (and its hash cache) on every save. Not a
 *  correctness bug (the trigger self-heals, translations are just recomputed
 *  at provider cost on the next write), but the carry-forward is the polite
 *  path. */
export async function saveEmbedWidgets(
  teamId: string,
  userId: string,
  slug: string,
  widgets: EmbedWidget[],
  socialLinks?: SocialLink[],
  i18n?: EmbedWidgetSet['i18n']
): Promise<void> {
  const payload = stripUndefinedDeep({
    teamId,
    slug,
    widgets,
    socialLinks: socialLinks ?? [],
    i18n,
  })
  await setDoc(doc(db, EMBED_WIDGETS_COLLECTION, teamId), {
    ...payload,
    updated_at: serverTimestamp(),
    updatedBy: userId,
  })
}

/** Publish via Cloud Function (sanitizes the draft into the public snapshot). */
export async function publishSite(teamId: string): Promise<{ slug: string }> {
  const res = await httpsCallable(functions, 'publishWebsite')({ teamId })
  return res.data as { slug: string }
}

/** Remove the public snapshot (and flag the draft disabled) via Cloud Function. */
export async function unpublishSite(teamId: string): Promise<void> {
  await httpsCallable(functions, 'unpublishWebsite')({ teamId })
}

/** Upload a site image to Storage and return its public download URL. */
export async function uploadSiteImage(teamId: string, sectionId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const key = `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`
  const sRef = storageRef(storage, `teams/${teamId}/site/${sectionId}/${key}.${ext}`)
  await uploadBytes(sRef, file)
  return getDownloadURL(sRef)
}

// Firestore rejects `undefined`; drop it recursively before writing.
function stripUndefinedDeep<T>(value: T): T {
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
