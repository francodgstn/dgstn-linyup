'use client'

// "Public pages" hub — the orientation layer for everything customer-facing. It
// keeps the deep management pages where they are and just makes the system
// legible.
//
// THIS FILE OWNS THE CENSUS OF PUBLIC SURFACES. The `surfaces` array below is the
// list; add a surface there and nowhere else. Each row's `action` is also the
// record of WHERE that surface is managed, and those prefixes have nothing in
// common with each other:
//
//   bio-link       → /team/bio-link
//   website        → /plugins/website          (set up via /settings/plugins)
//   shop           → /manage/offer (what the shop sells)
//   space          → /public-page/space
//   booking        → /settings/booking
//   └ appointments → /schedule/availability    (switched on in /settings/booking)
//   kiosk          → /plugins/kiosk            (set up via /settings/plugins)
//   signup         → /offer/plans?tab=subscriptions
//   forms          → /plugins/custom-forms     (set up via /settings/plugins)
//   documents      → /documents
//   events         → /events
//
// APPOINTMENTS HAVE NO ROW HERE, and did not get one back (2026-08-25). They
// were a peer row, then a row nested under Booking, and are now neither:
// `'appointments'` is deliberately not a `PublicSurface` (see types/team.ts) —
// visitors reach the picker through /public/{slug}/booking, so a row of its own
// put a second "booking" in one mental slot however it was indented.
//
// The one thing its row uniquely carried is kept: `appointmentPickerLive`
// composes the studio's toggle with whether anything is actually bookable, so a
// picker can be ON and empty, and that state has no other surface anywhere. It
// is appended to Booking's description instead (UX-28).
//
// That spread is the reason this page exists (UX-28) and the reason it must be
// findable: it is linked from the main nav's Grow section AND the Settings rail,
// under one id (`publicPages` in lib/settings-nav.ts + NAV_SECTIONS). Renaming any
// prefix above is off the table — these URLs are in bookmarks, bio-links and
// printed QR codes.
//
// It RENDERS inside the settings shell (see ./layout.tsx) — it is a settings
// section, and was the only one that read as a bare full page (UX-61).
//
// Layout is hero + list:
//
//  • Hero — the one thing every studio owner comes here for: their public link
//    (copy/open) and which surface visitors land on. This is the page's anchor.
//  • Surface list — every public surface as a compact row (icon · title · desc ·
//    preview · single CTA). Live surfaces read full-strength with a "Live" marker
//    and sort first; not-yet-set-up ones are dimmed and sink below. Rows
//    beat a card grid here because the page is a directory: hierarchy (link
//    first, live channels next, untapped ones quietly available) matters more
//    than symmetry.
//
// Surface availability comes from usePublicSurfaces. Richer per-surface content
// (Shop channels, Space content) lives on the surface's own detail page.

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { usePublicSurfaces } from '@/hooks/usePublicSurfaces'
import { useAuth } from '@/contexts/AuthContext'
import { QRDialog } from '@/components/layout/QRDialog'
import { PUBLIC_PAGE_QR_PARAM } from '@/lib/onboarding'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import type { PublicSurface } from '@linyup/shared'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Globe, Monitor, MonitorCheck, ShoppingBag, GraduationCap, CalendarCheck,
  UserPlus, ClipboardList, FileText, CalendarRange, ExternalLink, Copy, Check, Plus, Settings2,
} from 'lucide-react'
import { Tip } from '@/components/ui/tip'
import { CustomDomainCard } from './CustomDomainCard'
import { useCustomDomain } from '@/hooks/useCustomDomain'

// Plugin a surface needs; clicking "Set up" deep-links the plugins page, whose
// modal handles the included / add-on / upgrade flow for the current plan.
function pluginSetupHref(pluginId: string): Route {
  return `/settings/plugins?plugin=${pluginId}` as Route
}

function ManageLink({ href, label }: { href: Route; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
    >
      <Settings2 className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </Link>
  )
}

function SetupLink({ href, label }: { href: Route; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
    >
      <Plus className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </Link>
  )
}

