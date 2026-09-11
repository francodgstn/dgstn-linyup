'use client'

// Space Home = the contact's PERSONAL portal, not a course catalogue. It surfaces
// the signed-in contact's own data — membership (subscriptions + affiliation),
// the courses they can actually open, and shortcuts to their bookings/profile.
//
// Course DISCOVERY + buying lives in the shop (/public/{slug}/shop): the catalogue
// with locked/priced cards belongs there. Here we only ever show "My courses" —
// entitlements the contact already has — linking straight to the player. Anonymous
// visitors get a sign-in wall (this is a "my account" area), so free-course
// discovery also flows through the shop.
//
// THE ORDER OF THE PAGE IS THE POINT (UX-38 / UX-55). It opens with WHAT'S NEXT
// — her next booking — because that is the question a member opens a portal to
// answer. Everything that SELLS her something comes after everything that
// SERVES her. Before this, home led with her own name, then a membership block
// duplicated from Account, and offered four separate links into the shop and
// none into booking.
//
// FOUR BLOCKS WERE DUPLICATES AND ARE GONE:
//   1. the welcome card (name only) — the shell header already names her; the
//      greeting now rides on the next-up card;
//   2. the membership section — a second, DIVERGENT copy of Account's (it never
//      learned to say a membership is cancelling). One component now, two
//      variants, per `SpaceWaiverCard`;
//   3. the quick-links grid (Bookings / Account) — the portal nav directly above
//      it is those same links;
//   4. the shop's "subscriptions" row when the membership block was already
//      showing a "choose a plan" CTA to the same URL on the same screen.

import { useEffect, useState, type CSSProperties } from 'react'
import { collectionGroup, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { GraduationCap, CreditCard, ChevronRight, ShoppingBag, Ticket, CalendarDays } from 'lucide-react'
import { resolvePaymentOptions, heldSubscriptionTypeIds, type CourseAccessRule } from '@linyup/shared'
import { clientPaymentSnapshot } from '@/lib/paymentSnapshot'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { SpaceWaiverCard } from './SpaceWaiverCard'
import { SpaceMembershipCard } from './SpaceMembershipCard'
import { SpaceNextUpCard } from './SpaceNextUpCard'
import SpaceSignInWall from './SpaceSignInWall'
import { useSpaceAuth } from './SpaceAuthProvider'
import { useSpaceTheme } from './useSpaceTheme'
import { useSpaceContact } from './useSpaceContact'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicEvents } from '@/components/events/program/usePublicEvents'
import { usePublicFormat } from '../usePublicFormat'

// ─── Public course card data (from public_profile subcollection) ───────────────

export interface PublicCourseCard {
  id: string
  slug: string
  title: string
  summary?: string
  coverImageUrl?: string
  accessType: 'free' | 'registered' | 'subscription' | 'purchase'
  subscriptionTypeIds?: string[]
  priceAmount?: number // 'purchase' tier: one-off price (major units)
  hideFromShop?: boolean
  moduleCount?: number
  lessonCount?: number
  order?: number
}

// ─── Access check helper ──────────────────────────────────────────────────────
// Same resolver (@linyup/shared) the shop + Firestore rules' access story is built
// on; here it filters the catalogue down to the courses this contact may open
// (their "My courses" library). Only ever called for a signed-in contact (Space
// is sign-in gated — see the early return below). Unlike the shop's optimistic
// snapshot, Space has the contact's FULL held union (active_subscriptions +
// credit_summary via `heldSubscriptionTypeIds`, not just the primary
// `subscription_type_id`) — deliberately widens "included by subscription" to
// every held type, not just the primary one (P6, approved — pricing/display only).

function hasAccess(
  card: PublicCourseCard,
  heldSubscriptionTypeIds: string[],
  purchasedCourseIds?: Set<string>
): boolean {
  const rule: CourseAccessRule = {
    type: card.accessType,
    subscriptionTypeIds: card.subscriptionTypeIds,
    priceAmount: card.priceAmount,
  }
  const snapshot = clientPaymentSnapshot({
    authenticated: true,
    heldSubscriptionTypeIds,
    ownsCourse: purchasedCourseIds?.has(card.id),
  })
  // COVERED options only — a priced course always yields a `pay` option for
  // any signed-in contact, and "you could buy this" is not an entitlement
  // (this section shows the contact's library, never a catalogue).
  return resolvePaymentOptions(snapshot, { kind: 'course', accessRule: rule }).options.some(
    (o) => o.type === 'covered'
  )
}

