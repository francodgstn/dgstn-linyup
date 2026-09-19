'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import {
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { formatCurrency } from '@/lib/format'
import {
  Instagram,
  Facebook,
  Youtube,
  Twitter,
  Linkedin,
  Globe,
  MessageCircle,
  Star,
  Music2,
  MapPin,
  Phone,
  Mail,
  Clock,
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  List,
  ArrowRight,
  Check,
  Tag,
  User,
  X,
  ChevronLeft,
  ChevronRight,
  Plus,
  Minus,
  Quote,
  Play,
  Newspaper,
} from 'lucide-react'
import { DynamicIcon } from '@/components/ui/icon-picker'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import type {
  WebsiteSection,
  OrgSiteSection,
  HeroSection,
  ContentSection,
  GallerySection,
  ActivitiesSection,
  PricingSection,
  ScheduleSection,
  ContactSection,
  PlacesSection,
  FeaturesSection,
  CtaBannerSection,
  FaqSection,
  TestimonialsSection,
  VideoSection,
  TeamSection,
  FormSection,
  PostsSection,
  SplitSection,
  FormPublicProfile,
  SocialLink,
  OrgSiteTeamRef,
  SitePageRef,
  SiteCta,
} from '@linyup/shared'
import {
  videoEmbedSrc,
  browseDurationMinutes,
  compareActivities,
  mergeAvailabilitySlots,
  classAccessFacts,
  normalizeBenefit,
  resolveDurationBenefit,
  resolveDurationSale,
  sitePosts,
  type ActivityAccessRule,
  type ActivityDurationBenefit,
  type ActivityMemberBenefit,
  type Benefit,
  isHexColor,
  isLightColor,
  nameInitials,
  priceTermMonths,
  pricingTerms,
  PUBLIC_PROFILE_SUBCOLLECTION,
  TEAMS_COLLECTION,
  FORMS_COLLECTION,
} from '@linyup/shared'
import { formatSiteDate } from './siteDate'
import { FieldInput, isFieldAnswered } from '@/components/forms/FieldInput'
import {
  resolveActivityTerms,
  resolveActivityPricingDisplay,
  type ActivityTerm,
  type SubLookup,
} from '@/lib/activityTerms'
import type { SitePalette } from './theme'
import { ctaHref } from './theme'
import { publicHrefLocalized, publicSubHrefLocalized } from '@/lib/publicRoutes'
import { IntroOfferLine, readIntroTerms } from '@/components/pricing/IntroOfferLine'
import type { BookIntent } from '@/components/booking/BookingOverlay'
import { usePlaces } from '@/hooks/usePlaces'
import { ClubsBlock, LocationsBlock, CoachesBlock } from './orgSections'
import { WeeklyCalendar } from '@/components/schedule/WeeklyCalendar'
import { callFunction } from '@/lib/callFunction'

/**
 * THE CHROME FOLLOWS THE VISITOR; THE STUDIO'S CONTENT IS RESOLVED BEFORE IT
 * GETS HERE.
 *
 * This renderer draws two kinds of text and they are governed differently:
 *
 *   1. Linyup's chrome — "Book", "Loading…", "Free trial", "/mo", the empty
 *      states, the heading FALLBACKS used when a studio left one blank. None
 *      of it is the studio's words. It lives in the `Site` message namespace
 *      and follows the visitor's locale via next-intl, exactly like the rest
 *      of the app — unchanged by public-site localization.
 *   2. The studio's own words — headings, subheadings, body copy, activity
 *      names and descriptions, plan names, place names. Authored ONCE, in
 *      `Team.language` / `Organization.language`, and machine-translated at
 *      publish/save time into stored per-locale unit maps (`site_published` /
 *      `org_site_published` sidecars, `embed_widgets.i18n` inline — see
 *      `utils/siteTranslation.ts` in packages/shared, the ONE extractor and
 *      resolver). This module NEVER looks up a locale or reads a sidecar: the
 *      data boundary (PublicSite, PublicOrgSite, EmbedSection) resolves the
 *      site with `applySiteTranslations`/`applySectionTranslations` BEFORE
 *      handing it to `SectionBlock`, so every block here renders whatever
 *      string is already sitting on the section — base language or
 *      translated, it can't tell the difference and doesn't need to.
 *
 * Two things stay in the studio's authoring language on purpose, never routed
 * through the translation pipeline (`utils/siteTranslation.ts`'s scope
 * boundaries):
 *   - LIVE-MIRROR data read at render time from public_profile mirrors
 *     (activity / plan / session names) — a site translation translates what
 *     the tenant wrote INTO the site, not what the site pulls in live. These
 *     stay chrome-adjacent instead: exact prices/terms are assembled from data
 *     through next-intl (IntroOfferLine's precedent — "the sentence is a price
 *     promise and a mistranslated one is a lie"), never machine-translated.
 *   - BINDING text (waivers, policies, legal documents) — never
 *     machine-translated, full stop; see docs/fareharbor-analysis.md §6.1.
 */
export type SiteT = ReturnType<typeof useTranslations>

export interface RenderCtx {
  palette: SitePalette
  slug: string
  /**
   * Active locale. These blocks emit RAW `<a href>` — they cannot use next-intl's
   * `Link`, because the same components render inside a cross-origin iframe
   * (app/[locale]/embed/…) where every anchor click is delegated to `window.open`,
   * and in the website builder with no router context. So the locale prefix has
   * to be baked into the href by `publicHrefLocalized`.
   */
  locale: string
  /** Team sites only (undefined for org sites — use `orgId`/`orgTeams` instead). */
  teamId?: string
  /** Org sites only. */
  orgId?: string
  /** Org sites only — the embedded member-team snapshot, used by the clubs/
   *  locations/coaches aggregate blocks to fetch each club's live public_profile. */
  orgTeams?: OrgSiteTeamRef[]
  preview: boolean
  /**
   * Whether the studio can actually BE PAID (TeamPublicProfile.payments_enabled).
   * Set by the LIVE team site, which resolves the team; absent on the builder
   * canvas, the org site and the embed, none of which do. A priced door is
   * advertised only when true — see the pricing lines in the activities block
   * (UX-33). Absent ⇒ treated as "unknown", and the prices are shown: the
   * builder must render the studio's own configuration back to it, and the org
   * site's activity blocks belong to member teams whose accounts differ.
   */
  paymentsEnabled?: boolean
  socialLinks?: SocialLink[]
  /**
   * Set only by the LIVE team site (`PublicSite`), which hosts the booking
   * overlay. When present, booking CTAs open the funnel in place instead of
   * navigating away.
   *
   * Absent everywhere else on purpose: the website builder's canvas and the
   * cross-origin embed both render these same blocks with no
   * `PublicTeamProvider`, and the overlay would throw there.
   */
  onBook?: (intent: BookIntent) => void
  /**
   * A page of this site → its URL (`#section` appended when given), or
   * undefined for a page that is not published. Set by WebsiteRenderer, which
   * holds the page index; absent on hosts with no pages (org site, embed).
   */
  pageHref?: (pageId: string, sectionId?: string) => string | undefined
  /**
   * The site's page index — read by the Posts block to list blog posts newest
   * first (`sitePosts`). Team sites only (org sites have no pages/posts yet);
   * set by WebsiteRenderer from `site.pages`, absent on the embed.
   */
  pages?: SitePageRef[]
  /**
   * The short form of a public path, on a studio's OWN domain: the site lives
   * at `/angebot/crossfit` there, not `/public/{slug}/site/angebot/crossfit`.
   * Set by the live site when the request came through such a domain; absent
   * everywhere else, where the long path IS the address.
   */
  shortenHref?: (href: string) => string
}

export const SOCIAL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  instagram: Instagram,
  facebook: Facebook,
  youtube: Youtube,
  x: Twitter,
  linkedin: Linkedin,
  whatsapp: MessageCircle,
  website: Globe,
  review: Star,
  tiktok: Music2,
}

// In preview we never navigate away; on the live site links work normally.
function linkProps(href: string | undefined, preview: boolean, external = false) {
  if (!href) return { href: undefined }
  if (preview)
    return {
      href: undefined,
      onClick: (e: React.MouseEvent) => e.preventDefault(),
      style: { cursor: 'default' },
    }
  return external ? { href, target: '_blank' as const, rel: 'noopener noreferrer' } : { href }
}

// ─── Public-flow hrefs ───────────────────────────────────────────────────────
//
// Every link out of the website into a booking/shop flow goes through these.
// Two invariants, both easy to lose when hand-building template literals:
//   1. locale-PREFIXED — these render as raw <a> (see RenderCtx.locale)
//   2. `from: 'site'` — so the flow's back link returns to THIS website, not to
//      whatever surface the studio picked as its default landing.

/** Where an activity card's "Book" goes. Appointments have their own picker. */
function activityBookHref(
  ctx: RenderCtx,
  a: { id: string; slug?: string | null; activityType?: string },
  fallbackToBooking = false
): string | undefined {
  const { locale, slug } = ctx
  if (a.activityType === 'appointment')
    return shortHref(ctx, publicHrefLocalized(locale, slug, 'appointments', { activity: a.id, from: 'site' }))
  if (a.slug) return shortHref(ctx, publicSubHrefLocalized(locale, slug, 'booking', a.slug, { from: 'site' }))
  return fallbackToBooking
    ? shortHref(ctx, publicHrefLocalized(locale, slug, 'booking', { from: 'site' }))
    : undefined
}

/**
 * What a studio's own CTA opens in place, or null when it is a plain navigation.
 *
 * 'booking' opens the panel at its own front door; 'appointment' opens it
 * already on one activity — which is how a studio puts "Free intro" on the hero
 * without the visitor passing through a page and a form first. Everything else
 * (a page, the signup form, an external link) is a navigation and returns null.
 */
export function ctaIntent(cta: Pick<SiteCta, 'action' | 'activityId'> | undefined): BookIntent | null {
  if (!cta) return null
  if (cta.action === 'appointment')
    return cta.activityId ? { kind: 'appointment', activityId: cta.activityId } : { kind: 'root' }
  return cta.action === 'booking' ? { kind: 'root' } : null
}

/** A public path as this visitor's address bar should show it — short on the
 *  studio's own domain, unchanged everywhere else. See RenderCtx.shortenHref. */
export function shortHref(ctx: RenderCtx, href: string | undefined): string | undefined {
  return href && ctx.shortenHref ? ctx.shortenHref(href) : href
}

/**
 * Where a CLICKED session goes: straight to that class at that time.
 *
 * The whole point of the schedule block. Until this existed the CTA was one
 * constant `/booking` for every row, so picking "Fri 18:00 Yoga" landed the
 * visitor on a blank activity picker and made them find it again.
 */
function sessionBookHref(ctx: RenderCtx, session: { id: string }): string {
  return publicHrefLocalized(ctx.locale, ctx.slug, 'booking', {
    session: session.id,
    from: 'site',
  })
}

/** Which funnel an activity card opens: the appointment picker, or classes. */
function activityIntent(a: {
  id: string
  slug?: string | null
  activityType?: string
}): BookIntent {
  return a.activityType === 'appointment'
    ? { kind: 'appointment', activityId: a.id }
    : { kind: 'activity', activitySlug: a.slug ?? '' }
}

/**
 * Anchor props for a booking CTA: opens the overlay when the host provides one
 * (`ctx.onBook`), otherwise a plain navigation to the canonical route.
 *
 * The `href` STAYS on the anchor even when onBook handles the click, and that is
 * load-bearing, not decoration:
 *   - middle-click / cmd-click / "open in new tab" keep working
 *   - crawlers keep the link into the booking page
 *   - the embed iframe's click delegation still has an anchor to read
 * Never turn these into bare <button>s.
 */
export function bookProps(rawHref: string | undefined, ctx: RenderCtx, intent: BookIntent) {
  const href = shortHref(ctx, rawHref)
  // Preview wins FIRST — the builder canvas stays inert no matter what.
  if (ctx.preview) return linkProps(undefined, true)
  if (!ctx.onBook || !href) return linkProps(href, ctx.preview)
  return {
    href,
    onClick: (e: React.MouseEvent) => {
      // Leave new-tab/new-window intents to the browser.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      ctx.onBook!(intent)
    },
  }
}

// ─── Hero ───────────────────────────────────────────────────────────────────

/** Readable text over a solid hero background — THE shared contrast rule
 *  (`isLightColor`, WCAG), not a local YIQ guess with its own threshold. A
 *  value that is not a hex at all (unset, a CSS keyword) reads as light, as
 *  before, so the hero keeps dark text rather than vanishing. */
function hexIsLight(hex: string): boolean {
  const h = hex.trim()
  const normalised = h.startsWith('#') ? h : `#${h}`
  return isHexColor(normalised) ? isLightColor(normalised) : true
}

/**
 * A muted, looping background video that actually plays.
 *
 * React sets `muted` as a PROPERTY, never as the HTML attribute, and browsers
 * only autoplay a video they can see is muted — so `<video autoPlay muted>`
 * rendered by React sits paused on its first frame. Setting the property again
 * after mount and calling play() is the dependable way; a refusal (a data-saver
 * mode, a policy) leaves the poster showing, which is fine.
 *
 * ONE ATTEMPT IS NOT ENOUGH. A page opened in a background tab, or a video still
 * loading, refuses the first play() — and nothing would ask again. So it retries
 * whenever the video becomes playable, the page becomes visible, or the video
 * scrolls into view; each retry is a no-op once it is playing.
 */
function LoopVideo({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.muted = true
    const tryPlay = () => {
      if (video.paused && !document.hidden) video.play().catch(() => {})
    }
    tryPlay()
    video.addEventListener('canplay', tryPlay)
    document.addEventListener('visibilitychange', tryPlay)
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) tryPlay()
          })
    observer?.observe(video)
    return () => {
      video.removeEventListener('canplay', tryPlay)
      document.removeEventListener('visibilitychange', tryPlay)
      observer?.disconnect()
    }
  }, [src])
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      aria-hidden
      className="absolute inset-0 h-full w-full object-cover"
    />
  )
}

/** The hero's shading layers — an even wash, or white/black gradients that
 *  cover the side the copy sits on and leave the rest of the photo clear. */
function HeroShade({ style, tone, strength }: { style: NonNullable<HeroSection['overlayStyle']>; tone: 'dark' | 'light'; strength: number }) {
  const rgb = tone === 'light' ? '255,255,255' : '0,0,0'
  const fade = (deg: number) =>
    `linear-gradient(${deg}deg, rgba(${rgb},${strength}) 0%, rgba(${rgb},${strength * 0.55}) 35%, rgba(${rgb},0) 70%)`
  if (style === 'solid') {
    return <div className="absolute inset-0" style={{ background: `rgba(${rgb},${strength})` }} />
  }
  return (
    <>
      {(style === 'gradient-left' || style === 'gradient-left-bottom') && (
        <div className="absolute inset-0" style={{ background: fade(90) }} />
      )}
      {(style === 'gradient-bottom' || style === 'gradient-left-bottom') && (
        <div className="absolute inset-0" style={{ background: fade(0) }} />
      )}
    </>
  )
}

