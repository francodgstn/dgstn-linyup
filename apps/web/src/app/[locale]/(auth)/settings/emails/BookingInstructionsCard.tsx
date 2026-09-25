'use client'

// Booking confirmation note — a studio-authored plain-text block appended to
// every booking confirmation email (group classes + appointments) as a highlighted
// "Important" box. Ideal for waivers, gear rules, arrival instructions.
// Per-activity overrides live in the activity editor; this is the team-wide
// default (teams/{id}.settings.bookingConfirmationInstructions).
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
import { HintTip, SettingsSection } from '@/components/settings/SettingsSection'

interface TeamInstructionSettings {
  settings?: { bookingConfirmationInstructions?: string }
}

/** A one-field section that saves from the page's floating bar. */
export function BookingInstructionsCard() {
  const t = useTranslations('SettingsEmails')
  const tCommon = useTranslations('Common')
  const { currentTeamId, team, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'

  const stored =
    (team as TeamInstructionSettings | null)?.settings?.bookingConfirmationInstructions ?? ''
  const [value, setValue] = useState(stored)

  // Re-sync once the team doc (or a team switch) loads.
  useEffect(() => {
    setValue(stored)
  }, [stored])

  const dirty = value.trim() !== stored.trim()

  useSaveBarSection('booking-instructions', {
    dirty: canEdit && dirty,
    valid: true,
    reset: () => setValue(stored),
    save: async () => {
      if (!currentTeamId) return false
      try {
        await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
          'settings.bookingConfirmationInstructions': value.trim(),
        })
        return true
      } catch (err) {
        console.error('[emails] booking instructions save failed:', err)
        toast.error(tCommon('saveFailed'))
        return false
      }
    },
  })

  return (
    <SettingsSection
      title={
        <span className="inline-flex items-center gap-1.5">
          {t('instructionsTitle')}
          <HintTip>{t('instructionsSubtitle')}</HintTip>
        </span>
      }
    >
      <div className="space-y-1.5 py-4">
        <textarea
          aria-label={t('instructionsTitle')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!canEdit}
          rows={5}
          maxLength={2000}
          placeholder={t('instructionsPlaceholder')}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y disabled:opacity-60"
        />
        <p className="text-xs text-muted-foreground">
          {canEdit ? t('instructionsHint') : t('instructionsOwnerOnly')}
        </p>
      </div>
    </SettingsSection>
  )
}
