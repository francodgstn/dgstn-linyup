'use client'

// The member's own health-insurance details for the Tarif 595 receipts —
// AHV number, insurer, insured number — written by the member to their OWN
// `teams/{t}/tarif595_contacts/{contactId}` row, which the rules allow for the
// contact session on exactly these fields (TARIF595_CONTACT_SELF_FIELDS; the
// insurer GLN, sex override and guardian stay the studio's). Rendered only
// when the studio has the plugin installed (`enabled` from the same read the
// Receipts tab uses): a member of a studio that never issues receipts is
// never asked for an AHV number.
//
// A direct Firestore write, like the coaching goals — the rule IS the
// authorization, and there is no server-side validation worth a callable: the
// preview validates the AHV check digit again before anything is issued.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { Check, HeartPulse, Pencil } from 'lucide-react'
import { TARIF595_CONTACTS_SUBCOLLECTION, TEAMS_COLLECTION, formatAhv, isValidAhv, type Tarif595ContactData } from '@linyup/shared'
import { db } from '@/lib/firebase'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { useSpaceReceipts } from '../useSpaceReceipts'

type SelfFields = Pick<Tarif595ContactData, 'ahv_number' | 'insurer_name' | 'insured_number'>

function ownRow(teamId: string, contactId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, TARIF595_CONTACTS_SUBCOLLECTION, contactId)
}

export function InsuranceCard() {
  const t = useTranslations('Space')
  const { isAuthenticated, contact, teamId } = useSpaceAuth()
  const { accent, onDark, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const qc = useQueryClient()
  const { data: receipts } = useSpaceReceipts()
  const contactId = contact?.id ?? null
  const enabled = receipts?.enabled === true

  const rowQ = useQuery<SelfFields | null>({
    queryKey: ['space-insurance', teamId, contactId],
    enabled: isAuthenticated && enabled && !!teamId && !!contactId,
    queryFn: async () => {
      try {
        const snap = await getDoc(ownRow(teamId!, contactId!))
        if (!snap.exists()) return null
        const d = snap.data() as Tarif595ContactData
        return { ahv_number: d.ahv_number ?? null, insurer_name: d.insurer_name ?? null, insured_number: d.insured_number ?? null }
      } catch (err: unknown) {
        reportPublicLoadFailure('space/insurance', err)
        throw err
      }
    },
  })

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ahv: '', insurer: '', insured: '' })
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')

  useEffect(() => {
    if (rowQ.data === undefined) return
    setForm({ ahv: rowQ.data?.ahv_number ?? '', insurer: rowQ.data?.insurer_name ?? '', insured: rowQ.data?.insured_number ?? '' })
  }, [rowQ.data])

  if (!isAuthenticated || !enabled) return null

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }
  const inputStyle = { background: onDark ? 'rgba(255,255,255,0.06)' : '#fff', color: textMain, border: `1px solid ${cardBorder}` }
  const ahvTrimmed = form.ahv.trim()
  const ahvInvalid = ahvTrimmed !== '' && !isValidAhv(ahvTrimmed)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!teamId || !contactId || ahvInvalid) return
    setStatus('saving')
    try {
      // Only the self-writable keys — anything else is refused by the rules.
      await setDoc(
        ownRow(teamId, contactId),
        {
          ahv_number: ahvTrimmed || null,
          insurer_name: form.insurer.trim() || null,
          insured_number: form.insured.trim() || null,
          updated_at: serverTimestamp(),
        },
        { merge: true }
      )
      await qc.invalidateQueries({ queryKey: ['space-insurance', teamId, contactId] })
      setStatus('done')
      setEditing(false)
    } catch (err: unknown) {
      reportPublicLoadFailure('space/insurance-save', err)
      setStatus('error')
    }
  }

  const row = rowQ.data ?? null

  return (
    <section className="rounded-2xl p-4" style={cardStyle}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-4 w-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
            {t('insuranceTitle')}
          </h2>
        </div>
        {!editing && !rowQ.isError && !rowQ.isLoading && (
          <button
            type="button"
            onClick={() => {
              setEditing(true)
              setStatus('idle')
            }}
            className="inline-flex items-center gap-1 text-xs font-medium"
            style={{ color: accent }}
          >
            <Pencil className="h-3.5 w-3.5" /> {t('profileEdit')}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs" style={{ color: textMuted }}>
        {t('insuranceIntro')}
      </p>

      {status === 'done' && (
        <div className="mb-3 flex items-center gap-1.5 text-xs" style={{ color: '#16a34a' }}>
          <Check className="h-3.5 w-3.5" /> {t('insuranceSaved')}
        </div>
      )}

      {editing ? (
        <form onSubmit={submit} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: textMuted }}>
              {t('insuranceAhv')}
            </span>
            <input
              value={form.ahv}
              onChange={(e) => setForm({ ...form, ahv: e.target.value })}
              placeholder="756.1234.5678.97"
              inputMode="numeric"
              aria-invalid={ahvInvalid}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
            {ahvInvalid && (
              <span className="text-xs" style={{ color: '#dc2626' }}>
                {t('insuranceAhvInvalid')}
              </span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: textMuted }}>
              {t('insuranceInsurer')}
            </span>
            <input value={form.insurer} onChange={(e) => setForm({ ...form, insurer: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: textMuted }}>
              {t('insuranceInsuredNumber')}
            </span>
            <input value={form.insured} onChange={(e) => setForm({ ...form, insured: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
          </label>
          {status === 'error' && (
            <p className="text-xs" style={{ color: '#dc2626' }}>
              {t('insuranceSaveFailed')}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={status === 'saving' || ahvInvalid} className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ background: accent, color: '#fff' }}>
              {status === 'saving' ? t('saving') : t('insuranceSave')}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setStatus('idle')
              }}
              className="rounded-full px-4 py-2 text-sm font-medium"
              style={{ color: textMuted }}
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : rowQ.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded" style={{ background: cardBorder }} />
          ))}
        </div>
      ) : rowQ.isError ? (
        <p role="alert" className="text-sm" style={{ color: textMuted }} title={loadFailureDetail(rowQ.error) ?? undefined}>
          {t('insuranceLoadFailed')}
        </p>
      ) : (
        <dl className="space-y-1.5">
          <Row label={t('insuranceAhv')} value={row?.ahv_number ? formatAhv(row.ahv_number) : '—'} textMain={textMain} textMuted={textMuted} />
          <Row label={t('insuranceInsurer')} value={row?.insurer_name || '—'} textMain={textMain} textMuted={textMuted} />
          <Row label={t('insuranceInsuredNumber')} value={row?.insured_number || '—'} textMain={textMain} textMuted={textMuted} />
        </dl>
      )}
    </section>
  )
}

function Row({ label, value, textMain, textMuted }: { label: string; value: string; textMain: string; textMuted: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span style={{ color: textMuted }}>{label}</span>
      <span className="truncate text-right font-medium" style={{ color: textMain }}>
        {value}
      </span>
    </div>
  )
}
