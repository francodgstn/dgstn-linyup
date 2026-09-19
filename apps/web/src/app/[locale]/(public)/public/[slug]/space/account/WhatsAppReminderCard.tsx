'use client'

// The member's own WhatsApp answers — Space's door onto `Contact.whatsapp_consent`
// and `Contact.whatsapp_marketing_consent` (docs/whatsapp-outbound.md → "6a" /
// "Opt-in surfaces"). Two INDEPENDENT switches: booking reminders (what a
// booking implies) and news and offers (what it does not). Shown when the
// studio offers the channel (`TeamPublicProfile.whatsapp_opt_in_offered`) OR
// the contact already answered either question — the second half is what lets
// someone opt back OUT after the studio has since disconnected, and lets a
// member who opted out from the booking form flip back on if the studio
// reconnects while they're looking.
//
// Writes go through `setMyWhatsAppConsent` (contact-session callable, shared
// with the mobile app) — never a direct Firestore write; both consent fields
// are function-written only.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Check } from 'lucide-react'
import { whatsappConsentAllows, type WhatsAppConsentKind } from '@linyup/shared'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { useSpaceContact } from '../useSpaceContact'
import { usePublicTeam } from '../../PublicTeamProvider'
import { callFunction } from '@/lib/callFunction'

export function WhatsAppReminderCard() {
  const t = useTranslations('Space')
  const { isAuthenticated, teamId } = useSpaceAuth()
  const { team } = usePublicTeam()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const qc = useQueryClient()
  const { data: contact } = useSpaceContact()
  const [status, setStatus] = useState<Record<WhatsAppConsentKind, 'idle' | 'saved' | 'error'>>({
    reminders: 'idle',
    marketing: 'idle',
  })

  // Hooks first, always — the early return below (on whether this card should
  // show at all) must not skip any of them on a later render.
  const mutation = useMutation({
    mutationFn: async (vars: { optIn: boolean; kind: WhatsAppConsentKind }) => {
      const fn = callFunction<
        { teamId: string; optIn: boolean; source: 'space'; kind: WhatsAppConsentKind },
        { ok: boolean }
      >('setMyWhatsAppConsent')
      return (await fn({ teamId: teamId!, optIn: vars.optIn, source: 'space', kind: vars.kind })).data
    },
    onSuccess: async (_data, vars) => {
      setStatus((s) => ({ ...s, [vars.kind]: 'saved' }))
      await qc.invalidateQueries({ queryKey: ['public-contact-record'] })
    },
    onError: (_err, vars) => setStatus((s) => ({ ...s, [vars.kind]: 'error' })),
  })

  const offered = team.whatsapp_opt_in_offered === true
  const hasAnswered = !!contact?.whatsapp_consent || !!contact?.whatsapp_marketing_consent
  if (!isAuthenticated || (!offered && !hasAnswered)) return null

  function toggle(kind: WhatsAppConsentKind, next: boolean) {
    if (!teamId) return
    setStatus((s) => ({ ...s, [kind]: 'idle' }))
    mutation.mutate({ optIn: next, kind })
  }

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  return (
    <section className="rounded-2xl p-4" style={cardStyle}>
      <div className="mb-2 flex items-center gap-2">
        <MessageCircle className="h-4 w-4" style={{ color: accent }} />
        <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
          {t('whatsappTitle')}
        </h2>
      </div>
      <p className="mb-3 text-xs" style={{ color: textMuted }}>
        {offered ? t('whatsappRemindersIntro') : t('whatsappRemindersUnavailable')}
      </p>

      <div className="space-y-3">
        <WhatsAppKindRow
          kind="reminders"
          label={t('whatsappRemindersLabel')}
          optedIn={whatsappConsentAllows(contact, 'reminders')}
          offered={offered}
          status={status.reminders}
          pending={mutation.isPending && mutation.variables?.kind === 'reminders'}
          onToggle={(next) => toggle('reminders', next)}
          accent={accent}
          textMain={textMain}
        />
        <WhatsAppKindRow
          kind="marketing"
          label={t('whatsappMarketingLabel')}
          optedIn={whatsappConsentAllows(contact, 'marketing')}
          offered={offered}
          status={status.marketing}
          pending={mutation.isPending && mutation.variables?.kind === 'marketing'}
          onToggle={(next) => toggle('marketing', next)}
          accent={accent}
          textMain={textMain}
        />
      </div>
    </section>
  )
}

function WhatsAppKindRow({
  label,
  optedIn,
  offered,
  status,
  pending,
  onToggle,
  accent,
  textMain,
}: {
  kind: WhatsAppConsentKind
  label: string
  optedIn: boolean
  offered: boolean
  status: 'idle' | 'saved' | 'error'
  pending: boolean
  onToggle: (next: boolean) => void
  accent: string
  textMain: string
}) {
  const t = useTranslations('Space')
  return (
    <div>
      <label className="flex items-center justify-between gap-3 text-sm" style={{ color: textMain }}>
        <span>{label}</span>
        <input
          type="checkbox"
          role="switch"
          checked={optedIn}
          // Turning OFF is always allowed (the server accepts every opt-out);
          // turning ON only while the studio actually offers the channel.
          disabled={pending || (!optedIn && !offered)}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-5 w-9 shrink-0 accent-primary"
          style={{ accentColor: accent }}
        />
      </label>
      {status === 'saved' && (
        <div className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: '#16a34a' }}>
          <Check className="h-3.5 w-3.5" /> {t('whatsappRemindersSaved')}
        </div>
      )}
      {status === 'error' && (
        <p className="mt-1 text-xs" style={{ color: '#dc2626' }}>
          {t('whatsappRemindersError')}
        </p>
      )}
    </div>
  )
}
