'use client'

/**
 * THE QR SLIP SHEET — one printable slip per contact, cut apart and handed out.
 *
 * The per-contact dialog is the right unit at a counter and the wrong one for a
 * club: HMD Team Galli has 336 contacts and 332 of them have no email on file.
 * Opening a dialog per person is not a workflow, so this mints the whole
 * selection at once and lays it out for paper.
 *
 * ── THE SELECTION ARRIVES IN sessionStorage, NOT THE URL ────────────────────
 * Three hundred document ids do not fit in a query string, and a filter
 * re-evaluated on this page would silently print a DIFFERENT set from the one
 * the studio ticked (the list is live — a contact archived in between would
 * drop out). So the contacts page writes the exact ids it had, and this page
 * prints those or nothing. Per-TAB, and deliberately not cleared on read, so
 * refreshing the sheet still prints the same people.
 *
 * ── NOTHING IS MINTED UNTIL ASKED ───────────────────────────────────────────
 * Landing here creates no grants. Minting 336 live links is a real act with a
 * real window attached, so it takes a button press and states the window in
 * the same breath.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { QRCodeCanvas } from 'qrcode.react'
import { httpsCallable } from 'firebase/functions'
import { Printer, ArrowLeft } from 'lucide-react'
import { functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import {
  CONTACT_LINK_MAX_BATCH,
  CONTACT_LINK_SHEET_DEFAULT_TTL_MINUTES,
  CONTACT_LINK_SHEET_TTL_CHOICES,
} from '@linyup/shared'
import { readQrSheetSelection } from '@/lib/qrSheetSelection'
import { Button, buttonVariants } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Slip {
  contactId: string
  name: string
  url: string
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export default function ContactQrSheetPage() {
  const t = useTranslations('ContactLink')
  const { currentTeamId } = useAuth()
  const [ids, setIds] = useState<string[] | null>(null)
  const [ttl, setTtl] = useState<number>(CONTACT_LINK_SHEET_DEFAULT_TTL_MINUTES)
  const [slips, setSlips] = useState<Slip[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setIds(readQrSheetSelection())
  }, [])

  const create = useCallback(async () => {
    if (!currentTeamId || !ids?.length) return
    setBusy(true)
    setError(null)
    setProgress(0)
    try {
      const fn = httpsCallable<
        { teamId: string; contactIds: string[]; ttlMinutes: number },
        { links: Slip[]; skipped: string[] }
      >(functions, 'createContactUpdateLinksBatch')

      const all: Slip[] = []
      // Sequential, not Promise.all: each call revokes the previous grants for
      // the ids it carries, and firing twenty of those at one collection in
      // parallel is contention for no gain — the sheet is printed once.
      for (const group of chunk(ids, CONTACT_LINK_MAX_BATCH)) {
        const res = await fn({ teamId: currentTeamId, contactIds: group, ttlMinutes: ttl })
        all.push(...res.data.links)
        setProgress(all.length)
      }
      setSlips(all)
    } catch {
      setError(t('sheetFailed'))
    } finally {
      setBusy(false)
    }
  }, [currentTeamId, ids, ttl, t])

  if (ids === null) return null

  if (ids.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">{t('sheetTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('sheetNoSelection')}</p>
        <Link href={'/contacts' as Route} className={buttonVariants({ variant: 'outline' })}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('sheetBackToContacts')}
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="no-print space-y-4">
        <div>
          <h1 className="text-xl font-bold">{t('sheetTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('sheetIntro', { count: ids.length })}
          </p>
        </div>

        {!slips ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="sheet-ttl">{t('validFor')}</Label>
              <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
                <SelectTrigger id="sheet-ttl" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_LINK_SHEET_TTL_CHOICES.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {t('hours', { count: m / 60 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={create} disabled={busy}>
              {busy ? t('sheetCreating', { done: progress, total: ids.length }) : t('sheetCreate')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" />
              {t('sheetPrint')}
            </Button>
            <Link href={'/contacts' as Route} className={buttonVariants({ variant: 'outline' })}>
              {t('sheetBackToContacts')}
            </Link>
            {/* Stated where the studio is about to act on it, not in a tooltip:
                the slips are live grants and the sheet is worth collecting back. */}
            <p className="text-sm text-muted-foreground">
              {t('sheetLiveWarning', { count: slips.length })}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {slips && (
        <div className="qr-sheet grid grid-cols-2 gap-3 sm:grid-cols-3">
          {slips.map((s) => (
            <div
              key={s.contactId}
              className="qr-slip flex flex-col items-center gap-2 rounded-lg border bg-white p-4 text-center"
            >
              <p className="text-sm font-semibold text-black">{s.name}</p>
              <QRCodeCanvas value={s.url} size={128} includeMargin />
              <p className="text-[10px] leading-tight text-neutral-600">{t('sheetSlipHint')}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
