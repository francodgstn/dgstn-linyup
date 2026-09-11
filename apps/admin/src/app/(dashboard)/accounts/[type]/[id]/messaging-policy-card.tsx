'use client'

// Operator editor for a tenant's outbound-messaging policy. The policy decides
// whether the mail/SMS services deliver, filter (allowlist), redirect, or drop
// this tenant's messages — see packages/functions/src/mail/README.md
// ("Per-tenant delivery policy"). Writes go through the server actions (Admin
// SDK); Firestore rules deny all client access by design.

import { useState, useTransition } from 'react'
import type { MessagingMode } from '@linyup/shared'
import type { MessagingEnvStatus, SerializablePolicy } from '@/lib/queries/messaging'
import { Badge } from '@/components/ui/badge'
import {
  setMessagingPolicy,
  deleteMessagingPolicy,
  type MessagingPolicyInput,
} from './actions'

// Environment layer (kill switches + TEST_MODE) — sits ABOVE the tenant policy.
// Rendered ONLY when the environment overrides delivery (the policy view would
// otherwise lie); in normal operation the card stays uncluttered. A light
// divider separates the warning from the policy content below.
function EnvStatusBanner({ env }: { env: MessagingEnvStatus | null }) {
  if (!env || (env.mailEnabled && !env.testMode)) return null
  return (
    <>
      {!env.mailEnabled ? (
        <p className="rounded-md bg-red-100 px-2.5 py-1.5 text-xs font-medium text-red-800">
          MAIL_ENABLED=false — the environment kill switch is OFF. Nothing sends,
          regardless of this policy.
        </p>
      ) : (
        <p className="rounded-md bg-amber-100 px-2.5 py-1.5 text-xs font-medium text-amber-800">
          TEST_MODE is ON — ALL mail/SMS in this environment redirects to{' '}
          <code>{env.testEmail ?? '(unset → dropped)'}</code>. Tenant policies are bypassed.
        </p>
      )}
      <div className="border-t border-border/60" />
    </>
  )
}

const MODE_META: Record<MessagingMode, { label: string; badge: string; hint: string }> = {
  live: {
    label: 'Live',
    badge: 'bg-emerald-100 text-emerald-800',
    hint: 'Deliver normally to every recipient.',
  },
  allowlist: {
    label: 'Allowlist',
    badge: 'bg-amber-100 text-amber-800',
    hint: 'Deliver ONLY to the listed addresses/phones; everything else is dropped.',
  },
  redirect: {
    label: 'Redirect',
    badge: 'bg-sky-100 text-sky-800',
    hint: 'Every message is delivered to the redirect target instead of its recipient.',
  },
  silent: {
    label: 'Silent',
    badge: 'bg-zinc-200 text-zinc-700',
    hint: 'Drop everything — no outbound messaging for this tenant.',
  },
}

