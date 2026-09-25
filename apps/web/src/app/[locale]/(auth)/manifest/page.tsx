'use client'

// Manifest — the printable day sheet. Every session on one day with its roster,
// check-in state, and the notes a coach needs at the door.
//
// This is an OPERATIONAL sheet, not a report: it answers "who is coming to what,
// today", and it is built to be printed. The print rules live in globals.css
// (`.manifest-sheet` / `.no-print`) — the app chrome is hidden and the sheet
// prints as plain paper with check-in boxes to tick by hand when the tablet
// isn't to hand.

import { useMemo, useState } from 'react'
import type { Route } from 'next'
import { useTranslations, useLocale } from 'next-intl'
import { Printer, ChevronLeft, ChevronRight, Users } from 'lucide-react'
import { QuickLinks } from '@/components/layout/QuickLinks'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useDaySheet,
  activeBookings,
  heldOfferSeats,
  waitingEntries,
  type DaySheetEntry,
} from '@/hooks/useDaySheet'
import {
  waiverDoorCheckFromBookingState,
  type Booking,
  type WaitlistEntry,
} from '@linyup/shared'
import { WaiverChip, WaiverDoorCheckChip } from '@/components/WaiverChip'
import { BookingPartyLine } from '@/components/sessions/BookingPartyLine'
import { useWaiverRoster } from '@/hooks/useWaiverStates'

// ─── helpers ──────────────────────────────────────────────────────────────────

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fromDateKey(key: string): Date {
  return new Date(key + 'T00:00:00')
}

