'use client'

// /public/{slug}/waitlist?token=… — one page, two modes.
//
// WHICH TOKEN matched decides what the holder may do, and the server decides
// that, not the URL: `getWaitlistEntry` tries the single-use `offer_token`
// first and falls back to the long-lived `entry_token`. So a join-confirmation
// link (forwardable, and forwarded) can only ever show a status view, while the
// claim credential — minted per offer, deleted the moment the offer resolves —
// is the only thing that can take the seat.
//
// It is a callable rather than a client read because it has to be: the queue is
// readable only by team members and by a contact reading their OWN entry
// through a contact session, and a guest who joined from the public form has
// neither. The token in their mail is their whole identity here.
//
// Money is settled here and nowhere else in the queue's lifecycle. A free claim
// (covered by a membership, or a credit) finishes inline; a payable one takes
// the ordinary drop-in checkout with the offer token attached, so there is no
// second pricing path to keep in step with the first.

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { httpsCallable } from 'firebase/functions'
import { useLocale, useTranslations } from 'next-intl'
import { CalendarDays, CheckCircle2, Clock, MapPin, Users, XCircle } from 'lucide-react'
import type { WaitlistStatus } from '@linyup/shared'
import { functions } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCurrency } from '@/lib/format'
import {
  GiftCardRedeemField,
  giftCardCheckoutErrorMessage,
  type AppliedGiftCard,
} from '@/components/booking/GiftCardRedeemField'
import { WaiverStep } from '@/components/booking/WaiverStep'
import { BookingTerms, resolveCancellationPolicy } from '@/components/booking/BookingTerms'
import { useWaiverGate } from '@/hooks/useWaiverGate'
import { waiverErrorMessage } from '@/lib/waiver'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicFormat } from '../usePublicFormat'
import { type RegionalFormatter } from '@linyup/shared'

export const dynamic = 'force-dynamic'

// ─── types ────────────────────────────────────────────────────────────────────

interface WaitlistEntryView {
  mode: 'claim' | 'status'
  status: WaitlistStatus
  position: number | null
  /** Was a seat ever actually held for this person? `expired` is written both
   *  when an offer's window ran out and when the queue was closed without ever
   *  reaching them (the class ran, or was called off) — the two endings read
   *  completely differently to the person, and this is what separates them. */
  wasOffered: boolean
  firstname: string
  lastname: string
  email: string | null
  teamId: string
  sessionId: string
  offerExpiresAt: string | null
  session: {
    start: string | null
    end: string | null
    location: string | null
    /** Needed so the consent step resolves the SAME scope the claim's own gate
     *  does — a null would exclude an activity-scoped waiver here while the
     *  server still enforced it. */
    activityId: string | null
    activityName: string | null
    cancelled: boolean
    /** The activity's cancellation-terms override; null ⇒ use the team default. */
    cancellationPolicy: string | null
  }
  team: { name: string; slug: string | null }
}

