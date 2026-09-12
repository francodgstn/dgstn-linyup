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
import { useSaveShortcut } from '@/hooks/useSaveShortcut'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
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
import { NoShowPolicyCard } from './NoShowPolicyCard'
import { CancellationPolicyCard } from './CancellationPolicyCard'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
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

// One switch row — a ROW IN A GROUP, not a card. It carries no border of its
// own: the `divide-y rounded-lg border` wrapper draws the box and the hairlines
// between rows, exactly as the activity and subscription forms do. Fourteen
// separately-outlined boxes stacked down a settings pane read as fourteen
// unrelated decisions; one box with dividers reads as one panel, which is what
// it is.
//
// Extracted from the old inline map because the appointments row nests a
// control inside itself, and two shapes of the same row rendered two different
// ways is how they drift apart.
//
// IT CARRIES NO MATURITY CHIP any more. `badge`/`badgeHint` existed for the
// waitlist row's "Beta", and left with it — a chip on one row of a settled
// panel was saying "this is opt-in" in the one place the reader could not act
// on it. Settings → Experimental says it once, for everything that is.
function ToggleRow({
  control,
  name,
  label,
  desc,
  children,
}: {
  control: ReturnType<typeof useForm<FormData>>['control']
  name:
    | 'booking.showActivityDescription'
    | 'booking.showPricing'
    | 'booking.showFitnessAppField'
    | 'booking.appointmentsEnabled'
  label: string
  desc: string
  /** Rendered under the row, inside its border — the settings this switch owns. */
  children?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 p-3">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <button
              type="button"
              role="switch"
              aria-checked={field.value}
              onClick={() => field.onChange(!field.value)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                field.value ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-transform ${
                  field.value ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          )}
        />
      </div>
      {children && <div className="border-t p-3">{children}</div>}
    </div>
  )
}

