'use client'

import { useEffect, useRef, useState } from 'react'
import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import { signInWithCustomToken } from 'firebase/auth'
import { Link } from '@/i18n/navigation'
import { auth } from '@/lib/firebase-auth'
import { saveContactSession } from '@/lib/contactSession'
import { callFunction } from '@/lib/callFunction'

/**
 * Sign the buyer in from the checkout they just paid for (UX-88).
 *
 * The payment already identified them, so the receipt page must not ask for a
 * credential. `claimCheckoutSession` verifies the Stripe Checkout Session on the
 * studio's connected account and mints the session through the SAME
 * `buildContactSession` the passwordless login uses — the claims the Firestore
 * and Storage rules check. Nothing is decided here; this component only carries
 * the token to `signInWithCustomToken` and persists the record the public
 * surfaces read.
 *
 * IT NEVER BLOCKS THE RECEIPT. Every failure — no session, an email that is not
 * the contact's, Stripe unreachable — falls through to exactly the page that
 * shipped before it: the body copy and the CTA below. A buyer who paid always
 * sees their confirmation.
 *
 * SIGNED IN IS NOT JOINED. The server returns those as two facts and this states
 * only what it is told: the buyer's name, and — when the server says the studio
 * is still waiting on a registration — the link to finish it. It never implies
 * membership, because a shop or drop-in buyer's contact commonly has no
 * acquisition stage at all (UX-82/83).
 */

/** The redirect can beat the `checkout.session.completed` webhook that creates a
 *  guest buyer's contact, so a `pending` answer is a retry rather than a
 *  failure. Bounded: about nine seconds, after which the page simply shows what
 *  it always did. */
const RETRY_DELAY_MS = 1500
const MAX_ATTEMPTS = 6

type ClaimResult = {
  status: 'signed_in' | 'pending' | 'unavailable'
  customToken?: string
  sessionExpires?: number
  contact?: {
    id: string
    firstname: string
    lastname: string
    email: string | null
    subscription_type_id: string | null
  }
  joined?: boolean
  pendingSignup?: boolean
}

export function ClaimCheckoutSession({
  checkoutSessionId,
  slug,
  body,
  signedInBody,
  signupHref,
  showSignupLink,
}: {
  checkoutSessionId: string
  slug: string
  /** Already-translated fallback copy — what the page said before this existed. */
  body: string
  /** Already-translated copy for a buyer we managed to sign in. */
  signedInBody: string
  signupHref: Route
  /** False when the page's own CTA is already the registration link. */
  showSignupLink: boolean
}) {
  const t = useTranslations('PayResult')
  const [phase, setPhase] = useState<'claiming' | 'signed_in' | 'done'>('claiming')
  const [name, setName] = useState('')
  const [pendingSignup, setPendingSignup] = useState(false)
  // React 18 StrictMode double-invokes effects in dev; a second claim would be
  // harmless (the callable is a reader) but wasteful and visibly flickery.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false

    const claim = callFunction<{ checkoutSessionId: string; slug: string }, ClaimResult>(
      'claimCheckoutSession'
    )

    const run = async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          const { data } = await claim({ checkoutSessionId, slug })
          if (cancelled) return
          if (data.status === 'signed_in' && data.customToken && data.contact) {
            await signInWithCustomToken(auth, data.customToken)
            saveContactSession({
              contactId: data.contact.id,
              sessionExpires: new Date(data.sessionExpires ?? Date.now()).toISOString(),
              contact: {
                id: data.contact.id,
                firstname: data.contact.firstname,
                lastname: data.contact.lastname,
                email: data.contact.email,
                ...(data.contact.subscription_type_id
                  ? { subscription_type_id: data.contact.subscription_type_id }
                  : {}),
              },
            })
            if (cancelled) return
            setName(`${data.contact.firstname} ${data.contact.lastname}`.trim())
            setPendingSignup(data.pendingSignup === true)
            setPhase('signed_in')
            return
          }
          if (data.status !== 'pending') break
        } catch {
          // A refusal is never fatal here — fall through to the ordinary page.
          break
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
      if (!cancelled) setPhase('done')
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [checkoutSessionId, slug])

  if (phase === 'claiming') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{body}</p>
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {t('signingIn')}
        </p>
      </div>
    )
  }

  if (phase === 'signed_in') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{signedInBody}</p>
        {name && <p className="text-sm font-medium">{t('signedInAs', { name })}</p>}
        {/* The one thing that is still outstanding, when the server says so.
            Never a membership claim — only the registration the studio's own
            'full' checkout mode asked for. */}
        {pendingSignup && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{t('successBodySignup')}</p>
            {showSignupLink && (
              <Link
                href={signupHref}
                className="inline-block text-sm font-medium text-primary hover:underline"
              >
                {t('completeRegistration')}
              </Link>
            )}
          </div>
        )}
      </div>
    )
  }

  return <p className="text-sm text-muted-foreground">{body}</p>
}
