'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { QRCodeCanvas } from 'qrcode.react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { publicUrl, TEAMS_COLLECTION, PUBLIC_SURFACES, routableSurfaces, PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import type { ActivePublicSurfaces, PublicSurface, Team } from '@linyup/shared'
import { Copy, Download, Check, ExternalLink } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

/**
 * What a QR can point at: the check-in payload, or any public surface the team
 * actually has LIVE.
 *
 * Check-in is not a surface — it encodes a JSON payload the scanner app reads,
 * not a URL — which is why it is a separate member rather than an entry in
 * PUBLIC_SURFACES.
 */
type QRTarget = 'checkin' | PublicSurface

/** The `PublicHub` message key for a surface's label — reused rather than
 *  duplicated, so a rename lands in one place. */
const SURFACE_LABEL_KEY: Record<PublicSurface, string> = {
  'bio-link': 'surfaceBioLink',
  site: 'surfaceWebsite',
  space: 'surfaceSpace',
  booking: 'surfaceBooking',
  shop: 'surfaceShop',
  signup: 'surfaceSignup',
  documents: 'surfaceDocuments',
  kiosk: 'surfaceKiosk',
  events: 'surfaceEvents',
}

export function QRDialog({
  open,
  onClose,
  team,
}: {
  open: boolean
  onClose: () => void
  team: Team | null
}) {
  const t = useTranslations('TopBar')
  const tHub = useTranslations('PublicHub')
  const [target, setTarget] = useState<QRTarget>('checkin')
  const [copied, setCopied] = useState(false)
  const [live, setLive] = useState<PublicSurface[] | null>(null)
  // ONE canvas whose value changes with the selection. The old two-canvas
  // arrangement existed to keep a ref per tab; with a list of surfaces that
  // would mean a canvas each, all but one hidden.
  const qrRef = useRef<HTMLCanvasElement>(null)

  // Which surfaces this team actually has live — the same
  // `active_public_surfaces` the public root uses to pick a landing. Offering a
  // QR for a surface that 404s would be worse than not offering it.
  useEffect(() => {
    if (!open || !team?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, TEAMS_COLLECTION, team.id, PUBLIC_PROFILE_SUBCOLLECTION, team.id))
        if (cancelled) return
        // Through `routableSurfaces`: a shop with no till still renders — as a
        // read-only price list — so a QR to it lands somewhere real.
        const active = routableSurfaces(
          (snap.data()?.active_public_surfaces ?? {}) as Partial<ActivePublicSurfaces>
        )
        // bio-link is the tenant root and always exists; the rest must be live.
        setLive(
          PUBLIC_SURFACES.filter(
            (sf) => sf === 'bio-link' || active[sf as keyof ActivePublicSurfaces] === true
          )
        )
      } catch {
        // Degrade to the always-true surface rather than an empty dropdown: a
        // rules or network failure should not make the studio think it has no
        // public presence.
        if (!cancelled) setLive(['bio-link'])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, team?.id])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const checkinValue = team?.slug ? JSON.stringify({ team: team.slug }) : ''
  // The URL a scan lands on — empty for check-in, which encodes a payload.
  const targetUrl =
    target === 'checkin' || !team?.slug ? '' : publicUrl(origin, team.slug, target)
  const qrValue = target === 'checkin' ? checkinValue : targetUrl

  const options = useMemo<QRTarget[]>(() => ['checkin', ...(live ?? ['bio-link'])], [live])

  function labelFor(v: QRTarget): string {
    return v === 'checkin' ? t('qrCheckinTab') : tHub(SURFACE_LABEL_KEY[v] as never)
  }

  function activeRef() {
    return qrRef
  }

  function download(filename: string) {
    const canvas = activeRef().current
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = filename
    a.click()
  }

  function downloadBranded(teamName: string, filename: string) {
    const qr = activeRef().current
    if (!qr) return

    const pad = 20
    const headerH = 40
    const qrSize = qr.width
    const out = document.createElement('canvas')
    out.width = qrSize + pad * 2
    out.height = qrSize + headerH + pad * 2

    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, out.width - 2, out.height - 2)
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 16px Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(teamName, out.width / 2, headerH / 2 + pad)
    ctx.drawImage(qr, pad, headerH + pad / 2)

    const a = document.createElement('a')
    a.href = out.toDataURL('image/png')
    a.download = filename
    a.click()
  }

  async function downloadCheckinPdf() {
    const qrCanvas = qrRef.current
    if (!qrCanvas || !team) return

    // Scale QR 4× for crisp print resolution
    const scale = 4
    const hiRes = document.createElement('canvas')
    hiRes.width = qrCanvas.width * scale
    hiRes.height = qrCanvas.height * scale
    const hCtx = hiRes.getContext('2d')!
    hCtx.fillStyle = '#ffffff'
    hCtx.fillRect(0, 0, hiRes.width, hiRes.height)
    hCtx.drawImage(qrCanvas, 0, 0, hiRes.width, hiRes.height)
    const qrDataUrl = hiRes.toDataURL('image/png')

    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

    const pageW = doc.internal.pageSize.getWidth() // 210
    const pageH = doc.internal.pageSize.getHeight() // 297
    const margin = 22
    const centerX = pageW / 2 // 105
    const maxW = pageW - margin * 2 // 166

    // ── Title ────────────────────────────────────────────────────────────────
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(42)
    doc.setTextColor(0, 0, 0)
    doc.text('CHECK IN', centerX, 34, { align: 'center' })

    doc.setFontSize(34)
    doc.text('TO YOUR CLASS', centerX, 50, { align: 'center' })

    // ── Divider + team name ──────────────────────────────────────────────────
    const lineY = 62
    doc.setDrawColor(100, 100, 100)
    doc.setLineWidth(0.3)
    doc.line(50, lineY, centerX - 28, lineY)
    doc.line(centerX + 28, lineY, 160, lineY)

    doc.setFontSize(16)
    doc.setTextColor(0, 0, 0)
    doc.text(team.name, centerX, lineY + 1.5, { align: 'center' })

    // ── Description ──────────────────────────────────────────────────────────
    let cursorY = lineY + 9 // 71 mm
    if (team.description) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(90, 90, 90)
      const lines = doc.splitTextToSize(team.description, maxW - 20) as string[]
      for (const line of lines) {
        doc.text(line, centerX, cursorY, { align: 'center' })
        cursorY += 4.5
      }
      cursorY += 8
    } else {
      cursorY += 8
    }

    // ── QR code + border box ─────────────────────────────────────────────────
    const qrSize = 78
    const qrPad = 7
    const boxSize = qrSize + qrPad * 2 // 92
    const boxX = centerX - boxSize / 2
    const qrX = centerX - qrSize / 2

    doc.setDrawColor(70, 70, 70)
    doc.setLineWidth(0.9)
    doc.roundedRect(boxX + 0.45, cursorY + 0.45, boxSize - 0.9, boxSize - 0.9, 7, 7, 'S')
    doc.addImage(qrDataUrl, 'PNG', qrX, cursorY + qrPad, qrSize, qrSize)

    cursorY += boxSize

    // ── Instruction ───────────────────────────────────────────────────────────
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(18)
    doc.setTextColor(0, 0, 0)
    doc.text('Scan with your phone to check in', centerX, cursorY + 24, { align: 'center' })

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.setFontSize(8)
    doc.setTextColor(160, 160, 160)
    doc.text('Powered by Linyup', centerX, pageH - 10, { align: 'center' })

    doc.save(`linyup-checkin-${team.slug ?? 'poster'}.pdf`)
  }

  async function copyUrl() {
    if (!targetUrl) return
    await navigator.clipboard.writeText(targetUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const noSlug = !team?.slug

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('qrTitle')}</DialogTitle>
        </DialogHeader>

        {noSlug ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('qrNoSlug')}</p>
        ) : (
          <div className="space-y-4">
            {/* A DROPDOWN, not tabs: how many entries there are depends on what the
                team has installed and published, so the control has to scale from
                two to nine without reflowing the dialog. */}
            <Select value={target} onValueChange={(v) => setTarget(v as QRTarget)}>
              <SelectTrigger className="w-full">
                <SelectValue>{labelFor(target)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {options.map((v) => (
                  <SelectItem key={v} value={v}>
                    {labelFor(v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Description */}
            <p className="text-xs text-muted-foreground">
              {target === 'checkin' ? t('qrCheckinDesc') : t('qrSurfaceDesc')}
            </p>

            {/* One canvas — its value follows the selection. */}
            <div className="flex justify-center py-2">
              <QRCodeCanvas ref={qrRef} value={qrValue} size={200} level="M" />
            </div>

            {/* The URL a scan lands on. Check-in has none — it encodes a payload. */}
            {target !== 'checkin' && (
              <div className="flex items-center gap-2 bg-muted rounded-md px-3 py-1.5">
                {/* min-w-0 is what makes `truncate` actually bind on a flex
                    child: without it the span takes its content's intrinsic
                    width and a long surface URL widened the whole dialog. */}
                <span className="min-w-0 flex-1 truncate text-xs font-mono text-muted-foreground">
                  {targetUrl}
                </span>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            )}

            {/* Download buttons */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1 gap-1.5"
                onClick={() => download(`linyup-qr-${target}.png`)}
              >
                <Download className="h-3.5 w-3.5" />
                {t('qrDownloadPng')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1 gap-1.5"
                onClick={() =>
                  downloadBranded(team?.name ?? 'Linyup', `linyup-qr-${target}-branded.png`)
                }
              >
                <Download className="h-3.5 w-3.5" />
                {t('qrDownloadBranded')}
              </Button>
            </div>

            {/* PDF poster — check-in only: the poster's copy says "check in". */}
            {target === 'checkin' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full gap-1.5"
                onClick={downloadCheckinPdf}
              >
                <Download className="h-3.5 w-3.5" />
                {t('qrDownloadPoster')}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
