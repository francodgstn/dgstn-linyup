'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { UserCredential } from 'firebase/auth'
import { Mail, Loader2, ArrowLeft } from 'lucide-react'
import { signInWithProvider, sendMagicLink, type SocialProvider } from '@/lib/auth'
import { isSignupClosedError } from '@/lib/signupGate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// ─── brand marks (inline so we don't pull a brand-icon dependency) ───────────

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  )
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
      <path d="M16.37 12.78c.02 2.5 2.19 3.33 2.22 3.34-.02.06-.35 1.2-1.15 2.37-.69 1.02-1.41 2.03-2.55 2.05-1.11.02-1.47-.66-2.75-.66-1.27 0-1.67.64-2.73.68-1.09.04-1.93-1.1-2.63-2.11C5.46 18.04 4.36 14.5 5.8 12.1c.72-1.21 2-1.98 3.39-2 1.07-.02 2.07.72 2.73.72.65 0 1.87-.89 3.15-.76.54.02 2.05.22 3.02 1.64-.08.05-1.8 1.06-1.72 3.08ZM14.4 8.66c.59-.71.98-1.7.87-2.69-.85.03-1.87.57-2.47 1.28-.54.63-1.01 1.63-.88 2.6.94.07 1.9-.48 2.48-1.19Z" />
    </svg>
  )
}

// Facebook/Meta was removed on 2026-08-19: it was never enabled as a provider on
// any project, so the button could only ever fail with auth/operation-not-allowed,
// and enabling it would mean maintaining a Meta app for a login nobody asked for.
// The offered set is Google, Apple, email link and email/password.
//
// Not to be confused with the studio's own Facebook PAGE link on bio-links and
// team profiles (`TeamSocialLink.platform`) — a different feature, still supported.
const PROVIDERS: { id: SocialProvider; icon: () => React.ReactElement }[] = [
  { id: 'google', icon: GoogleIcon },
  { id: 'apple', icon: AppleIcon },
]

// ─── component ───────────────────────────────────────────────────────────────

export function SocialAuthButtons({
  onAuthed,
}: {
  /** Called after a successful social sign-in. Magic link redirects away instead. */
  onAuthed: (cred: UserCredential) => void | Promise<void>
}) {
  const t = useTranslations('Auth')
  const [busy, setBusy] = useState<SocialProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMagic, setShowMagic] = useState(false)
  const [magicEmail, setMagicEmail] = useState('')
  const [magicSending, setMagicSending] = useState(false)
  const [magicSent, setMagicSent] = useState(false)

  async function handleProvider(which: SocialProvider) {
    setError(null)
    setBusy(which)
    try {
      const cred = await signInWithProvider(which)
      await onAuthed(cred)
    } catch (err) {
      const code = (err as { code?: string }).code
      // User dismissed the popup — not an error worth surfacing.
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return
      }
      if (isSignupClosedError(err)) {
        // Provider sign-in that would create a NEW account, blocked server-side.
        setError(t('errorSignupClosed'))
      } else if (code === 'auth/account-exists-with-different-credential') {
        setError(t('errorAccountExists'))
      } else {
        setError(t('errorProvider'))
      }
    } finally {
      setBusy(null)
    }
  }

  async function handleMagicLink() {
    setError(null)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(magicEmail)) {
      setError(t('errorInvalidEmail'))
      return
    }
    setMagicSending(true)
    try {
      await sendMagicLink(magicEmail)
      setMagicSent(true)
    } catch {
      setError(t('errorMagicLink'))
    } finally {
      setMagicSending(false)
    }
  }

  if (magicSent) {
    return (
      <div className="rounded-lg border bg-muted/40 px-4 py-5 text-center text-sm space-y-1">
        <Mail className="mx-auto h-5 w-5 text-primary" />
        <p className="font-medium">{t('magicSentTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('magicSentBody', { email: magicEmail })}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-destructive text-sm bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {!showMagic ? (
        <div className="space-y-2">
          {PROVIDERS.map(({ id, icon: Icon }) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              className="w-full gap-2"
              disabled={busy !== null}
              onClick={() => handleProvider(id)}
            >
              {busy === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon />}
              {t(`continueWith.${id}`)}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2"
            disabled={busy !== null}
            onClick={() => setShowMagic(true)}
          >
            <Mail className="h-4 w-4" />
            {t('continueWithEmailLink')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="magic-email">{t('emailLinkLabel')}</Label>
          <Input
            id="magic-email"
            type="email"
            autoComplete="email"
            placeholder={t('emailLinkPlaceholder')}
            value={magicEmail}
            onChange={(e) => setMagicEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleMagicLink()}
          />
          <Button type="button" className="w-full gap-2" disabled={magicSending} onClick={handleMagicLink}>
            {magicSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {t('sendEmailLink')}
          </Button>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => { setShowMagic(false); setError(null) }}
          >
            <ArrowLeft className="h-3 w-3" />
            {t('backToOptions')}
          </button>
        </div>
      )}
    </div>
  )
}

/** A labeled "or" divider between the social buttons and the email/password form. */
export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="relative my-1">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t" />
      </div>
      <div className="relative flex justify-center text-xs">
        <span className="bg-card px-2 text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}
