'use client'

// Shared "new guest" details form — firstname/lastname/email/phone(+ optional
// fitness-aggregator select) — used by both the class BookingForm ('details'
// step) and the appointment picker's booking modal. Moved out of
// BookingForm.tsx verbatim (same fields, same zod schema, same markup);
// parameterized so each caller controls submit-button rendering and error text.
//
// BookingForm triggers the submit from its sticky bar (outside the <form>
// element) — the forwarded ref exposes an imperative `submit()` for that.

import { forwardRef, useImperativeHandle, useMemo } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { bookingContactFieldCustomId } from '@linyup/shared'
import type { BookingContactField, PublicCustomFieldDefinition } from '@linyup/shared'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function createNewGuestSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    firstname: z.string().min(1, t('errorRequired')).max(60),
    lastname: z.string().min(1, t('errorRequired')).max(60),
    email: z.string().email(t('errorInvalidEmail')),
    phone: z.string().max(30).optional(),
    aggregatorApp: z.string().optional(),
    /**
     * The studio's own contact fields — whatever `resolveBookingContactFields`
     * resolved for this booking, keyed exactly as the server expects them
     * (`birthdate`, `custom:swim_level`, …). Required-ness is enforced in
     * `superRefine` below rather than in the shape, because which keys exist is
     * a runtime answer.
     *
     * `phone` stays a first-class field above even when it arrives through the
     * list, so every existing caller keeps reading `values.phone`.
     */
    contactFieldAnswers: z.record(z.string(), z.unknown()).optional(),
  })
}

/** The same schema, with the studio's required fields actually required. */
function createGuestSchema(
  t: ReturnType<typeof useTranslations>,
  contactFields: BookingContactField[]
) {
  return createNewGuestSchema(t).superRefine((values, ctx) => {
    for (const field of contactFields) {
      if (field.required !== true) continue
      const raw =
        field.key === 'phone' ? values.phone : (values.contactFieldAnswers ?? {})[field.key]
      // An address is a map, so "did they answer" is about its parts. Street
      // and town are the ones that make it an address at all — a lone postcode
      // is not what a studio asking for one wants.
      const empty =
        field.key === 'address'
          ? (() => {
              const a = (raw ?? {}) as Record<string, unknown>
              return !['route', 'locality'].every(
                (k) => typeof a[k] === 'string' && (a[k] as string).trim()
              )
            })()
          : raw === undefined || raw === null || raw === '' || (typeof raw === 'string' && !raw.trim())
      if (!empty) continue
      ctx.addIssue({
        code: 'custom',
        message: t('errorRequired'),
        path: field.key === 'phone' ? ['phone'] : ['contactFieldAnswers', field.key],
      })
    }
  })
}

export type GuestDetailsValues = z.infer<ReturnType<typeof createNewGuestSchema>>

export interface GuestDetailsFormHandle {
  /** Imperatively triggers validation + submit — used by BookingForm's sticky
   *  bar Confirm button, which lives outside this component's <form>. */
  submit: () => void
}

