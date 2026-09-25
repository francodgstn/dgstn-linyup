'use client'

// /public/{slug}/course-waitlist?token=… — one page, two modes.
//
// The sibling of /public/{slug}/waitlist, which does this for a class seat. The
// shape is deliberately the same, because the person's question is the same:
// "have I got in, and what do I do now?"
//
// WHICH TOKEN MATCHED decides what they may do, and the SERVER decides that,
// not the URL. `getCourseWaitlistEntry` tries the single-use `offer_token`
// first and the long-lived `entry_token` second, so a forwarded join
// confirmation can only ever show a status view while the claim credential is
// the one thing that can take the place.
//
// Money is settled here and nowhere else in the queue's life. A free claim
// (covered by a plan, or a free course) finishes inline; a payable one leaves
// through the ORDINARY course checkout carrying the offer token, so there is no
// second pricing path to keep in step with the first, and the Stripe session is
// clamped to the offer's own deadline rather than given a fresh window.

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CalendarDays, CheckCircle2, MapPin, Users, XCircle } from 'lucide-react'
import type { CourseWaitlistStatus, RegionalFormatter } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCurrency } from '@/lib/format'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { callFunction } from '@/lib/callFunction'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicFormat } from '../usePublicFormat'

export const dynamic = 'force-dynamic'

interface CourseWaitlistView {
  mode: 'claim' | 'status'
  status: CourseWaitlistStatus
  position: number | null
  /** Was a place ever actually held for them? `expired` is written both when an
   *  offer lapsed and when the queue closed without ever reaching them, and the
   *  two endings read completely differently to the person. */
  wasOffered: boolean
  firstname: string
  teamId: string
  blockId: string
  contactId: string
  offerExpiresAt: string | null
  course: {
    name: string
    description: string | null
    firstMeeting: string | null
    lastMeeting: string | null
    lessons: number
    location: string | null
    providerName: string | null
    priceAmount: number | null
    cancelled: boolean
  }
  team: { name: string; slug: string | null }
}

function formatDay(fmt: RegionalFormatter, iso: string | null): string {
  if (!iso) return ''
  return fmt.custom(new Date(iso), { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function CourseWaitlistPage() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const t = useTranslations('CourseWaitlist')
  const fmt = usePublicFormat()
  const { team } = usePublicTeam()

  const [view, setView] = useState<CourseWaitlistView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [claimed, setClaimed] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setError(t('noToken'))
      setLoading(false)
      return
    }
    try {
      const res = await callFunction<{ token: string }, CourseWaitlistView>(
        'getCourseWaitlistEntry'
      )({ token })
      setView(res.data)
      setError(null)
    } catch (err) {
      reportPublicLoadFailure('course-waitlist', err)
      setError(t('invalidLink'))
    } finally {
      setLoading(false)
    }
  }, [token, t])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Take the place.
   *
   * The FREE rail is tried first and the payable answer comes back from the
   * server as a refusal, which is the only way round asking the client to price
   * anything: `resolvePaymentOptions` knows what plans this person holds and a
   * public page does not. A `payment_required` therefore is not an error, it is
   * the other branch, and the offer still stands while they take it.
   */
  async function claim() {
    if (!view || busy) return
    setBusy(true)
    setError(null)
    try {
      await callFunction<
        { blockId: string; contactId: string; offerToken: string },
        { settled: boolean }
      >('claimCourseBlockPlace')({
        blockId: view.blockId,
        contactId: view.contactId,
        offerToken: token,
      })
      setClaimed(true)
    } catch (err) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason
      if (reason === 'payment_required') {
        await pay()
        return
      }
      setError(
        reason === 'expired'
          ? t('offerExpired')
          : ((err as Error)?.message ?? t('claimFailed'))
      )
    } finally {
      setBusy(false)
    }
  }

  /** The payable branch: the ordinary course checkout, carrying the offer token
   *  so the place that is already held is the one paid for. */
  async function pay() {
    if (!view) return
    setBusy(true)
    try {
      const res = await callFunction<
        Record<string, unknown>,
        { url?: string | null }
      >('createCourseBlockCheckout')({
        teamId: view.teamId,
        blockId: view.blockId,
        contactId: view.contactId,
        slug: view.team.slug ?? team?.slug ?? '',
        origin: window.location.origin,
        waitlistToken: token,
      })
      if (res.data?.url) window.location.href = res.data.url
      else setError(t('claimFailed'))
    } catch (err) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason
      setError(
        reason === 'claim_window_too_short'
          ? t('windowTooShort')
          : reason === 'expired'
            ? t('offerExpired')
            : ((err as Error)?.message ?? t('claimFailed'))
      )
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error && !view) {
    return (
      <div className="mx-auto max-w-lg p-4 text-center">
        <XCircle className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (!view) return null

  const c = view.course
  const dates =
    c.firstMeeting && c.lastMeeting
      ? `${formatDay(fmt, c.firstMeeting)} – ${formatDay(fmt, c.lastMeeting)}`
      : formatDay(fmt, c.firstMeeting)

  // The course card, shown in every mode: whatever the answer is, it is about
  // this course and the person needs to recognize it.
  const card = (
    <div className="rounded-lg border p-4">
      <h2 className="font-medium">{c.name}</h2>
      {c.description && <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>}
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <span>{dates}</span>
        </div>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span>{t('lessons', { count: c.lessons })}</span>
        </div>
        {c.location && (
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span>{c.location}</span>
          </div>
        )}
        {c.priceAmount != null && (
          <div className="font-medium">
            {formatCurrency(c.priceAmount, team?.default_currency ?? 'CHF', fmt.locale)}
          </div>
        )}
      </dl>
    </div>
  )

  if (claimed) {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-4">
        <div className="text-center">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-600" />
          <h1 className="text-lg font-semibold">{t('claimedTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('claimedBody', { name: c.name })}
          </p>
        </div>
        {card}
      </div>
    )
  }

  const offerLive =
    view.mode === 'claim' &&
    view.status === 'offered' &&
    !!view.offerExpiresAt &&
    new Date(view.offerExpiresAt).getTime() > Date.now()

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">
          {offerLive ? t('offerTitle') : t('statusTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {offerLive
            ? t('offerBody', { name: view.firstname })
            : view.status === 'waiting'
              ? view.position
                ? t('waitingWithPosition', { position: view.position })
                : t('waiting')
              : view.status === 'claimed'
                ? t('alreadyOn')
                : // `expired` covers two very different endings, which is what
                  // `wasOffered` separates: an offer that ran out, or a queue
                  // that closed without ever reaching them.
                  view.wasOffered
                  ? t('offerExpired')
                  : t('queueClosed')}
        </p>
      </div>

      {card}

      {offerLive && (
        <>
          <p className="text-sm">
            {t('heldUntil', {
              when: fmt.custom(new Date(view.offerExpiresAt!), {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </p>
          <Button className="w-full" onClick={claim} disabled={busy}>
            {busy ? t('working') : c.priceAmount != null ? t('takeAndPay') : t('take')}
          </Button>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
