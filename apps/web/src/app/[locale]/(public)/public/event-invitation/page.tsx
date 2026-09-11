'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useTranslations, useLocale } from 'next-intl'
import { CalendarDays, MapPin, CreditCard, CheckCircle2, AlertCircle, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { createRegionalFormatter, type RegionalFormatter } from '@linyup/shared'

export const dynamic = 'force-dynamic'

// ─── types ────────────────────────────────────────────────────────────────────

interface InvitationEvent {
  id: string
  title: string
  description?: string
  start: string // ISO date string from Timestamp.toDate().toJSON()
  end: string
  location?: string
  type: string
  fee?: number
  status: string
}

interface InvitationContact {
  id: string
  firstname: string
  lastname: string
  email: string
}

interface InvitationDetails {
  event: InvitationEvent
  contact: InvitationContact
  attendee: { id: string } | null
  token: string
}

type PageState = 'loading' | 'invalid' | 'ready' | 'confirmed-attend' | 'confirmed-decline'
type RsvpStatus = 'none' | 'attending' | 'declined'

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(fmt: RegionalFormatter, iso: string) {
  return fmt.custom(new Date(iso), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function formatTime(fmt: RegionalFormatter, iso: string) {
  return fmt.time(new Date(iso))
}

function eventDurationLabel(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  const mins = Math.round(ms / 60000)
  const days = Math.floor(mins / 1440)
  if (days >= 1) return `${days}d`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function EventInvitationPage() {
  // A token route outside any studio's `[slug]` tree, so there is no public
  // profile (and no regional settings) in scope: the reader's language over the
  // platform defaults, which is still the studio's zone for every Swiss tenant.
  const locale = useLocale()
  const fmt = useMemo(() => createRegionalFormatter(locale, null), [locale])
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const t = useTranslations('Events')

  const [pageState, setPageState] = useState<PageState>('loading')
  const [details, setDetails] = useState<InvitationDetails | null>(null)
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus>('none')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setPageState('invalid')
      return
    }

    const fn = httpsCallable<{ token: string; trackView: boolean }, InvitationDetails>(
      functions,
      'getEventInvitationDetails'
    )

    fn({ token, trackView: true })
      .then((result) => {
        setDetails(result.data)
        setRsvpStatus(result.data.attendee ? 'attending' : 'none')
        setPageState('ready')
      })
      .catch((err: unknown) => {
        // 'invalid' is deliberate — a bad token and a dead backend are the same
        // dead end to the reader — but only one of them is our fault to fix.
        reportPublicLoadFailure('event-invitation/details', err)
        setPageState('invalid')
      })
  }, [token])

  async function handleRsvp(action: 'attend' | 'decline') {
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)

    try {
      const fn = httpsCallable<
        { token: string; action: 'attend' | 'decline'; notes?: string },
        { success: boolean }
      >(functions, 'handleEventInvitationResponse')

      await fn({ token, action, notes: notes || undefined })

      if (action === 'attend') {
        setRsvpStatus('attending')
        setPageState('confirmed-attend')
      } else {
        setRsvpStatus('declined')
        setPageState('confirmed-decline')
      }
    } catch (err) {
      setSubmitError((err as Error).message ?? 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // ─── computed flags ──────────────────────────────────────────────────────────

  const event = details?.event
  const isPast = event ? new Date(event.start) < new Date() : false
  const isClosed = event ? ['closed', 'cancelled'].includes(event.status) : false
  const canRsvp = !isPast && !isClosed

  // ─── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Minimal top bar */}
      <div className="border-b bg-white px-5 py-3.5">
        <span className="text-sm font-bold tracking-tight text-foreground">Linyup</span>
      </div>

      <div className="flex-1 flex flex-col items-center px-5 pt-8 pb-12">
        <div className="w-full max-w-md space-y-5">
          {/* ── Loading ─────────────────────────────────────────────────────── */}
          {pageState === 'loading' && (
            <div className="space-y-4">
              <Skeleton className="h-7 w-48" />
              <Skeleton className="h-4 w-64" />
              <div className="rounded-2xl border bg-white p-5 space-y-3">
                <Skeleton className="h-6 w-56" />
                <Skeleton className="h-4 w-72" />
                <Skeleton className="h-4 w-52" />
              </div>
            </div>
          )}

          {/* ── Invalid token ────────────────────────────────────────────────── */}
          {pageState === 'invalid' && (
            <div className="rounded-2xl border bg-white p-8 text-center space-y-3">
              <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <AlertCircle className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t('invitation_invalid')}
              </p>
            </div>
          )}

          {/* ── Main content ─────────────────────────────────────────────────── */}
          {(pageState === 'ready' ||
            pageState === 'confirmed-attend' ||
            pageState === 'confirmed-decline') &&
            details && (
              <>
                {/* Greeting */}
                <div className="space-y-0.5">
                  <h1 className="text-2xl font-bold">
                    {t('invitation_greeting', { firstname: details.contact.firstname })}
                  </h1>
                  <p className="text-muted-foreground text-sm">{t('invitation_invited')}</p>
                </div>

                {/* Event card */}
                <div className="rounded-2xl border bg-white p-5 space-y-4 shadow-sm">
                  <div>
                    <div className="flex items-start gap-2 flex-wrap mb-1">
                      <h2 className="text-xl font-bold leading-tight">{event!.title}</h2>
                      <Badge variant="secondary" className="capitalize text-xs shrink-0 mt-0.5">
                        {t(`type_${event!.type}` as Parameters<typeof t>[0])}
                      </Badge>
                    </div>
                    {event!.description && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {event!.description}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2 text-sm text-muted-foreground border-t pt-4">
                    {/* Date & time */}
                    <div className="flex items-start gap-2.5">
                      <CalendarDays className="h-4 w-4 shrink-0 mt-0.5 text-foreground/40" />
                      <div>
                        <p className="text-foreground font-medium">{formatDate(fmt, event!.start)}</p>
                        <p>
                          {formatTime(fmt, event!.start)}
                          {' – '}
                          {formatTime(fmt, event!.end)}
                          <span className="text-muted-foreground/60 ml-1.5">
                            ({eventDurationLabel(event!.start, event!.end)})
                          </span>
                        </p>
                      </div>
                    </div>

                    {/* Location */}
                    {event!.location && (
                      <div className="flex items-center gap-2.5">
                        <MapPin className="h-4 w-4 shrink-0 text-foreground/40" />
                        <span>{event!.location}</span>
                      </div>
                    )}

                    {/* Fee */}
                    {event!.fee != null && (
                      <div className="flex items-center gap-2.5">
                        <CreditCard className="h-4 w-4 shrink-0 text-foreground/40" />
                        <span>
                          {event!.fee > 0
                            ? t('invitation_fee', { amount: `CHF ${event!.fee}` })
                            : t('invitation_free')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Confirmed states ─────────────────────────────────────────── */}

                {pageState === 'confirmed-attend' && (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center space-y-2">
                    <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
                    <p className="font-semibold text-emerald-800">
                      {t('invitation_confirmedAttending')}
                    </p>
                  </div>
                )}

                {pageState === 'confirmed-decline' && (
                  <div className="rounded-2xl border bg-white p-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      {t('invitation_confirmedDeclined')}
                    </p>
                  </div>
                )}

                {/* ── RSVP section (only when not yet confirmed in this session) ─ */}
                {pageState === 'ready' && (
                  <div className="space-y-3">
                    {/* Current status banner */}
                    {rsvpStatus === 'attending' && (
                      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                        <p className="text-sm text-emerald-800 font-medium">
                          {t('invitation_alreadyAttending')}
                        </p>
                      </div>
                    )}
                    {rsvpStatus === 'declined' && (
                      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-muted border">
                        <p className="text-sm text-muted-foreground">
                          {t('invitation_alreadyDeclined')}
                        </p>
                      </div>
                    )}

                    {/* Event closed / past notice — no buttons */}
                    {!canRsvp && (
                      <div className="rounded-xl border bg-white px-4 py-3 text-sm text-muted-foreground text-center">
                        {isPast ? t('invitation_eventPast') : t('invitation_eventClosed')}
                      </div>
                    )}

                    {/* RSVP buttons */}
                    {canRsvp && (
                      <>
                        {/* Optional notes input */}
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {t('invitation_notesLabel')}
                          </label>
                          <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder={t('invitation_notesPlaceholder')}
                            rows={2}
                            className="w-full rounded-xl border border-input bg-white px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                          />
                        </div>

                        {/* Error */}
                        {submitError && (
                          <p className="text-xs text-destructive text-center">{submitError}</p>
                        )}

                        {/* Attend button */}
                        {rsvpStatus !== 'attending' && (
                          <button
                            onClick={() => handleRsvp('attend')}
                            disabled={submitting}
                            className="w-full py-3.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
                          >
                            {submitting ? t('invitation_submitting') : t('invitation_attendBtn')}
                          </button>
                        )}

                        {/* Decline button */}
                        {rsvpStatus !== 'declined' && (
                          <button
                            onClick={() => handleRsvp('decline')}
                            disabled={submitting}
                            className="w-full py-3 rounded-xl border border-input bg-white text-foreground font-medium text-sm hover:bg-muted transition-colors disabled:opacity-40"
                          >
                            {submitting ? t('invitation_submitting') : t('invitation_declineBtn')}
                          </button>
                        )}

                        {/* Change RSVP link (only when already responded) */}
                        {rsvpStatus !== 'none' && (
                          <button
                            onClick={() => setRsvpStatus('none')}
                            className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                          >
                            {t('invitation_changeRsvp')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </div>
  )
}