function formatTime(ts: { toDate(): Date } | undefined, locale: string): string {
  if (!ts) return ''
  return ts.toDate().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function bookingName(b: Booking): string {
  const full = `${b.firstname ?? ''} ${b.lastname ?? ''}`.trim()
  return full || b.email || '—'
}

/**
 * "A. Müller" — initial plus surname.
 *
 * The queue is printed as ONE line under the roster, not as a second list: the
 * coach's question at the door is "who do I call about this empty spot", and a
 * full second roster of people who are not coming makes the sheet harder to
 * read for the ten times out of eleven that nobody drops out. The phone number
 * lives one tap away in the app, which is where a call is made from anyway.
 */
function waitlistName(e: WaitlistEntry): string {
  const initial = e.firstname?.trim()?.[0]
  const last = e.lastname?.trim()
  if (initial && last) return `${initial}. ${last}`
  return last || e.firstname || e.email || '—'
}

/**
 * Book-form answers as one compact line.
 *
 * Answers are keyed by field id and the LABELS live on the activity, which the
 * day sheet doesn't load — so this prints values only. That reads fine in
 * practice ("left knee, size 42") and keeps the sheet to one query per session;
 * if labels turn out to matter, mirror them onto the booking at write time
 * rather than joining activities in here.
 */
function formatAnswers(answers: Record<string, unknown>): string {
  return Object.values(answers)
    .map((v) => {
      if (v === true) return '✓'
      if (v === false) return ''
      return Array.isArray(v) ? v.join(', ') : String(v ?? '')
    })
    .filter((s) => s.trim())
    .join(' · ')
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function ManifestPage() {
  const { currentTeamId, team } = useAuth()
  const t = useTranslations('Manifest')
  const tNav = useTranslations('Nav')
  const locale = useLocale()
  const [dayKey, setDayKey] = useState(() => toDateKey(new Date()))
  const day = useMemo(() => fromDateKey(dayKey), [dayKey])

  const { data: entries, isLoading } = useDaySheet(currentTeamId, day)

  function shiftDay(delta: number) {
    const next = fromDateKey(dayKey)
    next.setDate(next.getDate() + delta)
    setDayKey(toDateKey(next))
  }

  const dayLabel = day.toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  // Sessions with nobody booked still print — an empty class is exactly the
  // thing a coach wants to know before travelling to it.
  const visible = entries ?? []
  const totalBooked = visible.reduce((n, e) => n + activeBookings(e.bookings).length, 0)

  return (
    <div className="max-w-4xl space-y-5">
      {/* Toolbar — screen only */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold">{t('pageTitle')}</h1>
            <QuickLinks
              links={[
                { href: '/schedule' as Route, label: tNav('calendar') },
                { href: '/bookings' as Route, label: tNav('bookings') },
              ]}
            />
          </div>
          {/* The description ("Every session today, with its roster — built to
              print") said what the page visibly is. The two pages a coach
              actually moves to from here are worth the line instead. */}
        </div>
        <Button onClick={() => window.print()} className="gap-2">
          <Printer className="h-4 w-4" />
          {t('print')}
        </Button>
      </div>

      {/* Day navigator — screen only */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => shiftDay(-1)} aria-label={t('previousDay')}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <input
          type="date"
          value={dayKey}
          onChange={(e) => e.target.value && setDayKey(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button variant="outline" size="sm" onClick={() => shiftDay(1)} aria-label={t('nextDay')}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDayKey(toDateKey(new Date()))}>
          {t('today')}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      ) : (
        <div className="manifest-sheet space-y-5">
          {/* Sheet header — only meaningful on paper, where there's no app chrome */}
          <div className="hidden print:block border-b pb-2">
            <p className="text-lg font-semibold">{team?.name ?? ''}</p>
            <p className="text-sm">
              {dayLabel} · {t('bookedCount', { count: totalBooked })}
            </p>
          </div>

          <p className="no-print text-sm text-muted-foreground">
            {dayLabel} · {t('bookedCount', { count: totalBooked })}
          </p>

          {visible.length === 0 ? (
            <div className="rounded-xl border bg-muted/30 p-8 text-center">
              <p className="text-sm text-muted-foreground">{t('noSessions')}</p>
            </div>
          ) : (
            visible.map((entry) => <ManifestSession key={entry.session.id} entry={entry} />)
          )}
        </div>
      )}
    </div>
  )
}

// ─── one session block ────────────────────────────────────────────────────────

function ManifestSession({ entry }: { entry: DaySheetEntry }) {
  const t = useTranslations('Manifest')
  const locale = useLocale()
  const { session } = entry
  const roster = activeBookings(entry.bookings)
  // Seats the queue is holding for people who have not claimed them yet. They
  // are NOT on the roster (they are on the waiting line), but they are not free
  // either — see heldOfferSeats.
  const held = heldOfferSeats(entry.bookings)
  const waiting = waitingEntries(entry.waitlist)
  const checkedIn = new Set(entry.participants.map((p) => p.contactId))

  // A walk-in checked in without a booking still belongs on the sheet.
  const bookedContactIds = new Set(roster.map((b) => b.contact))
  const walkIns = entry.participants.filter((p) => !bookedContactIds.has(p.contactId))

  // THE ROWS THAT NEED THE CHIP MOST ARE THE ONES THE BOOKING FIELD CANNOT REACH.
  // A roster row carries `booking.waiver_state`, written by the rail that
  // committed the seat — a snapshot, and the right one for a sheet that
  // describes the booking as taken. A walk-in row has no booking document at
  // all: a staff add (never gated, by design) or a check-in scan. Left as the
  // booking field alone, the printed sheet would show no chip for exactly the
  // person whose waiver nobody ever collected. So these rows read the signer
  // rows — bounded by the walk-ins on this one session, and skipped entirely
  // when there are none.
  const walkInWaivers = useWaiverRoster(
    session.teamId ?? null,
    walkIns.map((p) => p.contactId),
    session.activityId ?? null
  )

  const cap = session.max_participants
  // Seats taken = the roster + walk-ins who checked in without a booking + the
  // seats held by unclaimed offers. This is what capacity is read against, and
  // all three parts are disjoint, so the breakdown below always adds up.
  const total = roster.length + walkIns.length + held
  // Only worth breaking down when the total ISN'T just the roster — otherwise
  // "10 booked (10 booked)" is pure noise.
  const splitParts = [t('countBooked', { count: roster.length })]
  if (walkIns.length > 0) splitParts.push(t('countWalkIns', { count: walkIns.length }))
  if (held > 0) splitParts.push(t('countHeld', { count: held }))
  const showSplit = splitParts.length > 1
  const isCancelled = session.status === 'cancelled'

  return (
    <section
      className={`manifest-session rounded-xl border bg-card p-4 space-y-3 ${
        isCancelled ? 'opacity-60' : ''
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2">
        <div className="min-w-0">
          <p className="font-semibold">
            {formatTime(session.start, locale)}–{formatTime(session.end, locale)}{' '}
            {session.activityName || t('sessionFallback')}
          </p>
          <p className="text-xs text-muted-foreground">
            {[session.providerName, session.location].filter(Boolean).join(' · ')}
          </p>
        </div>
        {/* Headcount. Capacity is measured against every TAKEN seat — a walk-in
            takes a spot as surely as a booking does, and a seat held for an
            unclaimed waitlist offer cannot be given to anyone else while the
            claim link is live, so counting only the roster against `cap`
            under-reports how full the session is. The split is only shown when
            the total ISN'T just the roster. */}
        <p className="text-sm font-medium tabular-nums">
          {cap ? `${total}/${cap}` : total}
          <span className="ml-1 font-normal text-muted-foreground">
            {showSplit ? t('totalLabel') : t('bookedLabel')}
          </span>
          {showSplit && (
            <span className="ml-2 font-normal text-muted-foreground">
              ({splitParts.join(' · ')})
            </span>
          )}
          {waiting.length > 0 && (
            <span className="ml-2 font-normal text-muted-foreground">
              · {t('waitlistCount', { count: waiting.length })}
            </span>
          )}
        </p>
      </header>

      {isCancelled && (
        <p className="text-sm font-medium text-destructive">{t('sessionCancelled')}</p>
      )}

      {/* The studio's own note for this specific session — the reason a
          headline exists (substitute coach, bring a mat, moved room). */}
      {session.headline && (
        <p className="text-sm font-medium">{session.headline}</p>
      )}
      {session.notes && <p className="text-sm text-muted-foreground">{session.notes}</p>}

      {roster.length === 0 && walkIns.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('nobodyBooked')}</p>
      ) : (
        <ul className="divide-y">
          {roster.map((b) => {
            const arrived = checkedIn.has(b.contact)
            return (
              <li key={b.id} className="flex items-center gap-3 py-1.5 text-sm">
                {/* Empty box on paper, filled state on screen — the sheet is
                    meant to be ticked by hand when the tablet isn't to hand. */}
                <span
                  aria-hidden
                  className={`inline-block h-4 w-4 shrink-0 rounded border ${
                    arrived ? 'bg-foreground print:bg-transparent' : ''
                  }`}
                />
                <span className="flex-1 min-w-0 truncate">{bookingName(b)}</span>
                {b.status === 'no_show' && (
                  <span className="shrink-0 text-xs text-muted-foreground">{t('noShow')}</span>
                )}
                {b.payment_status === 'required' && (
                  <span className="shrink-0 text-xs text-amber-700">{t('unpaid')}</span>
                )}
                {/* Immediately after `unpaid`, which is the template: one word,
                    colour-coded, `shrink-0`, read off data already loaded. It is
                    text and a stroke rather than a filled pill because
                    `globals.css` forces these backgrounds transparent for print
                    and most browsers drop background graphics anyway — a pill
                    would print as invisible text. */}
                {/* THE DOOR CHECK, off the booking's own stamp. A snapshot at
                    commit — the right one for a sheet that describes the booking
                    as taken — and the only reach the sheet has to a booked row,
                    which carries no signer lookup. Absent on every booking that
                    needs no check, which is every booking at a studio that has
                    not flagged a waiver for minors. */}
                <WaiverDoorCheckChip
                  check={waiverDoorCheckFromBookingState(b.waiver_state)}
                  print
                />
                {b.phone && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {b.phone}
                  </span>
                )}
                {/* Book-form answers — the reason the studio asked. Rendered
                    inline (not behind a toggle) because the whole point is that
                    the coach reads them on paper at the door. */}
                {/* Who else is coming, on the sheet the coach reads at the door. */}
                <BookingPartyLine booking={b} className="w-full pl-7 text-xs text-muted-foreground" />
                {b.question_answers && Object.keys(b.question_answers).length > 0 && (
                  <span className="w-full pl-7 text-xs text-muted-foreground">
                    {formatAnswers(b.question_answers)}
                  </span>
                )}
              </li>
            )
          })}
          {walkIns.map((p) => (
            <li key={p.contactId} className="flex items-center gap-3 py-1.5 text-sm">
              <span aria-hidden className="inline-block h-4 w-4 shrink-0 rounded border bg-foreground print:bg-transparent" />
              <span className="flex-1 min-w-0 truncate text-muted-foreground">
                <Users className="mr-1 inline h-3 w-3" />
                {t('walkIn')}
              </span>
              <WaiverChip state={walkInWaivers.states.get(p.contactId)} print />
              <WaiverDoorCheckChip check={walkInWaivers.checks.get(p.contactId)} print />
            </li>
          ))}
        </ul>
      )}

      {/* The point of the whole feature at the door: a no-show, and the names to
          call, on the same piece of paper. In queue order — the first name is
          the one the system would offer the seat to anyway. */}
      {waiting.length > 0 && (
        <p className="border-t pt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {t('waitlistHeading')} ({waiting.length}):
          </span>{' '}
          {waiting.map(waitlistName).join(' · ')}
        </p>
      )}
    </section>
  )
}