function HeroBlock({ section, ctx }: { section: HeroSection; ctx: RenderCtx }) {
  const { palette, slug, locale, preview } = ctx
  const href = shortHref(ctx, ctaHref(section.cta, slug, locale, ctx.pageHref))
  const center = section.align !== 'left'
  const overlay = (section.overlay ?? 40) / 100

  const hasImage = !!section.bgImageUrl
  // The loop never plays for a visitor who asked for less motion — the image
  // (its poster) stands in, which is why the image is still worth setting.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const showVideo = !!section.bgVideoUrl && !reducedMotion
  // A solid background colour, only when there is no image — an image is its own
  // background. Absent ⇒ the bold accent gradient, today's look.
  const solid = !hasImage && section.bgColor ? section.bgColor : null
  const inCard = section.layout === 'card'

  // TEXT COLOUR is the one thing a solid background forces us to decide. Over an
  // image or the accent gradient the text is white (with a shadow). Over a solid
  // colour it follows the colour's own perceived brightness, so a pale hero gets
  // dark text.
  const solidDarkText = solid ? hexIsLight(solid) : false
  // Over a photo or loop, a LIGHT wash takes dark copy and no shadow — the
  // same decision a pale solid colour makes.
  const lightWash = (hasImage || showVideo) && section.overlayTone === 'light'
  const darkText = solid ? solidDarkText : lightWash
  const fullText = darkText ? '#0f172a' : '#ffffff'
  const fullMuted = darkText
    ? 'rgba(15,23,42,0.78)'
    : solid
      ? 'rgba(255,255,255,0.9)'
      : 'rgba(255,255,255,0.92)'
  const shadow = solid || lightWash ? 'none' : '0 2px 18px rgba(0,0,0,0.35)'

  // In CARD layout the content sits on the theme's neutral surface, so it reads
  // the same way cards do everywhere — which is what makes a hero legible over a
  // busy image or a strong colour without a per-hero text decision.
  const cardText = inCard ? palette.text : fullText
  const cardMuted = inCard ? palette.muted : fullMuted
  const cardShadow = inCard ? 'none' : shadow

  const content = (
    <>
      <h1
        // Big on a desktop, calmer on a phone: at 390px a five-word headline in
        // capitals ran to four lines at 48px, which is a wall, not a headline.
        className="text-4xl @xl:text-5xl @2xl:text-6xl font-bold tracking-tight"
        style={{ color: cardText, textShadow: cardShadow }}
      >
        {renderHeadingText(section.headline, palette)}
      </h1>
      {section.subheadline && (
        <p
          className={`mt-4 text-lg @2xl:text-xl ${center ? 'mx-auto max-w-2xl' : 'max-w-2xl'}`}
          style={{ color: cardMuted, textShadow: cardShadow }}
        >
          {section.subheadline}
        </p>
      )}
      {section.cta?.label && (
        <div className={`mt-8 flex ${center ? 'justify-center' : 'justify-start'}`}>
          <a
            {...(ctaIntent(section.cta)
              ? bookProps(href, ctx, ctaIntent(section.cta)!)
              : linkProps(href, preview, section.cta.action === 'url'))}
            className="site-btn inline-flex items-center gap-2 rounded-full px-7 py-3 text-base font-semibold shadow-lg transition-transform hover:scale-[1.03]"
            style={{ background: palette.button, color: palette.onButton }}
          >
            {section.cta.label}
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      )}
    </>
  )

  return (
    <section
      id={section.id}
      className="relative flex items-center"
      style={{
        minHeight: '72vh',
        background: hasImage
          ? undefined
          : solid
            ? solid
            : `linear-gradient(135deg, ${palette.accent}, ${palette.accent}99)`,
      }}
    >
      {(hasImage || showVideo) && (
        <>
          {hasImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={section.bgImageUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {showVideo && <LoopVideo src={section.bgVideoUrl!} poster={section.bgImageUrl} />}
          <HeroShade
            style={section.overlayStyle ?? 'solid'}
            tone={section.overlayTone ?? 'dark'}
            strength={overlay}
          />
        </>
      )}
      <div
        className={`relative mx-auto w-full site-shell px-6 py-20 ${center ? 'text-center' : 'text-left'}`}
      >
        {inCard ? (
          <div
            className={`site-card rounded-2xl border p-8 shadow-xl @2xl:p-12 ${center ? 'mx-auto max-w-3xl' : 'max-w-3xl'}`}
            style={{ background: palette.surface, borderColor: palette.border }}
          >
            {content}
          </div>
        ) : (
          content
        )}
      </div>
    </section>
  )
}

// ─── shared section heading ─────────────────────────────────────────────────

/**
 * A studio marks words with `*asterisks*` to accent them inside a heading —
 * "Training, das *Resultate* liefert" — and the marked run renders in the
 * site's accent colour, markers dropped. ONE helper, used by the shared
 * `Heading`, the hero headline and the split section's heading; unmatched or
 * unmarked text renders exactly as it did before this existed. Dependency-free
 * (no markdown lib) and never renders raw HTML — the split parts are always
 * plain text nodes.
 */
function renderHeadingText(text: string, palette: SitePalette): React.ReactNode {
  const parts = text.split(/\*([^*]+)\*/)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} style={{ color: palette.accent }}>
        {part}
      </span>
    ) : (
      part
    )
  )
}

function Heading({
  text,
  palette,
  center = true,
}: {
  text?: string
  palette: SitePalette
  center?: boolean
}) {
  if (!text) return null
  return (
    <h2
      className={`text-3xl font-bold tracking-tight @xl:text-4xl @3xl:text-5xl ${center ? 'text-center' : ''}`}
      style={{ color: palette.text }}
    >
      {renderHeadingText(text, palette)}
    </h2>
  )
}

// ─── Content (generic rich-text block) ───────────────────────────────────────

function ContentBlock({ section, ctx }: { section: ContentSection; ctx: RenderCtx }) {
  const { palette } = ctx
  const imageRight = section.imageSide === 'right'
  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <div className={`grid items-center gap-10 ${section.imageUrl ? '@3xl:grid-cols-2' : ''}`}>
          {section.imageUrl && imageRight && <ContentText section={section} palette={palette} />}
          {section.imageUrl && (
            <div className="overflow-hidden site-card rounded-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={section.imageUrl} alt="" className="h-full w-full object-cover" />
            </div>
          )}
          {(!section.imageUrl || !imageRight) && <ContentText section={section} palette={palette} />}
        </div>
      </div>
    </section>
  )
}

function ContentText({ section, palette }: { section: ContentSection; palette: SitePalette }) {
  return (
    <div>
      {section.heading && (
        <h2 className="text-3xl font-bold tracking-tight" style={{ color: palette.text }}>
          {section.heading}
        </h2>
      )}
      {section.body && (
        // Body is rich HTML — sanitized at publish time. .site-prose styles it
        // with the site palette (color inherited; links use --site-accent).
        <div
          className={`site-prose leading-relaxed ${section.heading ? 'mt-4' : ''}`}
          style={{ color: palette.text, '--site-accent': palette.accent } as React.CSSProperties}
          dangerouslySetInnerHTML={{ __html: section.body }}
        />
      )}
    </div>
  )
}

// ─── Gallery ────────────────────────────────────────────────────────────────

