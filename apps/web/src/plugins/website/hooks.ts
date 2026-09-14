'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage, functions } from '@/lib/firebase'
import {
  SITE_DRAFTS_COLLECTION,
  SITE_PUBLISHED_COLLECTION,
  EMBED_WIDGETS_COLLECTION,
} from '@linyup/shared'
import type { SiteDraft, PublishedSite, EmbedWidget, EmbedWidgetSet, SocialLink } from '@linyup/shared'

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
  })
  await setDoc(doc(db, SITE_DRAFTS_COLLECTION, teamId), {
    ...payload,
    updated_at: serverTimestamp(),
    updatedBy: userId,
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