interface ClaimResult {
  requiresPayment: boolean
  amount?: number
  claimExpiresAt?: string
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatSessionDate(fmt: RegionalFormatter, iso: string | null): string {
  if (!iso) return ''
  return fmt.custom(new Date(iso), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function formatSessionTime(fmt: RegionalFormatter, startIso: string | null, endIso: string | null): string {
  if (!startIso) return ''
  const start = fmt.time(new Date(startIso))
  return endIso ? `${start} – ${fmt.time(new Date(endIso))}` : start
}

/**
 * Whole minutes left, ticking. The deadline is the SAME instant everywhere —
 * the booking hold's `expires_at`, the entry's `offer_expires_at` and (once a
 * payable claim reaches Stripe) the checkout session's expiry — so a countdown
 * that disagreed with the server would be promising time the seat does not have.
 */
function useCountdown(deadlineIso: string | null): number | null {
  const [msLeft, setMsLeft] = useState<number | null>(() =>
    deadlineIso ? new Date(deadlineIso).getTime() - Date.now() : null
  )
  useEffect(() => {
    if (!deadlineIso) {
      setMsLeft(null)
      return
    }
    const deadline = new Date(deadlineIso).getTime()
    const tick = () => setMsLeft(deadline - Date.now())
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [deadlineIso])
  return msLeft
}

function formatMinutesLeft(msLeft: number, locale: string): string {
  const minutes = Math.max(0, Math.round(msLeft / 60_000))
  if (minutes < 60) return new Intl.NumberFormat(locale).format(minutes) + ' min'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** The reason codes every claim path throws, mapped to the copy this page owns.
 *  `claimWaitlistSeat`, `createDropInCheckout` and the promoter all speak the
 *  same vocabulary, which is why this is one table and not three. */
function claimErrorKey(err: unknown): string {
  const e = err as { code?: string; details?: { reason?: string } }
  switch (e.details?.reason) {
    case 'claim_expired':
      return 'claimExpired'
    case 'already_claimed':
      return 'claimTaken'
    case 'booking_closed':
      return 'claimClosed'
    case 'claim_window_too_short':
      return 'claimWindowTooShort'
    // The price the surface showed is no longer the price the server resolves.
    // DOUBLY unreachable from this page: the guard fires only on a checkout that
    // carried a promo code (`assertQuotedAmount`), and by decision this rail
    // carries no promo field — and it sends no `quotedAmount` either. Mapped all
    // the same: the day it can fire, the refusal must already have copy rather
    // than falling through to "something went wrong".
    case 'price_changed':
      return 'priceChanged'
    // Every coverage denial the resolver can return for a class seat, and ALL of
    // them belong here. `not_joined` is not an exotic one: an activity with no
    // explicit accessRule and `isFreeTrial: false` resolves to `{type:'members'}`
    // (resolveActivityAccessRule), and joining the queue is deliberately NOT
    // gated on access — the badge on the public form is a warning, the claim is
    // the gate — so a prospect who was offered a seat and is refused at the claim
    // is the ordinary shape of this page's most important error, not an edge.
    // Missing it here rendered "something went wrong" instead of the copy that
    // was written for exactly this case.
    case 'not_joined':
    case 'no_subscription':
    case 'no_credits':
    case 'limit_reached':
      return 'claimNoAccess'
    default:
      return e.code === 'functions/not-found' ? 'invalidLink' : 'errorGeneric'
  }
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function WaitlistPage() {
  const t = useTranslations('Waitlist')
  const tShop = useTranslations('Shop')
  const tWaiver = useTranslations('Waiver')
  const locale = useLocale()
  const fmt = usePublicFormat()
  const { slug, team } = usePublicTeam()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const currency = team.default_currency ?? 'CHF'

  const [entry, setEntry] = useState<WaitlistEntryView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [payment, setPayment] = useState<{ amount: number } | null>(null)
  const [giftCard, setGiftCard] = useState<AppliedGiftCard | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [left, setLeft] = useState(false)

  // ── The consent step, INSIDE the claim window ─────────────────────────────
  // It adds no second timer: a waiver is not a price modifier and holds nothing,
  // so the tick happens inside the existing deadline and consumes none of it
  // beyond the seconds it takes to read. (`docs/waitlist.md`'s single-deadline
  // rule is why a promo code is refused on this rail; the reasoning is cited
  // rather than inherited, because it does not carry.)
  //
  // THIS RAIL USED TO PRESENT A WAIVER RATHER THAN GATE ON IT, and no longer
  // does. The exception existed only for a guardian's emailed signature — a link
  // ran 72 hours against a claim window whose floor is 35 minutes, and the entry
  // gets one offer ever, so refusing spent that offer on a document nobody could
  // complete in time. The consent step is now completable by the claimant on
  // this screen, inside the window, so the claim is gated like every other rail
  // and no booking in the product commits with a waiver unsigned.
  const waiverGate = useWaiverGate({
    teamId: entry?.teamId ?? null,
    requiredWaivers: team.required_waivers,
    activityId: entry?.session.activityId ?? null,
  })
  const [claimStep, setClaimStep] = useState<'idle' | 'waiver'>('idle')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fn = httpsCallable<{ token: string }, WaitlistEntryView>(functions, 'getWaitlistEntry')
      const res = await fn({ token })
      setEntry(res.data)
    } catch (err: unknown) {
      // Every failure here is the same failure TO THE READER: the link no longer
      // opens anything. The offer token is DELETED when an offer resolves, so
      // "expired" and "already claimed" are genuinely indistinguishable from
      // outside — and must be, or the credential would outlive its own offer.
      //
      // They are NOT indistinguishable to us, and the log is where that
      // distinction has to live: without it, a broken callable and a spent offer
      // both read as "invalid link" from the inside too.
      reportPublicLoadFailure('waitlist/entry', err)
      setError(t('invalidLink'))
    } finally {
      setLoading(false)
    }
  }, [token, t])

  useEffect(() => {
    if (token) load()
    else setLoading(false)
  }, [token, load])

  const msLeft = useCountdown(entry?.offerExpiresAt ?? null)
  const lapsed = msLeft !== null && msLeft <= 0

  const handleClaim = async () => {
    if (!entry) return
    setBusy(true)
    setError(null)
    try {
      // The consent step, once. On the SECOND pass — the step's own Confirm —
      // `ensure` is skipped rather than re-asked, so the version the claimant
      // just read is not replaced under them.
      if (waiverGate.applies && claimStep === 'idle') {
        const clear = await waiverGate.ensure({
          email: entry.email ?? undefined,
          firstname: entry.firstname,
          lastname: entry.lastname,
        })
        if (!clear) {
          setClaimStep('waiver')
          return
        }
      }
      const waiverAcceptances = waiverGate.acceptances

      const fn = httpsCallable<Record<string, unknown>, ClaimResult>(
        functions,
        'claimWaitlistSeat'
      )
      const res = await fn({
        offerToken: token,
        teamId: entry.teamId,
        sessionId: entry.sessionId,
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
      })
      if (res.data.requiresPayment) {
        // Nothing was written server-side — an abandoned pay screen has to leave
        // the offer exactly as it was, still claimable until its own deadline.
        setPayment({ amount: res.data.amount ?? 0 })
      } else {
        setClaimed(true)
      }
    } catch (err: unknown) {
      // A waiver refusal on this rail means the requirement moved under the
      // claimant. Re-present.
      // `recover` forces the resolve: an offer can outlive the mirror write that
      // was supposed to list the waiver, and `ensure` would answer "clear" from
      // its `!applies` line — leaving this claimant with a sentence, no step,
      // and exactly one offer they can never use.
      const waiverMsg = waiverErrorMessage(err, tWaiver)
      if (waiverMsg) {
        setClaimStep('idle')
        const presented = await waiverGate.recover(err, {
          email: entry.email ?? undefined,
          firstname: entry.firstname,
          lastname: entry.lastname,
        })
        if (presented) {
          setClaimStep('waiver')
          return
        }
        setError(waiverMsg)
        return
      }
      setError(t(claimErrorKey(err)))
    } finally {
      setBusy(false)
    }
  }

  const handlePay = async () => {
    if (!entry) return
    setBusy(true)
    setError(null)
    try {
      const fn = httpsCallable<
        Record<string, unknown>,
        { url?: string | null; paidWithGiftCard?: boolean }
      >(functions, 'createDropInCheckout')
      const res = await fn({
        teamId: entry.teamId,
        sessionId: entry.sessionId,
        // The token names the payer, so no contactDetails: the seat is already
        // held for one specific person and nobody else may buy it.
        waitlistToken: token,
        slug,
        locale,
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
        ...(giftCard ? { giftCardCode: giftCard.code } : {}),
        // NO SECOND PROMPT ACROSS THE PAYABLE HOP. A payable claim returns
        // `requiresPayment` and writes nothing — it never even reaches its own
        // gate — so the tick collected on the claim step has to ride the
        // checkout that actually books the seat.
        ...(waiverGate.acceptances.length
          ? { waiverAcceptances: waiverGate.acceptances }
          : {}),
      })
      // A gift card that covers the whole price moves no money through Stripe —
      // there is no session to redirect to, the seat is simply confirmed.
      if (res.data?.paidWithGiftCard) {
        setClaimed(true)
        return
      }
      if (res.data?.url) {
        window.location.href = res.data.url
        return
      }
      setError(t('errorGeneric'))
    } catch (err: unknown) {
      setError(giftCardCheckoutErrorMessage(err, tShop) ?? t(claimErrorKey(err)))
    } finally {
      setBusy(false)
    }
  }

  const handleLeave = async () => {
    setBusy(true)
    setError(null)
    try {
      const fn = httpsCallable<{ entryToken: string }, { ok: boolean }>(functions, 'leaveWaitlist')
      await fn({ entryToken: token })
      setLeft(true)
      setShowLeaveConfirm(false)
    } catch (err: unknown) {
      setError(t(claimErrorKey(err)))
    } finally {
      setBusy(false)
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  if (!token) return <p className="text-muted-foreground">{t('invalidLink')}</p>

  if (loading) {
    return (
      <div className="space-y-4 max-w-lg">
        <Skeleton className="h-7 w-56" />
        <div className="rounded-xl border p-5 space-y-3">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="text-center py-12 space-y-3">
        <XCircle className="h-12 w-12 text-muted-foreground mx-auto" />
        <p className="text-muted-foreground">{error ?? t('invalidLink')}</p>
      </div>
    )
  }

  if (claimed) {
    return (
      <div className="text-center py-12 space-y-3">
        <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
        <p className="font-semibold text-lg">{t('claimSuccess')}</p>
        <p className="text-sm text-muted-foreground">{t('claimSuccessBody')}</p>
      </div>
    )
  }

  if (left) {
    return (
      <div className="text-center py-12 space-y-3">
        <Users className="h-12 w-12 text-muted-foreground mx-auto" />
        <p className="font-semibold text-lg">{t('leftTitle')}</p>
      </div>
    )
  }

  const isClaim = entry.mode === 'claim' && entry.status === 'offered'
  const sessionCard = (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div className="flex items-start gap-2">
        <CalendarDays className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium">{entry.session.activityName ?? entry.team.name}</p>
          <p className="text-sm text-muted-foreground">
            {formatSessionDate(fmt, entry.session.start)}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatSessionTime(fmt, entry.session.start, entry.session.end)}
          </p>
        </div>
      </div>
      {entry.session.location && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4 shrink-0" />
          <span>{entry.session.location}</span>
        </div>
      )}
      {entry.session.cancelled && (
        <p className="text-sm font-medium text-destructive">{t('sessionCancelled')}</p>
      )}
    </div>
  )

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {isClaim ? t('claimTitle') : t('statusTitle')}
        </h1>
        {isClaim && (
          <p className="text-muted-foreground mt-1 text-sm">
            {t('claimSubtitle', { team: entry.team.name })}
          </p>
        )}
      </div>

      {/* The countdown is the claim view's whole point: a seat held for you, and
          for how much longer. Once it hits zero the buttons go — the server
          would refuse anyway, and a live button that always fails is worse than
          none. */}
      {isClaim && msLeft !== null && (
        <div
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
            lapsed
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <Clock className="h-4 w-4 shrink-0" />
          <span>
            {lapsed ? t('claimExpiredNow') : t('claimExpiresIn', { time: formatMinutesLeft(msLeft, locale) })}
          </span>
        </div>
      )}

      {sessionCard}

      {/* ── The consent step, inside the claim window ────────────────────── */}
      {isClaim && !lapsed && !payment && claimStep === 'waiver' && (
        <WaiverStep gate={waiverGate} teamName={entry.team.name} disabled={busy} />
      )}

      {/* The terms, on the screen that takes the seat. This is the one claim
          surface where the window is minutes long, so "it's in the confirmation
          email" is no answer at all — and the seat this button accepts is
          exactly the one the no-show fee counts against. Shown above BOTH the
          free claim and the paid one; renders null when the studio has neither
          a policy nor a fee. */}
      {isClaim && !lapsed && (
        <BookingTerms
          cancellationPolicy={resolveCancellationPolicy(
            entry.session.cancellationPolicy,
            team.bookingCancellationPolicy
          )}
          noShowPolicy={team.noShowPolicy}
          currency={currency}
          locale={locale}
        />
      )}

      {/* ── Claim ───────────────────────────────────────────────────────── */}
      {isClaim && !lapsed && !payment && (
        <Button
          onClick={handleClaim}
          // `waiverGate.ready` and not a bare predicate over the item list: over
          // the empty list a FAILED load leaves behind, that would be `true`,
          // which put a live Claim on an error screen.
          disabled={busy || (claimStep === 'waiver' && !waiverGate.ready)}
          className="w-full"
        >
          {busy ? t('claiming') : t('claimCta')}
        </Button>
      )}

      {/* The price the resolver returned for THIS person — a member rate, a
          drop-in price, whatever their own coverage worked out to. It is shown
          only after they asked to claim, because resolving it is what proves
          the offer is still theirs. */}
      {isClaim && !lapsed && payment && (
        <div className="space-y-4">
          <div>
            <h2 className="font-semibold">{t('claimPayTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('claimPaySubtitle')}</p>
          </div>

          <GiftCardRedeemField
            teamId={entry.teamId}
            locale={locale}
            applied={giftCard}
            onApplied={setGiftCard}
            disabled={busy}
          />

          <div className="flex items-center justify-between rounded-xl border bg-muted/30 p-4 text-sm font-semibold">
            <span>{t('claimPriceLabel')}</span>
            <span>{formatCurrency(payment.amount, currency, locale)}</span>
          </div>

          <Button onClick={handlePay} disabled={busy} className="w-full">
            {busy ? t('claiming') : t('claimPayCta')}
          </Button>
        </div>
      )}

      {/* ── Status ──────────────────────────────────────────────────────────
          Status-first, so an unknown position degrades to "you are on the list"
          rather than to whichever branch happened to be last. A position is
          DERIVED at read time and the queue scan is bounded, so null is a real
          (if rare) outcome on a very long queue — and telling someone their
          offer expired when it has not is the one wrong answer here. */}
      {!isClaim && (
        <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm">
          {entry.status === 'offered'
            ? t('statusOffered')
            : entry.status === 'claimed'
              ? t('statusClaimed')
              : entry.status === 'left'
                ? t('statusLeft')
                : entry.status === 'expired'
                  ? // Two endings, one status. Someone who held an offer missed a
                    // seat that was really theirs; someone who only ever waited
                    // was never offered anything, and telling them their "offer
                    // expired" invents a seat they never had — and reads as if
                    // they had missed a mail that was never sent.
                    entry.wasOffered
                    ? t('statusExpired')
                    : t('statusQueueClosed')
                  : entry.position !== null
                    ? t('statusPosition', { position: entry.position })
                    : t('statusWaiting')}
        </div>
      )}

      {/* Leaving is offered on the status view only — the claim view's own
          "no thanks" is simply not claiming, and the offer rolls on by itself.
          `leaveWaitlist` applies the same guard the sweep does, so clicking an
          older link after claiming can never delete the seat that was bought. */}
      {!isClaim && (entry.status === 'waiting' || entry.status === 'offered') && (
        showLeaveConfirm ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
            <p className="text-sm font-medium">{t('leaveConfirm')}</p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleLeave}
                disabled={busy}
                className="flex-1"
              >
                {busy ? t('leaving') : t('leaveConfirmYes')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowLeaveConfirm(false)}
                disabled={busy}
                className="flex-1"
              >
                {t('leaveConfirmNo')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/5"
            onClick={() => setShowLeaveConfirm(true)}
          >
            {t('leaveCta')}
          </Button>
        )
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
