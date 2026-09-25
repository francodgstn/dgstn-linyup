'use client'

// "Show me what this person signed" — the operator half of the export.
//
// A studio keeps a waiver for exactly one moment, and that moment arrives years
// later with a lawyer attached. So the artefact is a SINGLE self-contained file:
// every version an acceptance names, its full frozen text, the stored
// fingerprint and an explicit verdict on whether the two still match. A mismatch
// is printed together with what to do about it — an artefact that tells a reader
// the evidence is broken and stops there is worse than one that never checked.
//
// It also carries a second, clearly separated section: every acceptance found
// under the SAME EMAIL ADDRESS but a different contact record. That section is
// mandatory (one human routinely holds several contact ids here, because the
// guest match requires email AND name — a dropped umlaut is enough) and it is
// never merged, because an identity key is sha256(normalized email) and a shared
// family mailbox gives a mother and her child the same one.
//
// The member's own download from Space omits that section, and the SERVER — not
// this component — is what decides which of the two it is producing.
//
// ── IT IS A TAB, AND IT NEVER RETURNS null ──────────────────────────────────
// This used to render at the bottom of the Profile tab, under a ~557-line edit
// form, and `return null` unless the team required a waiver. Between the two, a
// signup-consent acceptance was recorded and displayed on NO screen in the
// product. So: its own tab, the UNION of both surfaces
// (`useContactDocumentRows`), and an honest empty state with somewhere to go
// instead of a disappearing panel.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Download, FileText, ShieldCheck } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useContactDocumentRows } from '@/hooks/useContactDocuments'
import { callFunction } from '@/lib/callFunction'

