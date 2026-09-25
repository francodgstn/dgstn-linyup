'use client'

// Booking page settings — how the public /public/{slug}/booking flow behaves.
// Extracted out of the bio-link editor into its own "Configure" page.
//
// ONE store: `teams/{id}/public_profile/{id}.bookingSettings`. This form writes
// it, this form re-hydrates from it, the public booking page reads it, the
// mobile app reads it and every booking callable reads it
// (packages/functions/src/booking/bookingSettings.ts). The team-doc mirror
// (`settings.booking`) is gone — it was owner-only, so a manager's mirror write
// was denied and the cutoff she had just set applied on the public page and
// nowhere else, while the form showed her the old value (UX-6).

import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useBookingSettings } from '@/hooks/useBookingSettings'
import { usePublicSurfaces } from '@/hooks/usePublicSurfaces'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import {  TEAMS_COLLECTION, PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import { resolveBookingContactFields } from '@linyup/shared'
import type {
  Team,
  BookingSettings,
  BookingContactField,
  CustomFieldDefinition,
} from '@linyup/shared'
import { BookingContactFieldsEditor } from '@/components/booking/BookingContactFieldsEditor'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { NoShowPolicyRows } from './NoShowPolicyRows'
import { CancellationPolicyRow } from './CancellationPolicyRow'
import { SaveBarProvider, useSaveBarSection } from '@/components/forms/SaveBar'
import { HintTip, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { PublicSurfaceLink } from '@/components/layout/PublicSurfaceLink'

// ─── schema ──────────────────────────────────────────────────────────────────

function createSafeUrlSchema(t: ReturnType<typeof useTranslations>) {
  return z
    .string()
    .refine((v) => v === '' || /^https?:\/\/.+/.test(v), t('errorInvalidUrl'))
    .optional()
}

function createBookingSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    flowType: z.enum(['activity-first', 'date-first']),
    windowMonths: z.number().int().min(1).max(6),
    showPhone: z.boolean(),
    contactFields: z.array(z.object({ key: z.string(), required: z.boolean().optional() })),
    showActivityDescription: z.boolean(),
    showPricing: z.boolean(),
    showFitnessAppField: z.boolean(),
    ctaUrl: createSafeUrlSchema(t),
    ctaLabel: z.string().optional(),
    appointmentsEnabled: z.boolean().optional(),
    waitlistEnabled: z.boolean().optional(),
    cutoffMinutes: z.number().int().min(0).max(10080),
    // A MAXIMUM, not a guarantee: the claim window is also clamped by the
    // cutoff above and by the session start, and an offer is simply not made
    // when what survives that clamp is too short to reach checkout.
    waitlistClaimMinutes: z.number().int().min(60).max(1440),
  })
}

function createSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({ booking: createBookingSchema(t) })
}

type FormData = z.infer<ReturnType<typeof createSchema>>

// ─── data hook ────────────────────────────────────────────────────────────────

function useTeam(teamId: string | null) {
  return useQuery<Team | null>({
    queryKey: ['team', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return snap.exists() ? ({ id: snap.id, ...snap.data() } as Team) : null
    },
  })
}

