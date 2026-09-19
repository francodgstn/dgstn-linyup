'use client'

// "Download my consent history" — the member's own copy of the artefact a studio
// would produce about them.
//
// It is free once `exportContactConsentHistory` exists, and it is the honest
// counterpart of a compliance ledger: a record kept about somebody should be one
// they can take with them. The SERVER decides the scope from the session, not
// from anything sent here, and a contact session may only ever export ITSELF —
// which is also what keeps the "other records for this email address" section
// (a household's rows, under a shared mailbox) an operator tool.
//
// The download is a Blob built from the returned HTML, never a link to a hosted
// file: the artefact is meant to be self-contained and to keep working years
// later, and a URL is the one part of it that would not.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { usePublicTeam } from '../../PublicTeamProvider'
import { callFunction } from '@/lib/callFunction'

export function ConsentHistoryDownload() {
  const t = useTranslations('Space')
  const { contact, isAuthenticated } = useSpaceAuth()
  const { accent, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const { team } = usePublicTeam()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  // Offered only where there is something to download. A team that requires
  // nothing has collected nothing, and a control that always produces an empty
  // artefact teaches a member the feature is broken.
  if (!isAuthenticated || !contact?.id || (team.required_waivers?.length ?? 0) === 0) return null

  const download = async () => {
    setBusy(true)
    setError(false)
    try {
      const fn = callFunction<
        { contactId: string; format: 'html' },
        { format: 'html'; html: string }
      >('exportContactConsentHistory')
      const res = await fn({ contactId: contact.id, format: 'html' })
      const blob = new Blob([res.data.html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `consent-history-${contact.id}.html`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-2xl p-4"
      style={{ background: cardBg, border: `1px solid ${cardBorder}` }}
    >
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="flex items-center gap-2 text-sm font-medium hover:underline disabled:opacity-50"
        style={{ color: accent }}
      >
        <Download className="h-4 w-4" />
        {busy ? t('consentDownloading') : t('consentDownload')}
      </button>
      <p className="mt-1 text-xs" style={{ color: textMuted }}>
        {t('consentDownloadHint')}
      </p>
      {error && <p className="mt-2 text-sm text-destructive">{t('consentDownloadError')}</p>}
    </section>
  )
}