// One public surface = one compact row. Live rows read full-strength with a
// "Live" marker; not-live rows dim so the eye lands on what's actually public.
function SurfaceRow({
  icon: Icon, title, desc, live, previewUrl, action, t,
}: {
  icon: React.ElementType
  title: string
  desc: string
  live: boolean
  previewUrl: string | null
  action: React.ReactNode
  t: (k: string) => string
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/40 sm:px-4 ${
        live ? '' : 'opacity-65'
      }`}
    >
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
          live ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
        }`}
      >
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium leading-tight">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground leading-snug">{desc}</p>
      </div>
      {live && (
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] font-medium text-emerald-600 sm:inline-flex dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {t('statusLive')}
        </span>
      )}
      {previewUrl && (
        <Tip label={t('preview')}>
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('preview')}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Tip>
      )}
      <div className="shrink-0">{action}</div>
    </div>
  )
}

// What one row draws. Flat: the appointments child was the only nesting this
// ever had, and it was dropped with it — a `child` nobody sets is a mechanism
// the next reader has to understand before discovering it is unused.
type SurfaceRowDef = {
  icon: React.ElementType
  title: string
  desc: string
  live: boolean
  previewUrl: string | null
  action: React.ReactNode
}

type SurfaceDef = SurfaceRowDef & {
  key: string
}