function BookingForm({
  control,
  register,
  customFieldDefinitions,
  customFieldsInstalled,
}: {
  control: ReturnType<typeof useForm<FormData>>['control']
  register: ReturnType<typeof useForm<FormData>>['register']
  /** Already gated on the custom-fields plugin by the page. */
  customFieldDefinitions: CustomFieldDefinition[]
  /** Passed on so the field list can point at the plugin rather than at a
   *  settings tab the studio does not have. */
  customFieldsInstalled: boolean
}) {
  const t = useTranslations('SettingsBooking')
  // The SAME two halves the Public pages screen reads, through the same hook, so
  // the two screens can never say different things about whether the picker is
  // live. `appointmentsLive` is the composed answer (`appointmentPickerLive`);
  // `appointmentsEnabled` is the stored toggle.
  const { flags: publicFlags } = usePublicSurfaces()
  const appointmentsEnabled = publicFlags.appointmentsEnabled
  const appointmentsLive = publicFlags.appointmentsLive
  return (
    <div className="space-y-6">
      {/* Flow type */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('flowTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('flowSubtitle')}</p>
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

      {/* ── ONE PANEL, NOT FOURTEEN CARDS ──────────────────────────────────
          Everything that configures the public booking page now sits in a
          single outlined group with hairlines between rows — the shape the
          activity and subscription forms already use. It replaces a stack of
          individually-bordered cards plus a "More options" disclosure.

          THE DISCLOSURE IS GONE, DELIBERATELY. It was hiding settings that were
          already answered sensibly by default — which is a good reason to
          DEMOTE them (put them lower) and a poor reason to HIDE them: a studio
          looking for the booking window had to guess that a collapsed grey bar
          contained it. Ordering carries that weight instead: what the page
          OFFERS comes first (appointments), then how the form BEHAVES (window,
          cutoff, which fields to ask for), then the optional custom button.

          WAITLISTS USED TO SIT SECOND, as the other thing the page offers, then
          last with a Beta chip. They are not on this page at all now — the
          switch is in Settings → Experimental, which is where an opt-in belongs
          and says the "may change" part once, on a page about exactly that,
          instead of as a chip on one row of a panel of settled settings.

          Each of these still has a default that is right for a studio that
          never opens this panel, so none of them is a question it must answer
          to go live:
            • appointments     -> on (the picker still needs bookable content
                                  behind it — see appointmentPickerLive)
            • booking window   -> 2 months ahead
            • booking cutoff   -> none, i.e. bookable up to the start
            • ask for a phone  -> off (one less field on the public form)
            • show description -> on (what the studio wrote is what visitors see)
            • fitness-app field-> on
            • custom button    -> empty, so no extra button is rendered
          Nothing here changes what anybody is charged or who may book. */}
      <div className="divide-y rounded-lg border">
        <ToggleRow
          control={control}
          name="booking.appointmentsEnabled"
          label={t('toggleAppointmentsEnabledLabel')}
          desc={t('toggleAppointmentsEnabledDesc')}
        >
          {/* THE TOGGLE IS AN INTENTION; the picker also needs something behind
              it (active bookable hours linked to a bookable appointment
              activity — see `appointmentPickerLive`). That "on, but empty" state
              had a signal only on the Public pages screen, which is not where
              anybody is standing when they flip this switch: the studio turned
              it on, saw nothing appear on the public page, and had no way to
              learn why. Same fact, said where the decision is made. */}
          {appointmentsEnabled && !appointmentsLive && (
            <div className="px-3 pb-3 -mt-1">
              <p className="text-xs text-amber-600">
                {t('appointmentsEmptyHint')}{' '}
                <Link href={'/schedule/availability' as Route} className="underline hover:no-underline">
                  {t('appointmentsEmptyHintLink')}
                </Link>
              </p>
            </div>
          )}
        </ToggleRow>

        {/* Booking window */}
        <div className="flex items-center justify-between gap-4 p-3">
          <div>
            <p className="text-sm font-medium">{t('windowTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('windowSubtitle')}</p>
          </div>
          <Controller
            control={control}
            name="booking.windowMonths"
            render={({ field }) => (
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger className="h-9 w-36">
                  <span className="flex flex-1 text-left text-sm truncate">
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
        </div>

        {/* Booking cutoff */}
        <div className="flex items-center justify-between gap-4 p-3">
          <div>
            <p className="text-sm font-medium">{t('cutoffTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('cutoffSubtitle')}</p>
          </div>
          <Controller
            control={control}
            name="booking.cutoffMinutes"
            render={({ field }) => (
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger className="h-9 w-48">
                  <span className="flex flex-1 text-left text-sm truncate">
                    {field.value === 0 ? t('cutoffNone') : t('cutoffMinutesBefore', { minutes: field.value })}
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
        </div>

        {/* Contact fields — a STACKED row (see the CTA block below for the same
            shape). This replaced the old single "ask for a phone number"
            switch: phone is now one row of this list, so there is one place
            that answers "what does the book form ask for" rather than a
            switch here and a list somewhere else. */}
        <div className="p-3">
          <Controller
            control={control}
            name="booking.contactFields"
            render={({ field }) => (
              <BookingContactFieldsEditor
                value={field.value ?? []}
                onChange={field.onChange}
                definitions={customFieldDefinitions}
                customFieldsInstalled={customFieldsInstalled}
              />
            )}
          />
        </div>
        <ToggleRow
          control={control}
          name="booking.showActivityDescription"
          label={t('toggleShowActivityDescriptionLabel')}
          desc={t('toggleShowActivityDescriptionDesc')}
        />
        <ToggleRow
          control={control}
          name="booking.showPricing"
          label={t('toggleShowPricingLabel')}
          desc={t('toggleShowPricingDesc')}
        />
        <ToggleRow
          control={control}
          name="booking.showFitnessAppField"
          label={t('toggleShowFitnessAppLabel')}
          desc={t('toggleShowFitnessAppDesc')}
        />

        {/* CTA button — a STACKED row: two labelled inputs cannot sit opposite
            their own title the way a switch or a select can, so this row keeps
            the group's padding and lets its content run full width. */}
        <div className="space-y-3 p-3">
          <div>
            <p className="text-sm font-medium">{t('ctaTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('ctaSubtitle')}</p>
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('ctaUrlLabel')}</label>
              <Input
                {...register('booking.ctaUrl')}
                type="url"
                placeholder={t('ctaUrlPlaceholder')}
                className="h-9 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('ctaLabelLabel')}</label>
              <Input
                {...register('booking.ctaLabel')}
                placeholder={t('ctaLabelPlaceholder')}
                className="h-9 text-sm"
              />
            </div>
          </div>
        </div>

        {/* THE WAITLIST ROW IS NOT HERE ANY MORE (2026-08-31). It sat last with
            a "Beta" chip; it now lives in Settings → Experimental, with its
            claim window, because a queue is not a booking-page setting in the
            way the window and the cutoff are — those configure a flow every
            studio has, that one decides whether a whole feature exists for
            them. The STORE did not move: `bookingSettings.waitlistEnabled` and
            `waitlistClaimMinutes` are still the fields, still read by the
            activity editor and by the promoter, and this form still carries
            them through a save untouched (see onSubmit). */}
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

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

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isSubmitting, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: getDefaults(stored),
  })

  // Re-hydrate from the store whenever it (re)loads or the team changes —
  // unless the studio has edits in flight, which a background refetch must
  // never throw away.
  useEffect(() => {
    if (stored && !isDirty) reset(getDefaults(stored))
  }, [currentTeamId, stored]) // eslint-disable-line react-hooks/exhaustive-deps

  useSaveShortcut(() => {
    if (isDirty && !isSubmitting) handleSubmit(onSubmit)()
  })

  async function onSubmit(data: FormData) {
    if (!currentTeamId) return
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
      toast.success(t('toastSaved'))
    } catch (err) {
      console.error('[booking save] failed:', err)
      toast.error(err instanceof Error ? err.message : t('toastSaveFailed'))
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

      {/* The save sits at the END of the form, not in the page header. It was
          the only header save in settings — default-size where every other one
          is small, and in a position nothing else used — so it read as a
          different kind of action from the save on the two policy cards
          directly below it.

          The form's content is wrapped in the shared `Card` (bg-card + border +
          shadow-sm) — the house convention every other settings page uses
          (Roles, Emails, the team Payments tab). This page used to be the one
          exception: a bare `divide-y rounded-lg border` panel with no
          background, which read as a different, flatter kind of page next to
          its siblings. `pt-6` because there is no CardHeader here — the page's
          own <h1> above already carries the title, matching the team Payments
          tab's headerless cards. */}
      <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl space-y-5">
        <Card>
          <CardContent className="pt-6">
            <BookingForm
              control={control}
              register={register}
              customFieldDefinitions={customFieldDefinitions}
              customFieldsInstalled={isInstalled('custom-fields')}
            />
          </CardContent>
        </Card>
        <SettingsSaveBar
          onSave={handleSubmit(onSubmit)}
          saving={isSubmitting}
          disabled={!isDirty}
        />
      </form>

      <div className="max-w-2xl space-y-4">
        <CancellationPolicyCard />
        <NoShowPolicyCard />
      </div>
    </div>
  )
}
