'use client'

// Settings → Emails — the CONFIGURATION half of "how this studio sends email":
//   1. Sender identity (managed vs BYO domain, custom placeholders) — OutreachCards.
//   2. System emails — the automatic transactional mail (bookings, reminders,
//      cancellations) with per-team toggles.
//   3. Booking confirmation note + SMS sender.
// The AUTHORING half — the outreach templates editor + placeholder reference —
// moved to its own page, Settings → Email templates, on 2026-08-27: a page that
// lists templates and a page that configures the sender were sharing a scroll
// purely because both were "email", and the templates list was pushing the
// sender/system-email cards below the fold. The Automations page links here.
import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { Link } from '@/i18n/navigation'
import { OutreachCards } from './OutreachCards'
import { SystemEmailsCard } from './SystemEmailsCard'
import { BookingInstructionsCard } from './BookingInstructionsCard'
import { SmsSenderCard } from './SmsSenderCard'
import { SaveBarProvider } from '@/components/forms/SaveBar'

export default function SettingsEmailsPage() {
  const t = useTranslations('SettingsEmails')
  const { currentTeamId, team } = useAuth()

  return (
    <div className="max-w-2xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('emailsSubtitle')}</p>
        {/* Forward pointer to the authoring half — see the header comment for
            why the two split. Not a back-link on the templates page: both rows
            sit in the settings rail, one directly below the other, so the rail
            is already the way back. */}
        <p className="text-xs text-muted-foreground mt-2">
          {t.rich('templatesLinkNote', {
            link: (chunks) => (
              <Link href="/settings/email-templates" className="text-primary hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>

      {/* ── Sender identity + reusable placeholders ──
          First, because everything below is sent AS this sender: templates and
          the system toggles are meaningless until the studio knows what address
          its members will see. Came from Settings → Team's Outreach tab when the
          two halves were merged (2026-08-25). */}
      {/* ONE SAVE FOR THE PAGE'S FORMS. The booking note and the SMS sender
          register with this bar; the sender's actions and the system-mail
          switches act at once and never join it. */}
      <SaveBarProvider>
      {currentTeamId && team && <OutreachCards teamId={currentTeamId} team={team} />}

      {/* ── System (transactional) emails ── */}
      <SystemEmailsCard />

      {/* ── Booking confirmation note (team-wide instructions block) ── */}
      <BookingInstructionsCard />

      {/* ── SMS sender (owner-only; hidden for managers) ── */}
      <SmsSenderCard />
      </SaveBarProvider>
    </div>
  )
}