export default function PublicPageHub() {
  const t = useTranslations('PublicHub')
  const { slug, publicUrl, defaultSurface, setDefaultSurface, flags } = usePublicSurfaces()
  const { team } = useAuth()
  // Same query key as the card below, so TanStack dedupes this to one read.
  // The hero exists to answer "what is my public address" — once a studio has
  // connected their own domain, answering with the linyup.com path would be
  // stale the moment it mattered most.
  const { data: customDomain } = useCustomDomain('team', team?.id ?? null)
  const liveDomain = customDomain?.status === 'active' ? customDomain.hostname : null

  const [copied, setCopied] = useState(false)
  const [pendingDefault, setPendingDefault] = useState<PublicSurface | null>(null)

  // ?qr=1 — arrive with the QR dialog already open. Same convention as the
  // `?new=1` quick actions (see lib/quickActions.ts): the param is read ONCE, in
  // a lazy initializer, and opens a dialog that already lives somewhere else. It
  // is a distinct param because this opens a viewer, not a create form.
  //
  // This hub is where the codes belong: they point at the public surfaces this
  // page is the census of. The setup checklist's "view all your QR codes" step
  // is the caller.
  const qrParams = useSearchParams()
  const [qrOpen, setQrOpen] = useState(() => qrParams.get(PUBLIC_PAGE_QR_PARAM) === '1')

  const homeUrl = publicUrl('')

  // Surfaces eligible to be the default landing: every available page that has a
  // single landing URL. Base surfaces (bio-link, booking, signup) are always
  // offered; plugin/content surfaces appear once live. Forms are excluded — they
  // have no index page to land on (only per-form URLs). Mirrors the surface list
  // order below.
  const defaultOptions: { value: PublicSurface; label: string }[] = [
    { value: 'bio-link', label: t('surfaceBioLink') },
    ...(flags.siteLive ? [{ value: 'site' as const, label: t('surfaceWebsite') }] : []),
    ...(flags.shopLive ? [{ value: 'shop' as const, label: t('surfaceShop') }] : []),
    ...(flags.spaceLive ? [{ value: 'space' as const, label: t('surfaceSpace') }] : []),
    { value: 'booking', label: t('surfaceBooking') },
    { value: 'signup', label: t('surfaceSignup') },
    ...(flags.documentsLive ? [{ value: 'documents' as const, label: t('surfaceDocuments') }] : []),
    ...(flags.eventsLive ? [{ value: 'events' as const, label: t('surfaceEvents') }] : []),
  ]
  const currentDefault = pendingDefault ?? defaultSurface

  async function copyUrl() {
    if (!homeUrl) return
    try {
      await navigator.clipboard.writeText(homeUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  async function onDefaultChange(surface: PublicSurface) {
    setPendingDefault(surface)
    await setDefaultSurface(surface)
  }

  // Every public surface, in one list. Landing surfaces first (they're what a
  // visitor can be dropped on at /public/{slug}), then the standalone pages.
  // Shop and Space route to their own detail pages; the rest link straight to
  // their existing editors. The list is re-sorted live-first at render.
  const surfaces: SurfaceDef[] = [
    {
      key: 'bio-link', icon: Globe, title: t('surfaceBioLink'), desc: t('bioLinkDesc'),
      live: true, previewUrl: homeUrl,
      action: <ManageLink href={'/team/bio-link' as Route} label={t('manage')} />,
    },
    {
      key: 'website', icon: Monitor, title: t('surfaceWebsite'), desc: t('websiteDesc'),
      live: flags.siteLive, previewUrl: publicUrl('site'),
      action: flags.websiteActive
        ? <ManageLink href={'/plugins/website' as Route} label={t('manage')} />
        : <SetupLink href={pluginSetupHref('website')} label={t('setUp')} />,
    },
    {
      // The shop is always publishable, but it is TWO pages: a self-checkout
      // where the studio can be paid, and a read-only price list where it
      // cannot (visitors are told to get in touch). Say which one this studio
      // has — the difference is invisible from here otherwise, and a studio
      // that thinks it has a storefront would find out from a customer.
      key: 'shop', icon: ShoppingBag, title: t('surfaceShop'),
      desc: flags.paymentsEnabled ? t('shopDesc') : t('shopDescPriceList'),
      live: flags.shopLive, previewUrl: publicUrl('shop'),
      // Manage a shop = manage what it sells. There was a /public-page/shop
      // settings page here until 2026-09-01; it wrote nothing and only signposted
      // /offer/* and the payment settings, so this row (live dot, preview, and
      // the price-list distinction above) replaced it outright.
      action: <ManageLink href={'/manage/offer' as Route} label={t('manage')} />,
    },
    {
      key: 'space', icon: GraduationCap, title: t('surfaceSpace'), desc: t('spaceDesc'),
      live: flags.spaceLive, previewUrl: publicUrl('space'),
      action: <ManageLink href={'/public-page/space' as Route} label={t('manage')} />,
    },
    {
      key: 'booking', icon: CalendarCheck, title: t('surfaceBooking'),
      // APPOINTMENTS HAVE NO ROW OF THEIR OWN (2026-08-25). They are reached
      // through booking, and `'appointments'` was never a `PublicSurface` — a
      // deep-link destination, not a front door — so a peer row put a second
      // "booking" in the reader's head for one concept.
      //
      // ONE SIGNAL SURVIVED THE DELETION, deliberately: the picker can be
      // switched ON and still return nothing, because a window with no
      // appointment activity behind it yields no slots. That state has no other
      // surface anywhere, so it is appended to this row's description rather
      // than lost with the row that used to carry it (UX-28).
      desc:
        flags.appointmentsEnabled && !flags.appointmentsLive
          ? `${t('bookingDesc')} ${t('appointmentsEmpty')}`
          : t('bookingDesc'),
      live: flags.bookingLive, previewUrl: publicUrl('booking'),
      action: <ManageLink href={'/settings/booking' as Route} label={t('manage')} />,
    },
    {
      key: 'kiosk', icon: MonitorCheck, title: t('surfaceKiosk'), desc: t('kioskDesc'),
      live: flags.kioskActive, previewUrl: publicUrl('kiosk'),
      action: flags.kioskActive
        ? <ManageLink href={'/plugins/kiosk' as Route} label={t('manage')} />
        : <SetupLink href={pluginSetupHref('kiosk')} label={t('setUp')} />,
    },
    {
      key: 'signup', icon: UserPlus, title: t('surfaceSignup'), desc: t('signupDesc'),
      live: true, previewUrl: publicUrl('signup'),
      // Straight to the tab, not through the /offer/subscriptions redirect stub —
      // the stub exists for links already in the world, not for the app's own.
      action: <ManageLink href={'/offer/plans?tab=subscriptions' as Route} label={t('manage')} />,
    },
    {
      key: 'forms', icon: ClipboardList, title: t('surfaceForms'), desc: t('formsDesc'),
      live: flags.formsLive, previewUrl: null,
      action: flags.formsActive
        ? <ManageLink href={'/plugins/custom-forms' as Route} label={t('manage')} />
        : <SetupLink href={pluginSetupHref('custom-forms')} label={t('setUp')} />,
    },
    {
      // Always "Manage": Documents is a default feature, so there is nothing to
      // set up — the surface is dark only until the studio publishes and shares
      // a document, which is what the Manage link takes them to.
      key: 'documents', icon: FileText, title: t('surfaceDocuments'), desc: t('documentsDesc'),
      live: flags.documentsLive, previewUrl: publicUrl('documents'),
      action: <ManageLink href={'/documents' as Route} label={t('manage')} />,
    },
    {
      // Always "Manage" for the same reason as Documents: events are a default
      // feature on every plan, and the surface is dark only until the studio
      // publishes one — events are PRIVATE by default. Manage goes to the
      // calendar, which is where events are created and published from.
      key: 'events', icon: CalendarRange, title: t('surfaceEvents'), desc: t('eventsDesc'),
      live: flags.eventsLive, previewUrl: publicUrl('events'),
      action: <ManageLink href={'/schedule' as Route} label={t('manage')} />,
    },
  ]

  // Live-first, preserving the defined order within each group. Stable sort keeps
  // landing surfaces ahead of standalone pages inside each half. PARENTS ONLY: a
  // child rides on its parent and is never sorted on its own live state, or a
  // dark Appointments row would detach from the Booking row it is a mode of.
  const orderedSurfaces = [...surfaces].sort((a, b) => Number(b.live) - Number(a.live))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Hero — public link + default landing */}
      <Card className="p-4 md:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Globe className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('yourPublicUrl')}</p>
              {homeUrl ? (
                <div className="mt-1 flex items-center gap-2">
                  <code className="truncate rounded bg-muted px-2 py-1 text-sm font-medium">
                    {liveDomain ?? `/public/${slug}`}
                  </code>
                  <Tip label={t('copy')}>
                    <button
                      type="button"
                      onClick={copyUrl}
                      aria-label={t('copy')}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </Tip>
                  <Tip label={t('open')}>
                    <a
                      href={homeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('open')}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Tip>
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">{t('noSlug')}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 md:border-l md:pl-5">
            <span className="text-xs font-medium text-muted-foreground">{t('defaultLanding')}</span>
            <Select value={currentDefault} onValueChange={(v) => { if (v) onDefaultChange(v) }}>
              <SelectTrigger className="w-[150px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {defaultOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('defaultLandingHint')}</p>
      </Card>

      {/* Their own domain — directly under the link it replaces. This is a
          property of the PAGES, which is why it lives here and not beside the
          email sender it was originally filed next to. */}
      {team?.id && (
        <Card className="p-4 md:p-5">
          <CustomDomainCard scope="team" entityId={team.id} plan={team.plan} slug={slug ?? undefined} />
        </Card>
      )}

      {/* Surface list — one row per public surface, live-first. */}
      <Card className="gap-0 py-0">
        <div className="divide-y divide-border">
          {orderedSurfaces.map((s) => (
            <div key={s.key}>
              <SurfaceRow
                icon={s.icon}
                title={s.title}
                desc={s.desc}
                live={s.live}
                previewUrl={s.previewUrl}
                action={s.action}
                t={t}
              />
            </div>
          ))}
        </div>
      </Card>

      {/* The studio's QR codes, opened by ?qr=1. The dialog is the same one the
          shell's QR button mounts — it owns the target picker and the download,
          and nothing about it is duplicated here. */}
      <QRDialog open={qrOpen} onClose={() => setQrOpen(false)} team={team} />
    </div>
  )
}
