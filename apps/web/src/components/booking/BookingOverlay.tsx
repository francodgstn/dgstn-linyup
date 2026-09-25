'use client'

import { useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import BookingForm from '@/app/[locale]/(public)/public/[slug]/booking/BookingForm'
import { rememberBookingReturn } from '@/lib/bookingReturn'
import { BookingChromeProvider, type BookingChromeValue } from './BookingChrome'

// ─── BookingOverlay ───────────────────────────────────────────────────────────
//
// The class booking funnel running ON TOP of the studio's website, so a visitor
// who clicks a class in the schedule never leaves the page they were reading.
// `/public/{slug}/booking` stays the canonical route and is unaffected — it is
// still what emails, QR codes, the bio-link and the Stripe return point at.
//
// The panel hosts the SAME `BookingForm`; only the chrome differs (see
// FlowShell). Nothing about the step machine is duplicated here.

/** What the visitor clicked. Mirrors the canonical route's param contract. */
export type BookIntent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'activity'; activitySlug: string }
  /**
   * An appointment activity — hosts the slot picker instead of the class funnel.
   * `providerId`/`date` come from a clicked availability window, which already
   * knows whose time it is and which day: without them the picker would ask the
   * visitor to choose all over again what they just clicked on.
   */
  | { kind: 'appointment'; activityId: string; providerId?: string; date?: string }
  | { kind: 'root' }

export interface BookingOverlayProps {
  slug: string
  intent: BookIntent | null
  /** Swap to the appointment picker in place (the host also updates the URL). */
  /**
   * The session a SUCCESSFUL Stripe payment just confirmed, vouched for by
   * /pay/result — never inferred from the URL. Opens the funnel on its
   * confirmation step instead of asking the buyer to book again.
   *
   * An id rather than a boolean so the confirmation is pinned to the booking it
   * belongs to: it must not carry over to a different class the visitor opens
   * afterwards.
   */
  paidSessionId?: string | null
  onClose: () => void
}

export function BookingOverlay({
  slug,
  intent,
  paidSessionId,
  onClose,
}: BookingOverlayProps) {
  const t = useTranslations('PublicBooking')
  const isDesktop = useMediaQuery('(min-width: 640px)')

  const chrome = useMemo<BookingChromeValue>(
    () => ({
      kind: 'overlay',
      onClose,
      // Leaving for another route (Stripe, the appointment picker). No close
      // first: a full-page navigation discards the panel anyway, and closing
      // rewrites the URL we want to remember. Deliberately captured BEFORE the
      // navigation so /pay/result can bring the buyer back to this exact page.
      navigate: (href) => {
        if (typeof window === 'undefined') return
        rememberBookingReturn(window.location.pathname + window.location.search)
        window.location.href = href
      },
    }),
    [onClose]
  )

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose()
    },
    [onClose]
  )

  const open = intent !== null

  // Remount per intent so a second click on a different class starts clean
  // rather than resuming the previous funnel's step.
  const body = intent ? (
    <BookingChromeProvider value={chrome}>
      {/* One funnel for every kind of offer. An appointment used to be a second
          component swapped in here; it is a step inside this one now. */}
      <BookingForm
        key={intentKey(intent)}
        slug={slug}
        from="site"
        initialSession={intent.kind === 'session' ? intent.sessionId : undefined}
        preSelectedActivitySlug={intent.kind === 'activity' ? intent.activitySlug : undefined}
        initialActivityId={intent.kind === 'appointment' ? intent.activityId : undefined}
        initialProviderId={intent.kind === 'appointment' ? intent.providerId : undefined}
        initialDate={intent.kind === 'appointment' ? intent.date : undefined}
        confirmedSessionId={
          // Only when the confirmed booking IS the one being shown.
          intent.kind === 'session' && paidSessionId === intent.sessionId
            ? intent.sessionId
            : undefined
        }
        // The host page owns the URL while the overlay is open, so the funnel
        // must not also write history entries — two writers would fight and
        // Back would need two presses to close.
        disableStepUrl
      />
    </BookingChromeProvider>
  ) : null

  // Fixed heights, not `max-h`: the funnel's steps differ a lot in length
  // (activity list vs. two-column session grid vs. five-field form) and a panel
  // that resizes under the visitor between steps reads as a glitch.
  // `dvh` not `vh` — with `vh`, iOS Safari's collapsing URL bar pushes the
  // sticky Confirm button below the fold.
  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* FlowShell's overlay header already carries a Close button, aligned
            with the activity title. The built-in one is absolutely positioned
            and would sit on top of it (and over the title on narrow panels). */}
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(92vh,860px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        >
          {/* The funnel's own step headings are plain <h1>s, so the dialog has no
              accessible name without this. Visually hidden — FlowShell draws the
              visible header. */}
          <DialogHeader className="sr-only">
            <DialogTitle>{t('titleBookSession')}</DialogTitle>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {/* Same reason as the dialog above — FlowShell draws the only Close. */}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="flex h-[92dvh] flex-col gap-0 overflow-hidden rounded-t-2xl p-0"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{t('titleBookSession')}</SheetTitle>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  )
}

function intentKey(intent: BookIntent): string {
  if (intent.kind === 'session') return `session:${intent.sessionId}`
  if (intent.kind === 'activity') return `activity:${intent.activitySlug}`
  if (intent.kind === 'appointment')
    return `appointment:${intent.activityId}:${intent.providerId ?? ''}:${intent.date ?? ''}`
  return 'root'
}
