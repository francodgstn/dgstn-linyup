'use client'

// "Tell me if a place comes free" — the way into a full course's queue.
//
// Self-contained on purpose. The class queue's join is woven through the
// booking form's step machine, because a class seat is chosen inside that flow;
// a course card is a standalone block above it, and pulling it through the same
// machine would mean teaching every step about an offer type it otherwise never
// sees. What this needs is a name, an address and a button.
//
// SIGNED IN, NOTHING IS ASKED. `joinCourseBlockWaitlist` identifies the caller
// from the contact-session token alone and ignores anything in the body, so
// sending details would be theatre, and asking for them would be worse: it
// invites a second spelling of a person the studio already has.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2 } from 'lucide-react'
import { callFunction } from '@/lib/callFunction'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface JoinResult {
  status: 'waiting' | 'offered'
  position: number | null
}

export function CourseWaitlistDialog({
  teamId,
  blockId,
  courseName,
  signedIn,
  onClose,
}: {
  teamId: string
  blockId: string
  courseName: string
  /** A verified contact session is on the page, so the server already knows who
   *  this is and the form collapses to one button. */
  signedIn: boolean
  onClose: () => void
}) {
  const t = useTranslations('CourseWaitlist')
  const [firstname, setFirstname] = useState('')
  const [lastname, setLastname] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState<JoinResult | null>(null)

  const ready = signedIn || (firstname.trim() && lastname.trim() && email.trim())

  async function join() {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await callFunction<Record<string, unknown>, JoinResult>(
        'joinCourseBlockWaitlist'
      )({
        teamId,
        blockId,
        // Omitted entirely when signed in: the server reads the caller from the
        // session and a body `contactId` proves nothing.
        ...(signedIn
          ? {}
          : {
              contactDetails: {
                firstname: firstname.trim(),
                lastname: lastname.trim(),
                email: email.trim(),
              },
            }),
      })
      setJoined(res.data)
    } catch (err) {
      const e = err as { message?: string; details?: { reason?: string } }
      const reason = e.details?.reason
      setError(
        reason === 'places_available'
          ? t('joinHasPlaces')
          : reason === 'already_enrolled'
            ? t('joinAlreadyOn')
            : reason === 'queue_full'
              ? t('joinQueueFull')
              : reason === 'email_required'
                ? t('joinEmailRequired')
                : (e.message ?? t('joinFailed'))
      )
    } finally {
      setBusy(false)
    }
  }

  if (joined) {
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('joinedTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm">
            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
            <p>
              {joined.position
                ? t('joinedWithPosition', { name: courseName, position: joined.position })
                : t('joinedBody', { name: courseName })}
            </p>
            {/* Said plainly, because it is the whole mechanism: a place is only
                ever redeemed through the mailed link, and one that goes unread
                rolls on to the next person. */}
            <p className="text-muted-foreground">{t('joinedMailNote')}</p>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>{t('closeButton')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('joinTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('joinBody', { name: courseName })}</p>
          {!signedIn && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cw-first">{t('firstname')}</Label>
                  <Input
                    id="cw-first"
                    value={firstname}
                    onChange={(e) => setFirstname(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cw-last">{t('lastname')}</Label>
                  <Input
                    id="cw-last"
                    value={lastname}
                    onChange={(e) => setLastname(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cw-email">{t('email')}</Label>
                <Input
                  id="cw-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t('emailWhy')}</p>
              </div>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={join} disabled={busy || !ready}>
            {busy ? t('working') : t('joinAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
