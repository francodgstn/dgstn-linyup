import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { CheckCircle2, XCircle } from 'lucide-react'
import { parseSlug } from '@linyup/shared'
import { publicHref } from '@/lib/publicRoutes'
import { RestoreBookingReturn } from './RestoreBookingReturn'
import { ClaimCheckoutSession } from './ClaimCheckoutSession'

export const dynamic = 'force-dynamic'

// Stripe Checkout success/cancel landing (member → studio Connect payments). Lives
// outside /public/[slug] so it must not use usePublicTeam; a `slug` query param
// (set by the checkout callable) lets it link back to the team's shop.
export default async function PayResultPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    slug?: string
    seg?: string
    email?: string
    cs?: string
  }>
}) {
  const { status, slug: rawSlug, seg, email, cs } = await searchParams
  const t = await getTranslations('PayResult')
  const success = status === 'success'
  // This page is reachable with any query — Stripe redirects here, but so does a
  // hand-crafted link. `slug` is interpolated into the CTA href below, so shape it
  // rather than trusting the round-trip: an unparseable slug just hides the CTA.
  const slug = parseSlug(rawSlug)
  // `{CHECKOUT_SESSION_ID}`, substituted by Stripe on the success redirect
  // (connect/checkout.ts). It is what lets this page sign the buyer in instead
  // of asking them for a credential after they have paid (UX-88). Shaped here
  // as well as on the server: this URL is reachable by hand, and an id that is
  // not Stripe's shape has no business being sent to a callable.
  const checkoutSessionId = /^cs_[A-Za-z0-9_]{10,255}$/.test(cs ?? '') ? cs! : null
  // Course purchases land with seg=space — point the buyer to their Space (where they
  // watch). A 'full' membership lands with seg=signup so the buyer finishes their
  // registration (consent + the studio's required fields). Both only on success.
  const toSpace = success && seg === 'space'
  const toSignup = success && seg === 'signup'
  // Drop-in bookings land with seg=booking — point the buyer back to the booking page.
  const toBooking = success && seg === 'booking'
  // Paid appointments land with seg=appointments — point the buyer back to the picker.
  const toAppointments = success && seg === 'appointments'

  // Primary CTA target + label. Built through the shared route helper so the
  // slug can only ever land in a path segment and params are encoded once.
  let ctaHref: Route = publicHref(slug ?? '', 'shop')
  let ctaLabel = t('backToShop')
  if (toSpace) {
    ctaHref = publicHref(slug ?? '', 'space')
    ctaLabel = t('openSpace')
  } else if (toSignup) {
    ctaHref = publicHref(slug ?? '', 'signup', { from: 'checkout', email })
    ctaLabel = t('completeRegistration')
  } else if (toBooking) {
    ctaHref = publicHref(slug ?? '', 'booking', { from: 'checkout' })
    ctaLabel = t('backToBooking')
  } else if (toAppointments) {
    ctaHref = publicHref(slug ?? '', 'booking', { from: 'checkout' })
    ctaLabel = t('backToAppointments')
  }

  const body = success
    ? toSpace
      ? t('successBodyCourse')
      : toSignup
        ? t('successBodySignup')
        : toBooking
          ? t('successBodyBooking')
          : toAppointments
            ? t('successBodyAppointment')
            : t('successBody')
    : t('cancelledBody')

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        {success ? (
          <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
        ) : (
          <XCircle className="mx-auto h-12 w-12 text-muted-foreground" />
        )}
        <h1 className="text-xl font-semibold">
          {success ? t('successTitle') : t('cancelledTitle')}
        </h1>
        {success && slug && checkoutSessionId ? (
          <ClaimCheckoutSession
            checkoutSessionId={checkoutSessionId}
            slug={slug}
            body={body}
            // A course buyer's copy told them to "sign in with this email to
            // start watching". Once the claim has signed them in that
            // instruction is stale, so the signed-in variant drops it. Every
            // other segment keeps its own body: the payment is the news, and
            // being signed in does not change what was bought.
            signedInBody={toSpace ? t('successBodyCourseSignedIn') : body}
            signupHref={publicHref(slug, 'signup', { from: 'checkout', email })}
            // The page's own CTA already IS the registration link when the
            // checkout asked for a full signup — don't offer it twice.
            showSignupLink={!toSignup}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{body}</p>
        )}
        {/* Booking payments came from a flow that may have been running as an
            overlay on the studio's website — put the buyer back there. Falls
            through to the static CTA below when there's nothing to restore. */}
        {toBooking && <RestoreBookingReturn />}
        {slug ? (
          <Link
            href={ctaHref as Route}
            className="inline-block text-sm font-medium text-primary hover:underline"
          >
            {ctaLabel}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">{t('close')}</p>
        )}
      </div>
    </div>
  )
}