export function MessagingPolicyCard({
  entityId,
  initialPolicy,
  env,
}: {
  entityId: string
  initialPolicy: SerializablePolicy | null
  env: MessagingEnvStatus | null
}) {
  const isTryTenant = entityId.startsWith('sandbox-')
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SerializablePolicy | null>(initialPolicy)

  // Draft state (only meaningful while editing).
  const [mode, setMode] = useState<MessagingMode>(saved?.mode ?? 'allowlist')
  const [allowEmails, setAllowEmails] = useState((saved?.allowEmails ?? []).join('\n'))
  const [allowPhones, setAllowPhones] = useState((saved?.allowPhones ?? []).join('\n'))
  const [redirectEmail, setRedirectEmail] = useState(saved?.redirectEmail ?? '')
  const [redirectPhone, setRedirectPhone] = useState(saved?.redirectPhone ?? '')
  const [ignoreTestMode, setIgnoreTestMode] = useState(saved?.ignoreTestMode === true)

  function beginEdit() {
    setMode(saved?.mode ?? 'allowlist')
    setAllowEmails((saved?.allowEmails ?? []).join('\n'))
    setAllowPhones((saved?.allowPhones ?? []).join('\n'))
    setRedirectEmail(saved?.redirectEmail ?? '')
    setRedirectPhone(saved?.redirectPhone ?? '')
    setIgnoreTestMode(saved?.ignoreTestMode === true)
    setError(null)
    setEditing(true)
  }

  function save() {
    if (
      mode === 'live' &&
      saved?.mode !== 'live' &&
      !window.confirm(
        'Set LIVE delivery? Every outbound email/SMS from this tenant will reach its real recipient — including messages to seeded/synthetic contacts (only @example.com-style addresses stay blocked).',
      )
    ) {
      return
    }
    // A SECOND confirmation, because this one is not about who a message goes
    // to — it is about whether the ENVIRONMENT still catches it at all.
    if (
      ignoreTestMode &&
      saved?.ignoreTestMode !== true &&
      !window.confirm(
        'Exempt this tenant from TEST_MODE? Its own policy will decide delivery, exactly as in production — real people will receive what this tenant sends, in an environment where everything else is redirected.',
      )
    ) {
      return
    }
    const input: MessagingPolicyInput = {
      mode,
      allowEmails: allowEmails.split(/[\n,;]+/),
      allowPhones: allowPhones.split(/[\n,;]+/),
      redirectEmail,
      redirectPhone,
      ignoreTestMode,
    }
    setError(null)
    startTransition(async () => {
      const res = await setMessagingPolicy(entityId, input)
      if (!res.ok) {
        setError(res.error ?? 'Failed to save.')
        return
      }
      setSaved({
        entityId,
        mode,
        allowEmails: input.allowEmails.map((e) => e.trim().toLowerCase()).filter(Boolean),
        allowPhones: input.allowPhones.map((p) => p.replace(/[\s\-()]/g, '')).filter(Boolean),
        ...(redirectEmail ? { redirectEmail } : {}),
        ...(redirectPhone ? { redirectPhone } : {}),
        ...(ignoreTestMode ? { ignoreTestMode: true } : {}),
      })
      setEditing(false)
    })
  }

  function removePolicy() {
    if (
      !window.confirm(
        'Remove the policy? The environment default (MESSAGING_DEFAULT_MODE — silent on the sandbox, live in production) will apply to this tenant.',
      )
    ) {
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await deleteMessagingPolicy(entityId)
      if (!res.ok) {
        setError(res.error ?? 'Failed to remove.')
        return
      }
      setSaved(null)
      setEditing(false)
    })
  }

  const meta = saved ? MODE_META[saved.mode] : null

  return (
    <div className="flex flex-col gap-4">
      {/* ── Environment override warning (hidden in normal operation) ── */}
      <EnvStatusBanner env={env} />

      {/* ── Read view ── */}
      {!editing && (
        <>
          {saved && meta ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.badge}`}>
                  {meta.label}
                </span>
                <span className="text-xs text-muted-foreground">{meta.hint}</span>
              </div>
              {saved.mode === 'allowlist' && (
                <div className="flex flex-col gap-1.5">
                  {(saved.allowEmails ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {(saved.allowEmails ?? []).map((e) => (
                        <Badge key={e} variant="outline" className="font-mono text-xs font-normal">
                          {e}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {(saved.allowPhones ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {(saved.allowPhones ?? []).map((p) => (
                        <Badge key={p} variant="outline" className="font-mono text-xs font-normal">
                          📱 {p}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {(saved.allowEmails ?? []).length === 0 && (saved.allowPhones ?? []).length === 0 && (
                    <p className="text-xs text-destructive">
                      Empty allowlist — behaves like silent.
                    </p>
                  )}
                </div>
              )}
              {saved.mode === 'redirect' && (
                <p className="text-sm">
                  → <code className="text-xs">{saved.redirectEmail ?? '—'}</code>
                  {saved.redirectPhone && (
                    <>
                      {' · '}
                      <code className="text-xs">{saved.redirectPhone}</code>
                    </>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No policy — the environment default applies (
              <code className="text-xs">MESSAGING_DEFAULT_MODE</code>
              {env ? (
                <>
                  {' = '}
                  <code className="text-xs font-semibold">{env.defaultMode}</code>
                </>
              ) : (
                ': silent on the sandbox, live in production'
              )}
              ).
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={beginEdit}
              className="w-fit rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              {saved ? 'Edit policy' : 'Create policy'}
            </button>
            {saved && (
              <button
                type="button"
                onClick={removePolicy}
                disabled={pending}
                className="w-fit rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive"
              >
                Remove (use env default)
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Edit view ── */}
      {editing && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(MODE_META) as MessagingMode[]).map((m) => {
              const disabled = m === 'live' && isTryTenant
              return (
                <button
                  key={m}
                  type="button"
                  disabled={disabled}
                  title={disabled ? 'sandbox-* (/try) tenants cannot be set to live' : MODE_META[m].hint}
                  onClick={() => setMode(m)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    mode === m ? MODE_META[m].badge : 'bg-muted text-muted-foreground hover:bg-muted/70'
                  }`}
                >
                  {MODE_META[m].label}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">{MODE_META[mode].hint}</p>

          {mode === 'allowlist' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Allowed emails (one per line; @domain.tld allowed)
                <textarea
                  value={allowEmails}
                  onChange={(e) => setAllowEmails(e.target.value)}
                  rows={3}
                  className="rounded-md border bg-background p-2 font-mono text-xs"
                  placeholder={'hello@swimliclub.com\n@linyup.com'}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Allowed phones (E.164, one per line)
                <textarea
                  value={allowPhones}
                  onChange={(e) => setAllowPhones(e.target.value)}
                  rows={3}
                  className="rounded-md border bg-background p-2 font-mono text-xs"
                  placeholder="+41761234501"
                />
              </label>
            </div>
          )}

          {mode === 'redirect' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Redirect email
                <input
                  value={redirectEmail}
                  onChange={(e) => setRedirectEmail(e.target.value)}
                  className="rounded-md border bg-background p-2 font-mono text-xs"
                  placeholder="capture@linyup.com"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Redirect phone (E.164, optional)
                <input
                  value={redirectPhone}
                  onChange={(e) => setRedirectPhone(e.target.value)}
                  className="rounded-md border bg-background p-2 font-mono text-xs"
                  placeholder="+41790000000"
                />
              </label>
            </div>
          )}

          {/* THE ENVIRONMENT EXEMPTION — offered only while TEST_MODE is
              actually on, because everywhere else it is a switch with no
              observable effect, and a control that does nothing teaches people
              to ignore it. Sandbox tenants are refused server-side too. */}
          {env?.testMode && !entityId.startsWith('sandbox-') && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs dark:border-amber-900 dark:bg-amber-950/40">
              <input
                type="checkbox"
                checked={ignoreTestMode}
                onChange={(e) => setIgnoreTestMode(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Exempt this tenant from TEST_MODE</span>
                <span className="mt-0.5 block text-muted-foreground">
                  Its own policy above decides delivery, exactly as in production — so real
                  recipients are reached while everything else in this environment is redirected
                  to <code>{env.testEmail ?? '(unset)'}</code>. Synthetic and suppressed addresses
                  stay blocked.
                </span>
              </span>
            </label>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save policy'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Changes take effect within ~60s (send-time policy cache). Synthetic recipients
        (@example.com &amp; friends) are always blocked regardless of policy.
      </p>
    </div>
  )
}
