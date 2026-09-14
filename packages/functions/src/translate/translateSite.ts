/* eslint-disable no-console */
// The site-translation writer — the ONE place that turns extracted units
// (packages/shared/src/utils/siteTranslation.ts) into stored translations,
// for both the team/org published site (sidecar docs) and embed widgets
// (inline field). Two exports:
//
//   buildSiteTranslations — pure(ish) compute: units + previous state + a
//     provider → the next `Partial<Record<UiLanguage, SiteTranslationUnits>>`.
//     No Firestore reads/writes; used directly by the widgets trigger (which
//     owns its own doc) and by translatePublishedSite below.
//
//   translatePublishedSite — the sidecar-doc writer for site_published /
//     org_site_published: reads the previous sidecars, calls
//     buildSiteTranslations, writes/deletes sidecars, returns the manifest.
//     Entirely throw-free — a translation failure degrades to fewer/no
//     locales, never to a failed publish.
import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import {
  PUBLIC_LOCALES,
  siteI18nDocId,
  translationSourceHash,
  extractSiteUnits,
  type TranslatableUnit,
  type SiteI18nManifest,
  type SiteMenuItem,
  type SitePageRef,
  type SiteMeta,
  type SiteTranslationDoc,
  type SiteTranslationUnits,
  type UiLanguage,
  type WebsiteSection,
  type OrgSiteSection,
} from '@linyup/shared'
import { sanitizeRichHtml } from '../utils/sanitizeHtml'
import { getTranslationProvider } from './provider'
import type { TranslationProvider } from './types'

// Defensive abuse bounds on a PROVIDER's output — generous, not display caps.
const HTML_UNIT_MAX_CHARS = 60000
const PLAIN_UNIT_MAX_CHARS = 1000

function clamp(text: string, format: 'plain' | 'html'): string {
  const max = format === 'html' ? HTML_UNIT_MAX_CHARS : PLAIN_UNIT_MAX_CHARS
  return text.length > max ? text.slice(0, max) : text
}

/** Sanitize-once: every HTML unit that came back from the provider goes
 *  through the SAME allowlist the publisher runs the source through before it
 *  is ever stored — never re-sanitized again on a later read. */
function sanitizeTranslated(text: string, format: 'plain' | 'html'): string {
  const clamped = clamp(text, format)
  return format === 'html' ? sanitizeRichHtml(clamped) : clamped
}

/**
 * Computes the next `SiteTranslationUnits` for ONE target locale from the
 * current source units + whatever the previous run stored for that locale.
 * No provider call here — this only decides what can be REUSED and what is
 * left `pending`.
 */
function resolveReusable(
  units: readonly TranslatableUnit[],
  previous: SiteTranslationUnits
): {
  result: SiteTranslationUnits
  pending: { key: string; text: string; format: 'plain' | 'html'; hash: string }[]
} {
  // Reverse index over the PREVIOUS run's units: srcHash → its stored
  // translation. Lets a brand-new key reuse a translation made for
  // differently-keyed but IDENTICAL source text, at zero provider cost.
  const reverseIndex = new Map<string, string>()
  for (const unit of Object.values(previous)) {
    if (!reverseIndex.has(unit.srcHash)) reverseIndex.set(unit.srcHash, unit.text)
  }

  const result: SiteTranslationUnits = {}
  const pending: { key: string; text: string; format: 'plain' | 'html'; hash: string }[] = []

  for (const unit of units) {
    const hash = translationSourceHash(unit.text)
    const prev = previous[unit.key]
    if (prev && prev.srcHash === hash) {
      // Reused verbatim, INCLUDING `pinned` — a future manual override must
      // survive an unrelated republish while its source text is unchanged.
      result[unit.key] = prev.pinned ? { text: prev.text, srcHash: hash, pinned: true } : { text: prev.text, srcHash: hash }
      continue
    }
    const reused = reverseIndex.get(hash)
    if (reused !== undefined) {
      // A different key, but the SAME source text already has a translation
      // this run's reverse index knows about. `pinned` does not travel here —
      // it is a property of the OLD key's override, not of this one. The old
      // unit's FORMAT is unknowable (units don't store it), so re-run this
      // unit's own sanitation over the reused text: an html slot never
      // inherits a plain-origin string unsanitized. Only first-time reuse pays
      // this — once stored, the unit is reused verbatim by key above.
      result[unit.key] = { text: sanitizeTranslated(reused, unit.format), srcHash: hash }
      continue
    }
    // srcHash mismatch against `prev` (if any) retranslates and — by simply
    // never copying `prev.pinned` forward — CLEARS pinned.
    pending.push({ key: unit.key, text: unit.text, format: unit.format, hash })
  }

  return { result, pending }
}