export interface GuestDetailsFormProps {
  /**
   * Whether to ask for a phone number. Callers that resolve the studio's
   * contact-field list pass `contactFields` instead and leave this to follow
   * from it; the appointment picker still passes it on its own.
   */
  showPhone: boolean
  /**
   * The studio's contact fields for THIS booking — already resolved
   * (`resolveBookingContactFields(bookingSettings, activity.contactFields)`).
   * `phone` in this list drives the phone input above; every other key renders
   * below and is submitted under `contactFieldAnswers`, where the server
   * narrows it again before it reaches the contact document.
   */
  contactFields?: BookingContactField[]
  /** Public mirrors of the team's custom-field definitions — label + options
   *  for any `custom:` key in the list. A key with no definition here renders
   *  nothing: it was never opted in to being asked publicly. */
  customFieldDefinitions?: PublicCustomFieldDefinition[]
  /** Whether the studio asks which partner app the visitor came through
   *  (BookingSettings.showFitnessAppField). The question is rendered only when
   *  `aggregatorApps` also has something to offer — see below. */
  showAggregatorField?: boolean
  /**
   * The partner apps this studio actually accepts, by name — the public mirror
   * of its own active `source: 'aggregator'` subscription types
   * (TeamPublicProfile.partner_apps).
   *
   * Empty (or absent) HIDES the question rather than falling back to a generic
   * list. The answer is stored against the studio's own vocabulary and the
   * server refuses anything outside it, so offering names a studio has never
   * heard of would collect nothing and imply a partnership that does not exist.
   */
  aggregatorApps?: string[]
  /**
   * Offer the "send me WhatsApp reminders" checkbox — only when the studio has
   * WhatsApp connected (`TeamPublicProfile.whatsapp_opt_in_offered`) AND this
   * form is asking for a phone number at all. Unticked by default, always; the
   * answer rides to the server as `contactFieldAnswers.whatsapp_opt_in`, the
   * reserved key `buildContactFieldPatch` reads for consent (never a contact
   * field of its own — see packages/functions/src/booking/contactFields.ts).
   *
   * A second, independent box rides beside it under the SAME `offered` gate —
   * "News and offers from {studio}" — sent as
   * `contactFieldAnswers.whatsapp_marketing_opt_in`. Two separate answers
   * (docs/whatsapp-outbound.md → "6a"): reminders is what booking a class
   * implies; news and offers is not, and Meta prices it differently.
   */
  whatsappOptIn?: { offered: boolean; studioName: string }
  submitting: boolean
  error?: string | null
  onSubmit: (values: GuestDetailsValues) => void | Promise<void>
  /** When set, renders a visible full-width submit button with this label
   *  (appointment picker use — a modal with no sticky bar). When omitted, the
   *  submit button is sr-only and must be triggered externally via the
   *  forwarded ref (BookingForm's sticky-bar Confirm button does this). */
  submitLabel?: string
  /** Label shown on the visible submit button while `submitting` is true.
   *  Defaults to the generic "Booking…" copy. Only relevant when `submitLabel`
   *  is set. */
  submittingLabel?: string
  accentColor?: string | null
}

