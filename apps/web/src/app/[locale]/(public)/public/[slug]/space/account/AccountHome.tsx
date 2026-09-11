'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { User, Pencil, Check } from 'lucide-react'
import { loadFailureDetail } from '@/lib/publicQueryError'
import { toDateInputValue } from '@/lib/format'
import { SpaceWaiverCard } from '../SpaceWaiverCard'
import { SpaceMembershipCard } from '../SpaceMembershipCard'
import SpaceSignInWall from '../SpaceSignInWall'
import { ConsentHistoryDownload } from './ConsentHistoryDownload'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { useSpaceContact } from '../useSpaceContact'
import { usePublicFormat } from '../../usePublicFormat'

/** Whatever a birthdate has been stored as — a Timestamp, a `{seconds}` map,
 *  an ISO string — as a Date, or null. The `<input type="date">` value is then
 *  the app's LOCAL-parts `toDateInputValue`, not a UTC slice: the copy that
 *  used to live here serialised through `toISOString()`, which for any zone
 *  ahead of UTC turned a midnight birthdate into the previous day. */
function toDate(v: unknown): Date | null {
  if (!v) return null
  let d: Date | null = null
  if (typeof v === 'string') d = new Date(v)
  else if (typeof (v as { toDate?: unknown }).toDate === 'function') d = (v as { toDate(): Date }).toDate()
  else if (typeof (v as { seconds?: unknown }).seconds === 'number') d = new Date((v as { seconds: number }).seconds * 1000)
  return d && !isNaN(d.getTime()) ? d : null
}