export function ConsentHistoryPanel({
  contactId,
  teamId,
  contactName,
}: {
  contactId: string
  teamId: string | null
  contactName: string
}) {
  const t = useTranslations('Waivers')
  // The two surface labels are owned by the Documents panel that writes them —
  // one copy of "Shown at signup" / "Required before booking" in the product,
  // so the tab and the panel can never describe the same flag differently.
  const tDocuments = useTranslations('Documents')
  const { rows, asksForAnything, loading, refetch } = useContactDocumentRows(teamId, contactId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // Which document is mid-revocation, and the typed reason. A destructive action
  // on a compliance record gets a confirmation with a reason field: the reason is
  // stored on the event, and it is the only part of a revocation that explains
  // itself years later.
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // Which document is being asked for, and what came back for THIS person.
  // Per row rather than per panel: the answer ("no email address", "already
  // signed") belongs beside the document it is about.
  const [asking, setAsking] = useState<string | null>(null)
  const [askOutcome, setAskOutcome] = useState<Record<string, string>>({})

  const ask = async (documentId: string) => {
    if (!teamId) return
    setAsking(documentId)
    try {
      const fn = callFunction<
        { teamId: string; documentId: string; contactIds: string[] },
        { counts: Record<string, number> }
      >('requestWaiverAcceptance')
      const res = await fn({ teamId: teamId!, documentId, contactIds: [contactId] })
      const counts = res.data.counts
      // One recipient, so exactly one count is 1 — reported as the sentence for
      // that outcome rather than as "sent" regardless, which is what a bulk send
      // that only totals would have said.
      const outcome =
        (['sent', 'already_signed', 'no_email', 'not_delivered', 'skipped'] as const).find(
          (k) => (counts[k] ?? 0) > 0
        ) ?? 'not_delivered'
      setAskOutcome((prev) => ({ ...prev, [documentId]: `ask_${outcome}` }))
    } catch (err) {
      const reason = (err as { details?: { reason?: string } }).details?.reason
      setAskOutcome((prev) => ({
        ...prev,
        [documentId]: reason === 'document_not_required' ? 'ask_not_required' : 'ask_error',
      }))
    } finally {
      setAsking(null)
    }
  }

  const revoke = async (documentId: string) => {
    setRevokeBusy(true)
    setRevokeError(null)
    try {
      const fn = callFunction<
        { documentId: string; contactId: string; reason?: string },
        { revoked: boolean }
      >('revokeWaiverAcceptance')
      await fn({ documentId, contactId, reason: revokeReason.trim() || undefined })
      setRevoking(null)
      setRevokeReason('')
      await refetch()
    } catch (err) {
      const reason = (err as { details?: { reason?: string } }).details?.reason
      setRevokeError(
        reason === 'not_signed'
          ? t('errorNotSigned')
          : reason === 'already_revoked'
            ? t('errorAlreadyRevoked')
            : reason === 'ledger_unreadable'
              ? t('errorLedgerUnreadable')
              : t('errorGeneric')
      )
    } finally {
      setRevokeBusy(false)
    }
  }

  const download = async () => {
    setBusy(true)
    setError(false)
    try {
      const fn = callFunction<
        { contactId: string; format: 'html' },
        { format: 'html'; html: string }
      >('exportContactConsentHistory')
      const res = await fn({ contactId, format: 'html' })
      const blob = new Blob([res.data.html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `consent-history-${contactName.replace(/\s+/g, '-').toLowerCase() || contactId}.html`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Skeleton className="h-40 w-full rounded-xl" />

  // THE HONEST EMPTY STATE. A team that asks for nothing has collected nothing —
  // which is a sentence worth reading, and a thing worth fixing, so it says both
  // and points at where.
  if (!asksForAnything) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
        <p className="font-medium">{t('contactEmptyTitle')}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {t('contactEmptyBody')}
        </p>
        <Link
          href={'/documents' as Route}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
        >
          {t('contactEmptyCta')}
        </Link>
      </div>
    )
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('exportTitle')}</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('exportHint')}</p>

      <ul className="mt-3 space-y-2">
        {rows.map(({ documentId: docId, title, atSignup, requiredBeforeBooking, signer, state }) => (
          <li key={docId} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">
                  {signer
                    ? `${t(`state_${state}` as 'state_valid')} · ${t('colVersion')} ${signer.accepted_version} · ${t(`role_${signer.signer_role}` as 'role_self')} · ${signer.accepted_at.toDate().toLocaleDateString()}`
                    : t('state_none')}
                </p>
                {/* WHICH SURFACE ASKED. A row can be in both sets, and the two
                    mean different things: one recorded a tick, the other refuses
                    a booking without it. Same wording as the Documents panel. */}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {atSignup && (
                    <Badge variant="secondary">{tDocuments('surfacesColSignup')}</Badge>
                  )}
                  {requiredBeforeBooking && (
                    <Badge variant="outline">{tDocuments('surfacesColRequired')}</Badge>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* ASK. Offered where the signature does not currently count and
                    the document is one Space can actually present — a document
                    merely shown at signup has no page to send anybody to, so the
                    control is absent rather than an error waiting to happen. */}
                {state !== 'valid' && requiredBeforeBooking && (
                  <button
                    type="button"
                    onClick={() => void ask(docId)}
                    disabled={asking === docId || !teamId}
                    className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {asking === docId ? t('askSending') : t('askAction')}
                  </button>
                )}
                {/* Offered only where there IS something to withdraw. A revoked row
                    keeps its history and is never revoked twice. */}
                {signer && signer.status !== 'revoked' && (
                  <button
                    type="button"
                    onClick={() => {
                      setRevoking(docId)
                      setRevokeReason('')
                      setRevokeError(null)
                    }}
                    className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    {t('revokeAction')}
                  </button>
                )}
              </div>
            </div>

            {askOutcome[docId] && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t(askOutcome[docId] as 'ask_sent')}
              </p>
            )}

            {revoking === docId && (
              <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-sm font-medium">{t('revokeConfirmTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('revokeConfirmBody')}</p>
                <label className="mt-2 block text-xs font-medium" htmlFor="waiver-revoke-reason">
                  {t('revokeReasonLabel')}
                </label>
                <input
                  id="waiver-revoke-reason"
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  maxLength={500}
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5 text-sm"
                />
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void revoke(docId)}
                    disabled={revokeBusy}
                    className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
                  >
                    {revokeBusy ? t('revoking') : t('revokeConfirmAction')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRevoking(null)}
                    disabled={revokeBusy}
                    className="rounded-lg border px-3 py-1.5 text-sm font-medium"
                  >
                    {t('revokeCancel')}
                  </button>
                </div>
                {revokeError && <p className="mt-2 text-sm text-destructive">{revokeError}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
      >
        <Download className="h-4 w-4" />
        {busy ? t('exportPreparing') : t('exportAction')}
      </button>
      {error && <p className="mt-2 text-sm text-destructive">{t('exportError')}</p>}
    </div>
  )
}
