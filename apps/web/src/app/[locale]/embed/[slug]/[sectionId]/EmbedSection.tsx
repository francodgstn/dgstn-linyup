'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { collection, doc, getDoc, query, where, limit, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import {
  EMBED_WIDGETS_COLLECTION,
  SITE_PUBLISHED_COLLECTION,
  applySectionTranslations,
  siteI18nDocId,
} from '@linyup/shared'
import type {
  EmbedWidgetSet,
  PublishedSite,
  WebsiteSection,
  SiteMeta,
  SiteFont,
  SocialLink,
  SiteTranslationDoc,
} from '@linyup/shared'
import { SectionBlock, type RenderCtx } from '@/components/site/sections'
import { buildPalette, FONT_STACK } from '@/components/site/theme'
import { EMBED_MESSAGE, isBookableAppHref, postToHost } from '@/lib/embedBridge'

// What we render once resolution settles, independent of where it came from.
interface Resolved {
  section: WebsiteSection
  themeMeta: { theme: SiteMeta['theme']; accentColor?: string }
  font: SiteFont
  transparent: boolean
  slug: string
  teamId: string
  socialLinks?: SocialLink[]
}

/**
 * Renders a single embeddable section in isolation, chrome-less, for iframing
 * into a studio's own website. Resolves **widget-first**: a standalone widget
 * (embed_widgets/{teamId}, authored without building a Linyup site) wins; if none
 * matches the id we fall back to a published site section (site_published) so
 * snippets created from the website builder keep working. Both reads are fully
 * public (no auth, public mirrors only) and reuse the same SectionBlock renderer.
 *
 * Reports its content height to the parent frame so public/embed.js can size the
 * host iframe (live sections like schedule/pricing load data async, growing the
 * height after first paint).
 */