export default function AccountHome() {
  const t = useTranslations('Space')
  const { isAuthenticated } = useSpaceAuth()
  const { accent, onDark, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  // Same read, same rule as the membership card: a failure here means we do not
  // know what this contact holds, which is a different statement from "they hold
  // nothing" — and this page renders it to the member's own face.
  const { data: contact, isLoading, isError, error } = useSpaceContact()

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ firstname: '', lastname: '', phone: '', birthdate: '', note: '' })
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!contact) return
    setForm({
      firstname: contact.firstname ?? '',
      lastname: contact.lastname ?? '',
      phone: contact.phone ?? '',
      birthdate: toDateInputValue(toDate(contact.birthdate)),
      note: '',
    })
  }, [contact])

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }
  const inputStyle = {
    background: onDark ? 'rgba(255,255,255,0.06)' : '#fff',
    color: textMain,
    border: `1px solid ${cardBorder}`,
  }

  if (!isAuthenticated) {
    return <SpaceSignInWall prompt={t('accountSignInPrompt')} />
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('saving')
    setErrMsg('')
    try {
      const fn = httpsCallable(functions, 'requestContactUpdate')
      await fn({
        contactDetails: {
          firstname: form.firstname,
          lastname: form.lastname,
          phone: form.phone || undefined,
          birthdate: form.birthdate || undefined,
        },
        note: form.note || undefined,
      })
      setStatus('done')
      setEditing(false)
    } catch (err) {
      setErrMsg((err as { message?: string }).message ?? 'Could not submit your request.')
      setStatus('error')
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {/* Membership — the SAME component Space Home renders, in its detailed
          variant. It was written twice, and the copies had already diverged:
          only this one learned to say a membership is cancelling. */}
      <SpaceMembershipCard variant="full" />

      {/* Profile */}
      <section className="rounded-2xl p-4" style={cardStyle}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4" style={{ color: accent }} />
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
              {t('profileTitle')}
            </h2>
          </div>
          {/* No editing on top of a failed read: the form prefills FROM `contact`,
              so opening it after the read failed would offer blank name fields and
              submit them as the member's new details. */}
          {!editing && !isError && (
            <button
              onClick={() => { setEditing(true); setStatus('idle') }}
              className="inline-flex items-center gap-1 text-xs font-medium"
              style={{ color: accent }}
            >
              <Pencil className="h-3.5 w-3.5" /> {t('profileEdit')}
            </button>
          )}
        </div>

        {status === 'done' && (
          <div className="mb-3 flex items-center gap-1.5 text-xs" style={{ color: '#16a34a' }}>
            <Check className="h-3.5 w-3.5" /> {t('profileRequestSubmitted')}
          </div>
        )}

        {editing ? (
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('fieldFirstname')} textMuted={textMuted}>
                <input required value={form.firstname} onChange={(e) => setForm({ ...form, firstname: e.target.value })}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
              </Field>
              <Field label={t('fieldLastname')} textMuted={textMuted}>
                <input required value={form.lastname} onChange={(e) => setForm({ ...form, lastname: e.target.value })}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
              </Field>
            </div>
            <Field label={t('fieldPhone')} textMuted={textMuted}>
              <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
            </Field>
            <Field label={t('fieldBirthdate')} textMuted={textMuted}>
              <input type="date" value={form.birthdate} onChange={(e) => setForm({ ...form, birthdate: e.target.value })}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
            </Field>
            <Field label={t('fieldNote')} textMuted={textMuted}>
              <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={2}
                placeholder={t('fieldNotePlaceholder')}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none resize-none" style={inputStyle} />
            </Field>
            {status === 'error' && <p className="text-xs" style={{ color: '#dc2626' }}>{errMsg}</p>}
            <p className="text-[11px]" style={{ color: textMuted }}>{t('profileApprovalNote')}</p>
            <div className="flex items-center gap-2">
              <button type="submit" disabled={status === 'saving'}
                className="text-sm font-medium px-4 py-2 rounded-full disabled:opacity-50"
                style={{ background: accent, color: '#fff' }}>
                {status === 'saving' ? t('saving') : t('profileSubmit')}
              </button>
              <button type="button" onClick={() => { setEditing(false); setStatus('idle') }}
                className="text-sm font-medium px-4 py-2 rounded-full" style={{ color: textMuted }}>
                {t('cancel')}
              </button>
            </div>
          </form>
        ) : isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-4 rounded animate-pulse" style={{ background: cardBorder }} />
            ))}
          </div>
        ) : isError ? (
          // The list below renders '—' in every row when there is no contact, and
          // '—' is a statement: it says the studio holds no phone number for you,
          // no date of birth, and — with the name row falling back the same way —
          // barely a record at all. After a FAILED read that is four claims we
          // cannot make, laid out as this member's current details.
          //
          // Deliberately the SENTENCE and not a second QueryErrorState: this is
          // the same `useSpaceContact` read that already failed in the membership
          // block above, which carries the block and the Retry that fixes both.
          // One failure, reported once, said in both places it matters.
          <p
            role="alert"
            className="text-sm"
            style={{ color: textMuted }}
            title={loadFailureDetail(error) ?? undefined}
          >
            {t('profileLoadFailed')}
          </p>
        ) : (
          <dl className="space-y-1.5">
            <Row label={t('fieldName')} value={`${contact?.firstname ?? ''} ${contact?.lastname ?? ''}`.trim() || '—'} textMain={textMain} textMuted={textMuted} />
            <Row label={t('fieldEmail')} value={contact?.email || '—'} textMain={textMain} textMuted={textMuted} />
            <Row label={t('fieldPhone')} value={contact?.phone || '—'} textMain={textMain} textMuted={textMuted} />
            <Row label={t('fieldBirthdate')} value={fmt.date(toDate(contact?.birthdate)) || '—'} textMain={textMain} textMuted={textMuted} />
          </dl>
        )}
      </section>

      {/* Signed documents — a member's own answer to "what have I agreed to",
          with the version, the date and the current state. It renders as a CARD
          here (always) and as a BANNER on Space Home (only when something is
          outstanding), from one component: two copies would disagree about what
          "signed" means the first time the predicate moved.

          `AccountHome` deliberately grows NO second date-of-birth prompt. The
          one in the profile form above is an optional profile field; the one
          compliance ask lives inside the waiver step and nowhere else. */}
      <SpaceWaiverCard variant="card" />

      {/* The member's own copy, free once the operator export exists — and
          scoped by the SERVER to the session's own contact, so it can only ever
          return their history and never a household's. */}
      <ConsentHistoryDownload />
    </div>
  )
}

function Field({ label, textMuted, children }: { label: string; textMuted: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium" style={{ color: textMuted }}>{label}</span>
      {children}
    </label>
  )
}

function Row({ label, value, textMain, textMuted }: { label: string; value: string; textMain: string; textMuted: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span style={{ color: textMuted }}>{label}</span>
      <span className="font-medium text-right truncate" style={{ color: textMain }}>{value}</span>
    </div>
  )
}
