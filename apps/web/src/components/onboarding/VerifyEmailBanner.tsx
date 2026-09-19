'use client'

/**
 * "Confirm your email address" — and, more usefully, what is switched off until
 * you do.
 *
 * ── WHY IT IS LOUD AND WHY IT IS NOT A WALL ─────────────────────────────────
 * The server refuses to send mail AS a studio whose owner never proved the
 * address (`mailService.sendEntityMail`). That gate is silent by nature: a
 * booking confirmation that is never sent looks, from the dashboard, exactly
 * like one that was. So the banner's job is not to nag — it is to be the only
 * place that says why the emails stopped, before the studio finds out from a
 * member who never got one.
 *
 * A hard wall was considered and rejected (Franco, 2026-08-23): somebody who
 * mistyped their address at signup would be locked out of an account they have
 * already started setting up, with nothing to do but wait to be deleted. Behind
 * a banner they can still work, and they can still fix it.
 *
 * ── IT ALSO TELLS THE SERVER ────────────────────────────────────────────────
 * Firebase flips `emailVerified` on the Auth user and fires no trigger, so
 * nothing in Firestore learns about it. This component reloads the user, and
 * once the token says verified it calls `confirmEmailVerified` — which reads
 * the claim off the signed token, not off anything sent here — so the team's
 * own flag catches up and the mail starts flowing. That is why the check runs
 * on mount rather than only behind the button: most people verify in another
 * tab and come back to this one.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MailWarning, Check, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { sendVerificationEmail } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { callFunction } from '@/lib/callFunction'

export function VerifyEmailBanner() {
  const t = useTranslations('VerifyEmail')
  const { user } = useAuth()
  const [verified, setVerified] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [checking, setChecking] = useState(false)

  const confirm = useCallback(async () => {
    if (!user) return false
    setChecking(true)
    try {
      // The client's cached user is stale by definition here — the flag was
      // flipped by clicking a link somewhere else entirely.
      await user.reload()
      if (!user.emailVerified) return false
      const fn = callFunction<Record<string, never>, { verified: boolean }>(
        'confirmEmailVerified'
      )
      await fn({})
      setVerified(true)
      return true
    } catch {
      return false
    } finally {
      setChecking(false)
    }
  }, [user])

  useEffect(() => {
    if (!user || user.emailVerified) {
      // Already verified in this session's token — still tell the server, since
      // nothing else will, and it is idempotent.
      if (user?.emailVerified) void confirm()
      return
    }
    void confirm()
  }, [user, confirm])

  if (!user || verified || user.emailVerified) return null

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-900/40 dark:bg-amber-950/30">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1.5">
        <MailWarning className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="min-w-0 flex-1 text-sm text-amber-900 dark:text-amber-200">
          <span className="font-medium">{t('title', { email: user.email ?? '' })}</span>{' '}
          <span className="text-amber-800/90 dark:text-amber-300/90">{t('body')}</span>
        </p>
        {sent ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-amber-800 dark:text-amber-300">
            <Check className="h-3.5 w-3.5" />
            {t('sent')}
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-amber-300 bg-transparent text-amber-900 hover:bg-amber-100 dark:text-amber-200"
            disabled={sending}
            onClick={async () => {
              setSending(true)
              const ok = await sendVerificationEmail(user)
              setSending(false)
              if (ok) setSent(true)
            }}
          >
            {sending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {t('resend')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-amber-900 hover:bg-amber-100 dark:text-amber-200"
          disabled={checking}
          onClick={() => void confirm()}
        >
          {checking && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t('recheck')}
        </Button>
      </div>
    </div>
  )
}
