'use client'

// Walk-in registration overlay — a session → details → confirmed flow over the
// same bookSession callable payload the public booking form uses. (It was
// adapted from the old `trial-booking/TrialBookingForm.tsx`, which was deleted
// on 2026-08-28 once the trial flow merged into `/booking` and left it
// unreachable.) The provided Kiosk.walkInNameLabel copy ("Full name") calls for
// a single name field rather than a first/last split, so the single value is
// split on the first space before it is sent to bookSession (which requires
// firstname + lastname separately).
//
// PRIVACY: this component keeps NO persistence of its own — no localStorage, no
// cookies. All form state is plain React state and is fully discarded on
// successful submit (reset()) and whenever the kiosk enters standby (KioskApp
// force-remounts this component via a `key` bump, which throws away all local
// state as a side effect of the unmount/remount).
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { httpsCallable } from 'firebase/functions'
import { useTranslations } from 'next-intl'
import { X, ChevronLeft, UserPlus, CheckCircle2 } from 'lucide-react'
import { functions } from '@/lib/firebase'
import { WaiverStep } from '@/components/booking/WaiverStep'
import { useWaiverGate } from '@/hooks/useWaiverGate'
import { waiverErrorMessage } from '@/lib/waiver'
import { usePublicTeam } from '../PublicTeamProvider'
import type { KioskSession } from './useKioskSessions'
import { usePublicFormat } from '../usePublicFormat'

const formSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
})

type FormValues = z.infer<typeof formSchema>

// 'waiver' sits between the details form and the booking call, inline and
// scrollable — the walk-in is staff-supervised and the tablet is right there, so
// the person at the desk reads and ticks on the spot.
//
// THIS SCREEN NO LONGER PROMISES ADMISSION IT CANNOT DELIVER. It used to carry
// three banners about a minor — admitted-with-a-chip on a PIN-paired device,
// "we have emailed the parent", or "type their address" — because the only way
// past a guardian requirement was an emailed link and the tablet's idle timer
// made waiting for one impossible. That machinery is gone: the consent step is
// completable by whoever is standing here, so the walk-in either signs or is
// refused, exactly like every other rail, and there is no copy to get wrong.
// A `mayIncludeMinors` waiver simply shows its second question here too.
//
type Step = 'select' | 'details' | 'waiver' | 'confirmed'

