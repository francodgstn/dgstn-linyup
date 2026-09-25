'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase-client'
import { Button } from '@/components/ui/button'

export function LoginForm() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGoogle() {
    setLoading(true)
    setError(null)
    try {
      const cred = await signInWithPopup(auth, new GoogleAuthProvider())
      const idToken = await cred.user.getIdToken()
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (!res.ok) {
        // Drop the client session so a rejected account isn't left signed in.
        await signOut(auth).catch(() => {})
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(
          res.status === 403
            ? 'This account is not authorized for the operator console.'
            : (body.error ?? 'Sign-in failed.'),
        )
        return
      }
      router.replace('/')
      router.refresh()
    } catch (e) {
      // Keep the real reason in the logs; show the user a generic message.
      console.error('operator sign-in failed:', e)
      setError('Sign-in was canceled or failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={handleGoogle} disabled={loading} className="w-full">
        {loading ? 'Signing in…' : 'Sign in with Google'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
