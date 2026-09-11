'use client'

// Public self-checkout ("shop"): lists what a studio sells — memberships (public
// subscription types), products (merch/equipment) AND online courses (one-off
// purchase) — and lets a member pay via Stripe Connect.
//
// …OR, for a studio whose Connect account cannot be charged, THE SAME PAGE AS A
// READ-ONLY PRICE LIST: the shelves, the prices, and no way to pay. UX-33
// removed the buy buttons by removing the whole surface, which also removed the
// only public place a visitor could see what a membership costs; a studio that
// takes cash at the desk is a normal business, not a broken one. `priceListMode`
// below is the switch, and the rule it enforces is that NOTHING MAY LOOK
// PAYABLE — a control that cannot complete is not rendered at all, never
// rendered disabled. (The server never depended on any of this:
// `requireChargeableAccount` refuses every checkout callable regardless.)
//
// Branded with the team's bio-link palette.
//
// Login-first: a purchase runs as a verified contact of the team,
// because what it grants (membership fields, a course entitlement, credits) has to
// attach to a person. Gift cards are the exception — the entitlement is a code, so a
// guest buys with nothing but an address. The surfaces are separated behind a tab
// toggle so they never visually mix.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collectionGroup, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { useTranslations, useLocale } from 'next-intl'
import { toast } from 'sonner'
import { ShoppingBag, GraduationCap, Gift, Loader2, X, Play, Lock, LogIn } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { db, functions } from '@/lib/firebase'
import { resolveBackground, getTextColor } from '@/lib/bioLink'
import { formatCurrency } from '@/lib/format'
import {
  resolveProductPrice,
  resolveProductCollectionNote,
  compareActivities,
  resolveDurationSale,
  resolvePaymentOptions,
  planGiftCardRedemption,
  type CheckoutContactMode,
  type ActivityAccessRule,
  type ActivityDurationBenefit,
  type ActivityMemberBenefit,
  type Benefit,
  type CourseAccessRule,
  COURSE_PURCHASES_SUBCOLLECTION,
  PUBLIC_PROFILE_SUBCOLLECTION,
  TEAMS_COLLECTION,
} from '@linyup/shared'
import { clientPaymentSnapshot } from '@/lib/paymentSnapshot'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { publicHref, publicSubHref } from '@/lib/publicRoutes'
import { resolveActivityTerms, type ActivityTerm } from '@/lib/activityTerms'
import { usePublicTeam } from '../PublicTeamProvider'
import PriceListNotice from './PriceListNotice'
import { usePublicContactAuth } from '../PublicContactAuthProvider'
import { PublicStudioTermsLink } from '../PublicStudioTermsLink'
import { DEFAULT_ACCENT } from '@/lib/colors'
import {
  PromoCodeField,
  priceChangedAmount,
  priceChangedMessage,
  promoCheckoutErrorMessage,
  useAcceptedPrice,
  type AppliedPromo,
} from '@/components/booking/PromoCodeField'
import {
  GiftCardRedeemField,
  giftCardCheckoutErrorMessage,
  type AppliedGiftCard,
} from '@/components/booking/GiftCardRedeemField'
// The plan's intro offer, said the SAME way on the card and in the modal.
import { IntroOfferLine, readIntroTerms } from '@/components/pricing/IntroOfferLine'

interface PlanPrice {
  id?: string
  amount: number
  recurrence: string
  label?: string
  included_months?: number
  credits?: number
  /** The plan's INTRO OFFER on this price, already resolved server-side by
   *  `syncSubscriptionTypesToPublicProfile` — present only when it is sellable,
   *  so the card can never advertise terms the checkout would refuse. Narrowed
   *  through `readIntroTerms`, never trusted as typed. */
  intro?: unknown
}
interface PlanEntry {
  id: string
  name: string
  description?: string
  prices?: PlanPrice[]
  checkout_contact_mode?: CheckoutContactMode
}

interface ProductVariantEntry {
  id: string
  label: string
  priceAmount?: number
}
interface ProductEntry {
  id: string
  name: string
  description?: string
  imageUrl?: string
  priceAmount: number
  variantLabel?: string
  variants?: ProductVariantEntry[]
  // How the buyer gets it (UX-79) — the product's OWN terms. The team default
  // arrives separately on the profile, and the pair is resolved by the shared
  // `resolveProductCollectionNote` so this surface and the receipt cannot
  // disagree about which of the two applies.
  collectionNote?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The intro offer mirrored onto a public price, or null. A one-liner so the
 *  card and the checkout modal ask the same question of the same field. */
function introTermsOf(price: PlanPrice) {
  return readIntroTerms(price.intro)
}

type CourseAccessType = 'free' | 'registered' | 'subscription' | 'purchase'

interface CourseEntry {
  id: string
  slug: string
  title: string
  summary?: string
  coverImageUrl?: string
  accessType: CourseAccessType
  subscriptionTypeIds?: string[]
  priceAmount?: number // 'purchase' tier only
  /** Subscriber benefit on the purchase price — 'purchase' tier only. Wins
   *  over the legacy `subscriptionTypeIds` free-inclusion when present. */
  benefit?: Benefit | null
}

// Raw shape of a course's world-readable public_profile summary (syncCoursePublicProfile).
interface RawCoursePublicProfile {
  accessType?: string
  slug?: string
  subscriptionTypeIds?: string[]
  priceAmount?: number | null
  benefit?: Benefit | null
  hideFromShop?: boolean
  title?: string
  summary?: string
  coverImageUrl?: string | null
  order?: number
}

// "Pay per visit" strip (Subscriptions tab): activities with a money story
// (drop-in or priced durations) — routing-only cross-sell into the booking
// flows, no purchase happens here. Same public_profile shape BookingForm /
// sections.tsx read.
interface PayPerVisitEntry {
  id: string
  name: string
  slug: string
  activityType?: string
  dropIn?: { enabled: boolean; priceAmount?: number }
  durations?: Array<{ minutes: number; priceAmount: number | null; benefitOnly?: boolean }>
  memberBenefit?: ActivityMemberBenefit | Benefit
  /** Read WITH `memberBenefit` through `resolveDurationBenefit` — the pair is
   *  what tells "no rule for this length" from a tenant that predates them. */
  durationBenefits?: ActivityDurationBenefit[]
  accessRule?: ActivityAccessRule
  order?: number
}

// Only activities with an actual money story belong in the strip — a bare
// gated/trial class with no drop-in, or an unpriced appointment, has nothing
// to "pay per visit" for.
function hasMoneyStory(a: PayPerVisitEntry): boolean {
  if (a.activityType === 'appointment') {
    // A benefit_only length (UX-70) carries no individual price — it is bought
    // as the subscription/pack, not per visit.
    return (a.durations ?? []).some((d) => resolveDurationSale(d).priceAmount !== null)
  }
  return a.dropIn?.enabled === true && typeof a.dropIn.priceAmount === 'number'
}

type Tab = 'subscriptions' | 'products' | 'courses' | 'giftcards'

type Checkout =
  | { kind: 'membership'; typeId: string; typeName: string; price: PlanPrice; mode: CheckoutContactMode }
  | { kind: 'product'; product: ProductEntry; variantId: string | null }
  | { kind: 'course'; course: CourseEntry }
  | { kind: 'giftcard'; amount: number }

export default function ShopHome({
  focusTypeId,
  focusCourseId,
  initialTab,
}: {
  focusTypeId: string | null
  focusCourseId: string | null
  initialTab: Tab | null
}) {
  const t = useTranslations('Shop')
  const tCommon = useTranslations('Common')
  // The promo widget's own namespace — a promo is not a shop item, and one
  // namespace serves every mount of PromoCodeField rather than a fork per
  // surface. (docs/promo-codes.md → "The mounts" owns that list.)
  const tPromo = useTranslations('Promo')
  const locale = useLocale()
  const { slug, teamId, team } = usePublicTeam()
  const { isAuthenticated, isRestoring, contact, openSignIn, logout } = usePublicContactAuth()

  const [plans, setPlans] = useState<PlanEntry[]>([])
  const [pendingCheckout, setPendingCheckout] = useState<Checkout | null>(null)
  const [products, setProducts] = useState<ProductEntry[]>([])
  const [courses, setCourses] = useState<CourseEntry[]>([])
  const [payPerVisitActivities, setPayPerVisitActivities] = useState<PayPerVisitEntry[]>([])
  const [purchasedCourseIds, setPurchasedCourseIds] = useState<Set<string>>(new Set())
  const [currency, setCurrency] = useState('CHF')
  const [giftCardAmounts, setGiftCardAmounts] = useState<number[]>([])
  const [giftCardApplied, setGiftCardApplied] = useState<AppliedGiftCard | null>(null)
  // The promo is a Stage A MODIFIER, so unlike the gift card it goes INTO the
  // modal's single price computation rather than being deducted after it.
  const [promoApplied, setPromoApplied] = useState<AppliedPromo | null>(null)
  const [loading, setLoading] = useState(true)
  const [systemDark, setSystemDark] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'subscriptions')
  const [tabTouched, setTabTouched] = useState(false)
  const [checkout, setCheckout] = useState<Checkout | null>(null)
  /** Guest gift-card buyer's address — receipt destination only, never identity
   *  (the server treats it as a prefill and links a contact only on a unique match). */
  const [guestEmail, setGuestEmail] = useState('')
  const [courseFocusHandled, setCourseFocusHandled] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Distinct from `error` (a checkout failure): this one means the CATALOGUE
  // itself did not load, and it must never be shown as "this studio sells
  // nothing" — the shape that hid the Space entitlements 403 for months.
  // …and it is kept SEPARATE from the entitlements failure below, because the two
  // say different things and the page owes a different answer to each:
  //
  //   catalogueLoadError  the shop's own contents did not load → the page failed.
  //   entitlementsError   the catalogue is fine; we just don't know what the
  //                       visitor already owns, so an owned course may read
  //                       "Buy" → a caveat over a real page, not a failed page.
  //
  // One shared slot made an EMPTY catalogue plus a failed entitlements read
  // render as "we couldn't load what this studio sells", which is false. Each is
  // also cleared where its own success is stored, so a transient failure cannot
  // pin a stale banner over data that has since loaded correctly.
  const [catalogueLoadError, setCatalogueLoadError] = useState<unknown>(null)
  const [entitlementsError, setEntitlementsError] = useState<unknown>(null)
  // Has an entitlements answer actually arrived FOR THE CURRENT IDENTITY?
  // `purchasedCourseIds.size === 0` cannot say: it is the same empty set for
  // "owns nothing", "still loading" and "the read was refused". Only the last two
  // are dangerous, and only for the paths that open a checkout WITHOUT the
  // visitor asking for that specific item again (the ?course= deep link, and its
  // resume after sign-in) — see both effects below.
  /**
   * WHO the entitlement set belongs to — not whether a read finished.
   *
   * `undefined` = never resolved; `null` = resolved for a signed-out visitor;
   * a string = resolved for that contact. `entitlementsResolved` is then DERIVED
   * during render, which is what makes it impossible to read a stale answer.
   *
   * A boolean could not do this. On the render where `isAuthenticated` flips,
   * the fetch effect below (declared first) calls its setter — which only
   * SCHEDULES a re-render — and the consumer effects then run later in the SAME
   * commit still holding the guest's `true`. They would open a checkout against
   * the empty set the page starts with, which is the precise thing the guard
   * exists to prevent. A dependency array does not help: the value is stale
   * within the commit, not between commits.
   */
  const [entitlementsFor, setEntitlementsFor] = useState<string | null | undefined>(undefined)
  const entitlementsResolved = entitlementsFor === (contact?.id ?? null)
  const [retryKey, setRetryKey] = useState(0)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  function retryCatalogue() {
    setCatalogueLoadError(null)
    setEntitlementsError(null)
    setLoading(true)
    setRetryKey((k) => k + 1)
  }

