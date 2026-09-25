'use client'

// The ONE sign-in wall of the member portal — the block every Space module
// showed a visitor who is not signed in.
//
// It exists for two reasons, and the second is the one that made it a defect
// rather than a tidiness complaint:
//
//  1. There were four byte-identical copies of it (home, bookings, payments,
//     account), differing only in which prompt sentence they passed.
//
//  2. All four gated on `isAuthenticated` ALONE. Restoring a persisted contact
//     session takes two async hops, and for that whole window `isAuthenticated`
//     is false — so a signed-in member opening her own portal was told, in the
//     studio's own colors, "Sign in to view your membership and details."
//     (UX-37). Four copies meant four places to get that wrong, and they did.
//
// The rule this encodes: WE DO NOT KNOW YET is not the same answer as NO, and
// only the second one is allowed to render a wall.

import { useTranslations } from 'next-intl'
import { LogIn } from 'lucide-react'
import { useSpaceAuth } from './SpaceAuthProvider'
import { useSpaceTheme } from './useSpaceTheme'

interface Props {
  /** Already-translated prompt — each module says what IT is gating. */
  prompt: string
}

export default function SpaceSignInWall({ prompt }: Props) {
  const t = useTranslations('Space')
  const { isRestoring, openSignIn } = useSpaceAuth()
  const { accent, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  // Restoring: no claim about who the visitor is, and no button that would
  // start a second sign-in over the session already coming back.
  if (isRestoring) {
    return (
      <div className="mt-10 flex items-center justify-center rounded-2xl p-8" style={cardStyle}>
        <div
          className="h-6 w-6 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: accent, borderTopColor: 'transparent' }}
        />
        <span className="sr-only">{t('restoringSession')}</span>
      </div>
    )
  }

  return (
    <div className="mt-10 rounded-2xl p-8 text-center" style={cardStyle}>
      <LogIn className="mx-auto h-7 w-7" style={{ color: accent }} />
      <p className="mt-3 text-sm" style={{ color: textMuted }}>{prompt}</p>
      <button
        onClick={() => openSignIn()}
        className="mt-4 text-sm font-medium px-4 py-2 rounded-full"
        style={{ background: accent, color: '#fff' }}
      >
        {t('signIn')}
      </button>
    </div>
  )
}
