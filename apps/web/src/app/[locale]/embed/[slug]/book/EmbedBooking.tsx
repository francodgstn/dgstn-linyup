'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PublicTeamProvider } from '@/app/[locale]/(public)/public/[slug]/PublicTeamProvider'
import { PublicContactAuthProvider } from '@/app/[locale]/(public)/public/[slug]/PublicContactAuthProvider'
import BookingForm from '@/app/[locale]/(public)/public/[slug]/booking/BookingForm'
import AppointmentPicker from '@/app/[locale]/(public)/public/[slug]/appointments/AppointmentPicker'
import { BookingChromeProvider, type BookingChromeValue } from '@/components/booking/BookingChrome'
import { publicHrefLocalized, publicSubHrefLocalized } from '@/lib/publicRoutes'
import { EMBED_MESSAGE, isFramed, postToHost } from '@/lib/embedBridge'

// ─── The booking panel, as a studio's own website sees it ─────────────────────
//
// The SAME funnel the Linyup-hosted website opens in `BookingOverlay`, hosted
// instead by `public/embed.js` on the studio's page. Nothing about the step
// machine, the pricing or the chrome is duplicated — this is the third host of
// `BookingChrome`, and it reports `kind: 'overlay'` because from the funnel's
// point of view that is exactly what it is: a panel someone can close.
//
// Where it differs from `BookingOverlay`, and why:
//
//   • The DIALOG IS NOT HERE. A panel drawn inside a content-sized iframe can
//     only cover that iframe, so the backdrop, the sizing and the sheet/dialog
//     switch live on the host page. This document IS the panel's contents.
//   • `onClose` and `navigate` are messages, not calls. Closing is the host's to
//     do (it owns the element), and Stripe Checkout refuses to be framed, so the
//     payment handoff has to move the whole window.
//   • Nothing is remembered for the Stripe round-trip. `rememberBookingReturn`
//     writes to this origin's sessionStorage, which is partitioned per host site
//     — the top-level `/pay/result` that Stripe redirects to would not see it.
//     The buyer lands on the app's own confirmation instead, which signs them in
//     and states what they bought (see docs/embed-booking.md → "Paying").
//   • `switchToAppointments` swaps in place, as on the website. Here it is local
//     state: the host does not know what a funnel step is, and must not have to.

interface Props {
  slug: string
  session?: string
  activitySlug?: string
  activityId?: string
  appointmentActivityId?: string
  providerId?: string
  date?: string
  referral?: string
}

export default function EmbedBooking({
  slug,
  session,
  activitySlug,
  activityId,
  appointmentActivityId,
  providerId,
  date,
  referral,
}: Props) {
  const locale = useLocale()
  const t = useTranslations('PublicBooking')
  // Only the APPOINTMENT arm is stateful, because only it can be entered mid-flow
  // (the class funnel hands over to the picker). The class arm's entry props are
  // read once by BookingForm, exactly as on the canonical route.
  const [appointment, setAppointment] = useState<{
    activityId: string
    providerId?: string
    date?: string
  } | null>(appointmentActivityId ? { activityId: appointmentActivityId, providerId, date } : null)

  // Opened directly rather than framed — this route has no chrome of its own, so
  // its Close button would have nothing to talk to and its funnel would dead-end.
  // Send the visitor to the real page instead of rendering a trap.
  const canonical = appointmentActivityId
    ? publicHrefLocalized(locale, slug, 'appointments', {
        activity: appointmentActivityId,
        provider: providerId,
        date,
      })
    : activitySlug
      ? // The slug form is a PATH segment on the canonical route, not a query.
        publicSubHrefLocalized(locale, slug, 'booking', activitySlug, { date, referral })
      : publicHrefLocalized(locale, slug, 'booking', {
          session,
          activity: activityId,
          date,
          referral,
        })
  // Decided in an effect, not during render: the server cannot know whether it
  // is framed, and answering differently on the first client render is a
  // hydration mismatch. The funnel mounts for the instant before the redirect.
  const [unframed, setUnframed] = useState(false)
  useEffect(() => {
    if (isFramed()) return
    setUnframed(true)
    window.location.replace(canonical)
  }, [canonical])

  // Tell the host the panel has something to show. It reveals the frame on this,
  // so a slow network shows the host's spinner rather than a white rectangle.
  //
  // The title rides along because the dialog's accessible name is on the HOST's
  // element, and the host page cannot know the visitor's language — the same
  // reason `FlowShell` draws the visible header in here and not out there.
  useEffect(() => {
    postToHost({ type: EMBED_MESSAGE.ready, title: t('titleBookSession') })
  }, [t])

  // Escape, from inside the panel.
  //
  // The host closes on Escape too, but only while focus is on ITS page — the
  // keystroke that matters lands in this frame, and a cross-origin parent never
  // sees it. So the panel has to say so itself; this is the half that actually
  // fires in practice.
  //
  // A popup layer inside the funnel (a select, the waiver sheet, a confirm
  // dialog) owns Escape while it is open: closing the whole panel out from under
  // one would throw away a half-filled form to dismiss a dropdown.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]'
        )
      )
        return
      postToHost({ type: EMBED_MESSAGE.close })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const chrome = useMemo<BookingChromeValue>(
    () => ({
      kind: 'overlay',
      onClose: () => postToHost({ type: EMBED_MESSAGE.close }),
      // Absolute: the host resolves this against ITS own page, where a
      // root-relative Linyup path means something else entirely.
      navigate: (href) =>
        postToHost({
          type: EMBED_MESSAGE.navigate,
          href: new URL(href, window.location.href).toString(),
        }),
      switchToAppointments: (id) => setAppointment({ activityId: id }),
    }),
    []
  )

  if (unframed) return null

  // `h-dvh`, so FlowShell's overlay branch (`h-full`) fills the frame the host
  // sized, and the funnel's sticky bar sits on the panel's bottom edge.
  return (
    <div className="h-dvh overflow-hidden bg-background">
      <PublicTeamProvider slug={slug}>
        <PublicContactAuthProvider>
          <BookingChromeProvider value={chrome}>
            {appointment ? (
              <AppointmentPicker
                key={appointmentKey(appointment)}
                slug={slug}
                presetActivityId={appointment.activityId}
                presetProviderId={appointment.providerId}
                presetDate={appointment.date}
                from="site"
                disableStepUrl
              />
            ) : (
              <BookingForm
                slug={slug}
                from="site"
                initialSession={session}
                preSelectedActivitySlug={activitySlug}
                initialActivityId={activityId}
                initialDate={date}
                referral={referral}
                // The host page owns the address bar. A `pushState` in here would
                // land in the TOP window's joint session history, so the visitor's
                // Back button would walk the funnel's steps instead of leaving the
                // studio's page — and the host's own "Back closes the panel" entry
                // would be buried under them.
                disableStepUrl
              />
            )}
          </BookingChromeProvider>
        </PublicContactAuthProvider>
      </PublicTeamProvider>
    </div>
  )
}

/** Remount the picker when the intent changes, so a swap starts clean. */
function appointmentKey(a: { activityId: string; providerId?: string; date?: string }): string {
  return `appointment:${a.activityId}:${a.providerId ?? ''}:${a.date ?? ''}`
}
