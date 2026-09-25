'use client'

// System emails — the automatic member-facing mail Linyup sends OUTSIDE the
// automations engine (booking confirmations, reminders, cancellation notices,
// data-update outcomes). Listed here so studios know they exist (and don't
// duplicate them with custom automations), with per-team on/off switches for
// studios that prefer full control. Enforcement lives in
// packages/functions/src/utils/systemEmails.ts (+ the pre-existing
// settings.bookingRemindersEnabled read in sendBookingReminders).
//
// Team-doc writes are owner-only per firestore.rules — managers see read-only.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  resolveBookingReminderSteps,
  WHATSAPP_PLUGIN_ID,
  type BookingReminderStep,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useWhatsAppIntegration } from '@/plugins/whatsapp/hooks'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { Plus, X } from 'lucide-react'
import { HintTip, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { Tip } from '@/components/ui/tip'

type ToggleKey =
  | 'booking_confirmation'
  | 'booking_reminder'
  | 'session_cancellation'
  | 'contact_update_review'

// Firestore field per key. booking_reminder reuses the pre-existing
// settings.bookingRemindersEnabled flag (already honoured by the daily task).
const FIELD_PATH: Record<ToggleKey, string> = {
  booking_confirmation: 'settings.system_emails.booking_confirmation',
  booking_reminder: 'settings.bookingRemindersEnabled',
  session_cancellation: 'settings.system_emails.session_cancellation',
  contact_update_review: 'settings.system_emails.contact_update_review',
}

const TOGGLE_KEYS: ToggleKey[] = [
  'booking_confirmation',
  'booking_reminder',
  'session_cancellation',
  'contact_update_review',
]

interface TeamEmailSettings {
  settings?: {
    system_emails?: Record<string, boolean>
    bookingRemindersEnabled?: boolean
    bookingReminderHours?: number
    bookingReminderSteps?: BookingReminderStep[]
  }
}

/** Whether the WhatsApp option should be OFFERED in the channel picker. Gated
 *  on install only (not on "connected" — a studio setting up a schedule before
 *  finishing Embedded Signup should not be blocked); the "will be skipped"
 *  hint below handles the not-yet-usable case regardless of why. */
function useWhatsAppChannelUsable(): { installed: boolean; usable: boolean } {
  const { currentTeamId, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'
  const { isInstalled } = useInstalledPlugins()
  const installed = isInstalled(WHATSAPP_PLUGIN_ID)
  const { data: integration } = useWhatsAppIntegration(currentTeamId, canEdit && installed)
  return { installed, usable: installed && integration?.status === 'connected' }
}

// ─── reminder schedule editor ─────────────────────────────────────────────────
// The offsets a studio can pick per step. Custom values can come later; these
// presets cover the common flows (incl. SWIMLI's 1 week / 2 days / day before).
const OFFSET_PRESETS = [336, 168, 72, 48, 24, 12, 2] as const

function stepId(channel: string, offsetHours: number): string {
  return `step-${channel}-${offsetHours}h`
}

function channelLabel(t: ReturnType<typeof useTranslations>, channel: BookingReminderStep['channel']): string {
  if (channel === 'sms') return t('reminderChannelSms')
  if (channel === 'whatsapp') return t('reminderChannelWhatsApp')
  return t('reminderChannelEmail')
}

function ReminderStepsEditor({
  steps,
  disabled,
  whatsappInstalled,
  whatsappUsable,
  onChange,
}: {
  steps: BookingReminderStep[]
  disabled: boolean
  /** Offer WhatsApp as a channel choice at all. */
  whatsappInstalled: boolean
  /** Installed AND connected — governs the "will be skipped" hint on an
   *  existing WhatsApp step, regardless of why it isn't usable yet. */
  whatsappUsable: boolean
  onChange: (next: BookingReminderStep[]) => void
}) {
  const t = useTranslations('SettingsEmails')

  const offsetLabel = (h: number) =>
    h % 24 === 0 ? t('reminderOffsetDays', { days: h / 24 }) : t('reminderOffsetHours', { hours: h })

  function update(i: number, patch: Partial<BookingReminderStep>) {
    const next = steps.map((s, idx) => {
      if (idx !== i) return s
      const merged = { ...s, ...patch }
      return { ...merged, id: stepId(merged.channel, merged.offsetHours) }
    })
    onChange(next)
  }

  return (
    <div className="ml-0 sm:ml-6 mt-2 space-y-2">
      {steps.map((s, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-2">
            <Select
              value={s.channel}
              onValueChange={(v) => update(i, { channel: v as BookingReminderStep['channel'] })}
            >
              <SelectTrigger className="w-32 h-8 text-xs" disabled={disabled}>
                <span>{channelLabel(t, s.channel)}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">{t('reminderChannelEmail')}</SelectItem>
                <SelectItem value="sms">{t('reminderChannelSms')}</SelectItem>
                {/* Offered only once the plugin is installed — an existing step
                    already set to 'whatsapp' before install/uninstall still
                    renders below via channelLabel, it simply isn't a pickable
                    option here. */}
                {whatsappInstalled && (
                  <SelectItem value="whatsapp">{t('reminderChannelWhatsApp')}</SelectItem>
                )}
              </SelectContent>
            </Select>
            <Select
              value={String(s.offsetHours)}
              onValueChange={(v) => update(i, { offsetHours: Number(v) })}
            >
              <SelectTrigger className="w-44 h-8 text-xs" disabled={disabled}>
                <span>{offsetLabel(s.offsetHours)}</span>
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...OFFSET_PRESETS, s.offsetHours])]
                  .sort((a, b) => b - a)
                  .map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {offsetLabel(h)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Tip label={t('reminderRemoveStep')}>
              <button
                type="button"
                disabled={disabled || steps.length <= 1}
                onClick={() => onChange(steps.filter((_, idx) => idx !== i))}
                className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors disabled:opacity-30"
                aria-label={t('reminderRemoveStep')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          {s.channel === 'whatsapp' && (
            <p className="text-xs text-muted-foreground">
              {whatsappUsable ? t('reminderWhatsAppNote') : t('reminderWhatsAppSkippedHint')}
            </p>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={disabled || steps.length >= 5}
          onClick={() => onChange([...steps, { id: stepId('email', 48), channel: 'email', offsetHours: 48 }])}
        >
          <Plus className="h-3 w-3 mr-1" />
          {t('reminderAddStep')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('reminderSmsNote')}</p>
      </div>
    </div>
  )
}

function readState(team: TeamEmailSettings | null | undefined): Record<ToggleKey, boolean> {
  const s = team?.settings
  return {
    booking_confirmation: s?.system_emails?.booking_confirmation !== false,
    booking_reminder: s?.bookingRemindersEnabled !== false,
    session_cancellation: s?.system_emails?.session_cancellation !== false,
    contact_update_review: s?.system_emails?.contact_update_review !== false,
  }
}

export function SystemEmailsCard() {
  const t = useTranslations('Automations')
  const { currentTeamId, team, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'
  const { installed: whatsappInstalled, usable: whatsappUsable } = useWhatsAppChannelUsable()

  const [state, setState] = useState<Record<ToggleKey, boolean>>(() =>
    readState(team as TeamEmailSettings | null)
  )
  const [saving, setSaving] = useState<ToggleKey | null>(null)

  // Reminder schedule (settings.bookingReminderSteps; legacy single email when unset).
  const teamSettings = (team as TeamEmailSettings | null)?.settings ?? {}
  const [steps, setSteps] = useState<BookingReminderStep[]>(() =>
    resolveBookingReminderSteps(teamSettings)
  )
  const [stepsSaving, setStepsSaving] = useState(false)

  // Re-sync once the team doc (or a team switch) loads.
  const serialized = JSON.stringify(readState(team as TeamEmailSettings | null))
  const serializedSteps = JSON.stringify(resolveBookingReminderSteps(teamSettings))
  useEffect(() => {
    setState(JSON.parse(serialized) as Record<ToggleKey, boolean>)
  }, [serialized])
  useEffect(() => {
    setSteps(JSON.parse(serializedSteps) as BookingReminderStep[])
  }, [serializedSteps])

  async function toggle(key: ToggleKey, value: boolean) {
    if (!currentTeamId || !canEdit) return
    setState((s) => ({ ...s, [key]: value })) // optimistic
    setSaving(key)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { [FIELD_PATH[key]]: value })
    } catch {
      setState((s) => ({ ...s, [key]: !value })) // revert on failure
    } finally {
      setSaving(null)
    }
  }

  async function saveSteps(next: BookingReminderStep[]) {
    if (!currentTeamId || !canEdit) return
    // Dedupe identical channel+offset entries (they'd share a sent-marker id).
    const deduped = next.filter((s, i) => next.findIndex((o) => o.id === s.id) === i)
    const prev = steps
    setSteps(deduped) // optimistic
    setStepsSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
        'settings.bookingReminderSteps': deduped,
      })
    } catch {
      setSteps(prev) // revert on failure
    } finally {
      setStepsSaving(false)
    }
  }

  // A SECTION OF ROWS (the Settings → General layout). Every switch here
  // still saves the moment it is flipped, and so does the reminder schedule —
  // switches that are not part of a form save instantly — so this section is
  // not part of the page's save bar. What each mail is sits behind its ⓘ.
  return (
    <SettingsSection
      title={
        <span className="inline-flex items-center gap-1.5">
          {t('systemEmails.title')}
          <HintTip>{t('systemEmails.subtitle')}</HintTip>
        </span>
      }
      description={!canEdit ? t('systemEmails.ownerOnly') : undefined}
    >
        {TOGGLE_KEYS.map((key) => (
          <div key={key} className={key === 'booking_reminder' && state.booking_reminder ? 'pb-4' : ''}>
            <SettingsRow
              inline
              htmlFor={`system-email-${key}`}
              label={t(`systemEmails.${key}` as Parameters<typeof t>[0])}
              hint={t(`systemEmails.${key}Desc` as Parameters<typeof t>[0])}
            >
              <Switch
                id={`system-email-${key}`}
                checked={state[key]}
                disabled={!canEdit || saving === key}
                onCheckedChange={(v) => toggle(key, v)}
              />
            </SettingsRow>
            {key === 'booking_reminder' && state.booking_reminder && (
              <ReminderStepsEditor
                steps={steps}
                disabled={!canEdit || stepsSaving}
                whatsappInstalled={whatsappInstalled}
                whatsappUsable={whatsappUsable}
                onChange={saveSteps}
              />
            )}
          </div>
        ))}

        {/* Always-on / configured-elsewhere entries — listed for awareness */}
        <SettingsRow inline label={t('systemEmails.otp')} hint={t('systemEmails.otpDesc')}>
          <Badge variant="outline" className="text-xs">
            {t('systemEmails.alwaysOn')}
          </Badge>
        </SettingsRow>
        {/* A RECEIPT FOR MONEY IS NOT A PREFERENCE. The confirmation for a
            booking somebody PAID for carries the manage-booking link and the
            only invitation into the member area, so switching it off would
            strand a buyer rather than quieten a mail — the same test the
            waitlist offer passes. Listed here (rather than hidden) for the same
            reason the sign-in codes are: a studio should know what goes out in
            its name, especially the part it cannot turn off. Enforcement:
            packages/functions/src/booking/paidConfirmation.ts. */}
        <SettingsRow inline label={t('systemEmails.paidBookingReceipt')} hint={t('systemEmails.paidBookingReceiptDesc')}>
          <Badge variant="outline" className="text-xs">
            {t('systemEmails.alwaysOn')}
          </Badge>
        </SettingsRow>
        {/* The same rule, on the rails that SELL rather than book: a credit
            pack's receipt is the only place the buyer can read how many credits
            they hold, a course's is the only thing that says where to watch it,
            and a product's is the only thing that says what happens next.
            Enforcement: packages/functions/src/connect/purchaseReceipts.ts. */}
        <SettingsRow inline label={t('systemEmails.purchaseReceipt')} hint={t('systemEmails.purchaseReceiptDesc')}>
          <Badge variant="outline" className="text-xs">
            {t('systemEmails.alwaysOn')}
          </Badge>
        </SettingsRow>
        <SettingsRow inline label={t('systemEmails.formReceipt')} hint={t('systemEmails.formReceiptDesc')}>
          <Badge variant="outline" className="text-xs">
            {t('systemEmails.perForm')}
          </Badge>
        </SettingsRow>
    </SettingsSection>
  )
}