interface Props {
  teamId: string
  sessions: KioskSession[]
  walkInActivityIds?: string[]
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

// bookSession requires firstname + lastname separately; split the single "Full
// name" field on the first space (mirrors the common quick-signup convention).
function splitName(fullName: string): { firstname: string; lastname: string } {
  const trimmed = fullName.trim().replace(/\s+/g, ' ')
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { firstname: trimmed, lastname: trimmed }
  return { firstname: trimmed.slice(0, idx), lastname: trimmed.slice(idx + 1) }
}

export default function WalkIn({ teamId, sessions, walkInActivityIds }: Props) {
  const t = useTranslations('Kiosk')
  const tWaiver = useTranslations('Waiver')
  const { team } = usePublicTeam()
  const fmt = usePublicFormat()
  const fmtDateTime = (d: Date) =>
    fmt.custom(d, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('select')
  const [selected, setSelected] = useState<KioskSession | null>(null)
  const [confirmedActivity, setConfirmedActivity] = useState('')
  const [bookingError, setBookingError] = useState<string | null>(null)
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null)
  // The consent step's own submit does not go through `handleSubmit`, so
  // react-hook-form's `isSubmitting` never flips for it — a separate flag, or
  // the tablet shows a live button through the whole booking call and collects a
  // second walk-in from an impatient second press.
  const [busy, setBusy] = useState(false)
  const waiverGate = useWaiverGate({
    teamId,
    requiredWaivers: team.required_waivers,
    activityId: selected?.activityId ?? null,
  })

  const {
    register,
    handleSubmit,
    reset: resetForm,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) })

  const eligible = useMemo(() => {
    const now = Date.now()
    const restrict = walkInActivityIds && walkInActivityIds.length > 0
    return sessions
      // Appointments are availability-only and exist only once booked — there is
      // no such thing as an open, walk-in-able appointment slot any more. Only
      // group classes are eligible for walk-in registration.
      .filter((s) => s.type !== 'appointment_session')
      .filter((s) => s.end.toDate().getTime() > now)
      .filter((s) => !restrict || (s.activityId && walkInActivityIds!.includes(s.activityId)))
  }, [sessions, walkInActivityIds])

  // Group eligible sessions per day for the horizontal day-chip picker.
  const days = useMemo(() => {
    const map = new Map<string, { key: string; date: Date; sessions: KioskSession[] }>()
    for (const s of eligible) {
      const d = s.start.toDate()
      const key = dayKey(d)
      let g = map.get(key)
      if (!g) {
        g = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), sessions: [] }
        map.set(key, g)
      }
      g.sessions.push(s)
    }
    return [...map.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
  }, [eligible])
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  // Fall back to the first (nearest) day when nothing is picked / the pick is stale.
  const activeDay = days.find((d) => d.key === selectedDay) ?? days[0]

  function resetAll() {
    setStep('select')
    setSelected(null)
    setConfirmedActivity('')
    setBookingError(null)
    setPendingValues(null)
    // PRIVACY: this overlay keeps nothing of its own, and a resolved waiver
    // carries a name and an address. It is thrown away with the rest of the form
    // state on every reset and on every standby.
    waiverGate.reset()
    resetForm()
  }

  function close() {
    setOpen(false)
    resetAll()
  }

  const onSubmit = async (values: FormValues) => {
    if (!selected || busy) return
    setBookingError(null)
    setBusy(true)
    try {
      await runBooking(values)
    } finally {
      setBusy(false)
    }
  }

  const runBooking = async (values: FormValues) => {
    if (!selected) return
    const { firstname, lastname } = splitName(values.name)

    // THE ONE TERMINAL SUBMIT ON THIS SURFACE. The consent step is interposed
    // here, before the call, on the first pass only.
    if (waiverGate.applies && step !== 'waiver') {
      const clear = await waiverGate.ensure({ email: values.email, firstname, lastname })
      if (!clear) {
        setPendingValues(values)
        setStep('waiver')
        return
      }
    }
    try {
      const bookSession = httpsCallable(functions, 'bookSession')
      await bookSession({
        teamId,
        sessionId: selected.id,
        contactDetails: {
          firstname,
          lastname,
          email: values.email,
          phone: values.phone || null,
        },
        // Taken at the door on the studio's own tablet — not a self-serve
        // online booking. Server re-validates against the BookingSource union.
        source: 'kiosk',
        ...(waiverGate.acceptances.length ? { waiverAcceptances: waiverGate.acceptances } : {}),
      })
      setConfirmedActivity(selected.activityName || '')
      setStep('confirmed')
      setPendingValues(null)
      waiverGate.reset()
      resetForm()
    } catch (err) {
      // The one refusal a coach at the door can act on: a document nobody has
      // signed. Every other failure keeps the generic string, which is this
      // surface's deliberate posture — a doorway tablet is not a place to debug.
      const waiverMsg = waiverErrorMessage(err, tWaiver)
      if (waiverMsg) {
        // …and "act on it" has to mean something. If the team's public mirror
        // was stale-empty the step was never shown, so `ensure` above answered
        // "clear" and this refusal would be a sentence on a tablet with no way
        // forward and a walk-in standing at the desk. `recover` forces the
        // resolve and puts the document on screen.
        if (
          await waiverGate.recover(err, { email: values.email, firstname, lastname })
        ) {
          setPendingValues(values)
          setStep('waiver')
          return
        }
      }
      setBookingError(waiverMsg ?? t('walkInError'))
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full bg-primary px-6 py-4 text-base font-semibold text-primary-foreground shadow-lg transition-transform hover:scale-[1.03] sm:bottom-10 sm:right-10"
      >
        <UserPlus className="h-5 w-5" />
        {t('walkInCta')}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b px-6 py-4">
        {step === 'details' || step === 'waiver' ? (
          <button
            type="button"
            onClick={() => {
              if (step === 'waiver') waiverGate.dismiss()
              setStep(step === 'waiver' ? 'details' : 'select')
            }}
            className="flex items-center gap-1 text-muted-foreground transition-opacity hover:opacity-70"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-muted"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col overflow-y-auto px-6 py-8">
        {step === 'select' && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold">{t('walkInTitle')}</h1>
              <p className="mt-1 text-muted-foreground">{t('walkInPickSession')}</p>
            </div>
            {eligible.length === 0 ? (
              <div className="rounded-xl border bg-muted/30 p-8 text-center text-muted-foreground">
                {t('noUpcoming')}
              </div>
            ) : (
              <div className="space-y-4">
                {/* Day picker — horizontally scrollable chips */}
                <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                  {days.map((g) => {
                    const isActive = g.key === activeDay?.key
                    return (
                      <button
                        key={g.key}
                        type="button"
                        onClick={() => setSelectedDay(g.key)}
                        className={`flex shrink-0 flex-col items-center rounded-xl border px-4 py-2 transition-colors ${
                          isActive
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'bg-card text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        <span className="text-xs font-medium uppercase tracking-wide">
                          {fmt.weekdayShort(g.date)}
                        </span>
                        <span className="text-lg font-bold tabular-nums">{g.date.getDate()}</span>
                      </button>
                    )
                  })}
                </div>

                {/* Sessions for the selected day */}
                <div className="space-y-3">
                  {activeDay?.sessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setSelected(s)
                        setStep('details')
                      }}
                      className="flex w-full items-center justify-between gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
                    >
                      <div>
                        <p className="font-semibold">
                          {s.activityName ?? 'Session'}
                          {s.providerName ? ` · ${s.providerName}` : ''}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {fmt.time(s.start)}
                          {s.location ? ` · ${s.location}` : ''}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'details' && selected && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold">{t('walkInTitle')}</h1>
              <p className="mt-1 text-muted-foreground">
                {selected.activityName ?? 'Session'}
                {selected.providerName ? ` · ${selected.providerName}` : ''} ·{' '}
                {fmtDateTime(selected.start.toDate())}
              </p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('walkInNameLabel')}</label>
                <input
                  type="text"
                  {...register('name')}
                  autoComplete="off"
                  className="w-full rounded-lg border bg-background px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {errors.name && <p className="text-xs text-destructive">{t('walkInError')}</p>}
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">{t('walkInEmailLabel')}</label>
                <input
                  type="email"
                  {...register('email')}
                  autoComplete="off"
                  className="w-full rounded-lg border bg-background px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {errors.email && <p className="text-xs text-destructive">{t('walkInError')}</p>}
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">{t('walkInPhoneLabel')}</label>
                <input
                  type="tel"
                  {...register('phone')}
                  autoComplete="off"
                  className="w-full rounded-lg border bg-background px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              {bookingError && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {bookingError}
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || busy}
                className="w-full rounded-xl bg-primary py-3.5 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {isSubmitting || busy ? t('walkInSubmitting') : t('walkInSubmit')}
              </button>
            </form>
          </div>
        )}

        {step === 'waiver' && selected && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold">{t('walkInTitle')}</h1>
              <p className="mt-1 text-muted-foreground">
                {selected.activityName ?? 'Session'} · {fmtDateTime(selected.start.toDate())}
              </p>
            </div>

            <WaiverStep gate={waiverGate} teamName={team.name || ''} />

            {bookingError && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {bookingError}
              </div>
            )}

            <button
              type="button"
              // `waiverGate.ready` and not a bare predicate over the item list:
              // over the empty list a FAILED load leaves behind, that would be
              // `true` — a live Register button on an error screen.
              disabled={busy || !waiverGate.ready}
              onClick={() => pendingValues && void onSubmit(pendingValues)}
              className="w-full rounded-xl bg-primary py-3.5 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? t('walkInSubmitting') : t('walkInSubmit')}
            </button>
          </div>
        )}

        {step === 'confirmed' && (
          <div className="flex flex-1 flex-col items-center justify-center space-y-6 py-8 text-center">
            <CheckCircle2 className="h-16 w-16 text-green-600" />
            <div>
              <h1 className="text-2xl font-bold">{t('registered')}</h1>
              {confirmedActivity && <p className="mt-2 text-muted-foreground">{confirmedActivity}</p>}
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-full bg-primary px-8 py-3 text-base font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
            >
              {t('startOver')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
