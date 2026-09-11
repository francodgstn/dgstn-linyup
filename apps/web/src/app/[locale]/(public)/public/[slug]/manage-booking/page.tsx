'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { httpsCallable } from 'firebase/functions'
import { useTranslations } from 'next-intl'
import { functions } from '@/lib/firebase'
import {
  callableErrorCode,
  cancelEffectKeys,
  cancelFailureIsRetryable,
  cancelFailureKey,
} from '@/lib/bookingCancellation'
import type { BookingCancelEffect, CancelBookingResult } from '@linyup/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CalendarDays, MapPin, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import { usePublicFormat } from '../usePublicFormat'
import { type RegionalFormatter } from '@linyup/shared'

export const dynamic = 'force-dynamic'

// ─── types ────────────────────────────────────────────────────────────────────

interface AvailableSession {
  id: string
  start: string
  end: string
  location: string | null
}

interface BookingDetails {
  booking: {
    contactId: string
    firstname: string
    lastname: string
    email: string
    phone: string | null
    status: string
    joinedAt: string | null
  }
  session: {
    id: string
    start: string
    end: string
    location: string | null
    isPast: boolean
  }
  activity: { id: string | null; name: string }
  team: { id: string; name: string; slug: string | null; language: string }
  availableSessions: AvailableSession[]
  canCancel: boolean
  canRebook: boolean
  /** What cancelling returns — a lesson credit, a usage-window unit — and
   *  whether the seat was paid for (in which case nothing returns the money).
   *  Absent when the server predates the field; the copy then simply omits it
   *  rather than guessing. */
  cancelReturns?: BookingCancelEffect
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatSessionDate(fmt: RegionalFormatter, iso: string): string {
  return fmt.custom(new Date(iso), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function formatSessionTime(fmt: RegionalFormatter, startIso: string, endIso: string): string {
  return `${fmt.time(new Date(startIso))} – ${fmt.time(new Date(endIso))}`
}

// The page has no layout of its own, and nothing above it supplies a container:
// the tenant layout mounts only the providers and the back bar. So every return
// branch has to bring its own centred column — including the cancel
// confirmation, which is the screen a member most often ends on. Same
// content-column metrics as BioLinkShell, without adopting the shell itself:
// this route already gets a PublicBackBar from the tenant layout, and the shell
// renders a second one.
function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-lg px-5 py-8 ${className ?? ''}`}>{children}</div>
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('ManageBooking')
  const map: Record<
    string,
    { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
  > = {
    pending: { label: t('statusPending'), variant: 'outline' },
    confirmed: { label: t('statusConfirmed'), variant: 'default' },
    cancelled: { label: t('statusCancelled'), variant: 'destructive' },
    no_show: { label: t('statusNoShow'), variant: 'secondary' },
  }
  const entry = map[status] ?? { label: status, variant: 'secondary' as const }
  return <Badge variant={entry.variant}>{entry.label}</Badge>
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function ManageBookingPage() {
  const t = useTranslations('ManageBooking')
  const tCancel = useTranslations('BookingCancellation')
  const fmt = usePublicFormat()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const [details, setDetails] = useState<BookingDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [cancelling, setCancelling] = useState(false)
  // What the server said the cancellation gave back, held so the confirmation
  // screen can state it. `null` = no cancellation has happened on this page.
  const [cancelDone, setCancelDone] = useState<BookingCancelEffect | null>(null)
  // A refusal, as a `BookingCancellation` message key plus whether pressing
  // again could possibly help. Only the unexplained failure is retryable.
  const [cancelFailure, setCancelFailure] = useState<{ key: string; retryable: boolean } | null>(
    null
  )
  const [rebooking, setRebooking] = useState(false)
  const [rebookDone, setRebookDone] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [activeToken, setActiveToken] = useState(token)

  const loadDetails = async (tok: string) => {
    setLoading(true)
    setError(null)
    try {
      const fn = httpsCallable<{ token: string }, { success: boolean } & BookingDetails>(
        functions,
        'getBookingDetails'
      )
      const result = await fn({ token: tok })
      setDetails(result.data as BookingDetails)
    } catch (err: unknown) {
      // The server's own sentences are English — this page is reached from a
      // mail in the studio's language, so they are never rendered raw.
      const code = callableErrorCode(err)
      setError(code === 'not-found' ? t('notFound') : t('loadFailed'))
      console.error('[public/manage-booking] load failed:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (activeToken) loadDetails(activeToken)
    else setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeToken])

  const handleCancel = async () => {
    if (!activeToken) return
    setCancelling(true)
    setCancelFailure(null)
    try {
      const fn = httpsCallable<{ token: string }, CancelBookingResult>(functions, 'cancelBooking')
      const res = await fn({ token: activeToken })
      // The server reports what it actually gave back; the screen repeats that
      // rather than describing cancellation in general.
      setCancelDone(res.data?.returned ?? { credit: false, usageUnit: false, paid: false })
      setShowCancelConfirm(false)
      setDetails(null)
    } catch (err: unknown) {
      console.error('[public/manage-booking] cancel failed:', err)
      setCancelFailure({ key: cancelFailureKey(err), retryable: cancelFailureIsRetryable(err) })
    } finally {
      setCancelling(false)
    }
  }

  const handleRebook = async () => {
    if (!activeToken || !selectedSessionId) return
    setRebooking(true)
    try {
      const fn = httpsCallable<
        { token: string; newSessionId: string },
        { success: boolean; newBookingToken?: string }
      >(functions, 'rebookSession')
      const result = await fn({ token: activeToken, newSessionId: selectedSessionId })
      setRebookDone(true)
      if (result.data.newBookingToken) {
        setActiveToken(result.data.newBookingToken)
        setSelectedSessionId(null)
        setRebookDone(false)
        await loadDetails(result.data.newBookingToken)
      }
    } catch (err: unknown) {
      // Same rule as the cancel path: the callable's message is English, and
      // this page is opened from a mail written in the studio's language.
      console.error('[public/manage-booking] rebook failed:', err)
      setError(t('rebookFailed'))
    } finally {
      setRebooking(false)
    }
  }

  if (!token) {
    return (
      <Frame>
        <p className="text-muted-foreground">{t('notFound')}</p>
      </Frame>
    )
  }

  if (loading) {
    return (
      <Frame>
        <div className="space-y-4">
          <Skeleton className="h-7 w-48" />
          <div className="rounded-xl border p-5 space-y-3">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
      </Frame>
    )
  }

  if (cancelDone) {
    // States the outcome, then what came back with it. A member who has just
    // given up a place is the person most owed the sentence about her credit.
    const effects = cancelEffectKeys(cancelDone, 'did')
    return (
      <Frame>
        <div className="text-center py-12 space-y-3">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
          <p className="font-semibold text-lg">{t('cancelSuccess')}</p>
          {effects.map((key) => (
            <p key={key} className="text-sm text-muted-foreground max-w-sm mx-auto">
              {tCancel(key)}
            </p>
          ))}
        </div>
      </Frame>
    )
  }

  if (error && !details) {
    return (
      <Frame>
        <div className="text-center py-12 space-y-3">
          <XCircle className="h-12 w-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">{error}</p>
        </div>
      </Frame>
    )
  }

  if (!details) return null

  const { booking, session, activity, availableSessions, canCancel, canRebook } = details
  const willReturn = cancelEffectKeys(details.cancelReturns, 'will')
  const sessionDateStr = formatSessionDate(fmt, session.start)
  const sessionTimeStr = formatSessionTime(fmt, session.start, session.end)

  return (
    <Frame className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>

      {/* Booking info card */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            {t('bookingFor')}
          </p>
          <p className="font-semibold text-lg">
            {booking.firstname} {booking.lastname}
          </p>
          <p className="text-sm text-muted-foreground">{booking.email}</p>
        </div>

        <div className="flex items-start gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">{activity.name}</p>
            <p className="text-sm text-muted-foreground">{sessionDateStr}</p>
            <p className="text-sm text-muted-foreground">{sessionTimeStr}</p>
          </div>
        </div>

        {session.location && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 shrink-0" />
            <span>{session.location}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('status')}:</span>
          <StatusBadge status={booking.status} />
        </div>

        {session.isPast && (
          <div className="flex items-center gap-2 text-sm text-orange-600 bg-orange-50 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{t('pastSession')}</span>
          </div>
        )}
      </div>

      {/* Cancel action */}
      {canCancel && !showCancelConfirm && (
        <Button
          variant="outline"
          className="text-destructive border-destructive/30 hover:bg-destructive/5 w-full"
          onClick={() => setShowCancelConfirm(true)}
        >
          {t('cancelButton')}
        </Button>
      )}

      {canCancel && showCancelConfirm && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <p className="text-sm font-medium">
            {t('cancelConfirm', { activity: activity.name, date: sessionDateStr })}
          </p>
          {/* What cancelling costs and what it returns, at the moment of the
              decision — not in the mail that arrives afterwards. */}
          {willReturn.map((key) => (
            <p key={key} className="text-sm text-muted-foreground">
              {tCancel(key)}
            </p>
          ))}
          {/* A refusal says what happened. `retryable` is false for every reason
              cancelBooking gives — the class has started, the studio checked her
              in, the booking is already gone — and the Yes button is withdrawn
              with it, because offering the press again is the thing that reads
              as "this product is broken". */}
          {cancelFailure && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {tCancel(cancelFailure.key)}
            </p>
          )}
          <div className="flex gap-2">
            {(!cancelFailure || cancelFailure.retryable) && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1"
              >
                {cancelling ? t('cancelling') : t('cancelConfirmYes')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowCancelConfirm(false)
                setCancelFailure(null)
              }}
              disabled={cancelling}
              className="flex-1"
            >
              {cancelFailure && !cancelFailure.retryable ? t('dismiss') : t('cancelConfirmNo')}
            </Button>
          </div>
        </div>
      )}

      {/* Rebook section */}
      {canRebook && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">{t('rebookTitle')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t('rebookDesc')}</p>

          <div className="space-y-2">
            {availableSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedSessionId(s.id === selectedSessionId ? null : s.id)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  selectedSessionId === s.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <p className="text-sm font-medium">{formatSessionDate(fmt, s.start)}</p>
                <p className="text-sm text-muted-foreground">{formatSessionTime(fmt, s.start, s.end)}</p>
                {s.location && (
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> {s.location}
                  </p>
                )}
              </button>
            ))}
          </div>

          {selectedSessionId && (
            <Button onClick={handleRebook} disabled={rebooking} className="w-full">
              {rebooking ? t('rebooking') : t('rebookButton')}
            </Button>
          )}
        </div>
      )}

      {!canRebook && !session.isPast && availableSessions.length === 0 && activity.id && (
        <p className="text-sm text-muted-foreground">{t('noAlternatives')}</p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </Frame>
  )
}
