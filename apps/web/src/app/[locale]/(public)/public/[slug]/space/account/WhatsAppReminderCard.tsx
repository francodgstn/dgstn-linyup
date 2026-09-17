'use client'

// The member's own WhatsApp opt-in — Space's door onto `Contact.whatsapp_consent`
// (docs/whatsapp-outbound.md → "Opt-in surfaces"). Shown when the studio offers
// the channel (`TeamPublicProfile.whatsapp_opt_in_offered`) OR the contact
// already answered — the second half is what lets someone opt back OUT after
// the studio has since disconnected, and lets a member who opted out from the
// booking form flip back on if the studio reconnects while they're looking.
//
// Writes go through `setMyWhatsAppConsent` (contact-session callable, shared
// with the mobile app) — never a direct Firestore write; `whatsapp_consent` is
// function-written only.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { MessageCircle, Check } from 'lucide-react'
import { whatsappConsentAllows } from '@linyup/shared'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { useSpaceContact } from '../useSpaceContact'
import { usePublicTeam } from '../../PublicTeamProvider'

export function WhatsAppReminderCard() {
  const t = useTranslations('Space')
  const { isAuthenticated, teamId } = useSpaceAuth()
  const { team } = usePublicTeam()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const qc = useQueryClient()
  const { data: contact } = useSpaceContact()
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  // Hooks first, always — the early return below (on whether this card should
  // show at all) must not skip any of them on a later render.
  const mutation = useMutation({
    mutationFn: async (optIn: boolean) => {
      const fn = httpsCallable<{ teamId: string; optIn: boolean; source: 'space' }, { ok: boolean }>(
        functions,
        'setMyWhatsAppConsent'
      )
      return (await fn({ teamId: teamId!, optIn, source: 'space' })).data
    },
    onSuccess: async () => {
      setStatus('saved')
      await qc.invalidateQueries({ queryKey: ['public-contact-record'] })
    },
    onError: () => setStatus('error'),
  })

  const offered = team.whatsapp_opt_in_offered === true
  const hasAnswered = !!contact?.whatsapp_consent
  if (!isAuthenticated || (!offered && !hasAnswered)) return null

  const optedIn = whatsappConsentAllows(contact)

  function toggle(next: boolean) {
    if (!teamId) return
    setStatus('idle')
    mutation.mutate(next)
  }

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  return (
    <section className="rounded-2xl p-4" style={cardStyle}>
      <div className="mb-2 flex items-center gap-2">
        <MessageCircle className="h-4 w-4" style={{ color: accent }} />
        <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
          {t('whatsappRemindersTitle')}
        </h2>
      </div>
      <p className="mb-3 text-xs" style={{ color: textMuted }}>
        {offered ? t('whatsappRemindersIntro') : t('whatsappRemindersUnavailable')}
      </p>

      {status === 'saved' && (
        <div className="mb-3 flex items-center gap-1.5 text-xs" style={{ color: '#16a34a' }}>
          <Check className="h-3.5 w-3.5" /> {t('whatsappRemindersSaved')}
        </div>
      )}
      {status === 'error' && (
        <p className="mb-3 text-xs" style={{ color: '#dc2626' }}>
          {t('whatsappRemindersError')}
        </p>
      )}

      <label className="flex items-center justify-between gap-3 text-sm" style={{ color: textMain }}>
        <span>{optedIn ? t('whatsappRemindersOn') : t('whatsappRemindersOff')}</span>
        <input
          type="checkbox"
          role="switch"
          checked={optedIn}
          // Turning OFF is always allowed (the server accepts every opt-out);
          // turning ON only while the studio actually offers the channel.
          disabled={mutation.isPending || (!optedIn && !offered)}
          onChange={(e) => toggle(e.target.checked)}
          className="h-5 w-9 shrink-0 accent-primary"
          style={{ accentColor: accent }}
        />
      </label>
    </section>
  )
}
