'use client'

// No-show policy (E5) — threshold-based fees, collected via an emailed payment
// link. Off by default. Persisted to teams/{id}.settings.noShowPolicy;
// owner-only team-doc write, same pattern as BookingInstructionsCard.
//
// THE TERMS ARE PUBLIC — this header used to say they were not. `feeAmount` and
// `threshold` are mirrored to TeamPublicProfile.noShowPolicy by
// syncTeamPublicProfile and stated on every public booking screen before the
// button (components/booking/BookingTerms). A fee somebody can incur without
// being told about it first is not an internal setting; it is a term of sale.
// `enabled` is not mirrored — absence IS off — so switching this off takes the
// terms off the public surfaces with it.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, resolveNoShowPolicy, type NoShowPolicySettings } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSaveBarSection } from '@/components/forms/SaveBar'
import { SettingsRow } from '@/components/settings/SettingsSection'

const DEFAULT_THRESHOLD = 3

function getDefaults(settings: unknown): NoShowPolicySettings {
  const resolved = resolveNoShowPolicy(settings)
  if (resolved) return resolved
  return { enabled: false, feeAmount: 0, threshold: DEFAULT_THRESHOLD }
}

/**
 * The no-show rows of the page's Policies section: the switch, and — while it
 * is on — the fee and the strike count under it. Saved from the page's
 * floating bar; the write is still its own (owner-only team doc).
 */
export function NoShowPolicyRows() {
  const t = useTranslations('SettingsBooking')
  const { currentTeamId, team, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'
  const currency = team?.default_currency ?? 'CHF'

  const stored = getDefaults(team?.settings)
  const [enabled, setEnabled] = useState(stored.enabled)
  const [feeAmount, setFeeAmount] = useState(String(stored.feeAmount || ''))
  const [threshold, setThreshold] = useState(String(stored.threshold))

  function resetToStored() {
    setEnabled(stored.enabled)
    setFeeAmount(String(stored.feeAmount || ''))
    setThreshold(String(stored.threshold))
  }

  useEffect(() => {
    resetToStored()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team?.id, stored.enabled, stored.feeAmount, stored.threshold])

  const feeAmountNumber = Number(feeAmount)
  const thresholdNumber = Math.floor(Number(threshold))
  const feeValid = Number.isFinite(feeAmountNumber) && feeAmountNumber > 0
  const thresholdValid = thresholdNumber >= 1
  const valid = !enabled || (feeValid && thresholdValid)

  const dirty =
    enabled !== stored.enabled ||
    feeAmountNumber !== stored.feeAmount ||
    thresholdNumber !== stored.threshold

  useSaveBarSection('no-show-policy', {
    dirty: canEdit && dirty,
    valid,
    reset: resetToStored,
    save: async () => {
      if (!currentTeamId || !valid) return false
      try {
        const policy: NoShowPolicySettings = {
          enabled,
          feeAmount: feeAmountNumber || 0,
          threshold: thresholdNumber || DEFAULT_THRESHOLD,
        }
        await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
          'settings.noShowPolicy': policy,
        })
        return true
      } catch (err) {
        console.error('[booking] no-show policy save failed:', err)
        toast.error(t('toastSaveFailed'))
        return false
      }
    },
  })

  return (
    <>
      <SettingsRow
        inline
        htmlFor="no-show-enabled"
        label={t('noShowPolicyTitle')}
        hint={t('noShowPolicySubtitle')}
      >
        <Switch
          id="no-show-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={!canEdit}
        />
      </SettingsRow>

      {enabled && (
        <>
          <SettingsRow htmlFor="no-show-fee" label={t('noShowFeeAmountLabel', { currency })}>
            <Input
              id="no-show-fee"
              type="number"
              min={0}
              step="0.01"
              value={feeAmount}
              disabled={!canEdit}
              aria-invalid={!feeValid || undefined}
              onChange={(e) => setFeeAmount(e.target.value)}
              className="w-32 tabular-nums"
            />
          </SettingsRow>
          <SettingsRow
            htmlFor="no-show-threshold"
            label={t('noShowThresholdLabel')}
            hint={t('noShowThresholdHint')}
          >
            <Input
              id="no-show-threshold"
              type="number"
              min={1}
              step="1"
              value={threshold}
              disabled={!canEdit}
              aria-invalid={!thresholdValid || undefined}
              onChange={(e) => setThreshold(e.target.value)}
              className="w-32 tabular-nums"
            />
            {/* Stays visible: the owner cannot see from here that these terms
                are shown publicly, or that the fee is EMAILED as a payment link
                rather than taken off a card, and would otherwise learn both
                from a customer. */}
            <p className="text-xs text-muted-foreground">{t('noShowPublicNote')}</p>
          </SettingsRow>
        </>
      )}
      {!canEdit && <p className="pb-4 text-xs text-muted-foreground">{t('ownerOnly')}</p>}
    </>
  )
}