export default function EmbedSection({ slug, sectionId }: { slug: string; sectionId: string }) {
  const locale = useLocale()
  const t = useTranslations('Site')
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [loading, setLoading] = useState(true)
  const [systemDark, setSystemDark] = useState(false)
  // Does this page carry embed.js, and can it open a booking panel? Until it
  // says so, a Book click opens a tab — which is what every already-pasted
  // snippet in the wild does, and must keep doing. A ref as well as state,
  // because the click listener below is a NATIVE one registered once.
  const hostModal = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      // 1) Standalone widget (decoupled from any published site).
      try {
        const wsnap = await getDocs(
          query(collection(db, EMBED_WIDGETS_COLLECTION), where('slug', '==', slug), limit(1))
        )
        if (!wsnap.empty) {
          const set = wsnap.docs[0].data() as EmbedWidgetSet
          const w = set.widgets?.find((x) => x.id === sectionId && !x.hidden)
          if (w) {
            // Inline translations — widgets have no draft/publish split, so
            // there is no sidecar doc to fetch, only the unit map riding on
            // the same public doc.
            const translated =
              set.i18n && locale !== set.i18n.srcLang
                ? applySectionTranslations(w, set.i18n.locales[locale as keyof typeof set.i18n.locales])
                : w
            if (!cancelled) {
              setResolved({
                section: translated,
                themeMeta: { theme: w.theme?.theme ?? 'light', accentColor: w.theme?.accentColor },
                font: w.theme?.font ?? 'sans',
                transparent: w.theme?.background === 'transparent',
                slug: set.slug,
                teamId: set.teamId,
                socialLinks: set.socialLinks,
              })
              setLoading(false)
            }
            return
          }
        }
      } catch (err: unknown) {
        reportPublicLoadFailure('embed/widget-set', err) // falls through to site sections
      }

      // 2) Fall back to a published site section.
      try {
        const ssnap = await getDocs(
          query(collection(db, SITE_PUBLISHED_COLLECTION), where('slug', '==', slug), limit(1))
        )
        if (!ssnap.empty) {
          const site = ssnap.docs[0].data() as PublishedSite
          const sec = site.sections.find((s) => s.id === sectionId && !s.hidden)
          if (sec && !cancelled) {
            // Manifest-gated sidecar — same doc the full site page reads.
            let translated = sec
            const manifest = site.i18n
            if (
              manifest &&
              locale !== manifest.srcLang &&
              manifest.locales.includes(locale as (typeof manifest.locales)[number])
            ) {
              try {
                const sidecarSnap = await getDoc(
                  doc(db, SITE_PUBLISHED_COLLECTION, siteI18nDocId(site.teamId, locale))
                )
                if (sidecarSnap.exists()) {
                  translated = applySectionTranslations(sec, (sidecarSnap.data() as SiteTranslationDoc).units)
                }
              } catch (err: unknown) {
                reportPublicLoadFailure('embed/site-section-i18n', err) // falls back to base-language text
              }
            }
            if (!cancelled) {
              setResolved({
                section: translated,
                themeMeta: { theme: site.meta.theme, accentColor: site.meta.accentColor },
                font: site.meta.font,
                transparent: false,
                slug: site.slug,
                teamId: site.teamId,
                socialLinks: site.socialLinks,
              })
            }
          }
        }
      } catch (err: unknown) {
        reportPublicLoadFailure('embed/site-section', err) // leaves it unresolved → unavailable
      }
      if (!cancelled) setLoading(false)
    }

    run()
    return () => {
      cancelled = true
    }
  }, [slug, sectionId, locale])

  // The launcher handshake. A message only ever GRANTS the in-page panel — there
  // is nothing a hostile parent can turn off, and nothing it can make this frame
  // do.
  //
  // ASKING IS RETRIED, because neither side can be sure it is second. embed.js
  // is loaded `async` and announces itself to each widget frame; a frame that is
  // still `about:blank` when it does never gets that message (and a `loading=
  // "lazy"` widget below the fold may not exist yet at all). One unanswered
  // hello would then cost the panel for the life of the page — for a handful of
  // messages, we simply keep asking until someone answers, then stop.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const data = event.data as { type?: string; modal?: boolean } | null
      if (data?.type !== EMBED_MESSAGE.host || !data.modal) return
      hostModal.current = true
      if (timer) clearTimeout(timer)
    }
    const ask = () => {
      postToHost({ type: EMBED_MESSAGE.hello })
      // ~6s, front-loaded: a launcher that is going to load has loaded by then,
      // and a page without one must stop talking to itself.
      if (++attempts < 12 && !hostModal.current) timer = setTimeout(ask, 500)
    }
    window.addEventListener('message', onMessage)
    ask()
    return () => {
      window.removeEventListener('message', onMessage)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // ── Where every click in a widget goes ──────────────────────────────────────
  //
  // The widget lives in a cross-origin iframe, so a link that navigates in-frame
  // would try to load a frame-denied app page (booking, sign-up and the studio's
  // own site all send X-Frame-Options: DENY) and fail into a blank box. So no
  // link here ever navigates this frame: it opens a top-level tab, or — on a
  // page carrying embed.js — asks the host to open the booking funnel as a modal
  // over the studio's own page, which is what a Linyup-hosted website does with
  // the same click. The host owns the URL mapping and falls back to a tab for
  // anything it cannot place, so asking is never worse.
  //
  // A NATIVE CAPTURE LISTENER, not an onClick on the wrapper, and that is
  // load-bearing: the schedule block's session-detail card stops propagation on
  // its own container (it is a hand-rolled backdrop that must not close when the
  // card is clicked), which silently swallowed the Book button inside it — the
  // one link a visitor most wants — and let it navigate the frame into the
  // X-Frame-Options wall. Capturing at the document runs before any React
  // handler, so no section can opt out of this by accident.
  const onDocumentClick = useCallback(
    (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as Element | null
      const anchor = target && typeof target.closest === 'function' ? target.closest('a') : null
      const href = anchor?.getAttribute('href')
      if (!anchor || !href || href.startsWith('#')) return
      e.preventDefault()
      if (hostModal.current && isBookableAppHref(anchor.href)) {
        // `locale`, because an English-pinned widget's links are UNPREFIXED
        // (localePrefix 'as-needed') — without it the panel would re-detect the
        // language from Accept-Language and could open in another one.
        postToHost({ type: EMBED_MESSAGE.open, href: anchor.href, hl: locale })
        return
      }
      window.open(anchor.href, '_blank', 'noopener,noreferrer')
    },
    [locale]
  )

  useEffect(() => {
    document.addEventListener('click', onDocumentClick, true)
    return () => document.removeEventListener('click', onDocumentClick, true)
  }, [onDocumentClick])

  // Resolve the 'auto' theme against the viewer's system preference.
  useEffect(() => {
    if (resolved?.themeMeta.theme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [resolved?.themeMeta.theme])

  // Tell the parent how tall we are (embed.js resizes the iframe to match).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const post = () => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      window.parent?.postMessage({ type: 'linyup:embed:height', slug, sectionId, height }, '*')
    }
    post()
    const ro = new ResizeObserver(post)
    ro.observe(el)
    return () => ro.disconnect()
  }, [slug, sectionId, resolved, loading])

  if (loading) return <div ref={rootRef} style={{ minHeight: 1 }} />

  if (!resolved) {
    return (
      <div
        ref={rootRef}
        style={{ padding: '16px', fontFamily: 'system-ui, sans-serif', fontSize: 14, color: '#64748b' }}
      >
        {t('embedUnavailable')}
      </div>
    )
  }

  const palette = buildPalette(resolved.themeMeta, systemDark)
  const font = FONT_STACK[resolved.font] ?? FONT_STACK.sans
  const ctx: RenderCtx = {
    palette,
    slug: resolved.slug,
    // The widget's own /[locale]/embed/… segment. Section hrefs must carry it:
    // they are opened as absolute top-level URLs by the delegating onClick below,
    // so there is no in-app router to infer the locale from.
    locale,
    teamId: resolved.teamId,
    preview: false,
    socialLinks: resolved.socialLinks,
  }

  // `@container` so the sections' container-query variants (@2xl:, @3xl:) respond
  // to the iframe width, exactly as they do inside WebsiteRenderer. A transparent
  // background lets the host page show through so the widget blends in.
  //
  // Clicks are handled by the document-level listener above, not here.
  return (
    <div
      ref={rootRef}
      className="@container"
      style={{
        background: resolved.transparent ? 'transparent' : palette.bg,
        color: palette.text,
        fontFamily: font,
      }}
    >
      <SectionBlock section={resolved.section} ctx={ctx} />
    </div>
  )
}