function getDefaults(stored: Partial<BookingSettings> | undefined): FormData {
  const rawBooking = (stored ?? {}) as Record<string, unknown>
  const rawMonths = Number(rawBooking.windowMonths)
  const windowMonths =
    Number.isInteger(rawMonths) && rawMonths >= 1 && rawMonths <= 6 ? rawMonths : 2
  const flowType = rawBooking.flowType === 'date-first' ? 'date-first' : 'activity-first'
  const rawCutoff = Number(rawBooking.cutoffMinutes)
  const cutoffMinutes = Number.isInteger(rawCutoff) && rawCutoff >= 0 && rawCutoff <= 10080 ? rawCutoff : 0
  const rawClaim = Number(rawBooking.waitlistClaimMinutes)
  // Absent falls back to the SAME default the promoter applies server-side
  // (WAITLIST_DEFAULT_CLAIM_MINUTES) — showing a different number here than the
  // one actually used is worse than showing none.
  const waitlistClaimMinutes =
    Number.isInteger(rawClaim) && rawClaim >= 60 && rawClaim <= 1440 ? rawClaim : 120
  return {
    booking: {
      flowType,
      windowMonths,
      showPhone: rawBooking.showPhone === true,
      // Seeded from the legacy flag while the list is absent, through the SAME
      // shared fallback the callables and the public form use — so a studio
      // that never opens this page sees exactly what its visitors already get.
      contactFields: resolveBookingContactFields(
        rawBooking as { contactFields?: BookingContactField[]; showPhone?: boolean },
        null
      ),
      showActivityDescription: rawBooking.showActivityDescription !== false,
      // Defaults ON — `!== false` — and the public form reads it the same way
      // (BookingForm's `showPricing`): the prices are the studio's, and a
      // studio that never opened this page still shows them.
      showPricing: rawBooking.showPricing !== false,
      // Defaults ON, like showActivityDescription above and unlike showPhone:
      // `!== false` so an absent flag reads as shown. A studio that does not
      // want the field switches it off; a studio that has never opened this
      // page still collects the answer, which is the useful default for a
      // field that only ever adds context to a booking.
      showFitnessAppField: rawBooking.showFitnessAppField !== false,
      ctaUrl: typeof rawBooking.ctaUrl === 'string' ? rawBooking.ctaUrl : '',
      ctaLabel: typeof rawBooking.ctaLabel === 'string' ? rawBooking.ctaLabel : '',
      // Defaults ON — `!== false`, like showActivityDescription above. Every
      // reader spells it the same way; the list of them is on
      // `BookingSettings.appointmentsEnabled` (types/team.ts), not repeated here.
      appointmentsEnabled: rawBooking.appointmentsEnabled !== false,
      waitlistEnabled: rawBooking.waitlistEnabled === true,
      cutoffMinutes,
      waitlistClaimMinutes,
    },
  }
}

// ─── booking form ──────────────────────────────────────────────────────────────

// Tiny visual mock of each flow's first step — a mini calendar (date-first) or a
// list of activities (activity-first) — shown on its choice card.
function FlowPreview({
  kind,
  selected,
}: {
  kind: 'activity-first' | 'date-first'
  selected: boolean
}) {
  const accent = selected ? 'bg-primary' : 'bg-foreground/30'
  const accentSoft = selected ? 'bg-primary/40' : 'bg-foreground/20'

  if (kind === 'date-first') {
    return (
      <div className="rounded-md border bg-muted/40 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <div className={`h-1.5 w-8 rounded ${accentSoft}`} />
          <div className="flex gap-0.5">
            <div className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
            <div className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
          </div>
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {Array.from({ length: 21 }).map((_, i) => (
            <div
              key={i}
              className={`aspect-square rounded-[2px] ${i === 9 ? accent : 'bg-foreground/[0.08]'}`}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/40 p-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={`flex items-center gap-1.5 rounded-[3px] px-1.5 py-1 ${
            i === 0
              ? selected
                ? 'bg-primary/15 ring-1 ring-primary/40'
                : 'bg-foreground/10 ring-1 ring-foreground/20'
              : 'bg-foreground/[0.05]'
          }`}
        >
          <div className={`h-3 w-3 shrink-0 rounded-full ${i === 0 ? accent : 'bg-foreground/25'}`} />
          <div className={`h-1.5 flex-1 rounded ${i === 0 ? accentSoft : 'bg-foreground/20'}`} />
        </div>
      ))}
    </div>
  )
}

// A switch bound to one boolean of the form. The row around it is the shared
// SettingsRow, so this is only the control.
function FormSwitch({
  control,
  name,
  id,
}: {
  control: ReturnType<typeof useForm<FormData>>['control']
  name:
    | 'booking.showActivityDescription'
    | 'booking.showPricing'
    | 'booking.showFitnessAppField'
    | 'booking.appointmentsEnabled'
  id: string
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} />
      )}
    />
  )
}

