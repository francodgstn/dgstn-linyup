'use client'

/**
 * Picking which CONTACT fields a book form collects.
 *
 * Used in two places with the same shape: Settings → Booking (the team-wide
 * list) and the activity editor (the per-activity list, which EXTENDS the team
 * one — it never replaces it, so the activity surface says so rather than
 * letting a studio assume the fields it does not tick are switched off).
 *
 * ── WHY A CUSTOM FIELD MAY BE UNAVAILABLE HERE ───────────────────────────────
 * A custom field can only be asked on the public book form once its definition
 * opts in (`publicOnBookingForm`), because asking it means mirroring its label
 * and options into the world-readable team profile. Rather than hide the
 * un-ticked ones — which reads as "the field is missing" and sends people
 * looking for a bug — they are listed, disabled, with the reason and where to
 * change it.
 *
 * ── TWO STEPS, DELIBERATELY, AND BOTH NAMED ──────────────────────────────────
 * Opting a definition in makes the field ASKABLE; switching it on here is what
 * starts ASKING it. Nothing links the two automatically, and that is the point:
 * the opt-in is an edit to the team doc in another settings tab, and letting it
 * silently add a question to the public book form would put a new field in front
 * of every newcomer off the back of a decision that never mentioned them.
 * The cost of two steps is that the second one is invisible, so this list says
 * out loud when a field is available but not asked, and where to add more.
 */

import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import {
  BOOKING_CONTACT_BASE_FIELDS,
  BOOKING_CONTACT_FIELD_CUSTOM_PREFIX,
  type BookingContactField,
  type CustomFieldDefinition,
} from '@linyup/shared'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

const CUSTOM_FIELDS_SETTINGS_ROUTE = '/settings/team?tab=custom-fields' as Route

interface Props {
  value: BookingContactField[]
  onChange: (next: BookingContactField[]) => void
  /** The team's definitions — un-opted-in ones render disabled, not hidden. */
  definitions: CustomFieldDefinition[]
  /** Whether the custom-fields plugin is installed.
   *
   *  DEFAULTS TO FALSE, i.e. to the upsell footer, because that branch is the
   *  safe one in both states: `/plugins` is always there, while the
   *  installed branch points at `/settings/team?tab=custom-fields`, a tab that
   *  only exists once the plugin is on and that otherwise falls back to General
   *  without saying why — a dead link exactly for the studio that has the least
   *  context. A mount that knows should still pass the real value: the upsell
   *  copy is wrong (not broken) for a studio that already has the plugin. */
  customFieldsInstalled?: boolean
  /** True in the activity editor, where the list EXTENDS the team default. */
  extendsTeamDefault?: boolean
  /** Keys already asked team-wide, shown as inherited in the activity editor. */
  inheritedKeys?: string[]
  /** Leave the title and description to the host, when it already shows them
   *  as a section heading (Settings → Booking). */
  hideHeader?: boolean
}

export function BookingContactFieldsEditor({
  value,
  onChange,
  definitions,
  customFieldsInstalled = false,
  extendsTeamDefault,
  inheritedKeys = [],
  hideHeader = false,
}: Props) {
  const t = useTranslations('BookingContactFields')
  const selected = new Map(value.map((f) => [f.key, f]))

  function toggle(key: string, on: boolean) {
    onChange(on ? [...value, { key }] : value.filter((f) => f.key !== key))
  }

  function setRequired(key: string, required: boolean) {
    onChange(value.map((f) => (f.key === key ? { ...f, required } : f)))
  }

  function row(key: string, label: string, opts?: { disabled?: boolean; hint?: React.ReactNode }) {
    const chosen = selected.get(key)
    const inherited = inheritedKeys.includes(key)
    return (
      <div key={key} className="flex items-start justify-between gap-3 py-2">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{label}</Label>
          {inherited && (
            <p className="text-xs text-muted-foreground">{t('inheritedFromTeam')}</p>
          )}
          {opts?.hint && <p className="text-xs text-muted-foreground">{opts.hint}</p>}
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {/* Shown even while the field is off, disabled. It used to render only
              once the field was on, so a studio looking for "required" at the
              moment it switched the field on found nothing where it had just
              been — and could not tell whether required had taken effect.
              The exception is a row this list does not own: an inherited field
              the activity has not added has its required-ness set by the team
              default, and an OFF switch beside it would assert "not required"
              about a field the team may well require. */}
          {!(inherited && !chosen) && (
            <label
              className={`flex items-center gap-2 text-xs text-muted-foreground ${
                chosen ? '' : 'opacity-50'
              }`}
            >
              {t('required')}
              <Switch
                checked={chosen?.required === true}
                disabled={!chosen}
                onCheckedChange={(v) => setRequired(key, v)}
              />
            </label>
          )}
          <Switch
            checked={!!chosen}
            disabled={opts?.disabled}
            onCheckedChange={(v) => toggle(key, v)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {!hideHeader && (
        <div>
          <p className="text-sm font-medium">{t('title')}</p>
          <p className="text-xs text-muted-foreground">
            {extendsTeamDefault ? t('descriptionActivity') : t('descriptionTeam')}
          </p>
        </div>
      )}

      <div className="divide-y rounded-md border px-3">
        {BOOKING_CONTACT_BASE_FIELDS.map((key) =>
          row(key, t(`field_${key}` as Parameters<typeof t>[0]))
        )}
        {definitions.map((def) => {
          const key = `${BOOKING_CONTACT_FIELD_CUSTOM_PREFIX}${def.id}`
          const askable = def.publicOnBookingForm === true
          const chosen = selected.has(key)
          return row(key, def.label, {
            disabled: !askable,
            // Three states, and the middle one is the one nobody could name:
            // not askable / askable but not asked / asked. Only the custom rows
            // carry it — the three base fields are always askable, so a hint on
            // every one of them would be noise.
            // The hint already names where to go ("…in Settings → Custom
            // fields"), so it IS the link rather than carrying a second phrase
            // naming the same destination twice.
            hint: askable ? (
              chosen ? undefined : t('notAskedYet')
            ) : (
              <Link
                href={CUSTOM_FIELDS_SETTINGS_ROUTE}
                className="text-primary hover:underline underline-offset-2"
              >
                {t('notPublicHint')}
              </Link>
            ),
          })
        })}
      </div>

      {/* Where the rest of the fields come from. Without it a studio reads the
          three base fields as the whole catalog — and when the plugin is not
          installed the list above is all it will ever have, with nothing on
          screen saying why. */}
      <div className="rounded-md border border-dashed px-3 py-2.5 text-center">
        <p className="text-xs text-muted-foreground">
          {customFieldsInstalled ? t('addFieldsPrompt') : t('addFieldsPluginPrompt')}
        </p>
        <Link
          href={customFieldsInstalled ? CUSTOM_FIELDS_SETTINGS_ROUTE : ('/plugins' as Route)}
          className="text-xs text-primary hover:underline underline-offset-2"
        >
          {customFieldsInstalled ? t('addFieldsLink') : t('addFieldsPluginLink')}
        </Link>
      </div>

      {/* The distinction the whole feature rests on, said once, where someone is
          about to make the choice. */}
      <p className="text-xs text-muted-foreground">{t('versusBookingQuestions')}</p>
    </div>
  )
}
