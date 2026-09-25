'use client'

// Team-wide cancellation policy default — shown on the public booking pages
// (before a visitor books) and appended to booking confirmation emails,
// whenever the activity being booked has no `cancellationPolicy` of its own.
// Per-activity overrides live in the activity editor.
//
// Deliberately separate from BookingInstructionsCard (settings/emails) — that
// field (bookingConfirmationInstructions) is email-only; this one is public,
// so it lives on the booking-flow settings page instead.
//
// Team-doc writes are owner-only per firestore.rules — managers see read-only.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useSaveBarSection } from '@/components/forms/SaveBar'
import { SettingsRow } from '@/components/settings/SettingsSection'

interface TeamPolicySettings {
  settings?: { bookingCancellationPolicy?: string }
}

/**
 * One row of the page's Policies section. It used to be a Card with its own
 * icon, heading and Save; it now saves from the page's floating bar with the
 * rest of Settings → Booking, while keeping its own write (the TEAM doc, which
 * is owner-only — the booking form above writes the public profile instead).
 */
export function CancellationPolicyRow() {
  const t = useTranslations('SettingsBooking')
  const { currentTeamId, team, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'

  const stored = (team as TeamPolicySettings | null)?.settings?.bookingCancellationPolicy ?? ''
  const [value, setValue] = useState(stored)

  // Re-sync once the team doc (or a team switch) loads.
  useEffect(() => {
    setValue(stored)
  }, [stored])

  const dirty = value.trim() !== stored.trim()

  useSaveBarSection('cancellation-policy', {
    dirty: canEdit && dirty,
    valid: true,
    reset: () => setValue(stored),
    save: async () => {
      if (!currentTeamId) return false
      try {
        await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
          'settings.bookingCancellationPolicy': value.trim(),
        })
        return true
      } catch (err) {
        console.error('[booking] cancellation policy save failed:', err)
        toast.error(t('toastSaveFailed'))
        return false
      }
    },
  })

  return (
    <SettingsRow
      stacked
      htmlFor="cancellation-policy"
      label={t('policyTitle')}
      hint={t('policySubtitle')}
    >
      <textarea
        id="cancellation-policy"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={!canEdit}
        rows={4}
        maxLength={2000}
        placeholder={t('policyPlaceholder')}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y disabled:opacity-60"
      />
      <p className="text-xs text-muted-foreground">
        {canEdit ? t('policyHint') : t('policyOwnerOnly')}
      </p>
    </SettingsRow>
  )
}
