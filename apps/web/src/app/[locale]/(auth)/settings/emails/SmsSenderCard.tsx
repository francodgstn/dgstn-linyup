'use client'

// SMS sender — the studio's alphanumeric sender name for transactional SMS
// (booking reminders). Stored at teams/{id}/integrations/sms_sender (owner-only
// per firestore.rules); consumed server-side by the SMS service, which falls
// back to "Linyup" when unset or disabled. SMS sending itself is billed from
// prepaid SMS credits on the platform's ESP account.

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  SMS_SENDER_INTEGRATION_DOC,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSaveBarSection } from '@/components/forms/SaveBar'
import { HintTip, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'

interface SmsSenderConfig {
  senderName?: string
  enabled?: boolean
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 11)
}

export function SmsSenderCard() {
  const t = useTranslations('SettingsEmails')
  const tCommon = useTranslations('Common')
  const { currentTeamId, user, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'
  const qc = useQueryClient()

  const { data: config } = useQuery<SmsSenderConfig | null>({
    queryKey: ['sms_sender', currentTeamId],
    // Integrations are owner-only readable; skip the query (and its permission
    // error) entirely for managers/coaches.
    enabled: !!currentTeamId && canEdit,
    queryFn: async () => {
      const snap = await getDoc(
        doc(
          db,
          TEAMS_COLLECTION,
          currentTeamId!,
          TEAM_INTEGRATIONS_SUBCOLLECTION,
          SMS_SENDER_INTEGRATION_DOC
        )
      )
      return snap.exists() ? (snap.data() as SmsSenderConfig) : null
    },
  })

  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    setName(config?.senderName ?? '')
    setEnabled(config?.enabled ?? false)
  }, [config])

  const dirty = sanitize(name) !== (config?.senderName ?? '') || enabled !== (config?.enabled ?? false)

  async function save(): Promise<boolean> {
    if (!currentTeamId || !canEdit) return false
    try {
      await setDoc(
        doc(
          db,
          TEAMS_COLLECTION,
          currentTeamId,
          TEAM_INTEGRATIONS_SUBCOLLECTION,
          SMS_SENDER_INTEGRATION_DOC
        ),
        {
          type: 'sms_sender',
          senderName: sanitize(name),
          enabled,
          updated_at: serverTimestamp(),
          updatedBy: user?.uid ?? null,
        },
        { merge: true }
      )
      await qc.invalidateQueries({ queryKey: ['sms_sender', currentTeamId] })
      return true
    } catch (err) {
      console.error('[emails] sms sender save failed:', err)
      toast.error(tCommon('saveFailed'))
      return false
    }
  }

  useSaveBarSection('sms-sender', {
    dirty: canEdit && dirty,
    valid: true,
    save,
    reset: () => {
      setName(config?.senderName ?? '')
      setEnabled(config?.enabled ?? false)
    },
  })

  // Managers can't read or write the config — hide the card entirely.
  if (!canEdit) return null

  return (
    <SettingsSection
      title={
        <span className="inline-flex items-center gap-1.5">
          {t('smsTitle')}
          <HintTip>{t('smsSubtitle')}</HintTip>
        </span>
      }
    >
      <SettingsRow inline htmlFor="sms-sender-enabled" label={t('smsEnabledLabel')}>
        <Switch id="sms-sender-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </SettingsRow>
      <SettingsRow
        htmlFor="sms-sender-name"
        label={t('smsSenderLabel')}
        hint={t('smsSenderHelp')}
        hintMode="focus"
      >
        <Input
          id="sms-sender-name"
          value={name}
          onChange={(e) => setName(sanitize(e.target.value))}
          placeholder="Linyup"
          maxLength={11}
          className="w-44"
        />
        {/* Visible: it is what the studio pays, and it is easy to miss. */}
        <p className="text-xs text-muted-foreground">{t('smsCostNote')}</p>
      </SettingsRow>
    </SettingsSection>
  )
}
