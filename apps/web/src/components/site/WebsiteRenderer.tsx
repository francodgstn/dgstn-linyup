'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronDown, Globe, Menu, Moon, Sun, X } from 'lucide-react'
import type {
  SiteMeta,
  SiteMenuItem,
  SitePageRef,
  PublicSurface,
  WebsiteSection,
  OrgSiteSection,
  OrgSiteTeamRef,
  SocialLink,
} from '@linyup/shared'
import { resolveThemePreset } from '@linyup/shared'
import { deriveSiteMenu, sitePageSegments } from '@linyup/shared'
import { publicHrefLocalized, publicSubHrefLocalized } from '@/lib/publicRoutes'
import { buildPalette, ctaHref } from './theme'
import { siteBrandRootProps } from './siteFonts'
import { SectionBlock, sectionNavLabel, bookProps, SOCIAL_ICONS, type RenderCtx } from './sections'
import type { BookIntent } from '@/components/booking/BookingOverlay'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { formatSiteDate } from './siteDate'

/** Structural subset satisfied by SiteDraft/PublishedSite (team sites, builder
 *  preview) AND OrgSiteDraft/OrgPublishedSite (org sites). `teamId` is only
 *  present on team-shaped sites; org sites pass their scope via the separate
 *  `orgId`/`orgTeams` props below instead of through `site`. */
export interface RenderableSite {
  teamId?: string
  name: string
  slug: string
  meta: SiteMeta
  sections: (WebsiteSection | OrgSiteSection)[]
  /** The stored header menu. Absent ⇒ derived — see the note in the header. */
  menu?: SiteMenuItem[]
  socialLinks?: SocialLink[]
  showBranding?: boolean
  /** The site's other pages (team sites). Absent ⇒ a one-page site. */
  pages?: SitePageRef[]
}