/**
 * The whole compute: source units → `Partial<Record<UiLanguage,
 * SiteTranslationUnits>>` for every target locale. Rebuilds each locale's unit
 * map FROM SCRATCH from `units` every call, so a key that no longer exists in
 * the source is never carried forward (no separate prune step). A locale that
 * ends up with zero units is OMITTED from the returned map (never written as
 * `{}`), which is what lets a sidecar for that locale be deleted rather than
 * kept as an empty doc, and is also the shape the widgets fixed-point guard
 * compares against.
 *
 * Throw-free: a provider failure for one locale is caught, warned once, and
 * degrades that locale to whatever was reused without it (cached units
 * survive; the units that needed a fresh translation are simply dropped).
 */
export async function buildSiteTranslations(args: {
  units: readonly TranslatableUnit[]
  srcLang: UiLanguage
  targets: readonly UiLanguage[]
  previous: Partial<Record<UiLanguage, SiteTranslationUnits>>
  provider: TranslationProvider | null
}): Promise<Partial<Record<UiLanguage, SiteTranslationUnits>>> {
  const { units, srcLang, targets, previous, provider } = args
  const out: Partial<Record<UiLanguage, SiteTranslationUnits>> = {}

  for (const target of targets) {
    if (target === srcLang) continue
    const { result, pending } = resolveReusable(units, previous[target] ?? {})

    if (pending.length > 0 && provider) {
      // Dedupe by (format, srcHash) — two pending units with the same hash
      // have the same source text (translationSourceHash is total over the
      // string), so translating the unique set costs one provider call per
      // distinct string PER FORMAT, whatever the run's cross-key duplication.
      // Format is part of the key on purpose: it decides both the provider's
      // tag handling and which sanitation runs, so an html unit sharing text
      // with a plain one must never receive the plain pipeline's output.
      const dedupeKey = (p: { format: 'plain' | 'html'; hash: string }) => `${p.format}:${p.hash}`
      const uniqueByKey = new Map<string, { text: string; format: 'plain' | 'html' }>()
      for (const p of pending) {
        if (!uniqueByKey.has(dedupeKey(p))) uniqueByKey.set(dedupeKey(p), { text: p.text, format: p.format })
      }
      const keys = [...uniqueByKey.keys()]

      try {
        const translated = await provider.translateBatch({
          texts: keys.map((k) => {
            const u = uniqueByKey.get(k)!
            return { text: u.text, format: u.format }
          }),
          source: srcLang,
          target,
        })
        const byKey = new Map<string, string>()
        keys.forEach((key, i) => {
          const raw = translated[i]
          if (typeof raw === 'string' && raw.trim() !== '') {
            byKey.set(key, sanitizeTranslated(raw, uniqueByKey.get(key)!.format))
          }
        })
        for (const p of pending) {
          const text = byKey.get(dedupeKey(p))
          if (text !== undefined) result[p.key] = { text, srcHash: p.hash }
        }
      } catch (err) {
        console.warn(`[translate] provider call failed for locale '${target}' — degrading to cached units:`, (err as Error).message)
        // Nothing added for `pending` this locale; already-reused entries in
        // `result` stand.
      }
    }
    // provider === null (or nothing pending): pending units are silently
    // dropped from `result` — "cached units survive, changed units dropped".

    if (Object.keys(result).length > 0) out[target] = result
  }

  return out
}

/**
 * The target locale set for a tenant authoring in `srcLang` — every supported
 * public locale except the one the tenant already writes in.
 */
function targetLocalesFor(srcLang: UiLanguage): UiLanguage[] {
  return (PUBLIC_LOCALES as readonly UiLanguage[]).filter((l) => l !== srcLang)
}