function GalleryBlock({ section, ctx }: { section: GallerySection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette } = ctx
  if (!section.images.length && !section.heading) return null

  if (section.layout === 'logos') {
    // Partner / certification logos: never cropped, evenly spaced, captions as
    // the accessible name (a logo's caption is the partner's name).
    return (
      <section id={section.id} className="py-16" style={{ background: palette.bg }}>
        <div className="mx-auto site-shell px-6">
          <Heading text={section.heading} palette={palette} />
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-12 gap-y-8">
            {section.images.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={img.url} alt={img.caption ?? ''} className="h-12 w-auto max-w-[160px] object-contain" />
            ))}
          </div>
        </div>
      </section>
    )
  }

  if (section.layout === 'marquee') {
    // THE LIST TWICE, moved by one copy's width (the keyframes in globals.css),
    // so the loop has no seam. The second copy is decoration: hidden from
    // assistive tech so each photo is announced once. The speed scales with the
    // number of photos, so a short strip does not race past.
    const duration = `${Math.max(20, section.images.length * 6)}s`
    return (
      <section id={section.id} className="py-16" style={{ background: palette.surface }}>
        {section.heading && (
          <div className="mx-auto mb-10 site-shell px-6">
            <Heading text={section.heading} palette={palette} />
          </div>
        )}
        <div className="site-marquee overflow-hidden">
          <div
            className="site-marquee-track flex w-max gap-4 px-2"
            style={{ '--site-marquee-duration': duration } as CSSProperties}
          >
            {[0, 1].map((copy) =>
              section.images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${copy}-${i}`}
                  src={img.url}
                  alt={copy === 0 ? (img.caption ?? '') : ''}
                  aria-hidden={copy === 1 ? true : undefined}
                  className="site-card-sm h-48 w-auto max-w-none rounded-xl object-cover @2xl:h-64"
                />
              ))
            )}
          </div>
        </div>
      </section>
    )
  }

  const cols =
    section.columns === 2
      ? '@2xl:grid-cols-2'
      : section.columns === 4
        ? '@2xl:grid-cols-2 @5xl:grid-cols-4'
        : '@2xl:grid-cols-2 @5xl:grid-cols-3'
  return (
    <section id={section.id} className="py-20" style={{ background: palette.surface }}>
      <div className="mx-auto site-shell px-6">
        <Heading text={section.heading} palette={palette} />
        <div className={`mt-10 grid grid-cols-1 gap-4 ${cols}`}>
          {section.images.map((img, i) => (
            <figure
              key={i}
              className="overflow-hidden site-card-sm rounded-xl"
              style={{ background: palette.bg }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.caption ?? ''}
                className="aspect-square w-full object-cover transition-transform hover:scale-105"
              />
              {img.caption && (
                <figcaption className="px-3 py-2 text-sm" style={{ color: palette.muted }}>
                  {img.caption}
                </figcaption>
              )}
            </figure>
          ))}
          {!section.images.length && (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyPhotos')}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Activities (live: team public_profile mirrors, type 'activity') ──────────

interface ActivityEntry {
  id: string
  name: string
  slug: string
  /** Session category — 'appointment' activities book via the appointment flow. */
  activityType?: string
  description?: string
  color?: string
  imageUrl?: string
  /** Free-text display labels mirrored from `Activity.tags` — shown as chips on
   *  the card, enforced nowhere. */
  tags?: string[]
  isFreeTrial?: boolean
  order?: number
  /** CLASS-ONLY. */
  accessRule?: ActivityAccessRule
  /** CLASS-ONLY. */
  dropIn?: { enabled: boolean; priceAmount?: number }
  /** CLASS-ONLY: a gated class still accepts a newcomer's free trial booking. */
  trialEnabled?: boolean
  /** CLASS-ONLY: reduced trial price (major units). Absent/null ⇒ the trial is
   *  FREE (today's behaviour); a number ⇒ the trial costs that instead. */
  trialPriceAmount?: number | null
  /** APPOINTMENT-ONLY: priced duration menu (member pricing stripped). */
  durations?: Array<{ minutes: number; priceAmount: number | null; benefitOnly?: boolean }>
  /** APPOINTMENT-ONLY: the one member-benefit rule, mirrored verbatim. */
  memberBenefit?: ActivityMemberBenefit | Benefit
  /** APPOINTMENT-ONLY. Read WITH `memberBenefit`, through
   *  `resolveDurationBenefit` — never on its own. */
  durationBenefits?: ActivityDurationBenefit[]
}

// Benefit chips stay GENERIC (no plan names — the website has no
// subscription-type list loaded).
//
// MONEY TERMS ONLY. Its one caller (payPerVisitLine) filters to price / dropIn /
// benefit*, so a 'gate' or 'trial' term never arrives here; access is said in
// full on the activity CARD, not compressed into a chip on the pricing block.
// A gate arm lived here until 2026-08 and was unreachable the whole time.
function activityTermLabel(term: ActivityTerm, currency: string, t: SiteT): string | null {
  switch (term.kind) {
    case 'dropIn':
      return t('termPerClass', { price: formatCurrency(term.amount ?? 0, currency) })
    case 'price':
      return term.min === term.max
        ? t('termFrom', { price: formatCurrency(term.min ?? 0, currency) })
        : `${formatCurrency(term.min ?? 0, currency)}–${formatCurrency(term.max ?? 0, currency)}`
    case 'benefitIncluded':
      return t('termIncludedWithSubscription')
    case 'benefitDiscount':
      return t('termMemberDiscount', { percent: term.percent ?? 0 })
    default:
      return null
  }
}

// Activities with an actual "pay per visit" money story — a priced appointment
// duration, or a priced drop-in on a class. Mirrors the shop's hasMoneyStory:
// a bare gated/trial class or an unpriced (free) appointment has nothing to sell
// per visit, so it never appears on the Pricing block's pay-per-visit card.
function activityHasMoneyStory(a: ActivityEntry): boolean {
  if (a.activityType === 'appointment') {
    // A benefit_only length is not sold per visit — it is sold as the plan.
    return (a.durations ?? []).some((d) => resolveDurationSale(d).priceAmount !== null)
  }
  return a.dropIn?.enabled === true && typeof a.dropIn.priceAmount === 'number'
}

// One activity's money terms as a "·"-joined line (price / drop-in / member
// benefit) for the Pricing block's pay-per-visit card. Generic labels — the
// website has no subscription-type list, same convention as the chips.
function payPerVisitLine(a: ActivityEntry, currency: string, t: SiteT): string {
  return resolveActivityTerms({
    type: a.activityType,
    dropIn: a.dropIn,
    durations: a.durations,
    memberBenefit: a.memberBenefit,
    durationBenefits: a.durationBenefits,
    accessRule: a.accessRule,
  })
    .filter(
      (term) => term.kind === 'price' || term.kind === 'dropIn' || term.kind.startsWith('benefit')
    )
    .map((term) => activityTermLabel(term, currency, t))
    .filter((l): l is string => !!l)
    .join(' · ')
}

// ─── activity card pricing (UX-94: hide / list / compact) ────────────────────
//
// A CARD'S LINES COME IN TWO KINDS AND ONLY ONE OF THEM IS OPTIONAL.
//
//   • GATE lines say what a visitor MUST have to book at all: "Open to members"
//     (the members tier — signing up, no money) and "Included with {plan}" on a
//     subscription-gated CLASS, where the named plan IS the key. These render
//     under every display mode. A studio that hides them buys itself a card a
//     prospect clicks and a booking flow that then refuses them, which is worse
//     than the price it was trying not to show.
//   • MONEY lines say what a visitor could CHOOSE to spend: drop-in, appointment
//     prices, a member discount, and an appointment's "included with {plan}"
//     benefit — an appointment has NO access gate (the price is the gate), so
//     that line names a saving, not a requirement.
//
// `pricingDisplay` governs the second kind — and, for a subscription-gated
// class, HOW MUCH OF THE GATE IS SAID INLINE:
//
//   list     the gate names its plan and price ("Included with Premium — CHF
//            89/mo"); every money line is inline too.
//   compact  the card is decluttered to the GENERIC requirement ("Requires an
//            active subscription") and the named, priced version moves behind
//            the link with the rest of the money.
//   hidden   the generic requirement only; nothing names a plan or an amount.
//
// The REQUIREMENT therefore survives every mode — a studio that hid it would buy
// itself a card a prospect clicks and a booking flow that then refuses them —
// while the plan's identity and price do not, which is what "hide" and "behind a
// link" were being asked for.
//
// An earlier version kept the gate line priced and inline under 'compact', on
// the reasoning that splitting it would duplicate the line or strip the number
// that made it actionable. That left `money` empty on any site whose priced
// activities were all gated, so the link never appeared and 'compact' did
// nothing at all.
interface CardPricing {
  /** Requirements. Always rendered. */
  gate: string[]
  /** Optional spend. Inline under 'list', behind the control under 'compact', absent under 'hidden'. */
  money: string[]
}

function ActivityPricingLines({
  pricing,
  mode,
  palette,
  t,
}: {
  pricing: CardPricing
  mode: 'list' | 'compact' | 'hidden'
  palette: SitePalette
  t: SiteT
}) {
  const [open, setOpen] = useState(false)
  const { gate, money } = pricing
  const inlineMoney = mode === 'list' || (mode === 'compact' && open)
  const rows = [...gate, ...(inlineMoney ? money : [])]
  const showToggle = mode === 'compact' && money.length > 0
  if (rows.length === 0 && !showToggle) return null

  return (
    <div className="mt-3 border-t" style={{ borderColor: palette.border }}>
      {rows.map((line, i) => (
        <p
          key={line + i}
          className={`py-1.5 text-sm${i > 0 ? ' border-t' : ''}`}
          style={{ color: palette.muted, borderColor: palette.border }}
        >
          {line}
        </p>
      ))}
      {showToggle && (
        // Icon + tooltip, and ALSO tap-to-open: a `title` alone is invisible on
        // a phone, which is where most of a studio's visitors read this card.
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={money.join(' · ')}
          aria-expanded={open}
          className={`flex items-center gap-1.5 py-1.5 text-sm transition-opacity hover:opacity-70${
            rows.length > 0 ? ' border-t' : ''
          }`}
          style={{ color: palette.muted, borderColor: palette.border }}
        >
          <Tag className="h-3.5 w-3.5 shrink-0" />
          {open ? t('pricesHide') : t('pricesShow')}
        </button>
      )}
    </div>
  )
}

function ActivitiesBlock({ section, ctx }: { section: ActivitiesSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  // slug/locale/preview are read from `ctx` by activityBookHref and bookProps —
  // not needed directly here.
  const { palette, teamId } = ctx
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [currency, setCurrency] = useState('CHF')
  // Subscription plans (id → name + price) so a card can name which plan includes
  // it — "Included with Premium — CHF 89/mo". Same aggregator the Pricing block reads.
  const [subPlans, setSubPlans] = useState<PlanEntry[]>([])
  const [loading, setLoading] = useState(true)

  const subLookup = useMemo<SubLookup>(() => {
    const byId = new Map(subPlans.map((p) => [p.id, p]))
    return (id: string) => {
      const p = byId.get(id)
      if (!p) return null
      const price = p.prices?.[0]
      return {
        id: p.id,
        name: p.name,
        priceLabel: price
          ? `${formatCurrency(price.amount, currency)}${recurrenceSuffix(price.recurrence, t)}`
          : null,
      }
    }
  }, [subPlans, currency, t])

  useEffect(() => {
    let alive = true
    const q = query(
      collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
      where('teamId', '==', teamId),
      where('type', '==', 'activity')
    )
    Promise.all([getDocs(q), getDoc(doc(db, TEAMS_COLLECTION, teamId!, PUBLIC_PROFILE_SUBCOLLECTION, teamId!))])
      .then(([snap, teamSnap]) => {
        if (!alive) return
        const list = snap.docs
          .map((d) => {
            const data = d.data()
            return {
              id: d.id,
              name: (data.name as string) || '',
              slug: (data.slug as string) || '',
              activityType: (data.activityType as string) || undefined,
              description: (data.description as string) || undefined,
              color: (data.color as string) || undefined,
              imageUrl: (data.image_url as string) || undefined,
              tags: Array.isArray(data.tags) ? (data.tags as string[]) : undefined,
              isFreeTrial: Boolean(data.isFreeTrial),
              order: typeof data.order === 'number' ? (data.order as number) : undefined,
              accessRule: (data.accessRule as ActivityAccessRule | undefined) ?? undefined,
              dropIn: (data.dropIn as ActivityEntry['dropIn']) ?? undefined,
              trialEnabled: data.trialEnabled === true,
              trialPriceAmount: typeof data.trialPriceAmount === 'number' ? (data.trialPriceAmount as number) : null,
              durations: Array.isArray(data.durations) ? (data.durations as ActivityEntry['durations']) : undefined,
              memberBenefit: (data.memberBenefit as ActivityMemberBenefit | undefined) ?? undefined,
              durationBenefits: Array.isArray(data.durationBenefits)
                ? (data.durationBenefits as ActivityDurationBenefit[])
                : undefined,
            }
          })
          .filter((a) => a.name)
          .sort(compareActivities)
        setActivities(list)
        setCurrency((teamSnap.data()?.default_currency as string | undefined) ?? 'CHF')
        setSubPlans((teamSnap.data()?.aggregator_subscription_types as PlanEntry[] | undefined) ?? [])
      })
      .catch((err: unknown) => {
        // A public marketing page: an empty activities block reads as "this
        // studio teaches nothing". Keep the terminal state, lose the silence.
        reportPublicLoadFailure('site/activities', err)
        if (alive) setActivities([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [teamId])

  // Two arrangements of the SAME card. Only the wrapper direction and the image
  // box differ — the body (chips, pricing rows, CTA) is shared, so the two can't
  // drift apart.
  const isList = section.layout === 'list'
  // Hide / list / icon + tooltip (UX-94). Absent ⇒ 'list' — today's cards.
  const pricingMode = section.pricingDisplay ?? 'list'
  const cols =
    section.columns === 2
      ? '@2xl:grid-cols-2'
      : section.columns === 4
        ? '@2xl:grid-cols-2 @5xl:grid-cols-4'
        : '@2xl:grid-cols-2 @5xl:grid-cols-3'
  // List: one full-width row per activity, image left. Container queries (not
  // viewport ones) because this also renders inside the embed iframe, where the
  // frame — not the window — is what the layout must respond to.
  const containerClass = isList
    ? 'mt-10 flex flex-col gap-4'
    : `mt-10 grid grid-cols-1 gap-5 ${cols}`
  // Side-by-side only once there's room; below that a list row stacks like a card.
  const cardClass = isList
    ? 'flex flex-col overflow-hidden site-card rounded-2xl border @2xl:flex-row'
    : 'flex flex-col overflow-hidden rounded-2xl border'
  const mediaClass = isList
    ? 'relative aspect-[4/3] w-full shrink-0 @2xl:aspect-auto @2xl:w-56 @4xl:w-72'
    : 'relative aspect-[4/3] w-full'

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <Heading text={section.heading ?? t('headingActivities')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        <div className={containerClass}>
          {loading ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : activities.length === 0 ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyActivities')}
            </p>
          ) : (
            activities.map((a) => {
              // Appointments book via their own flow (per-coach slot picker).
              const href = section.showBooking ? activityBookHref(ctx, a) : undefined
              // Structured commercial display (locked with the user): Free trial
              // stays a ribbon on the image; the card shows a type chip (Class /
              // Appointment) + NAMED pricing lines ("Included with {sub} — {price}",
              // "Discount with {sub} — {%}", drop-in, appointment price). No generic
              // "Subscription required" chip — where a plan IS the key it is named,
              // with its price. The one exception is the 'members' tier below,
              // where there is no plan to name because none is required.
              const d = resolveActivityPricingDisplay({ ...a, type: a.activityType }, subLookup)
              // A price is only advertised where somebody could pay it. `false`
              // is a resolved "this studio has no chargeable account"; undefined
              // is "not resolved here" (builder / org site / embed) and keeps
              // the previous behaviour. See RenderCtx.paymentsEnabled.
              const showPrices = ctx.paymentsEnabled !== false
              // TWO INDEPENDENT SWITCHES, kept apart on purpose.
              //   `amountsShown`  — the STUDIO'S display choice (UX-94).
              //   `showPrices`    — whether an ONLINE CHECKOUT could open at
              //                     all; it governed the drop-in and
              //                     appointment lines before this option
              //                     existed and still governs only those.
              // A membership price and a paid-trial badge are terms the studio
              // charges however it collects them, so they follow the display
              // choice alone — folding them into `showPrices` would have
              // silently blanked them for every studio without Stripe.
              const amountsShown = pricingMode !== 'hidden'
              const amountsAllowed = amountsShown && showPrices
              // Whether "Included with {plan}" is a REQUIREMENT here. Only a
              // class carries an access rule; an appointment's identical-looking
              // line comes from its member benefit and is a saving.
              const subscriptionGated = d.type === 'class' && siteClassFacts(a).planHoldersOnly
              const gate: string[] = []
              const money: string[] = []
              // A 'members'-tier class (the DEFAULT for every new class) used to
              // render nothing at all here: a name, a "Class" chip and a Book
              // link, with no hint that membership is required — on the surface a
              // prospect reaches earliest. It gets a line now, and the line names
              // the gate that is enforced (being signed up) rather than a plan
              // price nobody has to pay to book it. See `signedUpOnly`.
              if (d.signedUpOnly) gate.push(t('signedUpOnlyLine'))
              // A gated class whose plans are not public resolved to NO line at
              // all before this — the card looked open. Hiding a price must
              // never hide a gate, so the requirement is stated generically.
              if (d.planRequired) gate.push(t('planRequiredLine'))

              // THE INLINE LINE NAMES A PLAN ONLY UNDER 'list'.
              //
              // Both other modes exist to DECLUTTER THE CARD, and "Included with
              // Premium" is the clutter: it is the plan's identity, and under
              // 'compact' its price too. So they fall back to the generic
              // requirement — the same line a gated class already shows when its
              // plans are not public — and the named detail moves behind the
              // link ('compact') or goes away ('hidden').
              //
              // This is what makes 'compact' work at all. `showToggle` needs a
              // non-empty `money`, and on a site whose priced activities are all
              // subscription-gated EVERY line used to land in `gate` — so the
              // link never rendered and the mode was indistinguishable from
              // 'list'. Reported by Franco.
              const gateNamesPlans = pricingMode === 'list'
              for (const s of d.includedWith) {
                const line =
                  s.priceLabel && amountsShown
                    ? t('includedWithSubPriced', { name: s.name, price: s.priceLabel })
                    : t('includedWithSub', { name: s.name })
                // An appointment has no access gate, so its "included with" is a
                // saving, not a requirement — it was always money and stays there.
                if (!subscriptionGated) {
                  money.push(line)
                  continue
                }
                if (gateNamesPlans) {
                  gate.push(line)
                  continue
                }
                // Deduped: two plans that both include this class are still ONE
                // requirement, and `planRequired` above may have said it already.
                const generic = t('planRequiredLine')
                if (!gate.includes(generic)) gate.push(generic)
                if (pricingMode === 'compact') money.push(line)
              }
              if (amountsShown)
                // A percentage off, not an amount to be paid online — this line
                // never depended on `showPrices` and still does not.
                for (const s of d.discountWith)
                  money.push(t('discountWithSub', { name: s.name, percent: s.percent }))
              if (amountsAllowed) {
                if (d.dropInAmount != null)
                  money.push(t('termPerClass', { price: formatCurrency(d.dropInAmount, currency) }))
                if (d.appointmentPrice)
                  money.push(
                    d.appointmentPrice.min === d.appointmentPrice.max
                      ? t('termFrom', { price: formatCurrency(d.appointmentPrice.min, currency) })
                      : `${formatCurrency(d.appointmentPrice.min, currency)}–${formatCurrency(d.appointmentPrice.max, currency)}`
                  )
              }
              // A PAID trial badge quotes an amount, so it follows the switch; a
              // free one quotes none and always shows. It is never re-worded —
              // a "Trial" badge on a door that costs CHF 15 would read as free.
              const showTrialBadge = !!d.trial && (d.trial.priceAmount == null || amountsShown)
              return (
                <div
                  key={a.id}
                  className={cardClass}
                  style={{ borderColor: palette.border, background: palette.surface }}
                >
                  <div
                    className={mediaClass}
                    style={{ background: a.color || palette.accent }}
                  >
                    {a.imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={a.imageUrl}
                        alt=""
                        className="h-full w-full object-cover transition-transform hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <span
                          className="text-4xl font-bold"
                          style={{ color: '#ffffff', opacity: 0.92 }}
                        >
                          {a.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                    {showTrialBadge && d.trial && (
                      <span
                        className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-xs font-semibold shadow"
                        style={{ background: palette.accent, color: palette.onAccent }}
                      >
                        {d.trial.priceAmount != null
                          ? t('trialPriced', { price: formatCurrency(d.trial.priceAmount, currency) })
                          : t('trialFree')}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
                        {a.name}
                      </h3>
                      {/* Type chip — Class or Appointment */}
                      <span
                        className="rounded-full border px-2 py-0.5 text-xs"
                        style={{ borderColor: palette.border, color: palette.muted }}
                      >
                        {d.type === 'appointment' ? t('typeAppointment') : t('typeClass')}
                      </span>
                      {/* The studio's own words for this class ("Beginner
                          friendly", "Gi", "Kids"). Same chip shape as the type,
                          in the SITE palette — a per-site colour scheme cannot
                          take Tailwind's fixed greys. No translation: the studio
                          typed these, and nothing looks them up. */}
                      {a.tags?.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border px-2 py-0.5 text-xs"
                          style={{ borderColor: palette.border, color: palette.muted }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    {a.description && (
                      <p className="mt-2 flex-1 text-sm" style={{ color: palette.muted }}>
                        {a.description}
                      </p>
                    )}
                    {/* Each way to pay is its own row with a hairline between, so a
                        card offering a subscription AND a drop-in AND a trial reads
                        as a list rather than a paragraph of prices. Rules take the
                        site palette, not Tailwind's divide-* (colours are per-site).
                        The gate/money split — and why only one of them is
                        optional — lives in ActivityPricingLines. */}
                    <ActivityPricingLines
                      pricing={{ gate, money }}
                      mode={pricingMode}
                      palette={palette}
                      t={t}
                    />

                    {href && (
                      <a
                        // Both kinds open the overlay: the panel hosts the class
                        // funnel or the appointment picker depending on intent.
                        {...bookProps(href, ctx, activityIntent(a))}
                        className="mt-4 inline-flex items-center gap-1.5 self-start text-sm font-semibold transition-opacity hover:opacity-70"
                        style={{ color: palette.accent }}
                      >
                        {t('book')}
                        <ArrowRight className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Pricing (live: team public_profile.aggregator_subscription_types) ────────

interface PlanPrice {
  id?: string
  amount: number
  recurrence: string
  label?: string
  included_months?: number
  /** A credit-pack price's credit count — read only by `priceTermMonths`
   *  (a credit pack has no TERM to group by; its months are a validity
   *  window, not a commitment). */
  credits?: number
  /** The plan's INTRO OFFER on this price (resolved server-side by
   *  syncSubscriptionTypesToPublicProfile). Rendered through the same
   *  `IntroOfferLine` the shop uses — one discount, one sentence. */
  intro?: unknown
}

interface PlanEntry {
  id: string
  name: string
  description?: string
  prices?: PlanPrice[]
}

/** Short, public-facing recurrence suffixes ("/mo", "/yr"). An unknown
 *  recurrence renders nothing rather than a raw key. */
const RECURRENCE_KEYS: Record<string, string> = {
  weekly: 'recurrenceWeekly',
  biweekly: 'recurrenceBiweekly',
  monthly: 'recurrenceMonthly',
  quarterly: 'recurrenceQuarterly',
  annual: 'recurrenceAnnual',
}

function recurrenceSuffix(recurrence: string, t: SiteT): string {
  const key = RECURRENCE_KEYS[recurrence]
  return key ? t(key) : ''
}

// ─── pricing comparison table (UX-95) ────────────────────────────────────────
//
// The comparison a prospect actually makes — WHICH ACTIVITIES DOES EACH PLAN
// INCLUDE — as activities down the side and plans across the top. It is a
// rendering variant, not new data: the same activity `public_profile` mirrors
// and the same `aggregator_subscription_types` the cards already read, resolved
// through `resolveActivityAccessRule` / the appointment's `memberBenefit`.
//
// THE `members` TIER IS TICKED UNDER EVERY PLAN, and that is the whole care
// point of this block. `members` gates on being SIGNED UP, not on holding any
// particular plan — so every plan-holder can book it, and so can somebody with
// no plan at all. Leaving the row blank would say the opposite; picking a plan
// to tick would invent a rule that does not exist. The row therefore ticks
// across and carries a note saying why. `open` is the same shape for a
// different reason (nothing is required at all) and gets its own note.
type CellKind = 'yes' | 'no' | 'text'
interface Cell {
  kind: CellKind
  text?: string
}

/** What one plan buys you for one activity. */
function pricingCell(
  a: ActivityEntry,
  planId: string,
  currency: string,
  t: SiteT
): Cell {
  if (a.activityType === 'appointment') {
    // An appointment has NO access gate — the price is the gate — so a plan
    // never unlocks one; it can only make it cheaper.
    //
    // ONE CELL, SEVERAL LENGTHS. The rule is per length, and this table has one
    // cell per (plan, activity) on a page a stranger reads. So the cell states
    // a benefit only when EVERY length agrees; where they differ it falls
    // through to the "from CHF …" figure, which is true whatever the plan does,
    // and the picker quotes the real per-length price.
    //
    // Through `normalizeBenefit`, not `benefit.kind`: a per-length rule is
    // always stored in the generalized shape, and the legacy read below used to
    // see `effect` and report NOT COVERED for a plan that books free.
    const lengths = a.durations?.length ? a.durations : [{ minutes: 60 }]
    const rules = lengths.map((d) => normalizeBenefit(resolveDurationBenefit(a, d.minutes)))
    const first = rules[0] ?? null
    const unanimous = rules.every((b) => JSON.stringify(b) === JSON.stringify(first))
    const benefit = unanimous ? first : null
    if (benefit?.subscriptionTypeIds.includes(planId)) {
      if (benefit.effect === 'included' || benefit.effect === 'spend_credits') {
        return { kind: 'yes' }
      }
      if (benefit.effect === 'percent_off' && typeof benefit.percent === 'number') {
        return { kind: 'text', text: t('tableDiscount', { percent: benefit.percent }) }
      }
      if (benefit.effect === 'fixed_price' && typeof benefit.amount === 'number') {
        return { kind: 'text', text: formatCurrency(benefit.amount, currency) }
      }
    }
    // `resolveDurationSale` rather than a raw price test: a benefit_only length
    // (UX-70) has no individual price, so it must not produce a "from" figure.
    const priced = (a.durations ?? [])
      .map((d) => resolveDurationSale(d).priceAmount)
      .filter((p): p is number => typeof p === 'number')
    if (priced.length === 0) return { kind: 'yes' }
    const min = Math.min(...priced)
    return { kind: 'text', text: t('termFrom', { price: formatCurrency(min, currency) }) }
  }

  const facts = siteClassFacts(a)
  // Free to everyone it admits: every plan-holder qualifies.
  if (facts.free) return { kind: 'yes' }
  if (facts.includedPlanIds.includes(planId)) return { kind: 'yes' }
  // Not included — but say what a holder of THIS plan can still do rather than
  // leaving a bare dash where a door exists.
  if (a.dropIn?.enabled === true && typeof a.dropIn.priceAmount === 'number')
    return { kind: 'text', text: t('termPerClass', { price: formatCurrency(a.dropIn.priceAmount, currency) }) }
  return { kind: 'no' }
}

/** The row's one-line explanation, where the row needs one. */
function pricingRowNote(a: ActivityEntry, t: SiteT): string | null {
  if (a.activityType === 'appointment') {
    const priced = (a.durations ?? []).some(
      (d) => resolveDurationSale(d).priceAmount !== null
    )
    return priced ? null : t('tableFreeNote')
  }
  const facts = siteClassFacts(a)
  if (facts.free) return facts.signupRequired ? t('tableAnyPlanNote') : t('tableOpenNote')
  return null
}

/** WHO MAY BOOK a class on the site, derived (docs/class-access-derived.md) —
 *  from the mirror, whose drop-in is already RESOLVED, so no studio default is
 *  left to follow. */
function siteClassFacts(a: ActivityEntry) {
  return classAccessFacts(
    {
      type: 'class',
      accessRule: a.accessRule ?? undefined,
      isFreeTrial: a.isFreeTrial,
      dropIn:
        a.dropIn?.enabled === true && typeof a.dropIn.priceAmount === 'number'
          ? { mode: 'custom', priceAmount: a.dropIn.priceAmount }
          : { mode: 'off' },
    },
    null
  )
}

function PricingTable({
  plans,
  activities,
  currency,
  palette,
  t,
}: {
  plans: PlanEntry[]
  activities: ActivityEntry[]
  currency: string
  palette: SitePalette
  t: SiteT
}) {
  return (
    // A wide table scrolls INSIDE its own box — never the page, and never by
    // squeezing the columns until the plan names wrap to one letter.
    <div
      className="mt-10 overflow-x-auto site-card rounded-2xl border"
      style={{ borderColor: palette.border, background: palette.surface }}
    >
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr>
            <th
              className="border-b p-4 text-left font-semibold"
              style={{ borderColor: palette.border, color: palette.text }}
              scope="col"
            >
              {t('tableActivityColumn')}
            </th>
            {plans.map((p) => {
              const price = p.prices?.[0]
              return (
                <th
                  key={p.id}
                  scope="col"
                  className="border-b border-l p-4 text-center font-semibold"
                  style={{ borderColor: palette.border, color: palette.text }}
                >
                  {p.name}
                  {price && (
                    <span className="mt-0.5 block text-xs font-normal" style={{ color: palette.muted }}>
                      {formatCurrency(price.amount, currency)}
                      {recurrenceSuffix(price.recurrence, t)}
                    </span>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => {
            const note = pricingRowNote(a, t)
            return (
              <tr key={a.id}>
                <th
                  scope="row"
                  className="border-b p-4 text-left font-medium"
                  style={{ borderColor: palette.border, color: palette.text }}
                >
                  {a.name}
                  {note && (
                    <span className="mt-0.5 block text-xs font-normal" style={{ color: palette.muted }}>
                      {note}
                    </span>
                  )}
                </th>
                {plans.map((p) => {
                  const cell = pricingCell(a, p.id, currency, t)
                  return (
                    <td
                      key={p.id}
                      className="border-b border-l p-4 text-center"
                      style={{ borderColor: palette.border, color: palette.muted }}
                    >
                      {cell.kind === 'yes' ? (
                        // A tick needs a text alternative; "—" is decorative and
                        // hidden from the reader who is being read to.
                        <span style={{ color: palette.accent }}>
                          <Check className="mx-auto h-4 w-4" aria-hidden="true" />
                          <span className="sr-only">{t('tableIncluded')}</span>
                        </span>
                      ) : cell.kind === 'no' ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">{t('tableNotIncluded')}</span>
                        </>
                      ) : (
                        cell.text
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One plan's card. `onlyTermMonths` is the term tabs' whole point: instead of
 * every price the plan has, the card shows ONLY the one price for the active
 * term — set by `PricingBlock` when `groupBy: 'term'` is grouping ≥2 terms.
 * Absent ⇒ every price, today's card.
 */
function PlanCard({
  plan,
  onlyTermMonths,
  currency,
  palette,
  preview,
  ctaHref,
  ctaLabel,
  t,
}: {
  plan: PlanEntry
  onlyTermMonths?: number
  currency: string
  palette: SitePalette
  preview: boolean
  ctaHref: string | undefined
  ctaLabel: string
  t: SiteT
}) {
  const prices =
    onlyTermMonths == null
      ? (plan.prices ?? [])
      : (plan.prices ?? []).filter((pr) => priceTermMonths(pr) === onlyTermMonths)
  return (
    <div
      className="flex flex-col site-card rounded-2xl border p-6"
      style={{ borderColor: palette.border, background: palette.surface }}
    >
      <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
        {plan.name}
      </h3>
      {prices.length > 0 && (
        <div className="mt-3 space-y-1">
          {prices.map((pr, i) => {
            const intro = readIntroTerms(pr.intro)
            return (
              <div key={i}>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold" style={{ color: palette.text }}>
                    {formatCurrency(pr.amount, currency)}
                  </span>
                  <span className="text-sm" style={{ color: palette.muted }}>
                    {recurrenceSuffix(pr.recurrence, t)}
                    {pr.label ? ` · ${pr.label}` : ''}
                  </span>
                </div>
                {/* The offer, stated on the card the visitor decides from — a
                    price promise, and a mistranslated one is a lie, which is
                    why this sentence was the first thing here to be
                    translated (see the module header). */}
                {intro && (
                  <p className="mt-1 text-sm font-semibold" style={{ color: palette.accent }}>
                    <IntroOfferLine
                      intro={intro}
                      fullAmount={pr.amount}
                      recurrence={pr.recurrence}
                      currency={currency}
                    />
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
      {plan.description && (
        <p className="mt-2 flex-1 text-sm" style={{ color: palette.muted }}>
          {plan.description}
        </p>
      )}
      <a
        {...linkProps(preview ? undefined : ctaHref, preview)}
        className="site-btn mt-5 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-transform hover:scale-[1.02]"
        style={{ background: palette.button, color: palette.onButton }}
      >
        {ctaLabel}
      </a>
    </div>
  )
}

function PricingBlock({ section, ctx }: { section: PricingSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, slug, locale, teamId, preview } = ctx
  const [plans, setPlans] = useState<PlanEntry[]>([])
  // EVERY published activity, kept whole. Two readers want different subsets of
  // it and neither may narrow the fetch: the pay-per-visit card wants only the
  // ones with a price (`activityHasMoneyStory`), the comparison table wants all
  // of them — a members-only class with no price of its own is precisely the row
  // a prospect is scanning the table for.
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [currency, setCurrency] = useState('CHF')
  const [loading, setLoading] = useState(true)

  // Pay-per-visit activities (priced drop-ins + priced appointments) — the same
  // "additional lines" the shop shows under Subscriptions, surfaced here as a
  // card so the website's pricing isn't subscriptions-only.
  const ppvActivities = useMemo(
    () => activities.filter(activityHasMoneyStory),
    [activities]
  )

  // ── Term tabs (groupBy: 'term') — cards layout only ─────────────────────────
  //
  // Below 2 terms there is nothing to group ("1 month" tabbed against itself is
  // not a choice), so this falls all the way back to today's one-card-per-plan
  // grid regardless of the studio's setting.
  const [selectedTerm, setSelectedTerm] = useState<number | null>(null)
  const terms = useMemo(
    () => (section.groupBy === 'term' ? pricingTerms(plans) : []),
    [plans, section.groupBy]
  )
  const showTermTabs = (section.layout ?? 'cards') === 'cards' && terms.length >= 2
  // `pricingTerms` sorts ascending — the shortest term is the default tab.
  const activeTerm = selectedTerm !== null && terms.includes(selectedTerm) ? selectedTerm : terms[0]
  // Plans that DO have a price at the active term.
  const termPlans = useMemo(
    () =>
      showTermTabs
        ? plans.filter((p) => (p.prices ?? []).some((pr) => priceTermMonths(pr) === activeTerm))
        : [],
    [plans, showTermTabs, activeTerm]
  )
  // Plans with NO termed price at all (a credit pack, a per-class price) —
  // listed below the tabs as ordinary cards showing every price they have.
  const otherPlans = useMemo(
    () =>
      showTermTabs
        ? plans.filter((p) => !(p.prices ?? []).some((pr) => priceTermMonths(pr) !== null))
        : [],
    [plans, showTermTabs]
  )
  const planCta = (planId: string): string | undefined =>
    publicHrefLocalized(locale, slug, 'shop', { type: planId, from: 'site' })

  useEffect(() => {
    let alive = true
    // PricingBlock only ever renders inside a team site (org sites have no
    // 'pricing' section type), so teamId is always defined here. Plans live on
    // the team's single public_profile doc; the pay-per-visit prices come from
    // the per-activity mirrors (same query the Activities block reads).
    const planP = getDoc(doc(db, TEAMS_COLLECTION, teamId!, PUBLIC_PROFILE_SUBCOLLECTION, teamId!))
    const actP = getDocs(
      query(
        collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
        where('teamId', '==', teamId),
        where('type', '==', 'activity')
      )
    )
    Promise.all([planP, actP])
      .then(([snap, actSnap]) => {
        if (!alive) return
        const list = (snap.data()?.aggregator_subscription_types ?? []) as PlanEntry[]
        setPlans(Array.isArray(list) ? list : [])
        setCurrency((snap.data()?.default_currency as string | undefined) ?? 'CHF')
        const acts = actSnap.docs
          .map(
            (d) =>
              ({
                id: d.id,
                name: (d.data().name as string) || '',
                slug: (d.data().slug as string) || '',
                activityType: (d.data().activityType as string) || undefined,
                order: typeof d.data().order === 'number' ? (d.data().order as number) : undefined,
                accessRule: (d.data().accessRule as ActivityAccessRule | undefined) ?? undefined,
                dropIn: (d.data().dropIn as ActivityEntry['dropIn']) ?? undefined,
                durations: Array.isArray(d.data().durations)
                  ? (d.data().durations as ActivityEntry['durations'])
                  : undefined,
                memberBenefit: (d.data().memberBenefit as ActivityMemberBenefit | undefined) ?? undefined,
                durationBenefits: Array.isArray(d.data().durationBenefits)
                  ? (d.data().durationBenefits as ActivityDurationBenefit[])
                  : undefined,
              }) as ActivityEntry
          )
          .filter((a) => a.name)
          .sort(compareActivities)
        setActivities(acts)
      })
      .catch((err: unknown) => {
        reportPublicLoadFailure('site/pricing', err)
        if (alive) {
          setPlans([])
          setActivities([])
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [teamId])

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <Heading text={section.heading ?? t('headingPricing')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        {/* The table is a LAYOUT of the same plans, so it renders in place of the
            card grid and everything below it (pay-per-visit, "see all options")
            is untouched. A table with no activities to compare would be an empty
            grid of ticks, so that case falls back to the cards. */}
        {!loading && (section.layout ?? 'cards') === 'table' && plans.length > 0 && activities.length > 0 ? (
          <PricingTable
            plans={plans}
            activities={activities}
            currency={currency}
            palette={palette}
            t={t}
          />
        ) : (
        <>
          {/* Keyboard-accessible: ordinary <button>s, Tab + Enter/Space work
              with no extra wiring. `aria-selected` states which tab is active
              for assistive tech; the visual state comes from the palette. */}
          {!loading && showTermTabs && (
            <div
              role="tablist"
              aria-label={t('pricingTermTabsLabel')}
              className="mt-8 flex flex-wrap justify-center gap-2"
            >
              {terms.map((months) => {
                const active = months === activeTerm
                return (
                  <button
                    key={months}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedTerm(months)}
                    className="rounded-full border px-4 py-1.5 text-sm font-medium transition-colors"
                    style={
                      active
                        ? { background: palette.accent, borderColor: palette.accent, color: palette.onAccent }
                        : { background: 'transparent', borderColor: palette.border, color: palette.muted }
                    }
                  >
                    {t('pricingTermMonths', { count: months })}
                  </button>
                )
              })}
            </div>
          )}
        <div className="mt-10 grid grid-cols-1 gap-5 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {loading ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : plans.length === 0 ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyPlans')}
            </p>
          ) : showTermTabs ? (
            <>
              {termPlans.map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  onlyTermMonths={activeTerm}
                  currency={currency}
                  palette={palette}
                  preview={preview}
                  ctaHref={planCta(p.id)}
                  ctaLabel={section.ctaLabel ?? t('joinNow')}
                  t={t}
                />
              ))}
              {otherPlans.map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  currency={currency}
                  palette={palette}
                  preview={preview}
                  ctaHref={planCta(p.id)}
                  ctaLabel={section.ctaLabel ?? t('joinNow')}
                  t={t}
                />
              ))}
            </>
          ) : (
            plans.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                currency={currency}
                palette={palette}
                preview={preview}
                ctaHref={planCta(p.id)}
                ctaLabel={section.ctaLabel ?? t('joinNow')}
                t={t}
              />
            ))
          )}
        </div>
        </>
        )}
        {/* Pay per visit — the drop-in + appointment prices that aren't
            subscriptions. One card, each activity a row with its price line and
            a Book CTA into the right flow (appointments → picker, class → the
            activity's booking). */}
        {!loading && ppvActivities.length > 0 && (
          <div
            className="mt-6 site-card rounded-2xl border p-6"
            style={{ borderColor: palette.border, background: palette.surface }}
          >
            <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
              {t('payPerVisitTitle')}
            </h3>
            <p className="mt-1 text-sm" style={{ color: palette.muted }}>
              {t('payPerVisitSubtitle')}
            </p>
            <div className="mt-4 space-y-3">
              {ppvActivities.map((a) => {
                const line = payPerVisitLine(a, currency, t)
                const href = activityBookHref(ctx, a, true)
                return (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-4 border-t pt-3 first:border-t-0 first:pt-0"
                    style={{ borderColor: palette.border }}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium" style={{ color: palette.text }}>
                        {a.name}
                      </p>
                      {line && (
                        <p className="mt-0.5 text-xs" style={{ color: palette.muted }}>
                          {line}
                        </p>
                      )}
                    </div>
                    <a
                      {...bookProps(href, ctx, activityIntent(a))}
                      className="site-btn shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-transform hover:scale-[1.02]"
                      style={{ background: palette.button, color: palette.onButton }}
                    >
                      {t('book')}
                    </a>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!loading && plans.length > 0 && (
          <div className="mt-8 text-center">
            <a
              {...linkProps(
                preview ? undefined : publicHrefLocalized(locale, slug, 'shop', { from: 'site' }),
                preview
              )}
              className="text-sm font-medium underline-offset-4 hover:underline"
              style={{ color: palette.muted }}
            >
              {t('viewAllOptions')} →
            </a>
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Schedule (live: upcoming bookable sessions) ──────────────────────────────

/** The slice of `listAvailability`'s payload the schedule needs. */
interface AvailCoachLite {
  providerId: string
  providerName: string | null
  activities: {
    activityId: string
    activityName: string
    durations: { minutes: number }[]
    location: string | null
    days: { dayMs: number; slotsByDuration: Record<string, number[]> }[]
  }[]
}

interface SessionEntry {
  id: string
  activityName?: string
  activityColor?: string
  activityId?: string
  start: Timestamp
  end?: Timestamp
  location?: string
  providerName?: string
  /**
   * 'session' — a scheduled class, bookable at exactly this time.
   * 'availability' — a merged window in which an appointment CAN be booked;
   * the visitor still picks the exact start in the appointment picker.
   *
   * Absent ⇒ 'session', so the kiosk and existing call sites are unaffected.
   */
  variant?: 'session' | 'availability'
  /** Availability only — whose time this window is, so the picker can preselect. */
  providerId?: string
}

/** Timestamp-alike over a plain epoch, so merged windows reuse the session render path. */
function msTimestamp(ms: number): Timestamp {
  return Timestamp.fromMillis(ms)
}

// Group sorted sessions into ordered per-day buckets (used by the list dividers).
interface DayGroup {
  key: string // YYYY-MM-DD
  date: Date
  sessions: SessionEntry[]
}
function groupByDay(sessions: SessionEntry[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  for (const s of sessions) {
    const d = s.start.toDate()
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    let g = groups.get(key)
    if (!g) {
      g = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), sessions: [] }
      groups.set(key, g)
    }
    g.sessions.push(s)
  }
  return [...groups.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
}

const fmtTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** Local YYYY-MM-DD — the same day-key form MiniCalendar and `?date=` use. */
function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Midnight Monday of the current week — the timetable's lower bound. */
function mondayOfCurrentWeek(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

const isPastSession = (s: SessionEntry) =>
  (s.end ?? s.start).toDate().getTime() < Date.now()

function ScheduleBlock({ section, ctx }: { section: ScheduleSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, slug, locale, teamId, preview } = ctx
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  // Studio sets the default view; visitors can switch with the toggle below.
  const [view, setView] = useState<'list' | 'calendar'>(section.displayMode ?? 'calendar')
  const [selected, setSelected] = useState<SessionEntry | null>(null)
  const [activeDayKey, setActiveDayKey] = useState<string | null>(null)
  // Merged appointment availability, loaded separately (see the effect below).
  const [availability, setAvailability] = useState<SessionEntry[]>([])
  const [kind, setKind] = useState<'all' | 'classes' | 'appointments'>('all')

  useEffect(() => {
    let alive = true
    const windowEnd = new Date()
    windowEnd.setDate(windowEnd.getDate() + (section.windowDays ?? 7))
    // This query is CLASSES only, deliberately: appointments are availability-
    // only (a Session exists only once booked), so the only appointment_session
    // mirrors that exist are ALREADY-BOOKED appointments — listing those as
    // bookable would be wrong. Appointment availability comes from
    // listAvailability in the effect below instead. The lower bound is Monday of
    // the CURRENT week (not "now"): the calendar doubles as a timetable, showing
    // this week's already-run sessions muted.
    const q = query(
      collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
      where('teamId', '==', teamId),
      where('type', '==', 'session'),
      where('allowBooking', '==', true),
      where('start', '>=', Timestamp.fromDate(mondayOfCurrentWeek())),
      orderBy('start', 'asc'),
      limit(200)
    )
    getDocs(q)
      .then((snap) => {
        if (!alive) return
        const list = snap.docs
          .map((d) => ({ ...(d.data() as Omit<SessionEntry, 'id'>), id: d.id }))
          .filter((s) => s.start && s.start.toDate() <= windowEnd)
          .filter((s) => !section.activityId || s.activityId === section.activityId)
        setSessions(list)
      })
      .catch((err: unknown) => {
        reportPublicLoadFailure('site/schedule', err)
        if (alive) setSessions([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [teamId, section.windowDays, section.activityId])

  // ── Appointment availability ────────────────────────────────────────────────
  //
  // Two-step on purpose. `listAvailability` is a Cloud Function, and a public
  // marketing page can be hit a lot — so first check the (cheap, SDK-cached)
  // activity mirrors for an appointment offering, and only invoke the callable
  // for teams that actually have one. A classes-only studio pays nothing.
  useEffect(() => {
    if (preview || !teamId) return
    let alive = true
    const windowDays = section.windowDays ?? 7
    const windowEnd = Date.now() + windowDays * 24 * 60 * 60_000

    async function load() {
      // THIS QUERY NEEDS A DECLARED INDEX and fails SILENTLY without one.
      // Three equalities on a COLLECTION GROUP: unlike collection scope, where
      // Firestore's automatic single-field indexes are merged for a pure
      // equality query, collection-group scope needs its own — which is why
      // `public_profile` carries explicit COLLECTION_GROUP overrides for slug,
      // type and teamId. `activityType` had none, so this threw
      // FAILED_PRECONDITION on every real project and was swallowed by the
      // catch below: classes rendered, bookable hours silently did not. The
      // emulator does not enforce indexes, so it looked correct locally.
      // Covered by the teamId+type+activityType COLLECTION_GROUP index in
      // firestore.index.json — deleting it puts the silence back.
      const offerings = await getDocs(
        query(
          collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
          where('teamId', '==', teamId),
          where('type', '==', 'activity'),
          where('activityType', '==', 'appointment')
        )
      )
      if (!alive || offerings.empty) return

      const fn = callFunction<
        { teamId: string; days?: number; activityId?: string },
        { coaches: AvailCoachLite[] }
      >('listAvailability')
      const res = await fn({
        teamId: teamId!,
        days: windowDays,
        ...(section.activityId ? { activityId: section.activityId } : {}),
      })
      if (!alive) return

      const entries: SessionEntry[] = []
      for (const coach of res.data.coaches ?? []) {
        for (const activity of coach.activities ?? []) {
          // Browse by the SHORTEST duration — the most granular starts, and so
          // the widest true window. Picking an exact length is the picker's job.
          const minutes = browseDurationMinutes(activity.durations)
          if (!minutes) continue
          const starts = (activity.days ?? []).flatMap(
            (d) => d.slotsByDuration?.[String(minutes)] ?? []
          )
          for (const w of mergeAvailabilitySlots(starts, minutes)) {
            if (w.startMs > windowEnd) continue
            entries.push({
              id: `avail-${coach.providerId}-${activity.activityId}-${w.startMs}`,
              activityId: activity.activityId,
              providerId: coach.providerId,
              activityName: activity.activityName,
              providerName: coach.providerName ?? undefined,
              location: activity.location ?? undefined,
              start: msTimestamp(w.startMs),
              end: msTimestamp(w.endMs),
              variant: 'availability',
            })
          }
        }
      }
      if (alive) setAvailability(entries)
    }

    load().catch((err: unknown) => {
      // Availability is additive — a failure leaves the classes schedule intact.
      reportPublicLoadFailure('site/availability', err)
      if (alive) setAvailability([])
    })
    return () => {
      alive = false
    }
  }, [teamId, section.windowDays, section.activityId, preview])

  //
  // The section-level CTA ("Book a session") is a browse entry: no session in
  // hand, but it does carry the block's activity filter when it has one — a
  // schedule scoped to Yoga should open Yoga's calendar, not the full picker.
  // A CLICKED session gets `sessionBookHref` instead (see the modal below).
  const browseBookHref = preview
    ? undefined
    : publicHrefLocalized(locale, slug, 'booking', {
        activity: section.activityId || undefined,
        from: 'site',
      })

  // Classes and appointment availability share one timeline; the chips below
  // narrow it. Chips only appear when the team has BOTH — a classes-only studio
  // shouldn't be shown a filter with one meaningful option.
  const hasAvailability = availability.length > 0
  const showKindChips = hasAvailability && sessions.length > 0
  const visibleEntries = useMemo(() => {
    const wanted =
      kind === 'classes' ? sessions : kind === 'appointments' ? availability : [...sessions, ...availability]
    return [...wanted].sort((a, b) => a.start.toMillis() - b.start.toMillis())
  }, [kind, sessions, availability])

  // Daily list covers today onward (today's finished sessions render muted);
  // the calendar additionally shows the current week's past days as a timetable.
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const listDays = groupByDay(visibleEntries.filter((s) => s.start.toDate() >= startOfToday))
  const activeDay = listDays.find((g) => g.key === activeDayKey) ?? listDays[0]
  const today = new Date()
  const isToday = (d: Date) =>
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()

  // Kiosk-style daily list: selectable day chips on top, that day's sessions
  // below — a full multi-day list is unwieldy on a website.
  const DailyList = () => (
    <div className="space-y-4">
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {listDays.map((g) => {
          const active = g.key === activeDay?.key
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => setActiveDayKey(g.key)}
              aria-pressed={active}
              className="flex min-w-[3.75rem] shrink-0 flex-col items-center rounded-xl border px-3 py-2 transition-colors"
              style={
                active
                  ? { background: palette.accent, borderColor: palette.accent, color: palette.onAccent }
                  : { background: palette.bg, borderColor: palette.border, color: palette.text }
              }
            >
              <span
                className="text-xs font-semibold uppercase tracking-wide"
                style={active ? undefined : { color: palette.muted }}
              >
                {isToday(g.date)
                  ? t('today')
                  : g.date.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
              <span className="text-base font-bold tabular-nums">{g.date.getDate()}</span>
            </button>
          )
        })}
      </div>
      <div className="space-y-2.5">
        {/* Optional per-day cap (0/unset = all of the day). */}
        {(section.maxItems
          ? (activeDay?.sessions ?? []).slice(0, section.maxItems)
          : (activeDay?.sessions ?? [])
        ).map((s) => {
          const past = isPastSession(s)
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s)}
              className={`flex w-full items-center gap-4 site-card-sm rounded-xl border px-4 py-3 text-left transition-opacity hover:opacity-80 ${past ? 'opacity-50' : ''}`}
              style={{ borderColor: palette.border, background: palette.bg }}
            >
              <div
                className="h-10 w-1.5 shrink-0 rounded-full"
                style={{ background: s.activityColor || palette.accent }}
              />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate" style={{ color: palette.text }}>
                  {s.activityName ?? t('sessionFallback')}
                  {s.providerName ? ` · ${s.providerName}` : ''}
                </p>
                {s.location && (
                  <p className="text-xs" style={{ color: palette.muted }}>
                    {s.location}
                  </p>
                )}
              </div>
              <p className="text-sm shrink-0 tabular-nums" style={{ color: palette.text }}>
                {fmtTime(s.start.toDate())}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )


  const ToggleButton = ({
    mode,
    icon: Icon,
    label,
  }: {
    mode: 'list' | 'calendar'
    icon: typeof List
    label: string
  }) => {
    const active = view === mode
    return (
      <button
        type="button"
        onClick={() => setView(mode)}
        aria-label={label}
        aria-pressed={active}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors"
        style={
          active
            ? { background: palette.accent, color: palette.onAccent }
            : { color: palette.muted }
        }
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
      </button>
    )
  }

  return (
    <section id={section.id} className="py-20" style={{ background: palette.surface }}>
      {/* Calendar view needs room for the 7-day grid; list view stays a tidy reading width. */}
      <div className={`mx-auto px-6 ${view === 'calendar' ? 'site-shell' : 'max-w-3xl'}`}>
        <Heading text={section.heading ?? t('headingSchedule')} palette={palette} />

        <div className="mt-4 flex justify-center">
          <div
            className="inline-flex items-center gap-1 rounded-full border p-1"
            style={{ borderColor: palette.border }}
          >
            <ToggleButton mode="list" icon={List} label={t('viewDailyList')} />
            <ToggleButton mode="calendar" icon={CalendarRange} label={t('viewCalendar')} />
          </div>
        </div>

        {/* Classes vs appointment availability. Defaults to All so a visitor
            sees everything without having to discover the filter; only shown
            when the team actually has both to choose between. */}
        {showKindChips && (
          <div className="mt-3 flex justify-center">
            <div
              className="inline-flex items-center gap-1 rounded-full border p-1"
              style={{ borderColor: palette.border }}
            >
              {(['all', 'classes', 'appointments'] as const).map((k) => {
                const active = kind === k
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    aria-pressed={active}
                    className="rounded-full px-3 py-1.5 text-xs font-semibold transition-colors"
                    style={
                      active
                        ? { background: palette.accent, color: palette.onAccent }
                        : { color: palette.muted }
                    }
                  >
                    {t(
                      k === 'all' ? 'kindAll' : k === 'classes' ? 'kindClasses' : 'kindAppointments'
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="mt-8">
          {loading ? (
            <p className="text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : sessions.length === 0 ? (
            <p className="text-center text-sm" style={{ color: palette.muted }}>
              {t('emptySessions')}
            </p>
          ) : view === 'calendar' ? (
            // WeeklyCalendar is shared with the kiosk and styles its chrome with
            // app theme tokens (bg-background, border, muted…). On the public site
            // those must follow the studio's palette, not the viewer's app light/
            // dark mode — otherwise the hour axis renders dark on a light site.
            // Remapping the CSS vars here (they cascade via @theme inline) pins the
            // calendar to the site palette regardless of the global theme.
            <div
              style={
                {
                  '--background': palette.surface,
                  '--foreground': palette.text,
                  '--muted': palette.border,
                  '--muted-foreground': palette.muted,
                  '--border': palette.border,
                  '--primary': palette.accent,
                  color: palette.text,
                } as CSSProperties
              }
            >
              <WeeklyCalendar
                sessions={visibleEntries}
                accent={palette.accent}
                windowDays={section.windowDays ?? 7}
                onSelect={(s) => setSelected(s as SessionEntry)}
              />
            </div>
          ) : (
            <DailyList />
          )}
        </div>

        {selected && (
          <SessionDetailModal
            s={selected}
            palette={palette}
            bookLinkProps={
              section.showBooking && !isPastSession(selected) && !preview
                ? selected.variant === 'availability'
                  ? // An availability window is not a bookable moment — it's a
                    // range. Hand over to the picker, carrying the coach and day
                    // the window already identifies so the visitor isn't asked to
                    // choose again what they just clicked; they only pick the
                    // exact start and length.
                    bookProps(
                      publicHrefLocalized(locale, slug, 'appointments', {
                        activity: selected.activityId,
                        provider: selected.providerId,
                        date: toDayKey(selected.start.toDate()),
                        from: 'site',
                      }),
                      ctx,
                      {
                        kind: 'appointment',
                        activityId: selected.activityId ?? '',
                        providerId: selected.providerId,
                        date: toDayKey(selected.start.toDate()),
                      }
                    )
                  : bookProps(sessionBookHref(ctx, selected), ctx, {
                      kind: 'session',
                      sessionId: selected.id,
                    })
                : null
            }
            // This modal is a hand-rolled `fixed inset-0 z-50` overlay. The
            // booking panel portals to <body> at the same layer, so leaving this
            // backdrop underneath would break Esc and the focus trap — close it
            // FIRST, then open.
            onBookClick={() => setSelected(null)}
            onClose={() => setSelected(null)}
          />
        )}

        <div className="mt-8 text-center">
          <a
            {...bookProps(browseBookHref, ctx, { kind: 'root' })}
            className="site-btn inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-semibold transition-transform hover:scale-[1.02]"
            style={{ background: palette.button, color: palette.onButton }}
          >
            <CalendarDays className="h-4 w-4" />
            {t('bookASession')}
          </a>
        </div>
      </div>
    </section>
  )
}

// Palette-styled session detail (the calendar/list blocks only fit minimal
// info) — mirrors the kiosk's modal, plus a Book CTA when booking is offered.
function SessionDetailModal({
  s,
  palette,
  bookLinkProps,
  onBookClick,
  onClose,
}: {
  s: SessionEntry
  palette: SitePalette
  /** Ready-made anchor props from `bookProps`; null hides the CTA. */
  bookLinkProps: ReturnType<typeof bookProps> | null
  onBookClick: () => void
  onClose: () => void
}) {
  const t = useTranslations('Site')
  const start = s.start.toDate()
  const end = s.end?.toDate()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm site-card rounded-2xl border p-6 shadow-xl"
        style={{ background: palette.bg, borderColor: palette.border, color: palette.text }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className="mt-1 h-12 w-1.5 shrink-0 rounded-full"
            style={{ background: s.activityColor || palette.accent }}
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-bold">{s.activityName ?? t('sessionFallback')}</h3>
            <p className="mt-1 text-sm capitalize" style={{ color: palette.muted }}>
              {start.toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="shrink-0 rounded-lg p-1.5 transition-opacity hover:opacity-70"
            style={{ color: palette.muted }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0" style={{ color: palette.muted }} />
            <span className="font-medium tabular-nums">
              {fmtTime(start)}
              {end ? ` – ${fmtTime(end)}` : ''}
            </span>
          </div>
          {s.providerName && (
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 shrink-0" style={{ color: palette.muted }} />
              <span>{s.providerName}</span>
            </div>
          )}
          {s.location && (
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 shrink-0" style={{ color: palette.muted }} />
              <span>{s.location}</span>
            </div>
          )}
        </div>
        {bookLinkProps && (
          <a
            {...bookLinkProps}
            onClick={(e) => {
              // Dismiss this backdrop before the booking panel opens over it.
              onBookClick()
              bookLinkProps.onClick?.(e)
            }}
            className="site-btn mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-transform hover:scale-[1.02]"
            style={{ background: palette.button, color: palette.onButton }}
          >
            <CalendarPlus className="h-4 w-4" />
            {t('book')}
          </a>
        )}
      </div>
    </div>
  )
}

// ─── Contact ──────────────────────────────────────────────────────────────────

function ContactBlock({ section, ctx }: { section: ContactSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, preview, socialLinks } = ctx
  const socials = (socialLinks ?? []).filter((s) => s.url)
  const rows: { icon: React.FC<{ className?: string }>; value?: string }[] = [
    { icon: MapPin, value: section.address },
    { icon: Phone, value: section.phone },
    { icon: Mail, value: section.email },
    { icon: Clock, value: section.hours },
  ].filter((r) => r.value)

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <Heading text={section.heading ?? t('headingContact')} palette={palette} />
        <div
          className={`mt-10 grid gap-8 ${section.mapQuery ? '@3xl:grid-cols-2' : 'max-w-md mx-auto'}`}
        >
          <div className="space-y-4">
            {rows.map((r, i) => {
              const Icon = r.icon
              return (
                <div key={i} className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: `${palette.accent}1a`, color: palette.accent }}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <p className="whitespace-pre-line text-sm" style={{ color: palette.text }}>
                    {r.value}
                  </p>
                </div>
              )
            })}
            {section.showSocial && socials.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {socials.map((s) => {
                  const Icon = SOCIAL_ICONS[s.platform] ?? Globe
                  return (
                    <a
                      key={s.platform}
                      {...linkProps(s.url, preview, true)}
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
          </div>
          {section.mapQuery && (
            <div
              className="overflow-hidden site-card rounded-2xl border"
              style={{ borderColor: palette.border, minHeight: 240 }}
            >
              <iframe
                title="map"
                className="h-full w-full"
                style={{ minHeight: 240, border: 0 }}
                loading="lazy"
                src={`https://www.google.com/maps?q=${encodeURIComponent(section.mapQuery)}&output=embed`}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// Selected places as simple cards (no map). Published sites carry an embedded
// `places` snapshot; the builder preview resolves the selected ids live.
function PlacesBlock({ section, ctx }: { section: PlacesSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, preview, teamId } = ctx
  // PlacesBlock only ever renders inside a team site (org sites have no
  // 'places' section type), so teamId is always defined here.
  const { data: pool = [] } = usePlaces(preview && !section.places ? (teamId ?? null) : null)
  const places =
    section.places ??
    (section.placeIds ?? [])
      .map((id) => pool.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ id: p.id, name: p.name, address: p.address, mapsLink: p.mapsLink }))

  const cols =
    section.columns === 2
      ? '@2xl:grid-cols-2'
      : section.columns === 4
        ? '@2xl:grid-cols-2 @5xl:grid-cols-4'
        : '@2xl:grid-cols-2 @5xl:grid-cols-3'

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <Heading text={section.heading ?? t('headingPlaces')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        <div className={`mt-10 grid grid-cols-1 gap-5 ${cols}`}>
          {places.length === 0 ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyPlaces')}
            </p>
          ) : (
            places.map((p) => (
              <div
                key={p.id}
                className="flex flex-col site-card rounded-2xl border p-5"
                style={{ borderColor: palette.border, background: palette.surface }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: `${palette.accent}1a`, color: palette.accent }}
                  >
                    <MapPin className="h-4 w-4" />
                  </span>
                  <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
                    {p.name}
                  </h3>
                </div>
                {p.address && (
                  <p className="mt-3 text-sm" style={{ color: palette.muted }}>
                    {p.address}
                  </p>
                )}
                {p.mapsLink && (
                  <a
                    {...linkProps(preview ? undefined : p.mapsLink, preview, true)}
                    className="mt-4 inline-flex items-center gap-1.5 self-start text-sm font-semibold transition-opacity hover:opacity-70"
                    style={{ color: palette.accent }}
                  >
                    {t('openInMaps')}
                    <ArrowRight className="h-4 w-4" />
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Team (authored coaches / contact person — see TeamSection's doc comment) ─
//
// NOT the roster: every name, photo, role and bio is typed in the builder, same
// convention as Features/Testimonials. Two layouts of the SAME data:
//   - 'grid'    a portrait card per person — the "meet the coaches" wall.
//   - 'contact' one wide card per person with the bio and mailto:/tel:
//     buttons — "your contact person" on an offer page.

function TeamBlock({ section, ctx }: { section: TeamSection; ctx: RenderCtx }) {
  const { palette, preview } = ctx
  const items = section.items ?? []
  if (items.length === 0) return null

  const header = (
    <>
      <Heading text={section.heading} palette={palette} />
      {section.subheading && (
        <p className="mt-3 text-center" style={{ color: palette.muted }}>
          {section.subheading}
        </p>
      )}
    </>
  )

  // A soft, neutral wash instead of a flat accent fill — a cut-out portrait
  // needs something calm to sit on, in both light and dark themes; the two
  // faint layers are derived from the palette's own text colour so they never
  // fight the accent used everywhere else on the card.
  const avatarBg = `linear-gradient(180deg, color-mix(in srgb, ${palette.text} 6%, transparent), color-mix(in srgb, ${palette.text} 12%, transparent)), ${palette.surface}`

  const avatar = (item: TeamSection['items'][number], className: string) => (
    <div className={className} style={{ background: avatarBg }}>
      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-2xl font-bold" style={{ color: palette.accent }}>
            {nameInitials(item.name)}
          </span>
        </div>
      )}
    </div>
  )

  const badge = (item: TeamSection['items'][number]) =>
    item.badge && (
      <span
        className="mt-2 inline-block rounded-full border px-2 py-0.5 text-xs"
        style={{ borderColor: palette.border, color: palette.muted }}
      >
        {item.badge}
      </span>
    )

  if (section.layout === 'contact') {
    return (
      <section id={section.id} className="py-20" style={{ background: palette.bg }}>
        <div className="mx-auto max-w-4xl px-6">
          {header}
          <div className={`${section.heading || section.subheading ? 'mt-10' : ''} space-y-5`}>
            {items.map((item, i) => (
              <div
                key={i}
                className="site-card flex flex-col items-center gap-5 overflow-hidden rounded-2xl border p-6 text-center @xl:flex-row @xl:items-start @xl:text-left"
                style={{ borderColor: palette.border, background: palette.surface }}
              >
                {avatar(item, 'flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full')}
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
                    {item.name}
                  </h3>
                  {item.role && (
                    <p className="text-sm font-medium" style={{ color: palette.accent }}>
                      {item.role}
                    </p>
                  )}
                  {badge(item)}
                  {item.bio && (
                    <p className="mt-3 whitespace-pre-line text-sm" style={{ color: palette.muted }}>
                      {item.bio}
                    </p>
                  )}
                  {(item.email || item.phone) && (
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-2 @xl:justify-start">
                      {item.email && (
                        <a
                          {...linkProps(`mailto:${item.email}`, preview)}
                          className="site-btn inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold"
                          // An address is not a label: the theme's capitals (an
                          // unlayered .site-btn rule, so no utility can undo it)
                          // would print one nobody can read back.
                          style={{ background: palette.button, color: palette.onButton, textTransform: 'none' }}
                        >
                          <Mail className="h-3.5 w-3.5" />
                          {item.email}
                        </a>
                      )}
                      {item.phone && (
                        <a
                          {...linkProps(`tel:${item.phone.replace(/[^\d+]/g, '')}`, preview)}
                          className="inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold"
                          style={{ borderColor: palette.border, color: palette.text }}
                        >
                          <Phone className="h-3.5 w-3.5" />
                          {item.phone}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    )
  }

  const cols =
    section.columns === 2
      ? '@2xl:grid-cols-2'
      : section.columns === 4
        ? '@2xl:grid-cols-2 @5xl:grid-cols-4'
        : '@2xl:grid-cols-2 @5xl:grid-cols-3'

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        {header}
        <div className={`${section.heading || section.subheading ? 'mt-10' : ''} grid grid-cols-1 gap-5 ${cols}`}>
          {items.map((item, i) => (
            <div
              key={i}
              className="site-card flex flex-col overflow-hidden rounded-2xl border"
              style={{ borderColor: palette.border, background: palette.surface }}
            >
              {avatar(item, 'relative aspect-[4/5] w-full')}
              <div className="p-4 text-left">
                <h3 className="text-base font-semibold" style={{ color: palette.text }}>
                  {item.name}
                </h3>
                {item.role && (
                  <p className="text-sm" style={{ color: palette.muted }}>
                    {item.role}
                  </p>
                )}
                {badge(item)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Split (a story on one side, a panel of facts + CTA on the other) ───────

function SplitBlock({ section, ctx }: { section: SplitSection; ctx: RenderCtx }) {
  const { palette, slug, locale, preview } = ctx
  const items = section.items ?? []
  const side = section.side
  const panelFirst = section.sidePosition === 'left'
  const hasPanel = !!(side && (side.heading || side.text || side.imageUrl || side.facts?.length || side.cta?.label))

  if (!section.heading && !section.subheading && !section.body && items.length === 0 && !hasPanel) return null

  const main = (
    <div className="min-w-0">
      <Heading text={section.heading} palette={palette} center={false} />
      {section.subheading && (
        <p className={`text-lg ${section.heading ? 'mt-3' : ''}`} style={{ color: palette.muted }}>
          {section.subheading}
        </p>
      )}
      {section.body && (
        // Body is rich HTML — sanitized at publish time, same as the content block.
        <div
          className={`site-prose leading-relaxed ${section.heading || section.subheading ? 'mt-5' : ''}`}
          style={{ color: palette.text, '--site-accent': palette.accent } as React.CSSProperties}
          dangerouslySetInnerHTML={{ __html: section.body }}
        />
      )}
      {items.length > 0 && (
        <ul className={`space-y-4 ${section.heading || section.subheading || section.body ? 'mt-6' : ''}`}>
          {items.map((item, i) => (
            <li key={i} className="flex gap-3">
              <span
                className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                style={{ background: `${palette.accent}1a`, color: palette.accent }}
              >
                {item.icon ? (
                  <DynamicIcon name={item.icon} className="h-3.5 w-3.5" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </span>
              <div>
                <p className="font-semibold" style={{ color: palette.text }}>
                  {item.title}
                </p>
                {item.text && (
                  <p className="mt-1 text-sm" style={{ color: palette.muted }}>
                    {item.text}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const href = side?.cta?.label ? shortHref(ctx, ctaHref(side.cta, slug, locale, ctx.pageHref)) : undefined
  const panel = hasPanel && side && (
    <div
      className={`site-card overflow-hidden rounded-2xl border ${section.sideSticky ? '@3xl:sticky @3xl:top-24' : ''}`}
      style={{ borderColor: palette.border, background: palette.surface }}
    >
      {side.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={side.imageUrl} alt="" className="aspect-[4/3] w-full object-cover" />
      )}
      <div className="p-6">
        {side.heading && (
          <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
            {side.heading}
          </h3>
        )}
        {side.text && (
          <p className={`text-sm ${side.heading ? 'mt-2' : ''}`} style={{ color: palette.muted }}>
            {side.text}
          </p>
        )}
        {side.facts && side.facts.length > 0 && (
          <div className={side.heading || side.text ? 'mt-4' : ''}>
            {side.facts.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-4 border-t py-2.5 text-sm first:border-t-0 first:pt-0"
                style={{ borderColor: palette.border }}
              >
                <span style={{ color: palette.muted }}>{f.label}</span>
                <span className="font-medium" style={{ color: palette.text }}>
                  {f.value}
                </span>
              </div>
            ))}
          </div>
        )}
        {side.cta?.label && (
          <a
            {...(ctaIntent(side.cta)
              ? bookProps(href, ctx, ctaIntent(side.cta)!)
              : linkProps(href, preview, side.cta.action === 'url'))}
            className="site-btn mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold"
            style={{ background: palette.button, color: palette.onButton }}
          >
            {side.cta.label}
          </a>
        )}
      </div>
    </div>
  )

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <div className={`grid items-start gap-10 @3xl:gap-14 ${panel ? '@3xl:grid-cols-[1.6fr_1fr]' : ''}`}>
          {panel && panelFirst && panel}
          {main}
          {panel && !panelFirst && panel}
        </div>
      </div>
    </section>
  )
}

// ─── Form (one of the team's own forms, filled in on the page) ───────────────
//
// Reads the SAME world-readable mirror the standalone /forms/{slug} page reads
// (`forms/{formId}/public_profile/{formId}`) and submits through the SAME
// `submitForm` callable — this is the standalone form's fields and submit path,
// just embedded on the page instead of linked to. A `access: 'contacts'` form
// is NOT re-implemented here (the sign-in gate lives on the standalone page,
// which already carries it) — this block links out to it instead.

type FormLoadState =
  | { status: 'loading' }
  | { status: 'notfound' }
  | { status: 'gated'; formId: string; profile: FormPublicProfile }
  | { status: 'ready'; formId: string; profile: FormPublicProfile }

function useFormMirror(teamId: string | undefined, formId: string): FormLoadState {
  const [state, setState] = useState<FormLoadState>({ status: 'loading' })
  useEffect(() => {
    if (!teamId || !formId) {
      setState({ status: 'notfound' })
      return
    }
    let alive = true
    setState({ status: 'loading' })
    getDoc(doc(db, FORMS_COLLECTION, formId, PUBLIC_PROFILE_SUBCOLLECTION, formId))
      .then((snap) => {
        if (!alive) return
        if (!snap.exists()) {
          setState({ status: 'notfound' })
          return
        }
        const profile = snap.data() as FormPublicProfile
        if (profile.teamId !== teamId) {
          setState({ status: 'notfound' })
          return
        }
        setState(
          profile.access === 'contacts'
            ? { status: 'gated', formId, profile }
            : { status: 'ready', formId, profile }
        )
      })
      .catch((err: unknown) => {
        reportPublicLoadFailure('site/form', err)
        if (alive) setState({ status: 'notfound' })
      })
    return () => {
      alive = false
    }
  }, [teamId, formId])
  return state
}

function FormBlock({ section, ctx }: { section: FormSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, preview, locale, slug, teamId } = ctx
  const state = useFormMirror(teamId, section.formId)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const profile = state.status === 'ready' || state.status === 'gated' ? state.profile : null
  const sortedFields = useMemo(
    () => (profile?.fields ?? []).slice().sort((a, b) => a.order - b.order),
    [profile?.fields]
  )

  // No form chosen, no team to read it from (an org site / an embed with no
  // team context), or the mirror doesn't resolve — nothing to render. This is
  // ALSO what publish drops the section for, so a live site never shows this.
  if (!section.formId || !teamId || state.status === 'notfound') return null

  const submit = async () => {
    if (preview || state.status !== 'ready') return
    setError(null)
    for (const f of sortedFields) {
      if (f.required && !isFieldAnswered(f, answers[f.id])) {
        setError(t('formMissingRequired', { label: f.label }))
        return
      }
    }
    setSubmitting(true)
    try {
      const fn = callFunction('submitForm')
      await fn({ teamId, formId: state.formId, answers })
      setDone(true)
      // The enquiry and the intro call are ONE step for the visitor: open the
      // booking straight away. The thank-you keeps a button that reopens it, and
      // a host with no overlay (an embed) is left with that button — a plain link.
      if (section.next?.kind === 'appointment' && ctx.onBook) {
        ctx.onBook({ kind: 'appointment', activityId: section.next.activityId })
      }
    } catch (err: unknown) {
      setError((err as { message?: string })?.message || t('formSubmitError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto max-w-xl px-6">
        <Heading text={section.heading} palette={palette} />
        {section.text && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.text}
          </p>
        )}
        <div
          className={`site-card ${section.heading || section.text ? 'mt-10' : ''} rounded-2xl border p-6 @xl:p-8`}
          style={{ borderColor: palette.border, background: palette.surface }}
        >
          {state.status === 'loading' ? (
            <p className="text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : state.status === 'gated' ? (
            <div className="text-center">
              <p className="text-sm" style={{ color: palette.muted }}>
                {t('formSignInRequired')}
              </p>
              {profile?.slug && (
                <a
                  {...linkProps(
                    shortHref(ctx, publicSubHrefLocalized(locale, slug, 'forms', profile.slug)),
                    preview
                  )}
                  className="site-btn mt-4 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold"
                  style={{ background: palette.button, color: palette.onButton }}
                >
                  {t('formOpenForm')}
                </a>
              )}
            </div>
          ) : done ? (
            <div className="text-center">
              <p className="text-sm font-medium" style={{ color: palette.text }}>
                {t('formThankYou')}
              </p>
              {section.next?.kind === 'appointment' && (
                <a
                  {...bookProps(
                    publicHrefLocalized(locale, slug, 'appointments', {
                      activity: section.next.activityId,
                      from: 'site',
                    }),
                    ctx,
                    { kind: 'appointment', activityId: section.next.activityId }
                  )}
                  className="site-btn mt-4 inline-flex items-center justify-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold"
                  style={{ background: palette.button, color: palette.onButton }}
                >
                  {t('formChooseTime')}
                  <ArrowRight className="h-4 w-4" />
                </a>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {sortedFields.map((field) => (
                <div key={field.id} className="space-y-1.5">
                  {field.type !== 'checkbox' && (
                    <label className="text-sm font-medium" style={{ color: palette.text }}>
                      {field.label}
                      {field.required && <span style={{ color: '#dc2626' }}> *</span>}
                    </label>
                  )}
                  <FieldInput
                    field={field}
                    value={answers[field.id]}
                    onChange={(v) => setAnswers((prev) => ({ ...prev, [field.id]: v }))}
                  />
                </div>
              ))}
              {error && (
                <p className="text-sm" style={{ color: '#dc2626' }}>
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="site-btn inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
                style={{ background: palette.button, color: palette.onButton }}
              >
                {submitting ? t('formSubmitting') : t('formSubmit')}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Posts (a site's own blog — pages with kind: 'post') ────────────────────
//
// No extra read: `sitePosts` filters and sorts the SAME page index the site
// already carries (`ctx.pages`, set by WebsiteRenderer from `site.pages`), so a
// hidden or unpublished post is simply not in it — nothing here decides that.

function PostsBlock({ section, ctx }: { section: PostsSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, preview } = ctx
  const posts = sitePosts(ctx.pages).slice(0, section.limit ?? 6)

  if (posts.length === 0) {
    // The live site simply omits an empty blog block; the builder canvas says
    // why, so a studio doesn't wonder whether the section is broken.
    if (!preview) return null
    return (
      <section id={section.id} className="py-20" style={{ background: palette.bg }}>
        <div className="mx-auto site-shell px-6">
          <Heading text={section.heading ?? t('headingPosts')} palette={palette} />
          <p
            className="mt-6 rounded-lg border border-dashed p-6 text-center text-sm"
            style={{ color: palette.muted, borderColor: palette.border }}
          >
            {t('emptyPosts')}
          </p>
        </div>
      </section>
    )
  }

  const isList = section.layout === 'list'
  const cols =
    section.columns === 2
      ? '@2xl:grid-cols-2'
      : section.columns === 4
        ? '@2xl:grid-cols-2 @5xl:grid-cols-4'
        : '@2xl:grid-cols-2 @5xl:grid-cols-3'
  const containerClass = isList ? 'mt-10 flex flex-col gap-4' : `mt-10 grid grid-cols-1 gap-5 ${cols}`
  const cardClass = isList
    ? 'flex flex-col overflow-hidden site-card rounded-2xl border @2xl:flex-row'
    : 'flex flex-col overflow-hidden site-card rounded-2xl border'
  const mediaClass = isList
    ? 'relative aspect-[16/10] w-full shrink-0 @2xl:aspect-auto @2xl:w-56 @4xl:w-72'
    : 'relative aspect-[16/10] w-full'

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        <Heading text={section.heading ?? t('headingPosts')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        <div className={containerClass}>
          {posts.map((post) => {
            const href = ctx.pageHref?.(post.id)
            const inner = (
              <>
                <div className={mediaClass} style={{ background: palette.accent }}>
                  {post.coverImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={post.coverImageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Newspaper className="h-8 w-8" style={{ color: palette.onAccent, opacity: 0.85 }} />
                    </div>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-5">
                  {post.publishedOn && (
                    <p className="text-xs" style={{ color: palette.muted }}>
                      {formatSiteDate(post.publishedOn, ctx.locale)}
                    </p>
                  )}
                  <h3 className="mt-1 text-lg font-semibold" style={{ color: palette.text }}>
                    {post.title}
                  </h3>
                  {post.excerpt && (
                    <p className="mt-2 line-clamp-3 flex-1 text-sm" style={{ color: palette.muted }}>
                      {post.excerpt}
                    </p>
                  )}
                  <span
                    className="mt-4 inline-flex items-center gap-1.5 self-start text-sm font-semibold"
                    style={{ color: palette.accent }}
                  >
                    {t('readMore')}
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </div>
              </>
            )
            return href ? (
              <a
                key={post.id}
                {...linkProps(href, preview)}
                className={cardClass}
                style={{ borderColor: palette.border, background: palette.surface }}
              >
                {inner}
              </a>
            ) : (
              <div
                key={post.id}
                className={cardClass}
                style={{ borderColor: palette.border, background: palette.surface }}
              >
                {inner}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── Features (highlight cards) ──────────────────────────────────────────────

/** A feature link: a `#section` anchor stays in the page; anything else is an
 *  external URL and opens in a new tab. */
function featureLinkProps(url: string, preview: boolean) {
  // An anchor or a page of this site stays in the tab; anything else is external.
  if (url.startsWith('#') || url.startsWith('/')) return linkProps(url, preview, false)
  return linkProps(url, preview, true)
}

function FeaturesBlock({ section, ctx }: { section: FeaturesSection; ctx: RenderCtx }) {
  const { palette, preview } = ctx
  const items = section.items ?? []
  if (items.length === 0) return null
  const cols = section.columns ?? 3
  // CONTAINER queries, like every other block: the builder preview and an embed
  // iframe are narrower than the viewport, and viewport breakpoints laid the
  // columns out for a screen the section is not in.
  const gridCols =
    cols === 2 ? '@2xl:grid-cols-2' : cols === 4 ? '@2xl:grid-cols-2 @4xl:grid-cols-4' : '@2xl:grid-cols-3'
  const style = section.style ?? 'cards'

  const header = (
    <>
      <Heading text={section.heading} palette={palette} />
      {section.subheading && (
        <p className="mt-3 text-center text-lg" style={{ color: palette.muted }}>
          {section.subheading}
        </p>
      )}
    </>
  )

  // A page link wins over the address; a page that is not published gives none.
  const linkHref = (item: (typeof items)[number]) =>
    item.linkPageId ? ctx.pageHref?.(item.linkPageId) : item.linkUrl
  const link = (item: (typeof items)[number]) =>
    item.linkLabel && linkHref(item) ? (
      <a
        {...featureLinkProps(linkHref(item) as string, preview)}
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium"
        style={{ color: palette.accent }}
      >
        {item.linkLabel}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
    ) : null

  if (style === 'stats') {
    // Big figures, no cards — `title` is the figure, `text` its caption.
    return (
      <section id={section.id} className="py-16" style={{ background: palette.bg }}>
        <div className="mx-auto site-shell px-6">
          {header}
          <div className={`${section.heading || section.subheading ? 'mt-10' : ''} grid grid-cols-2 gap-8 ${cols === 2 ? '' : cols === 4 ? '@3xl:grid-cols-4' : '@3xl:grid-cols-3'}`}>
            {items.map((item, i) => (
              <div key={i} className="text-center">
                <p className="text-4xl font-bold tracking-tight @2xl:text-5xl" style={{ color: palette.text }}>
                  {item.title}
                </p>
                {item.text && (
                  <p className="mt-2 text-sm" style={{ color: palette.muted }}>
                    {item.text}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    )
  }

  if (style === 'checklist') {
    return (
      <section id={section.id} className="py-20" style={{ background: palette.bg }}>
        <div className="mx-auto site-shell px-6">
          {header}
          <ul className={`mt-10 grid grid-cols-1 gap-x-8 gap-y-5 ${gridCols}`}>
            {items.map((item, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                  style={{ background: palette.accent, color: palette.onAccent }}
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                <div>
                  <p className="font-semibold" style={{ color: palette.text }}>
                    {item.title}
                  </p>
                  {item.text && (
                    <p className="mt-1 text-sm" style={{ color: palette.muted }}>
                      {item.text}
                    </p>
                  )}
                  {link(item)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    )
  }

  if (style === 'panels') {
    // Solid panels — the row of statements a performance gym puts under its
    // hero. The studio's BUTTON colour when it chose one (a box that picked
    // black buttons means black blocks, which is the look this style is for),
    // else the page's own ink, so a site that never touched the brand fields
    // still gets a panel that reads on a light or a dark theme. No icon, text
    // left, and the studio's corner choice via `site-card`.
    return (
      <section id={section.id} className="py-20" style={{ background: palette.bg }}>
        <div className="mx-auto site-shell px-6">
          {header}
          <div className={`mt-10 grid grid-cols-1 gap-5 ${gridCols}`}>
            {items.map((item, i) => (
              <div
                key={i}
                className="site-card flex flex-col gap-2 p-8"
                style={{ background: palette.panel, color: palette.onPanel }}
              >
                <h3 className="text-xl font-bold @xl:text-2xl">{item.title}</h3>
                {item.text && (
                  <p className="text-base leading-relaxed" style={{ opacity: 0.85 }}>
                    {item.text}
                  </p>
                )}
                {link(item)}
              </div>
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto site-shell px-6">
        {header}
        <div className={`mt-10 grid grid-cols-1 gap-4 ${gridCols}`}>
          {items.map((item, i) => (
            <div
              key={i}
              className={`site-card-sm flex flex-col overflow-hidden rounded-xl border shadow-sm ${item.imageUrl ? '' : 'p-5'}`}
              style={{ background: palette.surface, borderColor: palette.border }}
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt="" className="aspect-[4/3] w-full object-cover" />
              ) : (
                item.icon && (
                  <span
                    className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ background: `${palette.accent}1a`, color: palette.accent }}
                  >
                    <DynamicIcon name={item.icon} className="h-5 w-5" />
                  </span>
                )
              )}
              <div className={item.imageUrl ? 'flex flex-1 flex-col p-5' : ''}>
                <h3 className="text-base font-semibold" style={{ color: palette.text }}>
                  {item.title}
                </h3>
                {item.text && (
                  <p className="mt-1.5 text-sm" style={{ color: palette.muted }}>
                    {item.text}
                  </p>
                )}
                {link(item)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── CTA banner (one centred card) ───────────────────────────────────────────

function CtaBannerBlock({ section, ctx }: { section: CtaBannerSection; ctx: RenderCtx }) {
  const { palette, slug, locale, preview } = ctx
  const href = shortHref(ctx, ctaHref(section.cta, slug, locale, ctx.pageHref))
  const ctaButton = section.cta?.label ? (
    <a
      {...(ctaIntent(section.cta)
        ? bookProps(href, ctx, ctaIntent(section.cta)!)
        : linkProps(href, preview, section.cta.action === 'url'))}
      className="site-btn inline-flex w-full items-center justify-center gap-2 rounded-full px-8 py-3.5 text-base font-semibold shadow-lg transition-transform hover:scale-[1.02] @xl:w-auto @xl:min-w-[16rem]"
      style={{ background: palette.button, color: palette.onButton }}
    >
      {section.cta.label}
      <ArrowRight className="h-4 w-4" />
    </a>
  ) : null

  if (section.style === 'band') {
    // Edge to edge. Over an image the text is white on a dimmed photo; without
    // one the band is the accent colour and the text its ink.
    const onImage = !!section.bgImageUrl
    const ink = onImage ? '#ffffff' : palette.onAccent
    return (
      <section
        id={section.id}
        className="relative overflow-hidden py-20"
        style={{ background: onImage ? '#000000' : palette.accent }}
      >
        {onImage && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={section.bgImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.45)' }} />
          </>
        )}
        <div className="relative mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight @2xl:text-4xl" style={{ color: ink }}>
            {section.heading}
          </h2>
          {section.text && (
            <p className="mx-auto mt-3 max-w-xl text-lg" style={{ color: ink, opacity: 0.9 }}>
              {section.text}
            </p>
          )}
          {ctaButton && <div className="mt-8">{ctaButton}</div>}
        </div>
      </section>
    )
  }

  return (
    <section id={section.id} className="py-16" style={{ background: palette.bg }}>
      <div className="mx-auto max-w-3xl px-6">
        <div
          className="site-card rounded-2xl border px-6 py-10 text-center shadow-sm @2xl:px-12"
          style={{ background: palette.surface, borderColor: palette.border }}
        >
          <h2 className="text-2xl font-bold tracking-tight @2xl:text-3xl" style={{ color: palette.text }}>
            {section.heading}
          </h2>
          {section.text && (
            <p className="mx-auto mt-3 max-w-xl text-base" style={{ color: palette.muted }}>
              {section.text}
            </p>
          )}
          {ctaButton && <div className="mt-7">{ctaButton}</div>}
        </div>
      </div>
    </section>
  )
}

// ─── FAQ (accordion) ─────────────────────────────────────────────────────────

function FaqBlock({ section, ctx }: { section: FaqSection; ctx: RenderCtx }) {
  const { palette } = ctx
  const items = section.items ?? []
  // The first row opens by default, so the section is never a wall of closed
  // bars a visitor has to probe to know it has content.
  const [open, setOpen] = useState(0)
  if (items.length === 0) return null

  if (section.style === 'panels') {
    // ONE block, not a stack of cards: hard edges, heavy rules between the
    // rows, and the open row filled in the panel colour — the same contrast the
    // panel features carry, so a bold page stays bold at the questions. The
    // corner choice is the studio's own, like everywhere else.
    return (
      <section id={section.id} className="py-20" style={{ background: palette.bg }}>
        <div className="mx-auto max-w-3xl px-6">
          <Heading text={section.heading} palette={palette} />
          <div
            className="site-card mt-10 overflow-hidden border-2"
            style={{ borderColor: palette.panel }}
          >
            {items.map((item, i) => {
              const isOpen = open === i
              return (
                <div
                  key={i}
                  className={i > 0 ? 'border-t-2' : undefined}
                  style={{
                    borderColor: palette.panel,
                    background: isOpen ? palette.panel : 'transparent',
                    color: isOpen ? palette.onPanel : palette.text,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? -1 : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left @xl:px-6 @xl:py-5"
                  >
                    <span className="text-base font-bold @xl:text-lg">{item.question}</span>
                    {isOpen ? (
                      <Minus className="h-5 w-5 shrink-0" />
                    ) : (
                      <Plus className="h-5 w-5 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <p
                      className="whitespace-pre-line px-5 pb-5 text-base leading-relaxed @xl:px-6"
                      style={{ opacity: 0.85 }}
                    >
                      {item.answer}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto max-w-3xl px-6">
        <Heading text={section.heading} palette={palette} />
        <div className="mt-8 space-y-2">
          {items.map((item, i) => {
            const isOpen = open === i
            return (
              <div
                key={i}
                className="overflow-hidden site-card-sm rounded-xl border shadow-sm"
                style={{ background: palette.surface, borderColor: palette.border }}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left"
                >
                  <span className="text-sm font-semibold" style={{ color: palette.text }}>
                    {item.question}
                  </span>
                  {isOpen ? (
                    <Minus className="h-4 w-4 shrink-0" style={{ color: palette.muted }} />
                  ) : (
                    <Plus className="h-4 w-4 shrink-0" style={{ color: palette.muted }} />
                  )}
                </button>
                {isOpen && (
                  <p
                    className="whitespace-pre-line px-4 pb-4 text-sm leading-relaxed"
                    style={{ color: palette.muted }}
                  >
                    {item.answer}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── Testimonials (one card, stepped with chevrons) ──────────────────────────

function TestimonialsBlock({ section, ctx }: { section: TestimonialsSection; ctx: RenderCtx }) {
  const { palette } = ctx
  const items = section.items ?? []
  const [i, setI] = useState(0)
  if (items.length === 0) return null
  const item = items[Math.min(i, items.length - 1)]
  const step = (d: number) => setI((n) => (n + d + items.length) % items.length)
  const many = items.length > 1
  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto max-w-3xl px-6">
        <Heading text={section.heading} palette={palette} />
        <div className="mt-8 flex items-center gap-3">
          {many && (
            <button
              type="button"
              aria-label="Previous"
              onClick={() => step(-1)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-opacity hover:opacity-70"
              style={{ borderColor: palette.border, color: palette.muted }}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <div
            className="flex-1 site-card rounded-2xl border px-6 py-8 text-center shadow-sm"
            style={{ background: palette.surface, borderColor: palette.border }}
          >
            <Quote className="mx-auto h-6 w-6" style={{ color: palette.accent }} />
            <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed" style={{ color: palette.text }}>
              {item.feedback}
            </p>
            <p className="mt-4 text-sm font-semibold" style={{ color: palette.text }}>
              {item.name}
            </p>
            {item.activity && (
              <p className="text-xs" style={{ color: palette.muted }}>
                {item.activity}
              </p>
            )}
          </div>
          {many && (
            <button
              type="button"
              aria-label="Next"
              onClick={() => step(1)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-opacity hover:opacity-70"
              style={{ borderColor: palette.border, color: palette.muted }}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
        </div>
        {many && (
          <div className="mt-4 flex justify-center gap-1.5">
            {items.map((_, n) => (
              <span
                key={n}
                className="h-1.5 w-1.5 rounded-full transition-colors"
                style={{ background: n === i ? palette.accent : palette.border }}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Video (YouTube / Vimeo, inline or lightbox, optional background loop) ────

function VideoBlock({ section, ctx }: { section: VideoSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, preview } = ctx
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // The player address is built HERE from the validated pair — a published site
  // never stores an iframe URL (utils/videoEmbed.ts).
  const film = section.provider && section.videoId ? { provider: section.provider, videoId: section.videoId } : null
  if (!film && !section.bgVideoUrl) return null
  const title = section.heading || t('videoPlayerTitle')

  const player = (autoplay: boolean) =>
    film ? (
      <iframe
        src={videoEmbedSrc(film.provider, film.videoId, { autoplay })}
        title={title}
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
        allowFullScreen
        loading="lazy"
        className="h-full w-full"
      />
    ) : null

  // INLINE: the player sits in the page under the heading.
  if (film && section.display !== 'lightbox') {
    return (
      <section id={section.id} className="py-20" style={{ background: palette.bg }}>
        <div className="mx-auto site-shell px-6">
          <Heading text={section.heading} palette={palette} />
          {section.text && (
            <p className="mx-auto mt-3 max-w-2xl text-center text-lg" style={{ color: palette.muted }}>
              {section.text}
            </p>
          )}
          <div
            className={`site-card ${section.heading || section.text ? 'mt-10' : ''} aspect-video w-full overflow-hidden rounded-2xl border`}
            style={{ borderColor: palette.border, background: '#000000' }}
          >
            {player(false)}
          </div>
        </div>
      </section>
    )
  }

  // LIGHTBOX (or a background loop on its own): a block over the loop / poster,
  // with a play button that opens the film over the page.
  const hasBackdrop = !!section.bgVideoUrl || !!section.posterUrl
  const showLoop = !!section.bgVideoUrl && !reducedMotion
  const ink = hasBackdrop ? '#ffffff' : palette.text
  const mutedInk = hasBackdrop ? 'rgba(255,255,255,0.9)' : palette.muted

  return (
    <section
      id={section.id}
      className="relative flex min-h-[60vh] items-center overflow-hidden"
      style={{ background: hasBackdrop ? '#000000' : palette.surface }}
    >
      {section.posterUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={section.posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
      {showLoop && <LoopVideo src={section.bgVideoUrl!} poster={section.posterUrl} />}
      {hasBackdrop && <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.45)' }} />}
      <div className="relative mx-auto w-full max-w-3xl px-6 py-20 text-center">
        {section.heading && (
          <h2 className="text-3xl font-bold tracking-tight @2xl:text-4xl" style={{ color: ink }}>
            {section.heading}
          </h2>
        )}
        {section.text && (
          <p className="mx-auto mt-4 max-w-2xl text-lg" style={{ color: mutedInk }}>
            {section.text}
          </p>
        )}
        {film && (
          <div className="mt-8">
            <button
              type="button"
              onClick={() => {
                if (!preview) setOpen(true)
              }}
              className="site-btn inline-flex items-center gap-2 rounded-full px-7 py-3 text-base font-semibold shadow-lg transition-transform hover:scale-[1.03]"
              style={{ background: palette.button, color: palette.onButton }}
            >
              <Play className="h-4 w-4" />
              {section.playLabel || t('videoPlay')}
            </button>
          </div>
        )}
      </div>

      {open && film && (
        // Hand-rolled rather than the app Dialog: a portal would render outside
        // .site-root and lose the site's brand variables and container queries.
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          <div className="relative w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('videoClose')}
              className="absolute -top-11 right-0 flex h-9 w-9 items-center justify-center rounded-full text-white transition-opacity hover:opacity-70"
            >
              <X className="h-6 w-6" />
            </button>
            <div className="site-card aspect-video w-full overflow-hidden rounded-2xl bg-black">{player(true)}</div>
          </div>
        </div>
      )}
    </section>
  )
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export function SectionBlock({
  section,
  ctx,
}: {
  section: WebsiteSection | OrgSiteSection
  ctx: RenderCtx
}) {
  switch (section.type) {
    case 'hero':
      return <HeroBlock section={section} ctx={ctx} />
    case 'content':
    case 'about':
      return <ContentBlock section={section} ctx={ctx} />
    case 'gallery':
      return <GalleryBlock section={section} ctx={ctx} />
    case 'activities':
      return <ActivitiesBlock section={section} ctx={ctx} />
    case 'pricing':
      return <PricingBlock section={section} ctx={ctx} />
    case 'schedule':
      return <ScheduleBlock section={section} ctx={ctx} />
    case 'contact':
      return <ContactBlock section={section} ctx={ctx} />
    case 'places':
      return <PlacesBlock section={section} ctx={ctx} />
    case 'features':
      return <FeaturesBlock section={section} ctx={ctx} />
    case 'cta_banner':
      return <CtaBannerBlock section={section} ctx={ctx} />
    case 'faq':
      return <FaqBlock section={section} ctx={ctx} />
    case 'testimonials':
      return <TestimonialsBlock section={section} ctx={ctx} />
    case 'video':
      return <VideoBlock section={section} ctx={ctx} />
    case 'team':
      return <TeamBlock section={section} ctx={ctx} />
    case 'form':
      return <FormBlock section={section} ctx={ctx} />
    case 'posts':
      return <PostsBlock section={section} ctx={ctx} />
    case 'split':
      return <SplitBlock section={section} ctx={ctx} />
    case 'clubs':
      return <ClubsBlock section={section} ctx={ctx} />
    case 'locations':
      return <LocationsBlock section={section} ctx={ctx} />
    case 'coaches':
      return <CoachesBlock section={section} ctx={ctx} />
    default:
      return null
  }
}

/** Nav-menu label for a section: an explicit `menuLabel` wins, then the section
 *  heading — both the studio's own words, returned verbatim — and only the
 *  last-resort type default is ours to translate. Keeps the menu terse while
 *  the on-page title can stay long. */
export function sectionNavLabel(section: WebsiteSection | OrgSiteSection, t: SiteT): string {
  const menuLabel = (section as { menuLabel?: string }).menuLabel?.trim()
  if (menuLabel) return menuLabel
  switch (section.type) {
    case 'content':
    case 'about':
      return section.heading || t('navContent')
    case 'gallery':
      return section.heading || t('navGallery')
    case 'activities':
      return section.heading || t('navActivities')
    case 'pricing':
      return section.heading || t('navPricing')
    case 'schedule':
      return section.heading || t('navSchedule')
    case 'contact':
      return section.heading || t('navContact')
    case 'places':
      return section.heading || t('navLocations')
    case 'features':
      return section.heading || t('navFeatures')
    case 'cta_banner':
      return section.heading || t('navCta')
    case 'faq':
      return section.heading || t('navFaq')
    case 'testimonials':
      return section.heading || t('navTestimonials')
    case 'video':
      return section.heading || t('navVideo')
    case 'team':
      return section.heading || t('navTeam')
    case 'form':
      return section.heading || t('navForm')
    case 'posts':
      return section.heading || t('navPosts')
    case 'split':
      return section.heading || t('navSplit')
    case 'clubs':
      return section.heading || t('navClubs')
    case 'locations':
      return section.heading || t('navLocations')
    case 'coaches':
      return section.heading || t('navCoaches')
    default:
      return ''
  }
}