export const GuestDetailsForm = forwardRef<GuestDetailsFormHandle, GuestDetailsFormProps>(
  function GuestDetailsForm(
    {
      showPhone,
      contactFields,
      customFieldDefinitions,
      showAggregatorField,
      aggregatorApps,
      whatsappOptIn,
      submitting,
      error,
      onSubmit,
      submitLabel,
      submittingLabel,
      accentColor,
    },
    ref
  ) {
    const t = useTranslations('PublicBooking')
    // Every row except phone, which has its own input above and predates the
    // list. A `custom:` key with no public definition is dropped here — the
    // studio never opted it in, so there is nothing to label it with.
    const extraFields = useMemo(() => {
      const defs = new Map((customFieldDefinitions ?? []).map((d) => [d.id, d]))
      return (contactFields ?? [])
        .filter((f) => f.key !== 'phone')
        .map((f) => {
          const customId = bookingContactFieldCustomId(f.key)
          return { field: f, def: customId ? defs.get(customId) : undefined, customId }
        })
        .filter((row) => !row.customId || !!row.def)
    }, [contactFields, customFieldDefinitions])
    const askPhone = contactFields ? contactFields.some((f) => f.key === 'phone') : showPhone
    const phoneRequired = contactFields?.some((f) => f.key === 'phone' && f.required) ?? false
    const schema = useMemo(() => createGuestSchema(t, contactFields ?? []), [t, contactFields])
    const form = useForm<GuestDetailsValues>({ resolver: zodResolver(schema) })

    useImperativeHandle(ref, () => ({
      submit: () => {
        form.handleSubmit(onSubmit)()
      },
    }))

    return (
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelFirstName')} <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              {...form.register('firstname')}
              autoComplete="given-name"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {form.formState.errors.firstname && (
              <p className="text-xs text-destructive">{form.formState.errors.firstname.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelLastName')} <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              {...form.register('lastname')}
              autoComplete="family-name"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {form.formState.errors.lastname && (
              <p className="text-xs text-destructive">{form.formState.errors.lastname.message}</p>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">
            {t('labelEmail')} <span className="text-destructive">*</span>
          </label>
          <input
            type="email"
            {...form.register('email')}
            autoComplete="email"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>

        {askPhone && (
          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelPhone')}{' '}
              {phoneRequired ? (
                <span className="text-destructive">*</span>
              ) : (
                <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
              )}
            </label>
            <input
              type="tel"
              {...form.register('phone')}
              autoComplete="tel"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {form.formState.errors.phone && (
              <p className="text-xs text-destructive">{form.formState.errors.phone.message}</p>
            )}
          </div>
        )}

        {/* Never pre-ticked — this is Meta-required consent, not a default. Two
            separate answers, same gate: reminders is implied by booking a
            class, news and offers is not. */}
        {askPhone && whatsappOptIn?.offered && (
          <>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                {...form.register('contactFieldAnswers.whatsapp_opt_in')}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-primary"
              />
              <span className="text-muted-foreground">
                {t('whatsappOptInLabel', { studioName: whatsappOptIn.studioName })}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                {...form.register('contactFieldAnswers.whatsapp_marketing_opt_in')}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-primary"
              />
              <span className="text-muted-foreground">
                {t('whatsappMarketingOptInLabel', { studioName: whatsappOptIn.studioName })}
              </span>
            </label>
          </>
        )}

        {/* The studio's own contact fields. Rendered from the RESOLVED list, so
            a team-wide field and an activity's own extra field look identical
            to the person filling the form — which is the point: they are
            answering about themselves, not about this class. */}
        {extraFields.map(({ field, def }) => {
          const label = def?.label ?? t(`contactField_${field.key}` as Parameters<typeof t>[0])
          // An address error is attached to the GROUP, not to one of its four
          // inputs, so this reads a message only where one was set.
          const errNode = (
            form.formState.errors.contactFieldAnswers as Record<string, { message?: unknown }> | undefined
          )?.[field.key]
          const error = typeof errNode?.message === 'string' ? errNode.message : undefined
          const inputClass =
            'w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary'
          return (
            <div key={field.key} className="space-y-1">
              <label className="text-sm font-medium">
                {label}{' '}
                {field.required ? (
                  <span className="text-destructive">*</span>
                ) : (
                  <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
                )}
              </label>
              {field.key === 'address' ? (
                // The four parts of ContactAddress, because that is what the
                // contact stores — a single line would land in a key no reader
                // looks at.
                <div className="grid grid-cols-3 gap-2">
                  <input
                    {...form.register('contactFieldAnswers.address.route')}
                    placeholder={t('contactFieldAddressRoute')}
                    autoComplete="address-line1"
                    className={`${inputClass} col-span-2`}
                  />
                  <input
                    {...form.register('contactFieldAnswers.address.street_number')}
                    placeholder={t('contactFieldAddressNumber')}
                    autoComplete="address-line2"
                    className={inputClass}
                  />
                  <input
                    {...form.register('contactFieldAnswers.address.postal_code')}
                    placeholder={t('contactFieldAddressPostalCode')}
                    autoComplete="postal-code"
                    className={inputClass}
                  />
                  <input
                    {...form.register('contactFieldAnswers.address.locality')}
                    placeholder={t('contactFieldAddressLocality')}
                    autoComplete="address-level2"
                    className={`${inputClass} col-span-2`}
                  />
                </div>
              ) : def?.type === 'select' ? (
                <select
                  {...form.register(`contactFieldAnswers.${field.key}`)}
                  className={inputClass}
                  defaultValue=""
                >
                  <option value="">—</option>
                  {(def.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : def?.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  {...form.register(`contactFieldAnswers.${field.key}`)}
                  className="h-4 w-4 accent-primary"
                />
              ) : (
                <input
                  type={
                    def?.type === 'number'
                      ? 'number'
                      : def?.type === 'date' || field.key === 'birthdate'
                        ? 'date'
                        : 'text'
                  }
                  // A number field posts a STRING without this, and the server
                  // stores what it is given.
                  {...form.register(`contactFieldAnswers.${field.key}`, {
                    valueAsNumber: def?.type === 'number',
                  })}
                  autoComplete="off"
                  className={inputClass}
                />
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )
        })}

        {/* Asked only when the studio both wants the question AND has partner
            apps to name. An empty dropdown is a worse question than no
            question: whatever it collected could not be stored. */}
        {showAggregatorField && (aggregatorApps?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelFitnessApp')} <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
            </label>
            <Controller
              name="aggregatorApp"
              control={form.control}
              render={({ field }) => (
                <Select
                  value={field.value || '__none__'}
                  onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t('notUsingFitnessApp')}</SelectItem>
                    {(aggregatorApps ?? []).map((app) => (
                      <SelectItem key={app} value={app}>
                        {app}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {submitLabel ? (
          <button
            type="submit"
            disabled={submitting}
            style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-sm"
          >
            {submitting ? (submittingLabel ?? t('ctaBooking')) : submitLabel}
          </button>
        ) : (
          // Hidden submit — triggered externally (e.g. BookingForm's sticky bar).
          <button type="submit" className="sr-only" aria-hidden="true">
            {t('srOnlySubmit')}
          </button>
        )}
      </form>
    )
  }
)