/**
 * Reads/writes the per-locale sidecar docs for a published site (team or org)
 * and returns the manifest to attach to the base doc as `i18n`. NEVER throws —
 * any failure (reading a sidecar, calling the provider, writing a sidecar) is
 * caught, warned once, and degrades the returned manifest to whatever locales
 * did succeed; a caller that cannot even read the previous sidecars still gets
 * `{ srcLang, locales: [] }` back rather than an exception.
 *
 * Sidecar docs NEVER carry a `slug` field (kept invisible to the public slug
 * queries on the same collection) — see `SiteTranslationDoc` in
 * `@linyup/shared` for the full invariant.
 *
 * `provider` is OMITTED by every live call site (`publishWebsite`,
 * `publishOrgWebsite`) — that resolves it through `getTranslationProvider()`
 * (Secret Manager / the emulator's `DEEPL_API_KEY` fallback). The backfill
 * script passes one explicitly (built straight from its own `DEEPL_API_KEY`
 * env var, deliberately bypassing Secret Manager for a one-off operator run),
 * distinguished from "omitted" by `'provider' in args` rather than a null
 * check, so a caller can also pass `null` to force the no-provider path.
 */
export async function translatePublishedSite(args: {
  db: Firestore
  collection: string
  id: string
  owner: { teamId: string } | { orgId: string }
  published: {
    meta?: SiteMeta
    menu?: readonly SiteMenuItem[]
    /** The site doc's page index — its titles and SEO are translated too. */
    pages?: readonly SitePageRef[]
    sections: readonly (WebsiteSection | OrgSiteSection)[]
  }
  srcLang: UiLanguage
  provider?: TranslationProvider | null
}): Promise<SiteI18nManifest> {
  const { db, collection, id, owner, published, srcLang } = args
  const fallback: SiteI18nManifest = { srcLang, locales: [] }

  try {
    const units = extractSiteUnits({ meta: published.meta, menu: published.menu, pages: published.pages, sections: published.sections })
    const targets = targetLocalesFor(srcLang)

    const refs = targets.map((locale) => db.collection(collection).doc(siteI18nDocId(id, locale)))
    const snaps = refs.length ? await db.getAll(...refs) : []
    const previous: Partial<Record<UiLanguage, SiteTranslationUnits>> = {}
    targets.forEach((locale, i) => {
      const data = snaps[i]?.data() as SiteTranslationDoc | undefined
      if (data?.kind === 'site_i18n' && data.units) previous[locale] = data.units
    })

    const provider = 'provider' in args ? (args.provider ?? null) : await getTranslationProvider()
    const desired = await buildSiteTranslations({ units, srcLang, targets, previous, provider })

    const locales: UiLanguage[] = []
    for (const locale of targets) {
      const ref = db.collection(collection).doc(siteI18nDocId(id, locale))
      const unitsForLocale = desired[locale]
      if (unitsForLocale && Object.keys(unitsForLocale).length > 0) {
        const doc: SiteTranslationDoc = {
          kind: 'site_i18n',
          ...('teamId' in owner ? { teamId: owner.teamId } : {}),
          ...('orgId' in owner ? { orgId: owner.orgId } : {}),
          locale,
          srcLang,
          units: unitsForLocale,
          updated_at: FieldValue.serverTimestamp() as unknown as SiteTranslationDoc['updated_at'],
        }
        await ref.set(doc)
        locales.push(locale)
      } else if (previous[locale]) {
        // Had a sidecar before, now translates to nothing — delete it so a
        // stale/empty sidecar never lingers.
        await ref.delete()
      }
    }

    return { srcLang, locales }
  } catch (err) {
    console.warn(`[translate] translatePublishedSite failed for ${collection}/${id} — publishing without translations:`, (err as Error).message)
    return fallback
  }
}

/**
 * Deletes every possible locale sidecar for one published site
 * (`{collection}/{id}__i18n_{locale}`, one per `PUBLIC_LOCALES` entry). Called
 * from every path that removes `site_published/{teamId}` or
 * `org_site_published/{orgId}` — unpublish (`utils/plugins.ts`), the org
 * unpublish callable, and (for a whole-team teardown) `saas-billing/purgeTeam`
 * — so a torn-down site never leaves its sidecars behind. Deleting a doc that
 * does not exist is a no-op, so this needs no read first; it does not throw.
 */
export async function deleteSiteI18nSidecars(
  db: Firestore,
  collection: string,
  id: string
): Promise<void> {
  try {
    const batch = db.batch()
    for (const locale of PUBLIC_LOCALES) {
      batch.delete(db.collection(collection).doc(siteI18nDocId(id, locale)))
    }
    await batch.commit()
  } catch (err) {
    console.warn(`[translate] deleteSiteI18nSidecars failed for ${collection}/${id}:`, (err as Error).message)
  }
}
