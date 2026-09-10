'use client'

/**
 * SHARE A ONE-CONTACT UPDATE LINK — QR, copy, optional spoken code, revoke.
 *
 * The studio hands this to somebody standing in front of them. Everything about
 * the dialog follows from that: it opens on the QR rather than on a settings
 * pane, the window is minutes by default, and the code (when asked for) is
 * rendered large enough to read aloud across a mat.
 *
 * ── THE LINK IS SHOWN ONCE ──────────────────────────────────────────────────
 * The server stores only `sha256(token)`, so nothing can re-display a link
 * after this dialog closes — see @linyup/shared → types/contactLink.ts. Minting
 * again is the way back, and it revokes the previous grant, so the answer to
 * "is the QR still on their camera roll live?" is always no.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { QRCodeCanvas } from 'qrcode.react'
import { httpsCallable } from 'firebase/functions'
import { Check, Copy, QrCode, RefreshCw, ShieldOff } from 'lucide-react'
import { functions } from '@/lib/firebase'
import {
  CONTACT_LINK_DEFAULT_TTL_MINUTES,
  CONTACT_LINK_TTL_CHOICES,
} from '@linyup/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Minted {
  url: string
  otp: string | null
  expiresAt: number
}

/** mm:ss remaining, or null once it has run out. */
function useCountdown(expiresAt: number | undefined): string | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!expiresAt) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [expiresAt])
  if (!expiresAt) return null
  const left = Math.max(0, expiresAt - Date.now())
  if (left === 0) return null
  const m = Math.floor(left / 60000)
  const s = Math.floor((left % 60000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ContactUpdateLinkDialog({
  open,
  onClose,
  teamId,
  contactId,
  contactName,
}: {
  open: boolean
  onClose: () => void
  teamId: string
  contactId: string
  contactName: string
}) {
  const t = useTranslations('ContactLink')
  const [ttl, setTtl] = useState<number>(CONTACT_LINK_DEFAULT_TTL_MINUTES)
  const [withOtp, setWithOtp] = useState(false)
  const [minted, setMinted] = useState<Minted | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const remaining = useCountdown(minted?.expiresAt)

  // A dialog reopened for the same contact must not show the previous link:
  // it has been revoked by any later mint, and showing a dead QR is worse than
  // showing none.
  useEffect(() => {
    if (!open) {
      setMinted(null)
      setError(null)
      setCopied(false)
    }
  }, [open])

  const mint = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const fn = httpsCallable<
        { teamId: string; contactId: string; ttlMinutes: number; requireOtp: boolean },
        Minted
      >(functions, 'createContactUpdateLink')
      const res = await fn({ teamId, contactId, ttlMinutes: ttl, requireOtp: withOtp })
      setMinted(res.data)
    } catch {
      setError(t('mintFailed'))
    } finally {
      setBusy(false)
    }
  }, [teamId, contactId, ttl, withOtp, t])

  const revoke = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const fn = httpsCallable<{ teamId: string; contactId: string }, { revoked: number }>(
        functions,
        'revokeContactUpdateLinks'
      )
      await fn({ teamId, contactId })
      setMinted(null)
    } catch {
      setError(t('revokeFailed'))
    } finally {
      setBusy(false)
    }
  }, [teamId, contactId, t])

  async function copy() {
    if (!minted) return
    await navigator.clipboard.writeText(minted.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4" />
            {t('title')}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">{t('intro', { name: contactName })}</p>

        {!minted ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ttl">{t('validFor')}</Label>
              <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
                <SelectTrigger id="ttl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_LINK_TTL_CHOICES.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m < 60 ? t('minutes', { count: m }) : t('hours', { count: m / 60 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="otp">{t('requireCode')}</Label>
                <p className="text-xs text-muted-foreground">{t('requireCodeHint')}</p>
              </div>
              <Switch id="otp" checked={withOtp} onCheckedChange={setWithOtp} />
            </div>

            <Button onClick={mint} disabled={busy} className="w-full">
              {busy ? t('minting') : t('createLink')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-center rounded-lg bg-white p-4">
              <QRCodeCanvas value={minted.url} size={200} includeMargin />
            </div>

            {minted.otp && (
              <div className="rounded-lg border border-dashed p-3 text-center">
                <p className="text-xs text-muted-foreground">{t('codeToRead')}</p>
                <p className="font-mono text-3xl tracking-[0.3em] tabular-nums">{minted.otp}</p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
                {minted.url}
              </code>
              <Button variant="outline" size="icon" onClick={copy} aria-label={t('copy')}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            <p className="text-center text-xs text-muted-foreground">
              {remaining ? t('expiresIn', { time: remaining }) : t('expired')}
            </p>

            <div className="flex gap-2">
              <Button variant="outline" onClick={mint} disabled={busy} className="flex-1">
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('newLink')}
              </Button>
              <Button variant="outline" onClick={revoke} disabled={busy} className="flex-1">
                <ShieldOff className="mr-2 h-4 w-4" />
                {t('revoke')}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