  useEffect(() => {
    let cancelled = false
    // Memberships + products live on the team's single public_profile doc; courses are
    // world-readable per-course public_profile summaries (same collection-group query
    // the Space uses). The shop is the courses' home, so it lists EVERY tier — only
    // courses the studio explicitly hid from the catalogue are dropped.
    const profileP = getDoc(doc(db, TEAMS_COLLECTION, teamId, PUBLIC_PROFILE_SUBCOLLECTION, teamId))
    const coursesP = getDocs(
      query(
        collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
        where('type', '==', 'course'),
        where('teamId', '==', teamId)
      )
    )
    // Same public activity mirrors BookingForm / the website Activities block
    // read — filtered down (below) to the ones with an actual money story.
    const activitiesP = getDocs(
      query(
        collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
        where('type', '==', 'activity'),
        where('teamId', '==', teamId)
      )
    )
    Promise.all([profileP, coursesP, activitiesP])
      .then(([snap, courseSnap, activitiesSnap]) => {
        if (cancelled) return
        const planList = (snap.data()?.aggregator_subscription_types ?? []) as PlanEntry[]
        const productList = (snap.data()?.products ?? []) as ProductEntry[]
        setPlans(Array.isArray(planList) ? planList : [])
        setProducts(Array.isArray(productList) ? productList : [])
        setCurrency((snap.data()?.default_currency as string | undefined) ?? 'CHF')
        const giftCards = snap.data()?.giftCards as { enabled?: boolean; amounts?: number[] } | undefined
        setGiftCardAmounts(
          giftCards?.enabled === true && Array.isArray(giftCards.amounts) ? giftCards.amounts : []
        )
        const courseList: CourseEntry[] = courseSnap.docs
          .map((d) => ({ id: d.ref.parent.parent?.id ?? d.id, data: d.data() as RawCoursePublicProfile }))
          .filter(({ data }) => data.hideFromShop !== true)
          .sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0))
          .map(({ id, data }) => ({
            id,
            slug: data.slug ?? '',
            title: data.title ?? '',
            summary: data.summary || undefined,
            coverImageUrl: data.coverImageUrl || undefined,
            accessType: (data.accessType as CourseAccessType) ?? 'registered',
            subscriptionTypeIds: data.subscriptionTypeIds ?? [],
            priceAmount: typeof data.priceAmount === 'number' ? data.priceAmount : undefined,
            benefit: data.benefit ?? null,
          }))
        setCourses(courseList)
        const activityList: PayPerVisitEntry[] = activitiesSnap.docs
          .map((d) => {
            const data = d.data()
            return {
              id: d.id,
              name: (data.name as string) || '',
              slug: (data.slug as string) || '',
              activityType: (data.activityType as string) || undefined,
              dropIn: (data.dropIn as PayPerVisitEntry['dropIn']) ?? undefined,
              durations: Array.isArray(data.durations) ? (data.durations as PayPerVisitEntry['durations']) : undefined,
              memberBenefit: (data.memberBenefit as ActivityMemberBenefit | Benefit | undefined) ?? undefined,
              durationBenefits: Array.isArray(data.durationBenefits)
                ? (data.durationBenefits as ActivityDurationBenefit[])
                : undefined,
              accessRule: (data.accessRule as ActivityAccessRule | undefined) ?? undefined,
              order: typeof data.order === 'number' ? (data.order as number) : undefined,
            }
          })
          .filter((a) => a.name && hasMoneyStory(a))
          .sort(compareActivities)
        setPayPerVisitActivities(activityList)
        setCatalogueLoadError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        reportPublicLoadFailure('shop/catalogue', err)
        setCatalogueLoadError(err)
        setPlans([])
        setProducts([])
        setCourses([])
        setPayPerVisitActivities([])
        setGiftCardAmounts([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId, retryKey])

  // Which 'purchase'-tier courses the signed-in contact already owns (lifetime
  // entitlements) — so an owned course shows "Open" instead of "Buy".
  useEffect(() => {
    if (!isAuthenticated || !contact?.id) {
      setPurchasedCourseIds(new Set())
      setEntitlementsError(null)
      // Nobody is signed in, so there is no entitlement this page could be
      // hiding: the question is answered, not pending. (What a guest CAN'T do is
      // buy — startCheckout sends them to sign-in first, and the resume below
      // re-asks this question as the contact they turn out to be.)
      setEntitlementsFor(null)
      return
    }
    let cancelled = false
    // No need to mark "in flight": `entitlementsFor` already names the PREVIOUS
    // identity, so the derived `entitlementsResolved` is false from the first
    // render on which the contact changed.
    getDocs(
      query(
        collectionGroup(db, COURSE_PURCHASES_SUBCOLLECTION),
        where('contactId', '==', contact.id),
        where('teamId', '==', teamId)
      )
    )
      .then((snap) => {
        if (cancelled) return
        setPurchasedCourseIds(
          new Set(snap.docs.map((d) => (d.data().courseId as string | undefined) ?? d.id))
        )
        setEntitlementsError(null)
        setEntitlementsFor(contact.id)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A failure here re-sells a course the contact already owns — the button
        // says "Buy" for something they paid for. Loud in the log, and the
        // partial banner tells them the page is not showing the whole truth. It
        // does NOT claim the catalogue failed: the catalogue is right here.
        // `entitlementsFor` is deliberately NOT advanced, so the derived
        // `entitlementsResolved` stays false: a card the visitor clicks
        // themselves is their own decision, but nothing may OPEN a checkout on
        // their behalf off an answer we never got.
        reportPublicLoadFailure('shop/purchases', err)
        setEntitlementsError(err)
      })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, contact?.id, teamId, retryKey])

  useEffect(() => {
    if (team?.bioLinkTheme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [team?.bioLinkTheme])

  // Can this studio BE PAID? Everything BOUGHT on this page — memberships,
  // products, courses, gift cards — goes through Stripe Connect, so with no
  // chargeable account there is no purchase here anyone could complete (UX-33).
  // Absent ⇒ closed: fail in the safe direction, and note that this is a
  // DISPLAY fact only — `payments_enabled` is a client-writable mirror, and
  // what actually stops a charge is `requireChargeableAccount` on every
  // checkout callable.
  const paymentsEnabled = team.payments_enabled === true
  // The whole page in one word. What follows from it is a PRICE LIST, not a
  // hidden page: read it below wherever a control would take money (never
  // rendered — see `startCheckout`) and wherever a price is merely stated
  // (still rendered, which is the point). The surface itself stays reachable —
  // `routableSurfaces` in @linyup/shared owns that half.
  const priceListMode = !paymentsEnabled

  const hasSubscriptions = plans.length > 0
  const hasProducts = products.length > 0
  const hasCourses = courses.length > 0
  // GIFT CARDS ARE THE ONE SHELF WITH NOTHING TO BROWSE. A membership, a product
  // and a course all exist off Stripe — the studio can sell them at the desk and
  // the price list tells the visitor what they cost. A gift card IS the payment:
  // there is no offline version of a prepaid balance to look at, and a "CHF 50
  // gift card" card with no way to buy one states a price for a thing that
  // cannot exist. So the tab is not offered at all without a till.
  const hasGiftCards = giftCardAmounts.length > 0 && paymentsEnabled
  const catalogueIsEmpty = !hasSubscriptions && !hasProducts && !hasCourses && !hasGiftCards
  // The full-page error is reserved for the case where the CATALOGUE query is the
  // thing that failed — which, here, always means NOTHING loaded: the three reads
  // are one `Promise.all`, so a single rejection skips the whole `then`, and the
  // catch empties every list. There is no partial catalogue to preserve, so
  // `&& catalogueIsEmpty` only ever restated `catalogueLoadError != null` and is
  // gone. (Should the load ever become per-query and keep what succeeded, this is
  // the line that has to grow the distinction back.)
  const showCatalogueError = catalogueLoadError != null
  // The caveat banner is for the OTHER failure, which is not a failure of the
  // page: the catalogue is right here and correct, we just don't know what the
  // visitor already owns. An EMPTY catalogue is a legitimate answer and keeps
  // this banner over it — "nothing for sale" stays true, "and we know what you
  // own" does not.
  const showPartialWarning = !showCatalogueError && entitlementsError != null
  const availableTabs = useMemo<Tab[]>(() => {
    const out: Tab[] = []
    if (hasSubscriptions) out.push('subscriptions')
    if (hasProducts) out.push('products')
    if (hasCourses) out.push('courses')
    if (hasGiftCards) out.push('giftcards')
    return out
  }, [hasSubscriptions, hasProducts, hasCourses, hasGiftCards])
  const showTabs = availableTabs.length > 1

  // Default the active tab to whichever surface has items, unless the user (or the
  // ?tab= param) chose one. ?type= focusing always implies memberships.
  useEffect(() => {
    if (loading || tabTouched || initialTab) return
    if (focusTypeId) setTab('subscriptions')
    else if (focusCourseId && hasCourses) setTab('courses')
    else setTab(availableTabs[0] ?? 'subscriptions')
  }, [loading, tabTouched, initialTab, focusTypeId, focusCourseId, hasCourses, availableTabs])

  // Pre-focus a subscription card from ?type=.
  useEffect(() => {
    if (!focusTypeId || loading || tab !== 'subscriptions') return
    const el = cardRefs.current[focusTypeId]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusTypeId, loading, tab])

  // LOGIN-FIRST — with ONE exception. Signed-in buyers go straight to the confirm
  // sheet (the purchase attaches to their contact via the session); everyone else
  // signs in or registers (allowRegistration) and the checkout resumes once auth
  // resolves (effect below).
  //
  // Gift cards skip the gate: what is bought is a CODE, usually for somebody else,
  // and it grants the buyer nothing that would need an account to hold. Making a
  // present require registration loses the sale; the buyer just leaves an address
  // for the receipt.
  const startCheckout = useCallback(
    (c: Checkout) => {
      // PRICE-LIST MODE: there is no checkout to start. Nothing on the page
      // calls this (every buy control is unrendered rather than disabled), so
      // this is the backstop for the two entries that do not come from a click
      // on it — the `?course=` deep link from the Space, and the resume after
      // sign-in. Both would otherwise collect an email and open a modal whose
      // Pay button the callable refuses.
      if (!paymentsEnabled) return
      if (isAuthenticated || c.kind === 'giftcard') {
        setCheckout(c)
        setError(null)
      } else {
        setPendingCheckout(c)
        openSignIn({ allowRegistration: true })
      }
    },
    [isAuthenticated, openSignIn, paymentsEnabled]
  )

  // Deep-link from the Space "Buy" CTA (?course=): open that course's checkout once.
  // Only purchase-tier courses are buyable — ignore the param for other tiers.
  //
  // AND ONLY ONCE OWNERSHIP IS KNOWN. This is the one place the page opens a
  // payment panel without the visitor having pressed anything on it, so it is the
  // one place `purchasedCourseIds` may not be read as fact before the query
  // behind it has answered: on the empty set every page starts with, an owned
  // course reads "not owned" and the deep link invites the buyer to pay for it a
  // second time. Unresolved is not "not owned" — it is "don't know", and "don't
  // know" does not open a checkout.
  useEffect(() => {
    if (!focusCourseId || loading || courseFocusHandled) return
    if (!entitlementsResolved) {
      // In flight: come back when it lands (this effect re-runs on it).
      if (entitlementsError == null) return
      // Refused, and it will not answer itself. Give the deep link up rather
      // than leave it armed: the catalogue is on screen with its caveat banner,
      // and a Buy the visitor presses there is a decision they made knowing the
      // page told them it may be incomplete.
      setCourseFocusHandled(true)
      return
    }
    const c = courses.find((x) => x.id === focusCourseId)
    if (c && c.accessType === 'purchase' && !purchasedCourseIds.has(c.id)) {
      startCheckout({ kind: 'course', course: c })
    }
    setCourseFocusHandled(true)
  }, [
    focusCourseId,
    loading,
    courseFocusHandled,
    courses,
    purchasedCourseIds,
    entitlementsResolved,
    entitlementsError,
    startCheckout,
  ])

  const isDark = team?.bioLinkTheme === 'dark' || (team?.bioLinkTheme === 'auto' && systemDark)
  const bg = team?.bioLinkBackground
  const bgStyle = resolveBackground(bg, isDark)
  const onDark = getTextColor(bg, isDark) === 'light'
  const accent = team?.bioLinkAccentColor ?? DEFAULT_ACCENT
  const textMain = onDark ? '#f9fafb' : '#111827'
  const textMuted = onDark ? 'rgba(249,250,251,0.65)' : '#6b7280'
  const cardBg = onDark ? 'rgba(255,255,255,0.08)' : '#ffffff'
  const cardBorder = onDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'

  const recurrenceSuffix = useMemo(
    () =>
      (r: string): string => {
        const key = `recurrence.${r}`
        const val = t(key as Parameters<typeof t>[0])
        return val === key ? '' : val
      },
    [t]
  )

  // Money-chip label for one resolved term, for the "pay per visit" strip below.
  // Unlike the public website (generic labels only), the shop already has the
  // subscription-type list loaded — the cross-sell bridge: resolve a SINGLE
  // held type's name ("Included with Premium"); fall back to generic when the
  // benefit spans several types.
  const payPerVisitTermLabel = useCallback(
    (term: ActivityTerm): string | null => {
      const nameFor = (ids?: string[]) =>
        ids?.length === 1 ? plans.find((p) => p.id === ids[0])?.name : undefined
      switch (term.kind) {
        case 'dropIn':
          return t('payPerVisitDropIn', { price: formatCurrency(term.amount ?? 0, currency) })
        case 'price':
          return term.min === term.max
            ? t('payPerVisitFromPrice', { price: formatCurrency(term.min ?? 0, currency) })
            : t('payPerVisitPriceRange', {
                min: formatCurrency(term.min ?? 0, currency),
                max: formatCurrency(term.max ?? 0, currency),
              })
        case 'benefitIncluded': {
          const name = nameFor(term.subscriptionTypeIds)
          return name ? t('payPerVisitIncludedNamed', { name }) : t('payPerVisitIncludedGeneric')
        }
        case 'benefitDiscount': {
          const name = nameFor(term.subscriptionTypeIds)
          return name
            ? t('payPerVisitDiscountNamed', { percent: term.percent ?? 0, name })
            : t('payPerVisitDiscountGeneric', { percent: term.percent ?? 0 })
        }
        default:
          return null
      }
    },
    [plans, currency, t]
  )

  // Resume a pending checkout once sign-in (or registration) resolves — always as
  // the authenticated contact. Unknown emails register in the sign-in dialog; there
  // is no anonymous fallback anymore.
  //
  // A COURSE waits here on the same fact the deep link waits on, and for a
  // sharper version of the same reason: signing in is the exact moment ownership
  // becomes knowable, so resuming the instant `isAuthenticated` flips would open
  // the panel on the guest's empty set every time. A read that FAILED does
  // release the wait — the caveat banner is up, and refusing a purchase the
  // visitor has now asked for twice would be a dead end with no way out of it.
  useEffect(() => {
    if (!pendingCheckout || !isAuthenticated) return
    if (pendingCheckout.kind === 'course') {
      if (!entitlementsResolved && entitlementsError == null) return
      if (purchasedCourseIds.has(pendingCheckout.course.id)) {
        // Already theirs. Selling it again is the failure mode; say so and let
        // the card behind this — now reading "Open" — take them to it.
        setPendingCheckout(null)
        toast.info(t('alreadyOwned'))
        return
      }
    }
    setCheckout(pendingCheckout)
    setError(null)
    setPendingCheckout(null)
  }, [
    isAuthenticated,
    pendingCheckout,
    entitlementsResolved,
    entitlementsError,
    purchasedCourseIds,
    t,
  ])

  function openMembership(
    typeId: string,
    typeName: string,
    price: PlanPrice,
    mode: CheckoutContactMode
  ) {
    startCheckout({ kind: 'membership', typeId, typeName, price, mode })
  }

  function openProduct(product: ProductEntry) {
    const firstVariant = product.variants && product.variants.length > 0 ? product.variants[0].id : null
    startCheckout({ kind: 'product', product, variantId: firstVariant })
  }

  function openCourse(course: CourseEntry) {
    startCheckout({ kind: 'course', course })
  }

  function openGiftCard(amount: number) {
    startCheckout({ kind: 'giftcard', amount })
  }

  // The contact's held union for course-coverage display — today the public
  // contact session only carries the single primary `subscription_type_id`
  // (no `active_subscriptions`/`credit_summary` mirror here), so this is a
  // one-element array in practice; the resolver itself supports the full held
  // union (P6 — see the Space's equivalent `hasAccess`).
  const heldSubscriptionTypeIds = contact?.subscription_type_id ? [contact.subscription_type_id] : []

  // Same resolver the server uses (@linyup/shared) for course access — pure
  // function of the course's accessRule + the visitor's optimistic snapshot.
  // `promo` is threaded rather than assumed: the CATALOGUE cards resolve without
  // one (no code has been typed yet at card level) and the checkout MODAL
  // resolves with it. One function, two inputs — never two independent
  // computations of the same number.
  const courseOptions = (c: CourseEntry, promo?: AppliedPromo | null) => {
    const rule: CourseAccessRule = {
      type: c.accessType,
      subscriptionTypeIds: c.subscriptionTypeIds,
      priceAmount: c.priceAmount,
    }
    const snapshot = clientPaymentSnapshot({
      authenticated: isAuthenticated,
      heldSubscriptionTypeIds,
      ownsCourse: purchasedCourseIds.has(c.id),
    })
    return resolvePaymentOptions(
      snapshot,
      { kind: 'course', accessRule: rule, benefit: c.benefit },
      promo ? { promo } : undefined
    )
  }

  // A signed-in holder's applied benefit on a 'purchase'-tier course, if any —
  // the base price struck through, the member price shown instead. Null for
  // anyone else (guest, no benefit, or already covered/owned).
  const courseMemberPrice = (c: CourseEntry): { amount: number; base: number } | null => {
    const { options } = courseOptions(c)
    const pay = options[0]
    if (pay?.type !== 'pay' || !pay.appliedBenefit) return null
    return { amount: pay.amount, base: pay.appliedBenefit.baseAmount }
  }

  // What the catalogue card offers for a course, given the visitor's session:
  //  'open'      → can read it now → link to the player
  //  'buy'       → purchase-tier, not owned → checkout
  //  'signin'    → registered/subscription course, needs a login first
  //  'subscribe' → subscription course, signed in but no qualifying membership
  const courseAccess = (c: CourseEntry): 'open' | 'buy' | 'signin' | 'subscribe' => {
    const { options, denial } = courseOptions(c)
    if (options[0]?.type === 'pay') return 'buy'
    if (options.length > 0) return 'open'
    // Purchase-tier misconfig (no price, not owned/included) — the old check
    // always offered 'buy' here regardless of auth state; preserve that.
    if (c.accessType === 'purchase') return 'buy'
    return denial === 'sign_in_required' ? 'signin' : 'subscribe'
  }

  // ── THE MODAL'S ONE COMPUTATION ────────────────────────────────────────────
  // Everything the checkout modal renders — the price, the struck-through base,
  // the promo's verdict — and the `quotedAmount` it sends comes out of THIS
  // single resolver result. Products go through the resolver too now (the
  // `product` arm), which is what lets a price MODIFIER exist on merchandise at
  // all without applying it at the callable, where tenders live.
  const checkoutQuote = (() => {
    if (checkout?.kind === 'course') return courseOptions(checkout.course, promoApplied)
    if (checkout?.kind === 'product') {
      return resolvePaymentOptions(
        // The product arm is snapshot-INVARIANT (it never covers, never denies,
        // and a Product carries no benefit), so the snapshot here cannot change
        // the answer — it is passed for uniformity with every other rail.
        clientPaymentSnapshot({ authenticated: isAuthenticated, heldSubscriptionTypeIds }),
        {
          kind: 'product',
          priceAmount: resolveProductPrice(checkout.product, checkout.variantId),
          benefit: null,
        },
        promoApplied ? { promo: promoApplied } : undefined
      )
    }
    return null
  })()

  // The amount the resolver produced for this modal.
  const resolvedAmount = (() => {
    if (!checkout) return 0
    if (checkout.kind === 'membership') return checkout.price.amount
    if (checkout.kind === 'giftcard') return checkout.amount
    const pay = checkoutQuote?.options[0]
    if (pay?.type === 'pay') return pay.amount
    return checkout.kind === 'course'
      ? (checkout.course.priceAmount ?? 0)
      : resolveProductPrice(checkout.product, checkout.variantId)
  })()

  // Redeeming a gift card only applies to the one-off product/course checkouts
  // (never memberships/subscriptions, never the gift-card purchase itself).
  const giftCardEligible = checkout?.kind === 'product' || checkout?.kind === 'course'
  // The same two rails take a promo, for the same reason: they are the one-off
  // purchases. A subscription would need a Stripe coupon rather than an amount
  // we compute, and a discount on a gift card would mint stored value the studio
  // was never paid for.
  const promoEligible = giftCardEligible

  // The only checkout a signed-out visitor can reach — see startCheckout.
  const needsGuestEmail = checkout?.kind === 'giftcard' && !isAuthenticated

  // Reset the applied code when a different item is opened (but NOT on a mere
  // product-variant swap, which re-creates the checkout object in place).
  const checkoutKey = !checkout
    ? null
    : checkout.kind === 'product'
      ? `product:${checkout.product.id}`
      : checkout.kind === 'course'
        ? `course:${checkout.course.id}`
        : checkout.kind === 'membership'
          ? `membership:${checkout.typeId}:${checkout.price.id ?? ''}`
          : `giftcard:${checkout.amount}`
  useEffect(() => {
    setGiftCardApplied(null)
    // A code is quoted against ONE purchase (the reservation key embeds the
    // product/course id), so opening a different item must not carry the
    // previous quote across.
    setPromoApplied(null)
  }, [checkoutKey])

  // ── The recovery half of the `price_changed` guard ────────────────────────
  // The server's own figure, once it has refused a quote and this modal has
  // shown it. It is BOTH what the modal renders from here on AND what the next
  // submit sends back as `quotedAmount` — which is what makes the refusal cost
  // one extra, informed click instead of looping forever (the modal would
  // otherwise re-derive the same optimistic number and be refused again).
  //
  // AN ACCEPTED FIGURE BELONGS TO ONE (target, code, IDENTITY) — the rule lives
  // in `useAcceptedPrice`, shared with the class BookingForm and the appointment
  // picker. Here the TARGET is the item AND its variant (a variant swap re-prices
  // the same product in place, without opening a different checkout); the
  // IDENTITY is the public contact session, which this modal can change under
  // itself — the stale-session branch in `submit()` below logs the buyer out and
  // re-opens sign-in with the checkout pending, and `courseOptions` re-quotes on
  // the membership that sign-in produces. Without the identity axis a guest
  // refused at the list price, who then signed in, would be shown and would
  // re-send that figure over a member price the resolver had already lowered.
  const checkoutVariantId = checkout?.kind === 'product' ? (checkout.variantId ?? null) : null
  const { acceptedPrice, acceptPrice } = useAcceptedPrice(
    [
      checkoutKey ?? '',
      checkoutVariantId ?? '',
      promoApplied?.code ?? '',
      isAuthenticated ? (contact?.id ?? 'auth') : 'guest',
      contact?.subscription_type_id ?? '',
    ].join('|')
  )

  // What the modal renders and what the buyer is asked to confirm.
  const checkoutAmount = acceptedPrice ?? resolvedAmount

  // The base price to strike through in the modal, and WHICH modifier produced
  // it. Read off the ONE result above — the resolver stamps at most one of
  // `appliedBenefit` / `appliedPromo`, so "member price" and "code price" are
  // mutually exclusive structurally rather than by convention.
  const checkoutMemberBase = (() => {
    // The server has told us what this actually costs, and it is higher than the
    // modifier we rendered — so there is no discount left to strike a base
    // through. Showing one over the server's figure would be the same broken
    // promise the guard exists to refuse.
    if (acceptedPrice !== null) return null
    const pay = checkoutQuote?.options[0]
    if (pay?.type !== 'pay') return null
    if (pay.appliedBenefit) {
      return { amount: pay.amount, base: pay.appliedBenefit.baseAmount, via: 'benefit' as const }
    }
    if (pay.appliedPromo) {
      return { amount: pay.amount, base: pay.appliedPromo.baseAmount, via: 'promo' as const }
    }
    return null
  })()

  async function submit() {
    if (!checkout) return
    // A guest has no session for the code to land in, so the address typed here
    // is the ONLY delivery route. Refuse a malformed one before Stripe, not after
    // the money moved — an unreachable buyer is a card nobody can find.
    if (needsGuestEmail && !EMAIL_RE.test(guestEmail.trim())) {
      setError(t('giftCardBuyerEmailInvalid'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (checkout.kind === 'membership') {
        if (!checkout.price.id) throw new Error('no-price')
        const fn = httpsCallable<
          {
            teamId: string
            subscriptionTypeId: string
            priceId: string
            slug: string
            locale: string
            origin?: string
          },
          { url: string }
        >(functions, 'createMembershipCheckout')
        const res = await fn({
          teamId,
          subscriptionTypeId: checkout.typeId,
          priceId: checkout.price.id,
          slug,
          locale,
          origin: window.location.origin,
        })
        if (res.data?.url) window.location.href = res.data.url
        else throw new Error('no-url')
      } else if (checkout.kind === 'product') {
        const fn = httpsCallable<
          {
            teamId: string
            productId: string
            variantId?: string
            slug: string
            locale: string
            origin?: string
            giftCardCode?: string
            promoCode?: string
            quotedAmount?: number
          },
          { url: string | null; paidWithGiftCard?: boolean }
        >(functions, 'createProductCheckout')
        const res = await fn({
          teamId,
          productId: checkout.product.id,
          ...(checkout.variantId ? { variantId: checkout.variantId } : {}),
          slug,
          locale,
          origin: window.location.origin,
          // THE FIGURE THIS MODAL RENDERED, sent WITH the code and only with it.
          // A code is what turns the rendered price into a promise ("Code X
          // applied", a struck-through base); without one the number is an
          // optimistic render the server is entitled to disagree with, and
          // asserting it would refuse ordinary sales. Disagreement here is
          // refused as `price_changed` carrying the server's number.
          ...(promoApplied
            ? { promoCode: promoApplied.code, quotedAmount: checkoutAmount }
            : {}),
          ...(giftCardApplied ? { giftCardCode: giftCardApplied.code } : {}),
        })
        if (res.data?.paidWithGiftCard) {
          setSubmitting(false)
          setCheckout(null)
          setGiftCardApplied(null)
          toast.success(t('paidWithGiftCard'))
        } else if (res.data?.url) {
          window.location.href = res.data.url
        } else throw new Error('no-url')
      } else if (checkout.kind === 'course') {
        const fn = httpsCallable<
          {
            teamId: string
            courseId: string
            slug: string
            locale: string
            origin?: string
            giftCardCode?: string
            promoCode?: string
            quotedAmount?: number
          },
          { url: string | null; paidWithGiftCard?: boolean }
        >(functions, 'createCourseCheckout')
        const res = await fn({
          teamId,
          courseId: checkout.course.id,
          slug,
          locale,
          origin: window.location.origin,
          // Same pairing as the product branch: the quote rides the code.
          ...(promoApplied
            ? { promoCode: promoApplied.code, quotedAmount: checkoutAmount }
            : {}),
          ...(giftCardApplied ? { giftCardCode: giftCardApplied.code } : {}),
        })
        if (res.data?.paidWithGiftCard) {
          setSubmitting(false)
          setCheckout(null)
          setGiftCardApplied(null)
          setPurchasedCourseIds((prev) => new Set(prev).add(checkout.course.id))
          toast.success(t('paidWithGiftCard'))
        } else if (res.data?.url) {
          window.location.href = res.data.url
        } else throw new Error('no-url')
      } else {
        const fn = httpsCallable<
          {
            teamId: string
            amount: number
            slug: string
            locale: string
            origin?: string
            purchaserEmail?: string
          },
          { url: string; sessionId: string }
        >(functions, 'createGiftCardCheckout')
        const res = await fn({
          teamId,
          amount: checkout.amount,
          slug,
          locale,
          origin: window.location.origin,
          // Guests only — a signed-in buyer's address comes from their session,
          // which the server trusts and this field never overrides.
          ...(!isAuthenticated && guestEmail ? { purchaserEmail: guestEmail.trim() } : {}),
        })
        if (res.data?.url) window.location.href = res.data.url
        else throw new Error('no-url')
      }
    } catch (err) {
      const code = (err as FunctionsError)?.code
      // Only a signed-in buyer can have a session to re-establish; a guest hitting
      // this would be logged out of nothing and shown a sign-in wall they were
      // explicitly allowed to skip.
      if (
        isAuthenticated &&
        (code === 'functions/unauthenticated' || code === 'functions/permission-denied')
      ) {
        // Session expired (or went stale) mid-flow — re-run the sign-in and resume.
        setSubmitting(false)
        setCheckout(null)
        setPendingCheckout(checkout)
        await logout()
        openSignIn({ allowRegistration: true })
        setError(null)
        return
      }
      // RECOVERY, before anything else: the server has told us what this really
      // costs. Render that figure, relabel the button to it, and let the buyer
      // take it — the next submit sends it back as `quotedAmount` and completes.
      // Without this branch the modal re-renders the same optimistic number and
      // is refused again, which is a lost sale wearing a safety feature's badge.
      // The sentence itself is composed by `priceChangedMessage`, because the
      // commonest cause is a REFUSED CODE rather than a moved price and only the
      // server knows which — see its docblock.
      const serverPrice = priceChangedAmount(err)
      if (serverPrice !== null) {
        acceptPrice(serverPrice)
        setError(
          priceChangedMessage(err, tPromo, formatCurrency(serverPrice, currency, locale))
        )
        setSubmitting(false)
        return
      }
      const giftMsg = giftCardApplied ? giftCardCheckoutErrorMessage(err, t) : null
      // PAY-TIME promo refusals — the preview is advisory about availability
      // (exhausted / busy / already used are decided by the reserve
      // transaction).
      const promoMsg = promoCheckoutErrorMessage(err, tPromo)
      setError(
        giftMsg ??
          promoMsg ??
          (code === 'functions/already-exists'
            ? t('alreadySubscribed')
            : code === 'functions/failed-precondition'
              ? t('notAvailable')
              : t('checkoutError'))
      )
      setSubmitting(false)
    }
  }

  // WHAT HAPPENS AFTER YOU PAY, stated BEFORE you pay (UX-79) — the product's
  // own terms, else the studio's default, else nothing (and then the modal stays
  // silent rather than inventing a delivery promise the data cannot back).
  //
  // It renders in the CHECKOUT MODAL rather than on the grid card: this is the
  // last screen before Stripe and the one place a full sentence fits, whereas a
  // two-column card would truncate it to a fragment — which answers the question
  // worse than not asking it. Same placement, and the same reasoning, as the
  // course access note directly beside it.
  const checkoutCollectionNote =
    checkout?.kind === 'product'
      ? resolveProductCollectionNote(checkout.product, team?.productCollectionNote)
      : null

  const checkoutTitle =
    checkout?.kind === 'membership'
      ? checkout.typeName
      : checkout?.kind === 'product'
        ? checkout.product.name
        : checkout?.kind === 'course'
          ? checkout.course.title
          : checkout?.kind === 'giftcard'
            ? t('giftCardTitle')
            : ''

  return (
    <div className="min-h-screen w-full" style={{ background: bgStyle, color: textMain }}>
      <div className="max-w-[640px] mx-auto px-5 pb-16">
        <div className="pt-10 flex items-center gap-3">
          {team?.profileImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={team.profileImage}
              alt={team?.name ?? ''}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            <ShoppingBag className="h-9 w-9" style={{ color: accent }} />
          )}
          <div>
            <h1 className="text-xl font-bold leading-tight">{team?.name ?? t('title')}</h1>
            <p className="text-sm" style={{ color: textMuted }}>
              {t('subtitle')}
            </p>
          </div>
        </div>

        {/* Something the page needed didn't load — most often the entitlements
            query, which decides whether an owned course reads "Open" or "Buy".
            Say so rather than letting the page present a partial truth as the
            truth. Shown over an empty catalogue too: "nothing for sale" is then
            still true, but "and we know what you own" is not. */}
        {!loading && showPartialWarning && (
          <div
            role="alert"
            className="mt-6 flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm"
            style={{ background: onDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}
          >
            <span style={{ color: textMuted }}>{t('loadPartial')}</span>
            <button
              type="button"
              onClick={retryCatalogue}
              className="shrink-0 text-xs font-semibold hover:underline"
              style={{ color: accent }}
            >
              {tCommon('errorRetry')}
            </button>
          </div>
        )}

        {/* No till: the shelves, the prices, and how to reach the studio. Above
            the tabs because it governs every one of them. */}
        {priceListMode && !showCatalogueError && (
          <PriceListNotice
            team={team}
            textMain={textMain}
            textMuted={textMuted}
            accent={accent}
            cardBg={cardBg}
            cardBorder={cardBorder}
          />
        )}

        {/* Memberships ⇄ Products ⇄ Courses toggle (only when 2+ surfaces exist) */}
        {showTabs && (
          <div
            className="mt-6 inline-flex rounded-full p-1"
            style={{ background: onDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}
          >
            {availableTabs.map((key) => {
              const active = tab === key
              const label =
                key === 'subscriptions'
                  ? t('tabSubscriptions')
                  : key === 'products'
                    ? t('tabProducts')
                    : key === 'courses'
                      ? t('tabCourses')
                      : t('tabGiftCards')
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key)
                    setTabTouched(true)
                  }}
                  className="rounded-full px-4 py-1.5 text-sm font-medium transition-colors"
                  style={{
                    background: active ? accent : 'transparent',
                    color: active ? '#ffffff' : textMuted,
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}

        {/* `isRestoring` joins `loading` deliberately (UX-37): every card on this
            page prices and unlocks itself from `isAuthenticated`, which is FALSE
            for the whole of a session restore. Painting first would put "Sign in
            to access" on a returning member's own courses and the full price on
            a member's discounted ones — then silently correct itself. A spinner
            for the same half-second states nothing false. */}
        {loading || isRestoring ? (
          <div className="mt-10 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin" style={{ color: textMuted }} />
          </div>
        ) : showCatalogueError ? (
          // The CATALOGUE query is the one that failed, and nothing loaded.
          // "This studio sells nothing" would be a lie told confidently — say the
          // page failed and offer the retry. Painted in the studio's own theme:
          // app tokens go near-black on a dark bio-link theme, i.e. invisible in
          // precisely the case this block exists for.
          <QueryErrorState
            onRetry={retryCatalogue}
            title={t('loadFailed')}
            detail={loadFailureDetail(catalogueLoadError)}
            theme={{ textMain, textMuted, accent, border: cardBorder }}
          />
        ) : catalogueIsEmpty ? (
          // The catalogue loaded and is genuinely empty. True regardless of what
          // else failed — the banner above carries that part. Said differently
          // without a till, where "nothing to buy" would be the wrong half of
          // the truth: there is nothing to buy HERE either way, and what is
          // missing is the studio's published prices.
          <p className="mt-10 text-center text-sm" style={{ color: textMuted }}>
            {priceListMode ? t('priceListEmpty') : t('noItems')}
          </p>
        ) : tab === 'subscriptions' ? (
          <section className="mt-6 space-y-4">
            {!showTabs && (
              <h2
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: textMuted }}
              >
                {t('subscriptionsSection')}
              </h2>
            )}
            {plans.map((plan) => (
              <div
                key={plan.id}
                ref={(el) => {
                  cardRefs.current[plan.id] = el
                }}
                className="rounded-2xl border p-5 transition-shadow"
                style={{
                  background: cardBg,
                  borderColor: focusTypeId === plan.id ? accent : cardBorder,
                  boxShadow: focusTypeId === plan.id ? `0 0 0 1px ${accent}` : undefined,
                }}
              >
                <p className="text-base font-semibold">{plan.name}</p>
                {plan.description && (
                  <p className="mt-1 text-sm" style={{ color: textMuted }}>
                    {plan.description}
                  </p>
                )}
                <div className="mt-3 space-y-2">
                  {(plan.prices ?? []).map((price, i) => (
                    <div key={price.id ?? i} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-sm font-medium">
                          {formatCurrency(price.amount, currency)}
                          {price.credits ? (
                            <span style={{ color: textMuted }}> · {t('creditsCount', { count: price.credits })}</span>
                          ) : (
                            <span style={{ color: textMuted }}> {recurrenceSuffix(price.recurrence)}</span>
                          )}
                        </span>
                        {(price.label || price.included_months) && (
                          <span className="ml-2 text-xs" style={{ color: textMuted }}>
                            {price.label}
                            {price.included_months
                              ? ` · ${t(price.credits ? 'creditsValidMonths' : 'includedMonths', { count: price.included_months })}`
                              : ''}
                          </span>
                        )}
                        {/* THE OFFER, STATED BEFORE PURCHASE — the whole
                            schedule, not just the small number. */}
                        {introTermsOf(price) && (
                          <p className="mt-0.5 text-xs font-medium" style={{ color: accent }}>
                            <IntroOfferLine
                              intro={introTermsOf(price)!}
                              fullAmount={price.amount}
                              recurrence={price.recurrence}
                              currency={currency}
                            />
                          </p>
                        )}
                      </div>
                      {/* UNRENDERED, not disabled, when there is no till: a
                          greyed-out Buy is a door that still looks like a door.
                          The price beside it is the whole point of the page. */}
                      {!priceListMode && (
                        <button
                          type="button"
                          disabled={!price.id}
                          onClick={() =>
                            openMembership(
                              plan.id,
                              plan.name,
                              price,
                              plan.checkout_contact_mode ?? 'minimal'
                            )
                          }
                          className="shrink-0 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
                          style={{ background: accent, color: '#ffffff' }}
                        >
                          {t('buy')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* "Pay per visit" strip — routing only, no purchase here (payment
                always happens in the booking flows). The cross-sell bridge back
                from booking into a membership: benefit chips resolve plan names
                from the aggregator already loaded above. */}
            {/* Dropped entirely without a till, and that is the SAME RULE the
                website already follows: `sections.tsx` keeps membership prices
                (terms the studio charges however it collects them) and hides
                the per-visit drop-in / appointment amounts, because those are
                doors rather than terms. Every row here is one of those doors —
                a per-visit price plus a Book CTA that lands on a flow where
                UX-33 has already suppressed the payable option. */}
            {!priceListMode && payPerVisitActivities.length > 0 && (
              <div className="mt-2 pt-5 border-t" style={{ borderColor: cardBorder }}>
                <h3 className="text-sm font-semibold">{t('payPerVisitHeading')}</h3>
                <p className="mt-0.5 text-xs" style={{ color: textMuted }}>
                  {t('payPerVisitSubtitle')}
                </p>
                <div className="mt-3 space-y-2">
                  {payPerVisitActivities.map((a) => {
                    const chipLabels = resolveActivityTerms({
                      type: a.activityType,
                      dropIn: a.dropIn,
                      durations: a.durations,
                      memberBenefit: a.memberBenefit,
                      durationBenefits: a.durationBenefits,
                      accessRule: a.accessRule,
                    })
                      .filter((term) => term.kind !== 'gate' && term.kind !== 'trial')
                      .map((term) => payPerVisitTermLabel(term))
                      .filter((label): label is string => !!label)
                    // `from: 'shop'` so the flow's back link returns here rather
                    // than to the team's default landing surface.
                    const href =
                      a.activityType === 'appointment'
                        ? publicHref(slug, 'appointments', { activity: a.id, from: 'shop' })
                        : a.slug
                          ? publicSubHref(slug, 'booking', a.slug, { from: 'shop' })
                          : publicHref(slug, 'booking', { from: 'shop' })
                    return (
                      <div
                        key={a.id}
                        className="rounded-xl border p-3 flex items-center justify-between gap-3"
                        style={{ borderColor: cardBorder }}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{a.name}</p>
                          {chipLabels.length > 0 && (
                            <p className="mt-0.5 text-xs truncate" style={{ color: textMuted }}>
                              {chipLabels.join(' · ')}
                            </p>
                          )}
                        </div>
                        <Link
                          href={href}
                          className="shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold"
                          style={{ background: accent, color: '#ffffff' }}
                        >
                          {t('payPerVisitCta')}
                        </Link>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>
        ) : tab === 'products' ? (
          <section className="mt-6 grid grid-cols-2 gap-4">
            {!showTabs && (
              <h2
                className="col-span-2 text-xs font-semibold uppercase tracking-wider"
                style={{ color: textMuted }}
              >
                {t('productsSection')}
              </h2>
            )}
            {products.map((product) => {
              // ONE LINE on the card, the WHOLE note in the modal. A browsing
              // buyer's question is binary ("do they post it, or am I collecting
              // it?") and is answered by the opening words; the terms themselves
              // need room, and a two-column card has none. Truncated on purpose,
              // never the only place it appears.
              const collectionNote = resolveProductCollectionNote(
                product,
                team?.productCollectionNote
              )
              const fromVariant =
                product.variants && product.variants.length > 0
                  ? Math.min(
                      ...product.variants.map((v) =>
                        typeof v.priceAmount === 'number' ? v.priceAmount : product.priceAmount
                      )
                    )
                  : product.priceAmount
              const showFrom =
                product.variants && product.variants.some((v) => typeof v.priceAmount === 'number')
              return (
                <div
                  key={product.id}
                  className="rounded-2xl border overflow-hidden flex flex-col"
                  style={{ background: cardBg, borderColor: cardBorder }}
                >
                  <div
                    className="aspect-square flex items-center justify-center overflow-hidden"
                    style={{ background: onDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                  >
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" />
                    ) : (
                      <ShoppingBag className="h-8 w-8" style={{ color: textMuted }} />
                    )}
                  </div>
                  <div className="p-3 flex flex-col gap-1 flex-1">
                    <p className="text-sm font-semibold leading-tight line-clamp-2">{product.name}</p>
                    {product.description && (
                      <p className="text-xs line-clamp-2" style={{ color: textMuted }}>
                        {product.description}
                      </p>
                    )}
                    <p className="mt-1 text-sm font-medium">
                      {showFrom && (
                        <span className="text-xs font-normal" style={{ color: textMuted }}>
                          {t('priceFrom')}{' '}
                        </span>
                      )}
                      {formatCurrency(fromVariant, currency)}
                    </p>
                    {/* ONE LINE on the card because the modal holds the rest —
                        except when there is no modal to hold it. Without a till
                        the card IS the last screen, and "how do I get it?" is
                        exactly the question a buyer who must come in and pay
                        needs answered, so the note is shown whole. */}
                    {collectionNote && (
                      <p
                        className={`text-xs ${priceListMode ? '' : 'line-clamp-1'}`}
                        style={{ color: textMuted }}
                      >
                        {collectionNote}
                      </p>
                    )}
                    {!priceListMode && (
                      <button
                        type="button"
                        onClick={() => openProduct(product)}
                        className="mt-2 w-full rounded-full px-4 py-2 text-sm font-semibold"
                        style={{ background: accent, color: '#ffffff' }}
                      >
                        {t('buy')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        ) : tab === 'courses' ? (
          <section className="mt-6 grid grid-cols-2 gap-4">
            {!showTabs && (
              <h2
                className="col-span-2 text-xs font-semibold uppercase tracking-wider"
                style={{ color: textMuted }}
              >
                {t('coursesSection')}
              </h2>
            )}
            {courses.map((course) => {
              const access = courseAccess(course)
              const memberPrice = course.accessType === 'purchase' ? courseMemberPrice(course) : null
              const badge =
                course.accessType === 'purchase'
                  ? formatCurrency(course.priceAmount ?? 0, currency)
                  : course.accessType === 'free'
                    ? t('accessFree')
                    : course.accessType === 'subscription'
                      ? t('accessSubscription')
                      : t('accessRegistered')
              const btn = 'mt-auto w-full rounded-full px-4 py-2 text-sm font-semibold inline-flex items-center justify-center gap-1.5'
              return (
                <div
                  key={course.id}
                  className="rounded-2xl border overflow-hidden flex flex-col"
                  style={{ background: cardBg, borderColor: cardBorder }}
                >
                  <div
                    className="aspect-video flex items-center justify-center overflow-hidden"
                    style={{ background: onDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                  >
                    {course.coverImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={course.coverImageUrl} alt={course.title} className="h-full w-full object-cover" />
                    ) : (
                      <GraduationCap className="h-8 w-8" style={{ color: textMuted }} />
                    )}
                  </div>
                  <div className="p-3 flex flex-col gap-1 flex-1">
                    <p className="text-sm font-semibold leading-tight line-clamp-2">{course.title}</p>
                    {course.summary && (
                      <p className="text-xs line-clamp-2" style={{ color: textMuted }}>
                        {course.summary}
                      </p>
                    )}
                    {memberPrice ? (
                      <p className="mt-1 mb-2 text-xs font-medium">
                        <span className="mr-1.5 line-through" style={{ color: textMuted }}>
                          {formatCurrency(memberPrice.base, currency)}
                        </span>
                        <span>{t('memberPrice', { price: formatCurrency(memberPrice.amount, currency) })}</span>
                      </p>
                    ) : (
                      <p className="mt-1 mb-2 text-xs font-medium" style={{ color: textMuted }}>{badge}</p>
                    )}
                    {/* A COURSE IS CONSUMED, NOT ONLY BOUGHT — which is why this
                        tab loses less than the others without a till. Opening
                        one (a free course, a course this contact already owns,
                        a course their membership covers) is not a payment path
                        and keeps working; so does signing in, which is how a
                        member reaches their own. Only the two money controls go:
                        Buy, and the "Get subscription" jump — the latter because
                        the tab it jumps to now sells nothing, so its label would
                        promise a purchase that is not there. The badge above
                        still states the price or the tier, which is what a
                        browsing visitor came for. */}
                    {access === 'open' ? (
                      <Link
                        href={`/public/${slug}/space/courses/${course.slug}?from=shop` as Route}
                        className={btn}
                        style={{ background: accent, color: '#ffffff' }}
                      >
                        <Play className="h-3.5 w-3.5" />
                        {t('openCourse')}
                      </Link>
                    ) : access === 'signin' ? (
                      <button type="button" onClick={() => openSignIn()} className={btn} style={{ background: accent, color: '#ffffff' }}>
                        <LogIn className="h-3.5 w-3.5" />
                        {t('signInToAccess')}
                      </button>
                    ) : access === 'buy' ? (
                      priceListMode ? null : (
                        <button type="button" onClick={() => openCourse(course)} className={btn} style={{ background: accent, color: '#ffffff' }}>
                          {t('buy')}
                        </button>
                      )
                    ) : hasSubscriptions && !priceListMode ? (
                      <button
                        type="button"
                        onClick={() => { setTab('subscriptions'); setTabTouched(true) }}
                        className={btn}
                        style={{ background: accent, color: '#ffffff' }}
                      >
                        <Lock className="h-3.5 w-3.5" />
                        {t('getMembership')}
                      </button>
                    ) : (
                      <p className="mt-auto inline-flex items-center justify-center gap-1.5 text-xs" style={{ color: textMuted }}>
                        <Lock className="h-3.5 w-3.5" />
                        {t('subscriptionRequired')}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        ) : hasGiftCards ? (
          // `hasGiftCards` already folds in the till (see its definition), so
          // this whole branch is unreachable in price-list mode — the tab that
          // selects it is not offered either.
          <section className="mt-6 space-y-4">
            {!showTabs && (
              <h2
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: textMuted }}
              >
                {t('tabGiftCards')}
              </h2>
            )}
            <p className="text-sm" style={{ color: textMuted }}>
              {t('giftCardsSubtitle')}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {giftCardAmounts.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => openGiftCard(amount)}
                  className="rounded-2xl border p-5 text-center transition-shadow hover:shadow-sm"
                  style={{ background: cardBg, borderColor: cardBorder }}
                >
                  <Gift className="mx-auto h-6 w-6" style={{ color: accent }} />
                  <p className="mt-2 text-lg font-semibold">{formatCurrency(amount, currency)}</p>
                  <p className="mt-0.5 text-xs" style={{ color: textMuted }}>
                    {t('buy')}
                  </p>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {/* The studio's own terms — the till had no route to them at all
            (UX-57). Renders nothing for a studio that has published none. */}
        <div className="mt-10 border-t pt-5 text-center" style={{ borderColor: cardBorder }}>
          <PublicStudioTermsLink color={textMuted} />
        </div>
      </div>

      {/* Email → checkout modal */}
      {checkout && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !submitting && setCheckout(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-5"
            style={{ background: cardBg, color: textMain }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{checkoutTitle}</p>
                {checkoutMemberBase ? (
                  <p className="text-xs">
                    <span className="mr-1.5 line-through" style={{ color: textMuted }}>
                      {formatCurrency(checkoutMemberBase.base, currency)}
                    </span>
                    <span>
                      {checkoutMemberBase.via === 'benefit'
                        ? t('memberPrice', { price: formatCurrency(checkoutAmount, currency) })
                        : formatCurrency(checkoutAmount, currency)}
                    </span>
                  </p>
                ) : (
                  <p className="text-xs" style={{ color: textMuted }}>
                    {formatCurrency(checkoutAmount, currency)}{' '}
                    {checkout.kind === 'membership' ? recurrenceSuffix(checkout.price.recurrence) : ''}
                  </p>
                )}
                {/* The plan price above is the RECURRING one and stays that
                    way — the intro is a schedule, not a different price tag, so
                    it is stated as its own sentence rather than by swapping the
                    figure. This is the last screen before Stripe. */}
                {checkout.kind === 'membership' && introTermsOf(checkout.price) && (
                  <p className="mt-1 text-xs font-medium" style={{ color: accent }}>
                    <IntroOfferLine
                      intro={introTermsOf(checkout.price)!}
                      fullAmount={checkout.price.amount}
                      recurrence={checkout.price.recurrence}
                      currency={currency}
                    />
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => !submitting && setCheckout(null)}
                aria-label={t('cancel')}
              >
                <X className="h-4 w-4" style={{ color: textMuted }} />
              </button>
            </div>

            {/* Variant selector for products with options (e.g. sizes) */}
            {checkout.kind === 'product' &&
              checkout.product.variants &&
              checkout.product.variants.length > 0 && (
                <div className="mt-4">
                  <label className="block text-xs font-medium">
                    {checkout.product.variantLabel || t('chooseOption')}
                  </label>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {checkout.product.variants.map((v) => {
                      const active = checkout.variantId === v.id
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => setCheckout({ ...checkout, variantId: v.id })}
                          className="rounded-full border px-3 py-1.5 text-xs font-medium"
                          style={{
                            borderColor: active ? accent : cardBorder,
                            background: active ? accent : 'transparent',
                            color: active ? '#ffffff' : textMain,
                          }}
                        >
                          {v.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

            {checkout.kind === 'course' && (
              <p className="mt-3 text-xs" style={{ color: textMuted }}>
                {t('courseAccessNote')}
              </p>
            )}

            {checkoutCollectionNote && (
              <p className="mt-3 text-xs whitespace-pre-line" style={{ color: textMuted }}>
                {checkoutCollectionNote}
              </p>
            )}

            {/* Promo code — the MODIFIER, ABOVE the tender in the UI as in the
                arithmetic. Product/course only, for the same reason the gift
                card is. */}
            {promoEligible && (
              <div className="mt-4">
                <PromoCodeField
                  teamId={teamId}
                  target={
                    checkout.kind === 'course'
                      ? { kind: 'course', courseId: checkout.course.id }
                      : {
                          kind: 'product',
                          productId: checkout.product.id,
                          ...(checkout.variantId ? { variantId: checkout.variantId } : {}),
                        }
                  }
                  applied={promoApplied}
                  onApplied={setPromoApplied}
                  outcome={checkoutQuote?.promo ?? null}
                  disabled={submitting}
                  colors={{ textMain, textMuted, borderColor: cardBorder, accentColor: accent }}
                />
              </div>
            )}

            {/* Gift card redemption — product/course only (see giftCardEligible). */}
            {giftCardEligible && (
              <div className="mt-4">
                <GiftCardRedeemField
                  teamId={teamId}
                  locale={locale}
                  applied={giftCardApplied}
                  onApplied={setGiftCardApplied}
                  disabled={submitting}
                  colors={{ textMain, textMuted, borderColor: cardBorder, accentColor: accent }}
                />
                {giftCardApplied &&
                  (() => {
                    const plan = planGiftCardRedemption(giftCardApplied.balance, checkoutAmount)
                    if (!plan) return null
                    return (
                      <p className="mt-2 text-xs" style={{ color: textMuted }}>
                        {plan.residual === 0
                          ? t('giftCardFullyCovers')
                          : t('giftCardResidual', {
                              amount: formatCurrency(plan.residual, currency, locale),
                            })}
                      </p>
                    )
                  })()}
              </div>
            )}

            {/* Guest gift-card purchase: no account, one address. The code is
                emailed here, so the field is required — see submit(). */}
            {needsGuestEmail ? (
              <div className="mt-4">
                <label className="block text-xs font-medium" htmlFor="shop-guest-email">
                  {t('giftCardBuyerEmailLabel')}
                </label>
                <input
                  id="shop-guest-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  disabled={submitting}
                  className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  style={{ borderColor: cardBorder, background: 'transparent', color: textMain }}
                />
                <p className="mt-1.5 text-xs" style={{ color: textMuted }}>
                  {t('giftCardBuyerEmailHelp')}
                </p>
                <p className="mt-0.5 text-xs" style={{ color: textMuted }}>
                  {t('giftCardGuestNote')}
                </p>
              </div>
            ) : (
              /* Login-first: the purchase attaches to the signed-in contact via the
                 session. "Switch account" restarts sign-in keeping the checkout pending
                 (e.g. a parent switching to the right child before buying). */
              <div
                className="mt-4 space-y-1 rounded-lg px-3 py-2 text-sm"
                style={{ background: onDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)', color: textMain }}
              >
                <p className="break-words">
                  {contact ? t('buyingAs', { name: `${contact.firstname} ${contact.lastname}` }) : ''}
                </p>
                {/* Own line so a long name never gets truncated by the link */}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={async () => {
                    const c = checkout
                    setCheckout(null)
                    setPendingCheckout(c)
                    await logout()
                    openSignIn({ allowRegistration: true })
                  }}
                  className="block text-xs underline-offset-2 hover:underline"
                  style={{ color: textMuted }}
                >
                  {t('switchAccount')}
                </button>
              </div>
            )}
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="mt-4 flex w-full items-center justify-center rounded-full px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
              style={{ background: accent, color: '#ffffff' }}
            >
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {/* After a `price_changed` refusal the button IS the consent: it
                  names the server's figure, and pressing it re-sends that exact
                  number as the quote. */}
              {acceptedPrice !== null
                ? tPromo('continueAtPrice', {
                    price: formatCurrency(acceptedPrice, currency, locale),
                  })
                : t('continueToPayment')}
            </button>
            {/* The LAST screen before Stripe is the last moment the terms can
                still inform the decision — the same reasoning that put
                BookingTerms above the booking button rather than in the
                confirmation email. */}
            <div className="mt-3 text-center">
              <PublicStudioTermsLink color={textMuted} withIcon={false} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
