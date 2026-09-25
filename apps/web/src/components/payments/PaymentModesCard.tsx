'use client'

// Settings → Payments: manage the studio's MANUAL payment modes (Cash / Bank
// transfer / TWINT / …). Owner-only. The list feeds the Record-payment dialog;
// until customized, a sensible default set is shown (and used) as a hint.
//
// Renders BARE (no card chrome) — the page wraps it in its own Card, first of
// the two under "Payments you take outside Linyup".

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, updateDoc } from 'firebase/firestore'
import { Plus, X } from 'lucide-react'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, DEFAULT_PAYMENT_MODES } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const MAX_MODE_LEN = 60

export function PaymentModesCard({
  teamId,
  current,
  canEdit,
}: {
  teamId: string
  current: string[] | undefined
  canEdit: boolean
}) {
  const t = useTranslations('TeamSettings')
  const modes = current ?? []
  const configured = modes.length > 0
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)

  async function write(next: string[]) {
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { payment_modes: next })
    } finally {
      setSaving(false)
    }
  }

  async function add() {
    const v = input.trim().slice(0, MAX_MODE_LEN)
    if (!v) return
    if (modes.some((m) => m.toLowerCase() === v.toLowerCase())) {
      setInput('')
      return
    }
    await write([...modes, v])
    setInput('')
  }

  return (
    // BARE — the host row owns the label and the hint. Each add and remove
    // writes at once: this is a list of chips, not a form, so it is not part of
    // the page's save bar.
    <div className="space-y-3">

      <div className="flex flex-wrap gap-1.5">
        {(configured ? modes : DEFAULT_PAYMENT_MODES).map((m) => (
          <span
            key={m}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
              configured ? '' : 'border-dashed text-muted-foreground'
            }`}
          >
            {m}
            {canEdit && configured && (
              <button
                type="button"
                onClick={() => write(modes.filter((x) => x !== m))}
                className="text-muted-foreground hover:text-destructive"
                disabled={saving}
                aria-label={`Remove ${m}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <div className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder={t('paymentModePlaceholder')}
            className="max-w-xs"
          />
          <Button size="sm" variant="outline" onClick={add} disabled={saving || !input.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            {t('paymentModeAdd')}
          </Button>
        </div>
      )}
    </div>
  )
}
