// Publishing a site's PAGES — the part of a publish that is identical for a
// team site and an organisation site.
//
// Both keep the home page's sections on the site doc and every other page in a
// `pages` subcollection beside it, listed by the site doc's `pages` index
// (`SitePageRef`). What differs between the two is WHICH sections exist and
// what else a publish does (a team's places and forms need reads of their own),
// so each callable passes its own section sanitizer and runs its own extras
// between `readSitePages` and `writeSitePages`. Everything about pages — which
// ones publish, unique section ids, per-page translation, the write order and
// the removal of pages that stopped being published — lives here once, so the
// two sites cannot drift on it.

import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import {
  SITE_I18N_SEPARATOR,
  SITE_PAGES_SUBCOLLECTION,
  type OrgSiteSection,
  type SitePageRef,
  type UiLanguage,
  type WebsiteSection,
} from '@linyup/shared'
import { translatePublishedSite, deleteSiteI18nSidecars } from '../translate/translateSite'
import { clean, dedupeSectionIds, sanitizePageRefs, sanitizeRedirects, type Dict } from './sanitize'

type Owner = { teamId: string } | { orgId: string }
type PageI18n = Awaited<ReturnType<typeof translatePublishedSite>>

/**
 * The draft's home sections and published pages, sanitized, with section ids
 * made unique across the whole site (an id is an anchor, a translation key and
 * an embed address). A page publishes only when it is in the draft's index, not
 * hidden, and has a doc.
 */
export async function readSitePages<S extends { id: string }>(args: {
  fs: Firestore
  draftCollection: string
  id: string
  draft: Dict
  sanitizeList: (raw: unknown) => S[]
  logTag: string
}): Promise<{ pageRefs: SitePageRef[]; sections: S[]; pageSections: S[][]; lists: S[][] }> {
  const { fs, draftCollection, id, draft, sanitizeList, logTag } = args
  const draftPagesSnap = await fs.collection(`${draftCollection}/${id}/${SITE_PAGES_SUBCOLLECTION}`).get()
  const draftPageSections = new Map(
    draftPagesSnap.docs
      .filter((doc) => !doc.id.includes(SITE_I18N_SEPARATOR))
      .map((doc) => [doc.id, (doc.data() as Dict).sections] as const)
  )
  const pageRefs: SitePageRef[] = sanitizePageRefs(draft.pages).filter(
    (ref) => !ref.hidden && draftPageSections.has(ref.id)
  )
  const deduped = dedupeSectionIds([
    sanitizeList(draft.sections),
    ...pageRefs.map((ref) => sanitizeList(draftPageSections.get(ref.id))),
  ])
  if (deduped.dropped.length) {
    console.warn(`[${logTag}] ${id}: dropped duplicate section ids ${deduped.dropped.join(', ')}`)
  }
  const [sections, ...pageSections] = deduped.lists
  return { pageRefs, sections, pageSections, lists: deduped.lists }
}

/** Old-site redirects, kept only when they lead somewhere published — or
 *  undefined, so an unset field stays unset on the published doc. */
export function publishedRedirects(raw: unknown, pageRefs: SitePageRef[]) {
  const redirects = sanitizeRedirects(raw, {
    pageIds: new Set(pageRefs.map((ref) => ref.id)),
    pagePaths: new Set(pageRefs.map((ref) => ref.path)),
  })
  return redirects.length ? redirects : undefined
}

/** Where a site's published pages live: `{publishedCollection}/{id}/pages`. */
export function publishedPagesCollection(publishedCollection: string, id: string): string {
  return `${publishedCollection}/${id}/${SITE_PAGES_SUBCOLLECTION}`
}

/**
 * Each page translated into sidecars of its own, beside the page doc — a page's
 * translations are read with that page, never with the whole site. Throw-free
 * like the site-level call: a failure degrades to fewer locales.
 */
export async function translateSitePages<S extends WebsiteSection | OrgSiteSection>(args: {
  fs: Firestore
  publishedCollection: string
  id: string
  owner: Owner
  pageRefs: SitePageRef[]
  pageSections: S[][]
  srcLang: UiLanguage
}): Promise<PageI18n[]> {
  const { fs, publishedCollection, id, owner, pageRefs, pageSections, srcLang } = args
  const collection = publishedPagesCollection(publishedCollection, id)
  const out: PageI18n[] = []
  for (const [index, ref] of pageRefs.entries()) {
    out.push(
      await translatePublishedSite({
        db: fs,
        collection,
        id: ref.id,
        owner,
        published: { sections: pageSections[index] },
        srcLang,
      })
    )
  }
  return out
}

/**
 * The page docs, written BEFORE the site doc that indexes them (the caller
 * writes that next) — a reader follows the index, so it never meets an entry
 * whose page is missing.
 */
export async function writeSitePages<S>(args: {
  fs: Firestore
  publishedCollection: string
  id: string
  owner: Owner
  pageRefs: SitePageRef[]
  pageSections: S[][]
  pageI18n: PageI18n[]
}): Promise<void> {
  const { fs, publishedCollection, id, owner, pageRefs, pageSections, pageI18n } = args
  if (!pageRefs.length) return
  const collection = publishedPagesCollection(publishedCollection, id)
  const batch = fs.batch()
  pageRefs.forEach((ref, index) => {
    batch.set(
      fs.collection(collection).doc(ref.id),
      clean({
        ...owner,
        pageId: ref.id,
        sections: pageSections[index],
        i18n: pageI18n[index],
        published_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      })
    )
  })
  await batch.commit()
}

/**
 * After the site doc is written: a page no longer published (deleted, hidden)
 * must not stay world-readable by its direct path — remove it and its
 * translation sidecars.
 */
export async function pruneUnpublishedPages(args: {
  fs: Firestore
  publishedCollection: string
  id: string
  pageRefs: SitePageRef[]
}): Promise<void> {
  const { fs, publishedCollection, id, pageRefs } = args
  const collection = publishedPagesCollection(publishedCollection, id)
  const keep = new Set(pageRefs.map((ref) => ref.id))
  const existing = await fs.collection(collection).select().get()
  for (const doc of existing.docs) {
    if (doc.id.includes(SITE_I18N_SEPARATOR) || keep.has(doc.id)) continue
    await doc.ref.delete()
    await deleteSiteI18nSidecars(fs, collection, doc.id)
  }
}
