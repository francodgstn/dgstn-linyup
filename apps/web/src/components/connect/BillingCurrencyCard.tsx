'use client'

// The studio's billing currency lives in Settings → Payments (it applies to every
// payment surface — subscriptions, products, courses, shop — not just one page).
// Extracted from the Subscriptions panel so the setter has a single home.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { collection, doc, getDocs, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, TEAM_INTEGRATIONS_SUBCOLLECTION } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Currency configured on any enabled payment gateway — pre-fills the billing
 *  currency when the team hasn't set one yet. */
export function useGatewayCurrency(teamId: string | null) {
  return useQuery<string | null>({
    queryKey: ['gateway-currency', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDocs(collection(db, TEAMS_COLLECTION, teamId, TEAM_INTEGRATIONS_SUBCOLLECTION))
      for (const d of snap.docs) {
        const data = d.data() as { type?: string; enabled?: boolean; config?: { currency?: string } }
        if (data.type === 'payment_gateway' && data.enabled && data.config?.currency) {
          return data.config.currency
        }
      }
      return null
    },
  })
}

export function BillingCurrencyCard({
  teamId,
  current,
  gatewayCurrency,
  canEdit,
}: {
  teamId: string
  current: string | undefined
  gatewayCurrency: string | null | undefined
  canEdit: boolean
}) {
  const t = useTranslations('TeamSettings')
  const resolved = (current ?? gatewayCurrency ?? DEFAULT_CURRENCY).toUpperCase()
  const [value, setValue] = useState(resolved)
  const [saving, setSaving] = useState(false)

  // Keep the selection in sync once the team doc / gateway currency loads. A stored
  // value outside the supported subset (legacy free-text entry) still shows as its
  // own option so it's never silently dropped.
  useEffect(() => {
    setValue(resolved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, gatewayCurrency])

  const dirty = value.toUpperCase() !== resolved
  const options = SUPPORTED_CURRENCIES.some((c) => c.code === resolved)
    ? SUPPORTED_CURRENCIES
    : [{ code: resolved, name: resolved, symbol: resolved }, ...SUPPORTED_CURRENCIES]

  async function save() {
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { default_currency: value.toUpperCase() })
    } finally {
      setSaving(false)
    }
  }

  return (
    // A CARD, like every other block on this tab. It was a bare bordered box
    // beside two real cards, which read as a different KIND of thing — a note
    // about the cards rather than a setting of its own.
    <Card>
      <CardContent className="pt-6 space-y-3">
      <div>
        <Label>{t('billingCurrency')}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{t('billingCurrencyDesc')}</p>
      </div>
      <div className="flex items-end gap-3">
        <Select value={value} onValueChange={(v) => v && setValue(v)} disabled={!canEdit}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((c) => (
              <SelectItem key={c.code} value={c.code} label={c.code}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canEdit && dirty && (
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        )}
      </div>
      </CardContent>
    </Card>
  )
}
