'use client'

// Manual appointment booking — a manager books an appointment for a client (or
// blocks time) from the Schedule, e.g. a phone booking. Unlike public booking
// (bookAppointment) or the availability model (see AppointmentAvailability.tsx),
// this writes through ONE staff-only callable that resolves the client (existing
// contact / brand-new contact / no client at all — a block) and, when there's a
// price, records how it's being settled (paid on the spot, awaiting an offline
// payment, or a Stripe payment link emailed to the client).

import { useEffect, useMemo, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { toast } from 'sonner'
import { Ban, Loader2, Plus, UserPlus, UserRound } from 'lucide-react'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import { formatDuration } from '@/components/sessions/SessionFormDialog'
import { ContactPicker } from '@/components/payments/ContactPicker'
import { DateTimePicker } from '@/components/ui/date-picker'
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { DEFAULT_PAYMENT_MODES, resolveAppointmentDurations, resolveDurationSale } from '@linyup/shared'
import type { Activity, ActivityDuration } from '@linyup/shared'
import { coachLabel, type CoachOption } from '@/hooks/useCoaches'
import { callFunction } from '@/lib/callFunction'

// ─── error surfacing (mirrors SessionFormDialog / TemplateDialog conventions) ──

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  return String(err)
}

class CallableTimeoutError extends Error {}
const CALLABLE_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms = CALLABLE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallableTimeoutError('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function defaultStart(): Date {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}

type ClientMode = 'existing' | 'new' | 'blocked'
type PaymentMode = 'paid_offline' | 'pending_offline' | 'payment_link'

interface CreateStaffAppointmentRequest {
  teamId: string
  providerId: string
  activityId: string
  startMs: number
  durationMinutes: number
  contactId?: string
  newContact?: { firstname: string; lastname: string; email: string; phone?: string }
  blocked?: boolean
  paymentMode?: PaymentMode
  amount?: number
  currency?: string
  method?: string
  note?: string
  locale?: string
  origin?: string
}

interface CreateStaffAppointmentResponse {
  sessionId: string
  contactId: string
  paymentUrl?: string
}

export function AppointmentFormDialog({
  open, onOpenChange, activities, coaches, teamId, userId, onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The team's full activity list (any type) — filtered to appointment offerings here. */
  activities: Activity[]
  coaches: CoachOption[]
  teamId: string
  userId: string
  onSaved: () => void
}) {
  const t = useTranslations('AppointmentForm')
  const locale = useLocale()
  const { team } = useAuth()
  const currency = team?.default_currency ?? 'CHF'
  const paymentModes = useMemo(
    () => (team?.payment_modes && team.payment_modes.length > 0 ? team.payment_modes : [...DEFAULT_PAYMENT_MODES]),
    [team?.payment_modes],
  )

  // Appointment activities own the durations/pricing menu — class offerings
  // can't be booked by hand (no duration menu, no availability model).
  const appointmentActivities = useMemo(
    () => activities.filter((a) => (a.type ?? 'class') === 'appointment'),
    [activities],
  )

  const [activityId, setActivityId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [start, setStart] = useState<Date | undefined>(defaultStart())
  const [durationMinutes, setDurationMinutes] = useState<number>(60)
  const [clientMode, setClientMode] = useState<ClientMode>('existing')
  const [contactId, setContactId] = useState('')
  const [newFirstname, setNewFirstname] = useState('')
  const [newLastname, setNewLastname] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [note, setNote] = useState('')
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('paid_offline')
  const [method, setMethod] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Reset the whole draft on each open — a stale field from a previous booking
  // must never leak into the next one.
  useEffect(() => {
    if (!open) return
    setActivityId(appointmentActivities[0]?.id ?? '')
    setProviderId(coaches.some((c) => c.userId === userId) ? userId : (coaches[0]?.userId ?? ''))
    setStart(defaultStart())
    setClientMode('existing')
    setContactId('')
    setNewFirstname('')
    setNewLastname('')
    setNewEmail('')
    setNewPhone('')
    setNote('')
    setPaymentMode('paid_offline')
    setMethod(paymentModes[0] ?? '')
    setAmount('')
    setError(null)
    setSubmitting(false)
    // Deliberately keyed on `open` only — activities/coaches/paymentModes are
    // re-derived from live props each render and would otherwise fight edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedActivity = appointmentActivities.find((a) => a.id === activityId) ?? null
  const durations = resolveAppointmentDurations(selectedActivity ?? {})

  // Keep the selected duration valid whenever the activity (and therefore its
  // duration menu) changes.
  useEffect(() => {
    if (!open) return
    if (!durations.some((d) => d.minutes === durationMinutes)) {
      setDurationMinutes(durations[0]?.minutes ?? 60)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activityId])

  const selectedDuration: ActivityDuration | undefined =
    durations.find((d) => d.minutes === durationMinutes) ?? durations[0]
  // Through the shared reader, so a length that is not sold individually
  // (UX-70) suggests NO amount here — a staff booking may still be made, it
  // just isn't priced from a number the studio removed from sale.
  const basePrice = selectedDuration ? resolveDurationSale(selectedDuration).priceAmount : null
  const showPayment = clientMode !== 'blocked' && typeof basePrice === 'number' && basePrice > 0

  // Suggest the base price whenever the priced item changes; the manager can
  // still edit it (phone-quoted price, discount, adjustment, …).
  useEffect(() => {
    if (!open || !showPayment || typeof basePrice !== 'number') return
    setAmount(basePrice.toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activityId, durationMinutes, clientMode])

  function close() {
    onOpenChange(false)
  }

  async function submit() {
    setError(null)
    if (!activityId) { setError(t('errorActivityRequired')); return }
    if (!providerId) { setError(t('errorCoachRequired')); return }
    if (!start) { setError(t('errorStartRequired')); return }
    if (clientMode === 'existing' && !contactId) { setError(t('errorContactRequired')); return }
    if (clientMode === 'new') {
      if (!newFirstname.trim() || !newLastname.trim() || !newEmail.trim()) {
        setError(t('errorNewContactRequired'))
        return
      }
      if (!EMAIL_RE.test(newEmail.trim())) { setError(t('errorEmailInvalid')); return }
    }

    let paymentAmountMinor: number | undefined
    if (showPayment) {
      const major = parseFloat(amount.replace(',', '.'))
      if (!Number.isFinite(major) || major <= 0) { setError(t('errorAmountInvalid')); return }
      if (paymentMode === 'paid_offline' && !method.trim()) { setError(t('errorMethodRequired')); return }
      paymentAmountMinor = Math.round(major * 100)
    }

    setSubmitting(true)
    try {
      const payload: CreateStaffAppointmentRequest = {
        teamId,
        providerId,
        activityId,
        startMs: start.getTime(),
        durationMinutes,
        locale,
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
      }
      if (clientMode === 'existing') {
        payload.contactId = contactId
      } else if (clientMode === 'new') {
        payload.newContact = {
          firstname: newFirstname.trim(),
          lastname: newLastname.trim(),
          email: newEmail.trim(),
          ...(newPhone.trim() ? { phone: newPhone.trim() } : {}),
        }
      } else {
        payload.blocked = true
      }
      if (note.trim()) payload.note = note.trim()
      if (showPayment) {
        payload.paymentMode = paymentMode
        payload.amount = paymentAmountMinor
        payload.currency = currency
        if (paymentMode === 'paid_offline') payload.method = method.trim()
      }

      const fn = callFunction<CreateStaffAppointmentRequest, CreateStaffAppointmentResponse>('createStaffAppointment')
      const res = await withTimeout(fn(payload))
      const { paymentUrl } = res.data

      onSaved()
      if (paymentUrl) {
        toast.success(t('paymentLinkToast'), {
          description: paymentUrl,
          action: {
            label: t('copyLink'),
            onClick: () => { navigator.clipboard.writeText(paymentUrl) },
          },
        })
      } else {
        toast.success(t('createdToast'))
      }
      close()
    } catch (err) {
      if (err instanceof CallableTimeoutError) toast.error(t('saveTimeoutError'))
      else toast.error(t('saveError', { message: errorMessage(err) }))
    } finally {
      setSubmitting(false)
    }
  }

  const CLIENT_MODES: { key: ClientMode; label: string; icon: typeof UserRound }[] = [
    { key: 'existing', label: t('clientExisting'), icon: UserRound },
    { key: 'new', label: t('clientNew'), icon: UserPlus },
    { key: 'blocked', label: t('clientBlocked'), icon: Ban },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <DialogBody>
        {appointmentActivities.length === 0 ? (
          /* An appointment is booked AGAINST an offering, so with none there is
             nothing to fill this dialog with. It used to say "create one under
             Offer -> Activities" and leave the manager to find it; it links
             there now. */
          <div className="rounded-md border border-dashed p-3 space-y-2">
            <p className="text-sm text-muted-foreground">{t('noAppointmentActivitiesHint')}</p>
            <Link
              href={'/offer/activities' as Route}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('createActivityAction')}
            </Link>
          </div>
        ) : (
          <div className="space-y-5 py-1">
            {/* Appointment — one param per row */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('sectionAppointment')}
              </p>
              <div className="divide-y rounded-lg border">
                <div className="flex items-center justify-between gap-4 p-3">
                  <Label className="font-medium">{t('fieldActivity')}</Label>
                  <Select value={activityId} onValueChange={(v) => setActivityId(v ?? '')}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder={t('fieldActivity')} />
                    </SelectTrigger>
                    <SelectContent>
                      {appointmentActivities.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-4 p-3">
                  <Label className="font-medium">{t('fieldCoach')}</Label>
                  <Select value={providerId} onValueChange={(v) => setProviderId(v ?? '')}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder={t('fieldCoach')} />
                    </SelectTrigger>
                    <SelectContent>
                      {coaches.map((c) => (
                        <SelectItem key={c.userId} value={c.userId}>{coachLabel(c)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-4 p-3">
                  <Label className="font-medium">{t('fieldStart')}</Label>
                  <DateTimePicker value={start} onChange={setStart} className="w-56" />
                </div>

                <div className="p-3 space-y-2">
                  <Label className="font-medium">
                    {t('fieldDuration')}
                    <span className="ml-2 font-normal text-muted-foreground">{formatDuration(durationMinutes)}</span>
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {durations.map((d) => (
                      <button
                        key={d.minutes}
                        type="button"
                        onClick={() => setDurationMinutes(d.minutes)}
                        aria-pressed={durationMinutes === d.minutes}
                        className={`h-9 rounded-md border px-2.5 text-sm transition-colors ${
                          durationMinutes === d.minutes
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {formatDuration(d.minutes)}
                        <span className="ml-1.5 opacity-80">
                          {/* Three modes, not two: a length sold only through a
                              plan is not free, and labeling it "Free" here is
                              what would have a coach book it as one (UX-70). */}
                          {resolveDurationSale(d).mode === 'benefit_only'
                            ? t('durationBenefitOnly')
                            : resolveDurationSale(d).priceAmount
                              ? formatCurrency(resolveDurationSale(d).priceAmount as number, currency, locale)
                              : t('free')}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Client — a 3-way switcher; breaks the row pattern by design. */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('sectionClient')}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {CLIENT_MODES.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setClientMode(key)}
                    className={`flex flex-col items-center gap-1 rounded-lg border p-2.5 text-xs font-medium transition-colors ${
                      clientMode === key
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'text-muted-foreground hover:border-foreground/30'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>

              {clientMode === 'existing' && (
                <ContactPicker teamId={teamId} value={contactId} onChange={setContactId} allowUnassign={false} />
              )}

              {clientMode === 'new' && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={newFirstname}
                      onChange={(e) => setNewFirstname(e.target.value)}
                      placeholder={t('fieldFirstname')}
                    />
                    <Input
                      value={newLastname}
                      onChange={(e) => setNewLastname(e.target.value)}
                      placeholder={t('fieldLastname')}
                    />
                  </div>
                  <Input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder={t('fieldEmail')}
                  />
                  <Input
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder={t('fieldPhoneOptional')}
                  />
                </div>
              )}

              {clientMode === 'blocked' && (
                <div className="space-y-1.5">
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('fieldNotePlaceholder')}
                  />
                  <p className="text-xs text-muted-foreground">{t('fieldNoteHint')}</p>
                </div>
              )}
            </div>

            {/* Payment — only when there's a client AND the chosen duration is priced. */}
            {showPayment && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('sectionPayment')}
                </p>
                <div className="divide-y rounded-lg border">
                  <div className="flex items-center justify-between gap-4 p-3">
                    <Label className="font-medium">{t('fieldPaymentMode')}</Label>
                    <Select value={paymentMode} onValueChange={(v) => v && setPaymentMode(v as PaymentMode)}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="paid_offline">{t('paymentModePaidOffline')}</SelectItem>
                        <SelectItem value="pending_offline">{t('paymentModePendingOffline')}</SelectItem>
                        <SelectItem value="payment_link">{t('paymentModePaymentLink')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {paymentMode === 'paid_offline' && (
                    <div className="flex items-center justify-between gap-4 p-3">
                      <Label className="font-medium">{t('fieldMethod')}</Label>
                      <Select value={method} onValueChange={(v) => setMethod(v ?? '')}>
                        <SelectTrigger className="w-48">
                          <SelectValue placeholder={t('fieldMethod')} />
                        </SelectTrigger>
                        <SelectContent>
                          {paymentModes.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-4 p-3">
                    <Label className="font-medium">{t('fieldAmount', { currency })}</Label>
                    <Input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="h-9 w-28 shrink-0"
                    />
                  </div>
                </div>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={submit} disabled={submitting || appointmentActivities.length === 0}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {submitting ? t('creating') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