export default function WebsiteRenderer({
  site,
  preview = false,
  orgId,
  orgTeams,
  onBook,
  surfaceLinks,
  memberControl,
  paymentsEnabled,
  page,
}: {
  site: RenderableSite
  preview?: boolean
  /** Org sites only — the org id and its embedded member-team snapshot. */
  orgId?: string
  orgTeams?: OrgSiteTeamRef[]
  /**
   * Opens the booking overlay in place. Only the live team site passes this;
   * optional so the builder canvas, the org site and the embed — none of which
   * have a `PublicTeamProvider` — keep working untouched.
   */
  onBook?: (intent: BookIntent) => void
  /**
   * Cross-surface links (shop, Space, …) derived by the host from
   * `active_public_surfaces`. Optional so the builder canvas, the org site and
   * the embed — none of which resolve a team — are untouched.
   */
  /** Live cross-surface links. `surface` is carried so a stored menu item can
   *  resolve its own href — the label and href stay the caller's job. */
  surfaceLinks?: { surface?: PublicSurface; href: string; label: string }[]
  /** "Sign in" / "Hi Anna" — the host owns the contact session. */
  memberControl?: { label: string; onClick: () => void }
  /** Whether the studio has a chargeable Stripe Connect account. Passed only by
   *  the live team site (the one host that resolves the team) — see
   *  RenderCtx.paymentsEnabled for why absent is not the same as false. */
  paymentsEnabled?: boolean
  /**
   * The page being shown, when it is not the home page. Header, footer and theme
   * are the site's; only `<main>` changes. Absent ⇒ the home page
   * (`site.sections`).
   */
  page?: { ref: SitePageRef; sections: (WebsiteSection | OrgSiteSection)[] }
}) {
  const locale = useLocale()
  const t = useTranslations('Site')
  const [systemDark, setSystemDark] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  /**
   * A VISITOR'S OWN CHOICE, which outranks their system setting.
   *
   * Null means "follow the system", which is the state every visitor starts in
   * — the toggle offers an override, it does not replace the default. Kept per
   * SITE rather than globally: a visitor who prefers one studio's page dark has
   * said nothing about another studio's.
   *
   * Read in an effect, never during render: localStorage does not exist on the
   * server, and seeding state from it directly is a hydration mismatch on every
   * visitor who has ever used the control.
   */
  const [override, setOverride] = useState<'light' | 'dark' | null>(null)

  // SUBSCRIBE WHENEVER THE ANSWER COULD MATTER — which is any adaptive preset,
  // not just the legacy `theme: 'auto'`. Guarding on the old field alone would
  // have left a preset-themed site frozen at "light" for a viewer in dark mode:
  // `buildPalette` asks for `systemDark`, and nothing would ever have set it.
  // Resolved through the SAME door buildPalette uses, so a CUSTOM adaptive theme
  // (which is not in the registry, so `surfaceThemePreset` would miss it) still
  // subscribes to the system preference and still enables the toggle.
  const themePreset = resolveThemePreset({
    presetId: site.meta.themePreset,
    light: site.meta.themeLight,
    dark: site.meta.themeDark,
    single: site.meta.themeSingle,
    lighting: site.meta.themeLighting,
  })
  const followsSystem = themePreset ? themePreset.adaptive : site.meta.theme === 'auto'
  useEffect(() => {
    if (!followsSystem) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [followsSystem])

  // The toggle only exists on a theme with two halves to move between, so the
  // stored preference is only ever read there too — a site that later switches
  // to a fixed look ignores a leftover value rather than acting on it.
  const toggleEnabled = !!site.meta.themeToggle && followsSystem
  const storageKey = `linyup.site.scheme.${site.slug}`
  useEffect(() => {
    if (!toggleEnabled) return
    try {
      const v = window.localStorage.getItem(storageKey)
      if (v === 'light' || v === 'dark') setOverride(v)
    } catch {
      // A private window, or storage the browser refuses. The site renders on
      // the system preference, which is the same thing it did before.
    }
  }, [toggleEnabled, storageKey])

  function chooseScheme(next: 'light' | 'dark') {
    setOverride(next)
    try {
      window.localStorage.setItem(storageKey, next)
    } catch {
      // Nothing to do — the choice still applies for this page view.
    }
  }

  const effectiveDark = toggleEnabled && override ? override === 'dark' : systemDark
  const palette = buildPalette(site.meta, effectiveDark)
  // Fonts, heading case and button shape, as root CSS variables (see siteFonts).
  const brandRoot = siteBrandRootProps(site.meta)
  // ── PAGES ───────────────────────────────────────────────────────────────
  // Every page is its own URL (a full navigation, not a client transition), so
  // a link to a section is `#id` only when that section is on THIS page — from
  // any other page it is the home URL plus the anchor.
  const pageSections = page?.sections ?? site.sections
  const homeHref = publicHrefLocalized(locale, site.slug, 'site')
  const pageById = new Map((site.pages ?? []).filter((p) => !p.hidden).map((p) => [p.id, p]))
  function pageHref(pageId: string, sectionId?: string): string | undefined {
    const ref = pageById.get(pageId)
    if (!ref) return undefined
    const anchor = sectionId ? `#${sectionId}` : ''
    if (page?.ref.id === ref.id) return anchor || '#top'
    return publicSubHrefLocalized(locale, site.slug, 'site', sitePageSegments(ref.path)) + anchor
  }
  const onPageIds = new Set(pageSections.map((sec) => sec.id))

  const ctx: RenderCtx = {
    palette,
    slug: site.slug,
    locale,
    teamId: site.teamId,
    orgId,
    orgTeams,
    preview,
    paymentsEnabled,
    socialLinks: site.socialLinks,
    // Second, independent guard (bookProps checks `preview` too): the builder
    // renders this component inside /(auth) with NO PublicTeamProvider, so a
    // leaked onBook would make the overlay throw and blank the canvas.
    onBook: preview ? undefined : onBook,
    pageHref,
    pages: site.pages,
  }

  // ── THE MENU ────────────────────────────────────────────────────────────
  // ONE tree, from `site.menu`. A site that has never been edited in the menu
  // tab has no stored tree, so `deriveSiteMenu` reproduces exactly what this
  // header used to draw — section anchors in section order, then the live
  // surface links. Nothing changes until a studio saves a menu of their own.
  //
  // Before this the two runs were rendered by two separate `.map`s and could
  // not interleave, which is why a Shop link could never sit between two
  // sections however either list was ordered.
  const menuTree: SiteMenuItem[] = site.meta.header.showNav
    ? (site.menu?.length
        ? site.menu
        : deriveSiteMenu({
            sections: site.sections,
            pages: site.pages,
            surfaceLinks: (surfaceLinks ?? []).flatMap((l) => (l.surface ? [{ surface: l.surface }] : [])),
          }))
    : []

  const surfaceByKey = new Map((surfaceLinks ?? []).flatMap((l) => (l.surface ? [[l.surface, l] as const] : [])))
  // Home sections and this page's — a menu may point at either.
  const sectionById = new Map([...site.sections, ...pageSections].map((sec) => [sec.id, sec]))

  /** Resolve one stored item to what the header actually needs to draw. A null
   *  href is a GROUP — a row that only opens its children. Items pointing at a
   *  deleted section or an unavailable surface resolve to nothing and are
   *  dropped, so removing a section never leaves a dead link behind. */
  function resolveItem(item: SiteMenuItem): { href: string | null; label: string } | null {
    switch (item.target.kind) {
      case 'section': {
        const sec = sectionById.get(item.target.sectionId)
        if (!sec) return null
        return {
          href: onPageIds.has(sec.id) ? `#${sec.id}` : `${homeHref}#${sec.id}`,
          label: item.label?.trim() || sectionNavLabel(sec, t),
        }
      }
      case 'page': {
        const ref = pageById.get(item.target.pageId)
        const href = pageHref(item.target.pageId, item.target.sectionId)
        if (!ref || !href) return null
        return { href, label: item.label?.trim() || ref.navLabel?.trim() || ref.title }
      }
      case 'surface': {
        const link = surfaceByKey.get(item.target.surface)
        if (!link) return null
        return { href: link.href, label: item.label?.trim() || link.label }
      }
      case 'url':
        if (!item.target.url.trim()) return null
        return { href: item.target.url, label: item.label?.trim() || item.target.url }
      case 'none':
        return item.label?.trim() ? { href: null, label: item.label.trim() } : null
    }
  }

  /** Drop unresolvable items, but KEEP a group whose children survived. */
  function prune(items: readonly SiteMenuItem[]): { item: SiteMenuItem; resolved: { href: string | null; label: string }; children: ReturnType<typeof prune> }[] {
    return items.flatMap((item) => {
      const children = prune(item.children ?? [])
      const resolved = resolveItem(item)
      if (!resolved) return children.length ? [] : []
      return [{ item, resolved, children }]
    })
  }

  type Branch = ReturnType<typeof prune>

  /** Levels 2..4, as indented rows. `depth` is 0 at the top of a panel. */
  function renderBranch(branch: Branch, depth: number): React.ReactNode {
    return branch.map((node) => (
      <div key={node.item.id}>
        {node.resolved.href ? (
          <a
            href={preview ? undefined : node.resolved.href}
            onClick={preview ? inert : undefined}
            className="block rounded-lg px-3 py-1.5 text-sm transition-opacity hover:opacity-70"
            style={{ color: palette.muted, paddingLeft: `${0.75 + depth * 0.75}rem` }}
          >
            {node.resolved.label}
          </a>
        ) : (
          // A group deeper in the tree is a LABEL, not a control: its children
          // are already visible beneath it, so there is nothing to open.
          <p
            className="px-3 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: palette.text, opacity: 0.55, paddingLeft: `${0.75 + depth * 0.75}rem` }}
          >
            {node.resolved.label}
          </p>
        )}
        {node.children.length > 0 && renderBranch(node.children, depth + 1)}
      </div>
    ))
  }

  /** The same tree in the mobile sheet — indented rows, every level visible,
   *  and each tap closes the sheet. */
  function renderMobileBranch(branch: Branch, depth: number): React.ReactNode {
    return branch.map((node) => (
      <div key={node.item.id}>
        {node.resolved.href ? (
          <a
            href={preview ? undefined : node.resolved.href}
            onClick={(e) => {
              if (preview) inert(e)
              setMobileOpen(false)
            }}
            className="block rounded-md py-2 text-sm transition-opacity hover:opacity-70"
            style={{ color: palette.muted, paddingLeft: `${depth * 0.875}rem` }}
          >
            {node.resolved.label}
          </a>
        ) : (
          <p
            className="pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: palette.text, opacity: 0.55, paddingLeft: `${depth * 0.875}rem` }}
          >
            {node.resolved.label}
          </p>
        )}
        {node.children.length > 0 && renderMobileBranch(node.children, depth + 1)}
      </div>
    ))
  }

  const menu = prune(menuTree)
  const hasMenu = menu.length > 0 || !!site.meta.header.ctaLabel

  const inert = (e: React.MouseEvent) => e.preventDefault()

  const headerAction = site.meta.header.ctaAction ?? 'booking'
  const headerHref = site.meta.header.ctaLabel
    ? ctaHref({ action: headerAction, url: site.meta.header.ctaUrl, pageId: site.meta.header.ctaPageId }, site.slug, locale, pageHref)
    : undefined

  // The header CTA is the most-clicked booking entry on the whole site, so it
  // opens the overlay like every other one. Signup/external CTAs stay plain
  // navigations. Null when this isn't a booking CTA.
  const headerBookProps =
    headerAction === 'booking' ? bookProps(headerHref, ctx, { kind: 'root' }) : null

  /** Plain-navigation fallback, matching the nav links' preview behaviour. */
  const headerLinkProps = { href: preview ? undefined : headerHref, onClick: preview ? inert : undefined }

  const socials = (site.socialLinks ?? []).filter((s) => s.url)
  const year = new Date().getFullYear()

  /** A FLAT link list — top bar, footer column, legal row — resolved exactly
   *  like the header menu, so a link to a deleted section or an unavailable
   *  surface drops out instead of rendering dead. Groups have no destination
   *  and nothing to open in a strip, so they are skipped. */
  function flatLinks(items: readonly SiteMenuItem[] | undefined): { id: string; href: string; label: string }[] {
    return (items ?? []).flatMap((item) => {
      const resolved = resolveItem(item)
      return resolved?.href ? [{ id: item.id, href: resolved.href, label: resolved.label }] : []
    })
  }

  const topBar = site.meta.header.topBar
  const topBarLinks = flatLinks(topBar?.items)
  const footer = site.meta.footer
  const footerColumns = (footer.columns ?? [])
    .map((column) => ({ ...column, links: flatLinks(column.items) }))
    .filter((column) => column.heading || column.links.length > 0)
  const footerLogos = footer.logos ?? []
  const legalLinks = flatLinks(footer.legal)
  const appLinks = footer.appLinks
  const hasFooterGrid = !!footer.text || footerColumns.length > 0 || !!appLinks?.ios || !!appLinks?.android

  return (
    <div
      className={`@container min-h-full w-full ${brandRoot.className}`}
      style={{ ...brandRoot.style, background: palette.bg, color: palette.text }}
    >
      {/* Top bar — scrolls away above the sticky header. */}
      {(topBar?.text || topBarLinks.length > 0) && (
        <div className="text-xs" style={{ background: palette.surface, borderBottom: `1px solid ${palette.border}` }}>
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-6 py-2">
            {topBar?.text ? (
              <p style={{ color: palette.muted }}>{topBar.text}</p>
            ) : (
              <span />
            )}
            {topBarLinks.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {topBarLinks.map((link) => (
                  <a
                    key={link.id}
                    href={preview ? undefined : link.href}
                    onClick={preview ? inert : undefined}
                    className="font-medium transition-opacity hover:opacity-70"
                    style={{ color: palette.text }}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <header
        className="sticky top-0 z-20 backdrop-blur"
        style={{ background: palette.headerBg, borderBottom: `1px solid ${palette.border}` }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <a
            href={preview ? undefined : page ? homeHref : '#top'}
            onClick={preview ? inert : undefined}
            className="flex items-center font-bold tracking-tight"
            style={{ color: palette.text }}
          >
            {site.meta.logoUrl ? (
              // A plain <img>: the logo is an arbitrary tenant URL, so next/image
              // would need every host allow-listed. The title stays the name.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={site.meta.logoUrl} alt={site.meta.title || site.name} className="h-8 w-auto max-w-[200px] object-contain" />
            ) : (
              site.meta.title || site.name
            )}
          </a>
          <nav className="hidden items-center gap-5 @3xl:flex">
            {/* ── LEVELS 1 AND 2+, DRAWN DIFFERENTLY ──────────────────────
                A top-level row with children opens ONE dropdown panel, and
                everything below it — levels 3 and 4 — renders as indented
                groups INSIDE that panel rather than as cascading flyouts.
                Cascades are hard to keep open with a pointer, impossible on
                touch, and need a keyboard path of their own; one panel needs
                none of that and shows the whole branch at once.
                CSS-only (group-hover + focus-within), so a menu still opens
                for a keyboard and costs no JS on a marketing page. */}
            {menu.map((top) =>
              top.children.length === 0 ? (
                <a
                  key={top.item.id}
                  href={preview || !top.resolved.href ? undefined : top.resolved.href}
                  onClick={preview ? inert : undefined}
                  className="whitespace-nowrap text-sm transition-opacity hover:opacity-70"
                  style={{ color: palette.muted }}
                >
                  {top.resolved.label}
                </a>
              ) : (
                <div key={top.item.id} className="group relative">
                  {/* A group row is a button, not a link: it has no destination
                      of its own, and an <a href="#"> would jump the page. */}
                  {/* THE CHEVRON IS THE ONLY THING THAT SAYS THIS OPENS.
                      Without it a parent row is indistinguishable from a plain
                      link, so a visitor either never discovers the submenu or
                      clicks expecting a page. It rotates with the panel, so the
                      same glyph also says "this is open" — and it is
                      `aria-hidden`, because `aria-expanded` on the control
                      already carries that to a screen reader. */}
                  {top.resolved.href ? (
                    <a
                      href={preview ? undefined : top.resolved.href}
                      onClick={preview ? inert : undefined}
                      className="inline-flex items-center gap-1 whitespace-nowrap text-sm transition-opacity hover:opacity-70"
                      style={{ color: palette.muted }}
                    >
                      {top.resolved.label}
                      <ChevronDown
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-hover:rotate-180 group-focus-within:rotate-180"
                      />
                    </a>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={false}
                      className="inline-flex items-center gap-1 whitespace-nowrap text-sm transition-opacity hover:opacity-70"
                      style={{ color: palette.muted }}
                    >
                      {top.resolved.label}
                      <ChevronDown
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-hover:rotate-180 group-focus-within:rotate-180"
                      />
                    </button>
                  )}
                  <div
                    className="invisible absolute left-0 top-full z-30 min-w-48 rounded-xl border p-2 opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
                    style={{ background: palette.headerBg, borderColor: palette.border }}
                  >
                    {renderBranch(top.children, 0)}
                  </div>
                </div>
              ),
            )}
            {site.meta.header.ctaLabel && (
              <a
                {...(headerBookProps ?? headerLinkProps)}
                className="site-btn shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold"
                style={{ background: palette.button, color: palette.onButton }}
              >
                {site.meta.header.ctaLabel}
              </a>
            )}
            {/* The cross-surface links are IN the menu tree above now — they
                used to be a second run here, which is exactly why they could
                never sit between two sections. */}
            {memberControl && (
              <button
                type="button"
                onClick={preview ? undefined : memberControl.onClick}
                className="text-sm font-medium transition-opacity hover:opacity-70"
                style={{ color: palette.accent }}
              >
                {memberControl.label}
              </button>
            )}
            {/* Hidden in the builder preview — a visitor-only control the
                studio never needs while editing its own site. */}
            {!preview && (
              <LocaleSwitcher triggerStyle={{ borderColor: palette.border, color: palette.muted }} />
            )}
          </nav>

          {/* THE VISITOR'S SCHEME SWITCH — outside the nav, deliberately.
              `hasMenu`'s nav is `@3xl:flex`, so anything inside it is DESKTOP
              ONLY. The first cut put this there beside the locale switcher and
              it vanished below that width — a control a phone visitor could
              never reach, which is most of them (Franco, 2026-09-03).

              It renders only where it can do something: `toggleEnabled`
              requires the studio to have asked for it AND a theme with two
              halves, so this is never a button with nothing to switch to.

              ONE BUTTON THAT FLIPS, not a three-way light/dark/auto. A visitor
              does not think "follow my system", they think the page is too
              bright. Auto is where everyone starts. */}
          <div className="flex items-center gap-1">
            {toggleEnabled && (
              <button
                type="button"
                onClick={() => chooseScheme(effectiveDark ? 'light' : 'dark')}
                aria-label={t(effectiveDark ? 'schemeToLight' : 'schemeToDark')}
                title={t(effectiveDark ? 'schemeToLight' : 'schemeToDark')}
                className="flex h-9 w-9 items-center justify-center rounded-md border transition-opacity hover:opacity-70"
                style={{ borderColor: palette.border, color: palette.muted }}
              >
                {effectiveDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            )}

          {/* Mobile hamburger */}
          {hasMenu && (
            <button
              type="button"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={t('menuAria')}
              aria-expanded={mobileOpen}
              className="flex h-9 w-9 items-center justify-center rounded-md transition-opacity hover:opacity-70 @3xl:hidden"
              style={{ color: palette.text }}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          )}
          </div>
        </div>

        {/* Mobile menu panel */}
        {hasMenu && mobileOpen && (
          <div
            className="@3xl:hidden"
            style={{ background: palette.bg, borderTop: `1px solid ${palette.border}` }}
          >
            <nav className="mx-auto flex max-w-5xl flex-col gap-1 px-6 py-3">
              {/* THE WHOLE TREE, FLAT AND INDENTED — no dropdowns on a phone.
                  A tap-to-open submenu inside an already-open sheet is two
                  gestures to reach one page, and it hides the shape of the menu
                  behind the thing you are trying to understand. Indentation
                  says the same thing and costs nothing. */}
              {renderMobileBranch(menu, 0)}
              {site.meta.header.ctaLabel && (
                <a
                  {...(headerBookProps ?? headerLinkProps)}
                  onClick={(e) => {
                    // Dismiss the menu first, then let the CTA do its thing —
                    // otherwise the overlay opens behind an open mobile menu.
                    setMobileOpen(false)
                    if (headerBookProps) headerBookProps.onClick?.(e)
                    else if (preview) inert(e)
                  }}
                  className="site-btn mt-2 rounded-full px-4 py-2 text-center text-sm font-semibold"
                  style={{ background: palette.button, color: palette.onButton }}
                >
                  {site.meta.header.ctaLabel}
                </a>
              )}
              {/* Cross-surface links are part of the tree above now. */}
              {memberControl && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false)
                    if (!preview) memberControl.onClick()
                  }}
                  className="rounded-md py-2 text-left text-sm font-medium transition-opacity hover:opacity-70"
                  style={{ color: palette.accent }}
                >
                  {memberControl.label}
                </button>
              )}
              {!preview && (
                <div className="pt-2">
                  <LocaleSwitcher triggerStyle={{ borderColor: palette.border, color: palette.muted }} />
                </div>
              )}
            </nav>
          </div>
        )}
      </header>

      <main id="top">
        {/* A POST'S OWN HEADER — date, title, excerpt, cover image — sits above
            its sections like a printed article's byline; the sections below
            are the body, same as any other page. Never on a plain page or the
            home page (`page?.ref.kind` is only ever 'post' when a post is
            being viewed). */}
        {page?.ref.kind === 'post' && (
          <section className="py-16" style={{ background: palette.bg }}>
            <div className="mx-auto max-w-5xl px-6">
              {page.ref.publishedOn && (
                <p className="text-sm" style={{ color: palette.muted }}>
                  {formatSiteDate(page.ref.publishedOn, locale)}
                </p>
              )}
              <h1
                className="mt-2 text-3xl font-bold tracking-tight @2xl:text-4xl"
                style={{ color: palette.text }}
              >
                {page.ref.title}
              </h1>
              {page.ref.excerpt && (
                <p className="mt-4 max-w-3xl text-lg" style={{ color: palette.muted }}>
                  {page.ref.excerpt}
                </p>
              )}
              {page.ref.coverImageUrl && (
                <div className="site-card mt-8 overflow-hidden rounded-2xl border" style={{ borderColor: palette.border }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.ref.coverImageUrl}
                    alt=""
                    className="aspect-[16/9] w-full object-cover"
                  />
                </div>
              )}
            </div>
          </section>
        )}
        {pageSections.map((s: WebsiteSection | OrgSiteSection) => (
          <SectionBlock key={s.id} section={s} ctx={ctx} />
        ))}
      </main>

      {/* Partner / certification logos — a strip above the footer. */}
      {footerLogos.length > 0 && (
        <div style={{ background: palette.bg, borderTop: `1px solid ${palette.border}` }}>
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-10 gap-y-6 px-6 py-8">
            {footerLogos.map((logo, i) => {
              // eslint-disable-next-line @next/next/no-img-element
              const img = <img src={logo.url} alt={logo.alt ?? ''} className="h-10 w-auto max-w-[140px] object-contain" />
              return logo.link ? (
                <a
                  key={i}
                  href={preview ? undefined : logo.link}
                  onClick={preview ? inert : undefined}
                  target={preview ? undefined : '_blank'}
                  rel="noopener noreferrer"
                  className="transition-opacity hover:opacity-70"
                >
                  {img}
                </a>
              ) : (
                <span key={i}>{img}</span>
              )
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="py-10" style={{ background: palette.surface, borderTop: `1px solid ${palette.border}` }}>
        {hasFooterGrid && (
          <div
            className="mx-auto mb-8 grid max-w-5xl gap-8 border-b px-6 pb-8 text-left @xl:grid-cols-2 @3xl:grid-cols-4"
            style={{ borderColor: palette.border }}
          >
            <div className="space-y-3">
              {site.meta.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={site.meta.logoUrl} alt={site.meta.title || site.name} className="h-8 w-auto max-w-[180px] object-contain" />
              ) : (
                <p className="font-bold tracking-tight" style={{ color: palette.text }}>
                  {site.meta.title || site.name}
                </p>
              )}
              {footer.text && (
                <p className="whitespace-pre-line text-sm" style={{ color: palette.muted }}>
                  {footer.text}
                </p>
              )}
              {(appLinks?.ios || appLinks?.android) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {/* Store names are proper nouns — not translated. */}
                  {(
                    [
                      ['App Store', appLinks?.ios],
                      ['Google Play', appLinks?.android],
                    ] as const
                  ).map(([store, href]) =>
                    href ? (
                      <a
                        key={store}
                        href={preview ? undefined : href}
                        onClick={preview ? inert : undefined}
                        target={preview ? undefined : '_blank'}
                        rel="noopener noreferrer"
                        className="rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
                        style={{ background: palette.text, color: palette.bg }}
                      >
                        {store}
                      </a>
                    ) : null
                  )}
                </div>
              )}
            </div>
            {footerColumns.map((column) => (
              <div key={column.id} className="space-y-2">
                {column.heading && (
                  <p className="text-sm font-semibold" style={{ color: palette.text }}>
                    {column.heading}
                  </p>
                )}
                <ul className="space-y-1.5">
                  {column.links.map((link) => (
                    <li key={link.id}>
                      <a
                        href={preview ? undefined : link.href}
                        onClick={preview ? inert : undefined}
                        className="text-sm transition-opacity hover:opacity-70"
                        style={{ color: palette.muted }}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-6 text-center">
          {site.meta.footer.showSocial && socials.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {socials.map((s) => {
                const Icon = SOCIAL_ICONS[s.platform] ?? Globe
                return (
                  <a
                    key={s.platform}
                    href={preview ? undefined : s.url}
                    onClick={preview ? inert : undefined}
                    target={preview ? undefined : '_blank'}
                    rel={preview ? undefined : 'noopener noreferrer'}
                    aria-label={s.platform}
                    className="flex h-9 w-9 items-center justify-center rounded-full border transition-opacity hover:opacity-70"
                    style={{ borderColor: palette.border, color: palette.text }}
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                )
              })}
            </div>
          )}
          <p className="text-sm" style={{ color: palette.muted }}>© {year} {site.name}</p>
          {legalLinks.length > 0 && (
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
              {legalLinks.map((link) => (
                <a
                  key={link.id}
                  href={preview ? undefined : link.href}
                  onClick={preview ? inert : undefined}
                  className="text-xs transition-opacity hover:opacity-70"
                  style={{ color: palette.muted }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
          {site.showBranding && (
            <p className="text-xs" style={{ color: palette.muted }}>
              {t('poweredBy')}{' '}
              <a
                href={preview ? undefined : 'https://linyup.com'}
                onClick={preview ? inert : undefined}
                target={preview ? undefined : '_blank'}
                rel="noopener noreferrer"
                className="font-medium hover:underline"
                style={{ color: palette.muted }}
              >
                Linyup
              </a>
            </p>
          )}
        </div>
      </footer>
    </div>
  )
}