// ─── One entry in "My courses" ────────────────────────────────────────────────
// Extracted because the section renders the grid from two branches: the normal
// one, and the degraded one where a query failed and we show the error state
// above whatever entitlements we could still resolve.

function CourseCard({
  course,
  slug,
  cardStyle,
}: {
  course: PublicCourseCard
  slug: string
  cardStyle: CSSProperties
}) {
  const t = useTranslations('Space')
  const { textMain, textMuted } = useSpaceTheme()
  return (
    <Link
      href={`/public/${slug}/space/courses/${course.slug}` as Route}
      className="rounded-xl overflow-hidden transition-all hover:scale-[1.015] hover:shadow-lg"
      style={cardStyle}
    >
      <div className="aspect-video bg-muted/30 flex items-center justify-center overflow-hidden">
        {course.coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={course.coverImageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <GraduationCap className="h-8 w-8" style={{ color: textMuted }} />
        )}
      </div>
      <div className="p-3">
        <p className="font-semibold text-sm leading-snug" style={{ color: textMain }}>
          {course.title}
        </p>
        <p className="text-xs mt-1" style={{ color: textMuted }}>
          {t('lessonCount', { count: course.lessonCount ?? 0 })}
        </p>
      </div>
    </Link>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SpaceHome() {
  const t = useTranslations('Space')
  const tEvents = useTranslations('EventProgram')
  const { slug, teamId, isAuthenticated, contact } = useSpaceAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const { team } = usePublicTeam()
  const {
    data: fullContact,
    isError: contactFailed,
    error: contactError,
    refetch: refetchContact,
  } = useSpaceContact()
  const [courses, setCourses] = useState<PublicCourseCard[]>([])
  const [purchasedCourseIds, setPurchasedCourseIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  // ONE SLOT PER QUERY, deliberately. Any of these failing makes the library
  // WRONG rather than empty — a 403 on the entitlements query hides exactly the
  // courses the contact paid for — but they fail and recover independently, so a
  // shared slot would let whichever one succeeded LAST erase a live error (and,
  // conversely, pin a stale one over correct data). Each effect owns its slot and
  // clears it on its own success; the section below reads the union.
  const [courseListError, setCourseListError] = useState<unknown>(null)
  const [entitlementsError, setEntitlementsError] = useState<unknown>(null)
  const [retryKey, setRetryKey] = useState(0)

  // Upcoming published events — the studio's own plus its parent org's. Read
  // from the same world-readable mirrors the public events page uses. NOT
  // filtered to the events this contact RSVP'd to: the attendees subcollection
  // is not readable by a contact session, so personalising it needs a callable.
  const { events: upcomingEvents } = usePublicEvents(teamId, team?.org_id ?? null, { limit: 3 })

  // Load published courses (only needed once signed in — to compute "My courses").
  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    let cancelled = false
    const q = query(
      collectionGroup(db, 'public_profile'),
      where('type', '==', 'course'),
      where('teamId', '==', teamId)
    )
    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        const cards = snap.docs.map((d) => ({
          id: d.ref.parent.parent?.id ?? d.id,
          ...(d.data() as Omit<PublicCourseCard, 'id'>),
        }))
        cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        setCourses(cards)
        // Clear where the success is stored: a transient failure must not leave a
        // banner sitting over data that has since loaded correctly.
        setCourseListError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        reportPublicLoadFailure('space/courses', err)
        setCourseListError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, teamId, retryKey])

  // Which 'purchase'-tier courses this contact has bought (lifetime entitlements).
  // Authorised by the {path=**}/purchases collection-group block in
  // firestore.rules — which is scoped by BOTH `where` clauses below, so neither
  // may be dropped without the whole query being refused.
  useEffect(() => {
    if (!isAuthenticated || !contact?.id) {
      setPurchasedCourseIds(new Set())
      setEntitlementsError(null)
      return
    }
    let cancelled = false
    const q = query(
      collectionGroup(db, 'purchases'),
      where('contactId', '==', contact.id),
      where('teamId', '==', teamId)
    )
    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        setPurchasedCourseIds(
          new Set(snap.docs.map((d) => (d.data().courseId as string | undefined) ?? d.id))
        )
        setEntitlementsError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        reportPublicLoadFailure('space/purchases', err)
        setEntitlementsError(err)
      })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, contact?.id, teamId, retryKey])

  // The contact doc decides which subscription-tier courses are open, so its
  // failure belongs in the library's error slot too — not only in the membership
  // block above it. Only where it can actually hide something, though: against a
  // course list that loaded and came back empty there is nothing to hide, and
  // claiming otherwise would be its own false alarm.
  const membershipError = contactFailed ? contactError : null
  const coursesError =
    courseListError ?? entitlementsError ?? (courses.length > 0 ? membershipError : null)

  function retryCourses() {
    setCourseListError(null)
    setEntitlementsError(null)
    setLoading(true)
    setRetryKey((k) => k + 1)
    void refetchContact()
  }

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }
  // The Space is painted from the STUDIO's bio-link theme, so the error block has
  // to be too — app tokens render it near-black on a dark studio theme.
  const errorTheme = { textMain, textMuted, accent, border: cardBorder }

  // Anonymous → sign-in wall. Space is a personal area; discovery lives in the
  // shop. The wall knows the difference between "not signed in" and "not known
  // yet" — see SpaceSignInWall.
  if (!isAuthenticated || !contact) {
    return <SpaceSignInWall prompt={t('accountSignInPrompt')} />
  }

  // ── My courses = accessible entitlements only (no locked/buy cards here) ──
  // Full held union when the fuller contact doc has loaded (active_subscriptions
  // + credit_summary), falling back to just the session's primary
  // subscription_type_id until it does.
  const heldTypeIds = heldSubscriptionTypeIds(fullContact ?? { subscription_type_id: contact.subscription_type_id })
  const myCourses = courses.filter((c) => hasAccess(c, heldTypeIds, purchasedCourseIds))

  // ── Shop quick links — the studio's sellable channels, deep-linked to the right
  // shop tab. Gated by the SAME world-readable signals the shop reads (the private
  // installed_plugins are unreadable here), so a channel appears only when it's
  // actually on: subscription types / products denormalized onto public_profile,
  // and purchase-tier courses. ──
  const profile = team as typeof team & {
    aggregator_subscription_types?: unknown[]
    products?: unknown[]
  }
  const hasSubscriptions =
    Array.isArray(profile.aggregator_subscription_types) && profile.aggregator_subscription_types.length > 0
  const hasProducts = Array.isArray(profile.products) && profile.products.length > 0
  // The shop is the courses' home and lists every tier, so link to it whenever the
  // studio has any shop-visible course (not just purchasable ones).
  const hasShopCourses = courses.some((c) => c.hideFromShop !== true)
  // A contact with a live plan is here to CHANGE it, not to start one. Without a
  // plan the membership block above is already offering exactly this URL, and
  // two links to one page on one screen is the duplication UX-55 counted.
  const hasActiveSubscription =
    (fullContact?.active_subscriptions?.length ?? 0) > 0 || !!fullContact?.subscription_type_id
  const shopLinks = [
    hasSubscriptions && hasActiveSubscription && {
      key: 'subscriptions',
      label: t('changeSubscription'),
      icon: CreditCard,
      href: `/public/${slug}/shop?tab=subscriptions`,
    },
    hasProducts && {
      key: 'products',
      label: t('shopProducts'),
      icon: ShoppingBag,
      href: `/public/${slug}/shop?tab=products`,
    },
    hasShopCourses && {
      key: 'courses',
      label: t('shopCourses'),
      icon: GraduationCap,
      href: `/public/${slug}/shop?tab=courses`,
    },
  ].filter(Boolean) as { key: string; label: string; icon: typeof CreditCard; href: string }[]

  return (
    <div className="mt-6 space-y-4">
      {/* WHAT'S NEXT — first, above everything, and carrying the greeting the
          standalone welcome card used to carry on its own. */}
      <SpaceNextUpCard bookingLive={team?.active_public_surfaces?.booking === true} />

      {/* Complete-signup reminder — PROMINENT when a paid 'full'-mode purchase left
          the registration unfinished (pending_signup), light for self-registered
          minimal contacts (shop/form entry). Studio-toggleable in Space settings
          (mirrored to public_profile as space_signup_nudge). The signup page skips
          the OTP for signed-in contacts, so the CTA is one step. */}
      {(team as { space_signup_nudge?: boolean } | null)?.space_signup_nudge !== false &&
        fullContact &&
        !fullContact.signup_completed_at &&
        (fullContact.pending_signup === true ? (
          <div className="rounded-2xl p-4" style={{ background: accent, color: '#fff' }}>
            <p className="text-sm font-semibold">{t('signupNudgeTitle')}</p>
            <p className="mt-1 text-xs opacity-90">{t('signupNudgeBody')}</p>
            <Link
              href={`/public/${slug}/signup?from=checkout` as Route}
              className="mt-3 inline-block rounded-full bg-white px-4 py-1.5 text-xs font-semibold"
              style={{ color: accent }}
            >
              {t('signupNudgeCta')} →
            </Link>
          </div>
        ) : fullContact.entry === 'shop' || fullContact.entry === 'form' ? (
          <div
            className="flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm"
            style={cardStyle}
          >
            <span style={{ color: textMuted }}>{t('signupNudgeLight')}</span>
            <Link
              href={`/public/${slug}/signup?from=checkout` as Route}
              className="shrink-0 text-xs font-medium hover:underline"
              style={{ color: accent }}
            >
              {t('signupNudgeCta')} →
            </Link>
          </div>
        ) : null)}

      {/* A superseded or missing signature, surfaced to a member who is NOT
          currently booking — which is the only way a `require_resign` publish
          reaches somebody before it refuses them mid-flow. Renders nothing when
          everything is in order. */}
      <SpaceWaiverCard variant="banner" />

      {/* Membership — ONE implementation, shared with Account (see
          SpaceMembershipCard). The copy this replaced had already fallen behind
          Account's: it never said a membership was cancelling. */}
      <SpaceMembershipCard variant="summary" slug={slug} hasSubscriptionsForSale={hasSubscriptions} />

      {/* Lesson credits — compact list of credit-pack balances (denormalised
          Contact.credit_summary). Hidden entirely when the contact holds none —
          but NOT when the contact read FAILED. `credit_summary` lives on the doc
          that just refused to load, so the gate below cannot tell "no credits"
          from "no answer", and the whole section disappearing off the page is
          read by a member as the first one: lessons they paid for, gone. Absence
          because we could not look is not absence in fact.
          The sentence rather than a second QueryErrorState, for the same reason
          as AccountHome's profile card: this IS the membership block's failure,
          one section above, and that block already carries the Retry. */}
      {(membershipError != null || (fullContact?.credit_summary?.length ?? 0) > 0) && (
        <section className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <Ticket className="h-4 w-4" style={{ color: accent }} />
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
              {t('creditsTitle')}
            </h2>
          </div>
          {membershipError != null ? (
            <p role="alert" className="text-sm" style={{ color: textMuted }}>
              {t('creditsUnknown')}
            </p>
          ) : (
            <div className="space-y-2">
              {fullContact!.credit_summary!.map((entry) => (
                <div key={entry.subscription_type_id} className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium" style={{ color: textMain }}>
                    {entry.subscription_type_name ?? t('membershipActive')}
                  </span>
                  <span className="text-sm" style={{ color: textMuted }}>
                    {t('creditsRemaining', { count: entry.remaining })}
                    {entry.next_expires_at && (
                      <>
                        {' '}
                        · {t('creditsExpiresOn', { date: fmt.date(entry.next_expires_at) })}
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* My courses — accessible entitlements only; discovery/buying is in the shop.
          Hidden entirely when the studio publishes no courses — but NOT when a
          query failed, because "no courses" would then be a claim we cannot make. */}
      {(loading || courses.length > 0 || coursesError != null) && (
        <section className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <GraduationCap className="h-4 w-4" style={{ color: accent }} />
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
              {t('myCourses')}
            </h2>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div
                className="h-6 w-6 rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: accent, borderTopColor: 'transparent' }}
              />
            </div>
          ) : coursesError != null ? (
            // A failure never renders as an empty library. Anything that DID
            // resolve still shows below it — the list is incomplete, not absent.
            <>
              <QueryErrorState
                onRetry={retryCourses}
                title={t('coursesLoadFailed')}
                detail={loadFailureDetail(coursesError)}
                theme={errorTheme}
              />
              {myCourses.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {myCourses.map((course) => (
                    <CourseCard key={course.id} course={course} slug={slug} cardStyle={cardStyle} />
                  ))}
                </div>
              )}
            </>
          ) : myCourses.length === 0 ? (
            <p className="text-sm py-4" style={{ color: textMuted }}>{t('noAccessibleCourses')}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {myCourses.map((course) => (
                <CourseCard key={course.id} course={course} slug={slug} cardStyle={cardStyle} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Upcoming events — read-only teaser; the full list lives on the public
          events page, and each card links straight to its programme. */}
      {upcomingEvents.length > 0 && (
        <section className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4" style={{ color: accent }} />
              <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
                {tEvents('spaceEventsTitle')}
              </h2>
            </div>
            <Link
              href={`/public/${slug}/events` as Route}
              className="text-xs underline underline-offset-2"
              style={{ color: textMuted }}
            >
              {tEvents('spaceEventsAll')}
            </Link>
          </div>
          <div className="grid gap-2">
            {upcomingEvents.map((ev) => {
              const start = (ev.start as unknown as { toDate?: () => Date } | null)?.toDate?.()
              return (
                <Link
                  key={ev.id}
                  href={`/public/${slug}/events/${ev.id}` as Route}
                  className="flex items-center gap-2 rounded-xl px-3 py-2.5 transition-opacity hover:opacity-80"
                  style={{ background: `${accent}14`, color: textMain }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{ev.title}</p>
                    {start && (
                      <p className="text-xs" style={{ color: textMuted }}>
                        {fmt.dayMonthLong(start)}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4" style={{ color: textMuted }} />
                </Link>
              )
            })}
          </div>
        </section>
      )}

      {/* Shop — the studio's sellable channels, deep-linked to the right shop tab */}
      {shopLinks.length > 0 && (
        <section className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <ShoppingBag className="h-4 w-4" style={{ color: accent }} />
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
              {t('shopTitle')}
            </h2>
          </div>
          <div className="grid gap-2">
            {shopLinks.map((l) => {
              const Icon = l.icon
              return (
                <Link
                  key={l.key}
                  href={l.href as Route}
                  className="flex items-center gap-2 rounded-xl px-3 py-2.5 transition-opacity hover:opacity-80"
                  style={{ background: `${accent}14`, color: textMain }}
                >
                  <Icon className="h-4 w-4" style={{ color: accent }} />
                  <span className="flex-1 text-sm font-medium">{l.label}</span>
                  <ChevronRight className="h-4 w-4" style={{ color: textMuted }} />
                </Link>
              )
            })}
          </div>
        </section>
      )}

      {/* NO quick-links grid here. It listed "My bookings" and "Account" —
          the two tabs the portal nav renders a few pixels above it, on every
          page of the portal. A second copy of a navigation control is not a
          shortcut; it is the same control twice. */}

      {/* Branding */}
      {team?.showBranding === true && (
        <p className="pt-6 text-center text-[11px]" style={{ color: textMuted }}>
          {t('poweredBy')}{' '}
          <Link href={'/' as Route} className="hover:underline font-medium" style={{ color: textMuted }}>
            Linyup
          </Link>
        </p>
      )}
    </div>
  )
}