// ── ROWS, NOT A CARD (the Settings → General layout) ──────────────────────
// This page used to be one Card holding a hand-rolled bordered panel of
// switch rows, each with its description printed under it, followed by two
// more Cards (cancellation, no-show) with their own Saves. It is now four
// sections of rows with hairlines between them and one Save, the floating bar.
// The descriptions moved behind each row's ⓘ; the two that stay visible are the
// ones a studio acts on (the "nothing is bookable yet" warning and the no-show
// terms being public).
//
// THE ORDER STILL CARRIES THE WEIGHT the old comment here described: what the
// page OFFERS comes first (the flow, bookable hours), then how the form
// BEHAVES (window, cutoff, what it shows), then what it ASKS (contact fields),
// then the optional button. Every one of them has a default that is right for
// a studio that never opens this page:
//   • appointments     -> on (the picker still needs bookable content behind
//                         it — see appointmentPickerLive)
//   • booking window   -> 2 months ahead
//   • booking cutoff   -> none, i.e. bookable up to the start
//   • contact fields   -> the team default (phone off)
//   • show description -> on
//   • show prices      -> on
//   • partner field    -> on
//   • custom button    -> empty, so no extra button is rendered
// Nothing here changes what anybody is charged or who may book.
//
// WAITLISTS ARE NOT ON THIS PAGE: the switch and its claim window are in
// Settings → Experimental. The store did not move — `waitlistEnabled` and
// `waitlistClaimMinutes` are still carried through a save untouched (see
// onSubmit).
function BookingForm({
  control,
  register,
  errors,
  customFieldDefinitions,
  customFieldsInstalled,
}: {
  control: ReturnType<typeof useForm<FormData>>['control']
  register: ReturnType<typeof useForm<FormData>>['register']
  errors: ReturnType<typeof useForm<FormData>>['formState']['errors']
  /** Already gated on the custom-fields plugin by the page. */
  customFieldDefinitions: CustomFieldDefinition[]
  /** Passed on so the field list can point at the plugin rather than at a
   *  settings tab the studio does not have. */
  customFieldsInstalled: boolean
}) {
  const t = useTranslations('SettingsBooking')
  const tFields = useTranslations('BookingContactFields')
  // The SAME two halves the Public pages screen reads, through the same hook, so
  // the two screens can never say different things about whether the picker is
  // live. `appointmentsLive` is the composed answer (`appointmentPickerLive`);
  // `appointmentsEnabled` is the stored toggle.
  const { flags: publicFlags } = usePublicSurfaces()
  const appointmentsEnabled = publicFlags.appointmentsEnabled
  const appointmentsLive = publicFlags.appointmentsLive
  return (
    <>
      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1.5">
            {t('flowTitle')}
            <HintTip>{t('flowSubtitle')}</HintTip>
          </span>
        }
      >
        {/* The two flows as picture cards: a studio chooses by what the
            visitor will SEE first, and a sketch of it says that faster than
            either label. */}
        <div className="py-4">
          <Controller
            control={control}
            name="booking.flowType"
            render={({ field }) => (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(
                  [
                    {
                      value: 'activity-first',
                      label: t('flowActivityFirstLabel'),
                      desc: t('flowActivityFirstDesc'),
                    },
                    {
                      value: 'date-first',
                      label: t('flowDateFirstLabel'),
                      desc: t('flowDateFirstDesc'),
                    },
                  ] as const
                ).map((opt) => {
                  const selected = field.value === opt.value
                  return (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer flex-col gap-3 rounded-lg border p-3 transition-colors ${
                        selected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                          : 'hover:bg-muted/30'
                      }`}
                    >
                      <FlowPreview kind={opt.value} selected={selected} />
                      <div className="flex items-start gap-2">
                        <input
                          type="radio"
                          value={opt.value}
                          checked={selected}
                          onChange={() => field.onChange(opt.value)}
                          className="mt-0.5 accent-primary"
                        />
                        <div>
                          <p className="text-sm font-medium">{opt.label}</p>
                          <p className="text-xs text-muted-foreground">{opt.desc}</p>
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('sectionPage')}>
        {/* ONE child of the divided list, so no hairline falls between the
            switch and the warning that belongs to it. */}
        <div>
          <SettingsRow
            inline
            htmlFor="booking-appointments"
            label={t('toggleAppointmentsEnabledLabel')}
            hint={t('toggleAppointmentsEnabledDesc')}
          >
            <FormSwitch
              control={control}
              name="booking.appointmentsEnabled"
              id="booking-appointments"
            />
          </SettingsRow>
          {/* THE TOGGLE IS AN INTENTION; the picker also needs something
              behind it (active bookable hours linked to a bookable appointment
              activity — see `appointmentPickerLive`). Said where the switch
              is, because this is where a studio stands when it wonders why
              nothing appeared on the public page. Always visible: it is a
              problem to act on, not a description. */}
          {appointmentsEnabled && !appointmentsLive && (
            <p className="-mt-2 pb-4 text-xs text-amber-600">
              {t('appointmentsEmptyHint')}{' '}
              <Link
                href={'/schedule/availability' as Route}
                className="underline hover:no-underline"
              >
                {t('appointmentsEmptyHintLink')}
              </Link>
            </p>
          )}
        </div>

        <SettingsRow htmlFor="booking-window" label={t('windowTitle')} hint={t('windowSubtitle')}>
          <Controller
            control={control}
            name="booking.windowMonths"
            render={({ field }) => (
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger id="booking-window" className="w-full">
                  <span className="flex flex-1 truncate text-left text-sm">
                    {t('windowMonths', { count: field.value })}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('windowMonths', { count: 1 })}</SelectItem>
                  <SelectItem value="2">{t('windowMonths', { count: 2 })}</SelectItem>
                  <SelectItem value="3">{t('windowMonths', { count: 3 })}</SelectItem>
                  <SelectItem value="6">{t('windowMonths', { count: 6 })}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </SettingsRow>

        <SettingsRow htmlFor="booking-cutoff" label={t('cutoffTitle')} hint={t('cutoffSubtitle')}>
          <Controller
            control={control}
            name="booking.cutoffMinutes"
            render={({ field }) => (
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger id="booking-cutoff" className="w-full">
                  <span className="flex flex-1 truncate text-left text-sm">
                    {field.value === 0
                      ? t('cutoffNone')
                      : t('cutoffMinutesBefore', { minutes: field.value })}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">{t('cutoffNone')}</SelectItem>
                  <SelectItem value="15">{t('cutoffMinutesBefore', { minutes: 15 })}</SelectItem>
                  <SelectItem value="30">{t('cutoffMinutesBefore', { minutes: 30 })}</SelectItem>
                  <SelectItem value="60">{t('cutoffMinutesBefore', { minutes: 60 })}</SelectItem>
                  <SelectItem value="120">{t('cutoffMinutesBefore', { minutes: 120 })}</SelectItem>
                  <SelectItem value="1440">{t('cutoffMinutesBefore', { minutes: 1440 })}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </SettingsRow>

        <SettingsRow
          inline
          htmlFor="booking-show-description"
          label={t('toggleShowActivityDescriptionLabel')}
          hint={t('toggleShowActivityDescriptionDesc')}
        >
          <FormSwitch
            control={control}
            name="booking.showActivityDescription"
            id="booking-show-description"
          />
        </SettingsRow>
        <SettingsRow
          inline
          htmlFor="booking-show-pricing"
          label={t('toggleShowPricingLabel')}
          hint={t('toggleShowPricingDesc')}
        >
          <FormSwitch control={control} name="booking.showPricing" id="booking-show-pricing" />
        </SettingsRow>
        <SettingsRow
          inline
          htmlFor="booking-show-partner"
          label={t('toggleShowFitnessAppLabel')}
          hint={t('toggleShowFitnessAppDesc')}
        >
          <FormSwitch
            control={control}
            name="booking.showFitnessAppField"
            id="booking-show-partner"
          />
        </SettingsRow>

        {/* Two inputs cannot sit opposite one title, so the control column
            holds both, each with its own small label. */}
        <SettingsRow
          htmlFor="booking-cta-url"
          label={t('ctaTitle')}
          hint={t('ctaSubtitle')}
          error={errors.booking?.ctaUrl?.message}
        >
          <div className="space-y-2">
            <Input
              id="booking-cta-url"
              {...register('booking.ctaUrl')}
              type="url"
              aria-label={t('ctaUrlLabel')}
              aria-invalid={!!errors.booking?.ctaUrl || undefined}
              placeholder={t('ctaUrlPlaceholder')}
              className="font-mono"
            />
            <Input
              {...register('booking.ctaLabel')}
              aria-label={t('ctaLabelLabel')}
              placeholder={t('ctaLabelPlaceholder')}
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* WHAT THE FORM ASKS. The editor keeps its own list (a box of rows is
          right there: each is an item, not a setting); its title and
          description become this section's heading. Phone is one row of the
          list, so there is one place that answers "what does the book form ask
          for". */}
      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1.5">
            {tFields('title')}
            <HintTip>{tFields('descriptionTeam')}</HintTip>
          </span>
        }
      >
        <div className="py-4">
          <Controller
            control={control}
            name="booking.contactFields"
            render={({ field }) => (
              <BookingContactFieldsEditor
                hideHeader
                value={field.value ?? []}
                onChange={field.onChange}
                definitions={customFieldDefinitions}
                customFieldsInstalled={customFieldsInstalled}
              />
            )}
          />
        </div>
      </SettingsSection>
    </>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

/** The booking form's registration with the page's save bar. A component of
 *  its own because the hook must sit INSIDE the provider the page renders. */
function BookingFormSection({
  form,
  onSubmit,
}: {
  form: ReturnType<typeof useForm<FormData>>
  onSubmit: (data: FormData) => Promise<boolean>
}) {
  const { handleSubmit, reset, formState } = form
  useSaveBarSection('booking-settings', {
    dirty: formState.isDirty,
    // Validation runs on save (zod); a refused save shows the field error and
    // leaves the bar up.
    valid: true,
    save: () =>
      new Promise<boolean>((resolve) => {
        void handleSubmit(
          async (data) => resolve(await onSubmit(data)),
          () => resolve(false)
        )()
      }),
    reset: () => reset(),
  })
  return null
}

export default function BookingSettingsPage() {
  const { currentTeamId } = useAuth()
  // The team doc is still read for the slug + name copied onto the public
  // profile below; the booking settings themselves come from that same public
  // profile — the one store this form both reads and writes.
  const { data: team, isLoading: teamLoading } = useTeam(currentTeamId)
  const { data: stored, isLoading: settingsLoading } = useBookingSettings(currentTeamId)
  // Gated the same way the contacts list gates them: custom fields are a
  // plugin, and offering rows a studio cannot manage sends them looking for a
  // settings page they do not have.
  const { isInstalled } = useInstalledPlugins()
  const customFieldDefinitions = useMemo(
    () => (isInstalled('custom-fields') ? team?.custom_field_definitions ?? [] : []),
    [isInstalled, team?.custom_field_definitions]
  )
  const isLoading = teamLoading || settingsLoading
  const qc = useQueryClient()
  const t = useTranslations('SettingsBooking')
  const tNav = useTranslations('Nav')
  const schema = useMemo(() => createSchema(t), [t])

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: getDefaults(stored),
  })
  const {
    register,
    control,
    reset,
    formState: { isDirty, errors },
  } = form

  // Re-hydrate from the store whenever it (re)loads or the team changes —
  // unless the studio has edits in flight, which a background refetch must
  // never throw away.
  useEffect(() => {
    if (stored && !isDirty) reset(getDefaults(stored))
  }, [currentTeamId, stored]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(data: FormData): Promise<boolean> {
    if (!currentTeamId) return false
    const bookingSettings: BookingSettings = {
      flowType: data.booking.flowType,
      windowMonths: data.booking.windowMonths,
      // DERIVED, never edited: the legacy flag is only ever read as a fallback
      // while `contactFields` is absent, and saving this form makes it present.
      // Keeping the two in agreement means an older reader (or a rollback)
      // still sees the studio's actual choice rather than a stale switch.
      showPhone: data.booking.contactFields.some((f) => f.key === 'phone'),
      contactFields: data.booking.contactFields,
      showActivityDescription: data.booking.showActivityDescription,
      showPricing: data.booking.showPricing,
      showFitnessAppField: data.booking.showFitnessAppField,
      ctaUrl: data.booking.ctaUrl || null,
      ctaLabel: data.booking.ctaLabel || null,
      // Absent ⇒ ON, the same way `getDefaults` above reads it — a save must
      // never be the thing that decides the default differently from the form
      // that produced it.
      appointmentsEnabled: data.booking.appointmentsEnabled ?? true,
      // CARRIED THROUGH, NOT EDITED. Both moved to Settings → Experimental; the
      // form still hydrates them (getDefaults) and still writes them back, so
      // saving this page cannot silently close a studio's queues or reset a
      // claim window it no longer shows. Dropping them from the write would
      // leave the stored values standing (the setDoc merges) but would let this
      // form's re-hydrate disagree with the store, which is the shape of UX-6.
      waitlistEnabled: data.booking.waitlistEnabled ?? false,
      cutoffMinutes: data.booking.cutoffMinutes,
      waitlistClaimMinutes: data.booking.waitlistClaimMinutes,
    }
    try {
      // ONE write, to the one store — team-member writable, world-readable, and
      // what the booking callables read. There is no second write to fail
      // silently behind it.
      const profileRef = doc(db, TEAMS_COLLECTION, currentTeamId, PUBLIC_PROFILE_SUBCOLLECTION, currentTeamId)
      await setDoc(
        profileRef,
        { type: 'team', slug: team?.slug ?? '', name: team?.name ?? '', bookingSettings },
        { merge: true }
      )
      // Saved state, from what was actually written — the form is clean again
      // and the next background refetch has nothing to disagree with.
      reset(getDefaults(bookingSettings))
      await qc.invalidateQueries({ queryKey: ['booking-settings', currentTeamId] })
      // No success toast: the save bar says "Saved" itself.
      return true
    } catch (err) {
      console.error('[booking save] failed:', err)
      toast.error(err instanceof Error ? err.message : t('toastSaveFailed'))
      return false
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-5xl space-y-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('pageTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('pageSubtitle')}</p>
        </div>
        {/* THE PAGE THIS ONE CONFIGURES. Every control below changes what a
            visitor sees, and the right-hand side of this header was empty — so
            checking the result meant knowing the public URL by heart. */}
        <PublicSurfaceLink subPath="booking" label={tNav('bookingPage')} className="shrink-0" />
      </div>

      {/* ONE SAVE FOR THE PAGE. The booking form (public profile) and the
          two policies (team doc, owner-only) are three writes to two
          documents, and used to be three Save buttons. Each still owns its
          write and registers with this bar; the bar is the only button. */}
      <SaveBarProvider>
        <BookingFormSection form={form} onSubmit={onSubmit} />
        <form
          onSubmit={(e) => e.preventDefault()}
          className="max-w-2xl space-y-10"
        >
          <BookingForm
            control={control}
            register={register}
            errors={errors}
            customFieldDefinitions={customFieldDefinitions}
            customFieldsInstalled={isInstalled('custom-fields')}
          />
          <SettingsSection title={t('sectionPolicies')}>
            <CancellationPolicyRow />
            <NoShowPolicyRows />
          </SettingsSection>
        </form>
      </SaveBarProvider>
    </div>
  )
}
