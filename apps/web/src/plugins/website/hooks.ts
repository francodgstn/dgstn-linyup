'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '@/lib/firebase'
import { stripUndefinedDeep, useDraftSitePages, saveDraftSitePages } from '@/lib/sitePagesClient'
import {
  SITE_DRAFTS_COLLECTION,
  SITE_PUBLISHED_COLLECTION,
  EMBED_WIDGETS_COLLECTION,
} from '@linyup/shared'
import type {
  SiteDraft,
  PublishedSite,
  EmbedWidget,
  EmbedWidgetSet,
  SocialLink,
  WebsiteSection,
} from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

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
 *  value its `sections`. The shared implementation is in lib/sitePagesClient. */
export function useSitePageDocs(teamId: string | null) {
  return useDraftSitePages<WebsiteSection>(SITE_DRAFTS_COLLECTION, teamId, 'site-pages')
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

/**
 * Persist the draft (full overwrite — the draft is the complete document).
 *
 * EVERY FIELD OF SiteDraft MUST APPEAR BELOW. This is a setDoc without merge,
 * so a field left out of this object is not "left alone" — it is DELETED from
 * the studio's draft the next time anything is saved, and then from the live
 * site the next time it is published. It has happened twice: first the menu
 * tree, then the redirect table, which quietly took a studio's old-URL
 * forwarding with it. Both were invisible — no error, no failing test, the
 * builder still showing what it held in memory.
 *
 * So the payload is TYPED against the document's own shape: a field added to
 * SiteDraft fails tsc here until it is carried. stripUndefinedDeep then drops
 * whatever this draft has not set, so an absent field stays absent.
 */
export async function saveSiteDraft(teamId: string, userId: string, draft: SiteDraft): Promise<void> {
  const fields: { [K in keyof Omit<Required<SiteDraft>, 'teamId' | 'updated_at' | 'updatedBy'>]: SiteDraft[K] } = {
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
    // The old-URL redirect table. There is no editor for it yet, which is
    // exactly why its absence here was invisible: a seeded or imported site
    // carried redirects, and the studio's first Save deleted them.
    redirects: draft.redirects,
  }
  const payload = stripUndefinedDeep(fields)
  await setDoc(doc(db, SITE_DRAFTS_COLLECTION, teamId), {
    teamId,
    ...payload,
    updated_at: serverTimestamp(),
    updatedBy: userId,
  })
}

/** Persist every page's sections and delete the pages removed this session —
 *  see lib/sitePagesClient. */
export async function saveSitePages(
  teamId: string,
  userId: string,
  pages: { id: string; sections: WebsiteSection[] }[],
  removedPageIds: string[]
): Promise<void> {
  await saveDraftSitePages({
    draftCollection: SITE_DRAFTS_COLLECTION,
    id: teamId,
    owner: { teamId },
    userId,
    pages,
    removedPageIds,
  })
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
  const res = await callFunction('publishWebsite')({ teamId })
  return res.data as { slug: string }
}

/** Remove the public snapshot (and flag the draft disabled) via Cloud Function. */
export async function unpublishSite(teamId: string): Promise<void> {
  await callFunction('unpublishWebsite')({ teamId })
}

/** Upload a site image to Storage and return its public download URL. */
export async function uploadSiteImage(teamId: string, sectionId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const key = `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`
  const sRef = storageRef(storage, `teams/${teamId}/site/${sectionId}/${key}.${ext}`)
  await uploadBytes(sRef, file)
  return getDownloadURL(sRef)
}

