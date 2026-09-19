'use client'

import { useState } from 'react'
import {
  PLATFORM_NOTICE_TEMPLATES,
  PLATFORM_NOTICE_VARIABLES,
  noticePlaceholdersIn,
  platformNoticeAudienceProblem,
  platformNoticePlaceholderProblem,
  renderNoticeText,
  type PlatformNoticeAudience,
  type PlatformNoticeTemplateId,
  type SaasPlan,
} from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

// Compose → PREVIEW → send. The preview step is not decoration: a send to "all"
// is irreversible and outward-facing, so the operator sees the resolved count,
// and the studios with no reachable address, BEFORE anything leaves. The send
// button stays disabled until a preview for the current audience has run.

const PLANS: SaasPlan[] = ['free', 'coach', 'studio', 'organization']

interface PreviewResult {
  teamCount: number
  recipientCount: number
  unreachable: { teamId: string; teamName: string }[]
  sample: { teamId: string; teamName: string; plan: string | null; emails: string[] }[]
  overLimit: boolean
  limit: number
}

interface SendResult {
  noticeId: string
  teamCount: number
  sent: number
  skipped: number
  failed: number
}

export function NoticeComposer() {
  const [templateId, setTemplateId] = useState<PlatformNoticeTemplateId>('blank')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<PlatformNoticeAudience['kind']>('plans')
  const [plans, setPlans] = useState<SaasPlan[]>([])
  const [teamIds, setTeamIds] = useState('')
  const [createdAfter, setCreatedAfter] = useState('')
  const [createdBefore, setCreatedBefore] = useState('')
  const [includeManagers, setIncludeManagers] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<SendResult | null>(null)

  const template = PLATFORM_NOTICE_TEMPLATES.find((t) => t.id === templateId)

  const audience: PlatformNoticeAudience = {
    kind,
    ...(kind === 'plans' ? { plans } : {}),
    ...(kind === 'teams'
      ? { teamIds: teamIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) }
      : {}),
    createdAfter: createdAfter ? new Date(createdAfter).getTime() : null,
    createdBefore: createdBefore ? new Date(createdBefore).getTime() : null,
  }
  const audienceProblem = platformNoticeAudienceProblem(audience)

  // Only the variables this notice actually uses get an input. Showing all of
  // them invites filling one the text never references, which then looks
  // answered and is not.
  const usedIds = [...new Set([...noticePlaceholdersIn(subject), ...noticePlaceholdersIn(body)])]
  const operatorVars = PLATFORM_NOTICE_VARIABLES.filter(
    (v) => v.scope === 'operator' && usedIds.includes(v.id)
  )
  const recipientVars = PLATFORM_NOTICE_VARIABLES.filter(
    (v) => v.scope === 'recipient' && usedIds.includes(v.id)
  )
  const placeholderProblem = platformNoticePlaceholderProblem(subject, body, values)

  // What one studio would actually receive. Recipient values are stand-ins here
  // — the real ones resolve per studio at send time — but seeing the sentence
  // finished is what catches a token nobody filled.
  const previewSubject = renderNoticeText(subject, {
    ...values,
    studio_name: 'Example Studio',
    plan: 'studio',
  }).text
  const previewBody = renderNoticeText(body, {
    ...values,
    studio_name: 'Example Studio',
    plan: 'studio',
  }).text

  // Any edit to the audience invalidates a preview taken against the previous
  // one — otherwise the count on screen belongs to a different set than the one
  // about to be mailed, which is the worst possible moment for a stale number.
  const invalidatePreview = () => {
    setPreview(null)
    setSent(null)
  }

  function applyTemplate(id: PlatformNoticeTemplateId) {
    setTemplateId(id)
    const t = PLATFORM_NOTICE_TEMPLATES.find((x) => x.id === id)
    if (!t) return
    // Only fill EMPTY fields: picking a template after typing must not discard
    // what was typed.
    if (!subject.trim()) setSubject(t.subject)
    if (!body.trim()) setBody(t.body)
  }

  async function runPreview() {
    setBusy(true)
    setError(null)
    try {
      const fn = callFunction<
        { audience: PlatformNoticeAudience; includeManagers: boolean },
        PreviewResult
      >('previewPlatformNotice')
      const { data } = await fn({ audience, includeManagers })
      setPreview(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    if (!preview) return
    const ok = window.confirm(
      `Send "${subject}" to ${preview.recipientCount} recipient(s) across ${preview.teamCount} studio(s)?\n\nThis cannot be undone.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const fn = callFunction<
        {
          subject: string
          body: string
          templateId: PlatformNoticeTemplateId
          audience: PlatformNoticeAudience
          includeManagers: boolean
          values: Record<string, string>
        },
        SendResult
      >('sendPlatformNotice')
      const { data } = await fn({ subject, body, templateId, audience, includeManagers, values })
      setSent(data)
      setPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  const canSend =
    !!preview &&
    !preview.overLimit &&
    preview.recipientCount > 0 &&
    !!subject.trim() &&
    !!body.trim() &&
    !placeholderProblem

  return (
    <section className="space-y-4 rounded-lg border p-5">
      <div>
        <h2 className="text-lg font-semibold">Send a notice</h2>
        <p className="text-sm text-muted-foreground">
          Goes out as Linyup (hello@linyup.com) to studio owners. Suppressions and the messaging
          policy still apply, and internal tenants are excluded.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Template</span>
          <select
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value as PlatformNoticeTemplateId)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          >
            {PLATFORM_NOTICE_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {template?.noticeDays && (
            <span className="block text-xs text-amber-700">
              This kind of change owes {template.noticeDays} days&apos; notice before it takes
              effect.
            </span>
          )}
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="A change to the providers we use"
          />
        </label>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          className="w-full rounded-md border px-3 py-2 font-mono text-xs"
          placeholder="Plain text. Blank lines become paragraphs."
        />
        <span className="block text-xs text-muted-foreground">
          Plain text — blank lines become paragraphs, and the Linyup layout is applied at send
          time. Placeholders like <code>{'{{effective_date}}'}</code> get inputs below; the send is
          refused while any is unfilled.
        </span>
      </label>

      {usedIds.length > 0 && (
        <fieldset className="space-y-3 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">Fill in the placeholders</legend>
          {operatorVars.map((v) => (
            <label key={v.id} className="block space-y-1 text-sm">
              <span className="font-medium">
                {v.label} <code className="text-xs text-muted-foreground">{`{{${v.id}}}`}</code>
              </span>
              <input
                value={values[v.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.id]: e.target.value }))}
                className="w-full rounded-md border px-3 py-2 text-sm"
                placeholder={v.hint}
              />
            </label>
          ))}
          {recipientVars.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Filled per studio at send time:{' '}
              {recipientVars.map((v) => `{{${v.id}}}`).join(', ')}
            </p>
          )}
          {placeholderProblem && <p className="text-xs text-red-600">{placeholderProblem}</p>}
        </fieldset>
      )}

      {(subject.trim() || body.trim()) && (
        <details className="rounded-md border p-4" open={!!placeholderProblem}>
          <summary className="cursor-pointer text-sm font-medium">
            Preview — what one studio receives
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-sm font-medium">{previewSubject || <em>No subject</em>}</p>
            <pre className="whitespace-pre-wrap rounded bg-muted/50 p-3 text-xs">{previewBody}</pre>
            <p className="text-xs text-muted-foreground">
              Studio name and plan are stand-ins here; the real values resolve per studio.
            </p>
          </div>
        </details>
      )}

      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Audience</legend>

        <div className="flex flex-wrap gap-4 text-sm">
          {(['all', 'plans', 'teams'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="audience-kind"
                checked={kind === k}
                onChange={() => {
                  setKind(k)
                  invalidatePreview()
                }}
              />
              {k === 'all' ? 'All studios' : k === 'plans' ? 'By plan' : 'Specific studios'}
            </label>
          ))}
        </div>

        {kind === 'plans' && (
          <div className="flex flex-wrap gap-3 text-sm">
            {PLANS.map((p) => (
              <label key={p} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={plans.includes(p)}
                  onChange={(e) => {
                    setPlans((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))
                    invalidatePreview()
                  }}
                />
                {p}
              </label>
            ))}
          </div>
        )}

        {kind === 'teams' && (
          <textarea
            value={teamIds}
            onChange={(e) => {
              setTeamIds(e.target.value)
              invalidatePreview()
            }}
            rows={3}
            placeholder="Team ids, one per line or comma-separated"
            className="w-full rounded-md border px-3 py-2 font-mono text-xs"
          />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Created on or after</span>
            <input
              type="date"
              value={createdAfter}
              onChange={(e) => {
                setCreatedAfter(e.target.value)
                invalidatePreview()
              }}
              className="w-full rounded-md border px-3 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Created before</span>
            <input
              type="date"
              value={createdBefore}
              onChange={(e) => {
                setCreatedBefore(e.target.value)
                invalidatePreview()
              }}
              className="w-full rounded-md border px-3 py-1.5 text-sm"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeManagers}
            onChange={(e) => {
              setIncludeManagers(e.target.checked)
              invalidatePreview()
            }}
          />
          Also send to managers
          <span className="text-xs text-muted-foreground">
            (owners always receive it — the DPA names the account owner)
          </span>
        </label>

        {audienceProblem && <p className="text-xs text-red-600">{audienceProblem}</p>}
      </fieldset>

      {preview && (
        <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-2">
          <p className="font-medium">
            {preview.recipientCount} recipient(s) across {preview.teamCount} studio(s)
          </p>
          {preview.overLimit && (
            <p className="text-red-600">
              Over the {preview.limit} limit — narrow the audience.
            </p>
          )}
          {preview.unreachable.length > 0 && (
            <p className="text-amber-700">
              {preview.unreachable.length} studio(s) have no reachable address and will NOT be
              notified: {preview.unreachable.map((u) => u.teamName).join(', ')}
            </p>
          )}
          {preview.sample.length > 0 && (
            <ul className="text-xs text-muted-foreground">
              {preview.sample.map((s) => (
                <li key={s.teamId}>
                  {s.teamName} — {s.emails.join(', ') || 'none'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {sent && (
        <p className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Sent to {sent.sent} recipient(s) across {sent.teamCount} studio(s)
          {sent.skipped > 0 && `, ${sent.skipped} skipped`}
          {sent.failed > 0 && `, ${sent.failed} failed`}. Recorded as {sent.noticeId}.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={runPreview}
          disabled={busy || !!audienceProblem}
          className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Preview audience'}
        </button>
        <button
          type="button"
          onClick={send}
          disabled={busy || !canSend}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Send notice
        </button>
      </div>
    </section>
  )
}
