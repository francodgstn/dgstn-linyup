'use client'

// One write-only Secret Manager field: a masked input, a save button, and a
// configured/not-configured badge. The stored value is NEVER echoed back — the
// page only ever learns whether *something* is set, so an operator can replace a
// secret but never read one out of the console.
//
// Extracted from the Brevo form so the Stripe settings page uses the identical
// control: the clear-on-save behavior and the "write-only" promise are security
// properties, and two copies would eventually disagree about them.

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

export interface SaveSecretResult {
  ok: boolean
  error?: string
  /** Set when the value could not be stored because Secret Manager is
   *  unavailable (emulators) — the save was a no-op, not a failure. */
  warning?: string
}

export function ConfiguredBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <Badge variant="success">Configured</Badge>
  ) : (
    <Badge variant="warning">Not configured</Badge>
  )
}

export function SecretField({
  label,
  name,
  configured,
  hint,
  buttonLabel,
  action,
}: {
  label: string
  name: string
  configured: boolean
  hint: string
  buttonLabel: string
  action: (formData: FormData) => Promise<SaveSecretResult>
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SaveSecretResult | null>(null)

  function onSubmit(formData: FormData) {
    setResult(null)
    startTransition(async () => {
      const r = await action(formData)
      setResult(r)
      // Clear the field on a clean save so the secret is not left in the DOM.
      if (r.ok && !r.warning) {
        const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)
        if (input) input.value = ''
      }
    })
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <ConfiguredBadge configured={configured} />
      </div>

      <div className="flex items-start gap-3">
        <Input
          name={name}
          type="password"
          autoComplete="new-password"
          placeholder={configured ? '•••••••• (set — enter a value to replace)' : 'Enter value'}
          className="flex-1"
        />
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : buttonLabel}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{hint}</p>

      {result?.ok && !result.warning && <p className="text-sm text-[var(--success)]">Saved.</p>}
      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
      {result?.ok && result.warning && (
        <p className="text-sm text-[var(--warning)]">Not saved: {result.warning}</p>
      )}
    </form>
  )
}
