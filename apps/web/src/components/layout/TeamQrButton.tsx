'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { QrCode } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { QRDialog } from '@/components/layout/QRDialog'

/**
 * The studio's public QR codes, as an icon button.
 *
 * It used to sit beside the user avatar at the foot of the sidebar, which put a
 * STUDIO-level action inside the ACCOUNT cluster — it has nothing to do with
 * who is signed in. It now lives with the other occasional-but-deliberate
 * destinations (plugins, settings, the help center) at the top.
 *
 * Owns its own dialog state so the utility row stays a flat list of icons; the
 * alternative was lifting `qrOpen` into the sidebar and threading it down.
 *
 * Styled to match UtilityIconLink deliberately — the row must read as one
 * cluster, and this being a button that opens a dialog rather than a link is an
 * implementation detail, not something to telegraph. That includes `showLabel`,
 * which UtilityIconLink also takes: inside the utilities menu every entry is a
 * labelled row, and one bare icon among them would read as a different kind of
 * thing.
 */
export function TeamQrButton({ showLabel }: { showLabel?: boolean }) {
  // 'TopBar' is where `qrTitle` actually lives — the button moved out of
  // UserMenu, but the message did not move with it.
  const t = useTranslations('TopBar')
  const { team } = useAuth()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('qrTitle')}
        aria-label={t('qrTitle')}
        className={`flex h-8 shrink-0 items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
          showLabel ? 'w-full gap-2 px-2 text-sm' : 'w-8 justify-center'
        }`}
      >
        <QrCode className="h-4 w-4 shrink-0" />
        {showLabel && <span className="truncate">{t('qrTitle')}</span>}
      </button>
      <QRDialog open={open} onClose={() => setOpen(false)} team={team} />
    </>
  )
}
