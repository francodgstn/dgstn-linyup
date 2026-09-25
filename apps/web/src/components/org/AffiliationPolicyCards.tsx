'use client'

/**
 * WHAT AN AFFILIATION IS CALLED, AND WHETHER A STUDIO MAY OVERRIDE IT.
 *
 * The organization's affiliation POLICY, as opposed to its vocabulary (the
 * statuses and types, next door in `AffiliationVocabularyCards`). Both are
 * mounted by `org/{orgId}/affiliation-settings`.
 *
 * Moved out of the org settings page, where they sat several screens below the
 * organization's name and language — the same diagnosis that moved the
 * vocabulary cards off it in 2026-08-28, applied to the two that were left
 * behind. Nothing about them changed in the move: same queries, same fields,
 * same `isAdmin` gate, which each applies for itself.
 */

import { useState, useEffect } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { doc, updateDoc, deleteField } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ChevronDown, Languages, Lock } from 'lucide-react'
import { ORGANIZATIONS_COLLECTION } from '@linyup/shared'
import type { Organization } from '@linyup/shared'

/** The four locales an affiliation term can be written in. */
const LOCALES: { key: 'en' | 'de' | 'fr' | 'it'; flag: string; label: string }[] = [
  { key: 'en', flag: '🇬🇧', label: 'EN' },
  { key: 'de', flag: '🇩🇪', label: 'DE' },
  { key: 'fr', flag: '🇫🇷', label: 'FR' },
  { key: 'it', flag: '🇮🇹', label: 'IT' },
]

// Common, fully translated affiliation terms offered as one-click presets. The
// dropdown shows each in the admin's own language; picking one stores all four.
type TermPresetKey = 'membership' | 'affiliation' | 'license' | 'subscription' | 'pass'
const AFFILIATION_TERM_PRESETS: Record<TermPresetKey, Record<'en' | 'de' | 'fr' | 'it', string>> = {
  membership: { en: 'Membership', de: 'Mitgliedschaft', fr: 'Adhésion', it: 'Iscrizione' },
  affiliation: { en: 'Affiliation', de: 'Zugehörigkeit', fr: 'Affiliation', it: 'Affiliazione' },
  license: { en: 'License', de: 'Lizenz', fr: 'Licence', it: 'Licenza' },
  subscription: { en: 'Subscription', de: 'Abonnement', fr: 'Abonnement', it: 'Abbonamento' },
  pass: { en: 'Pass', de: 'Pass', fr: 'Pass', it: 'Pass' },
}
const TERM_PRESET_KEYS: TermPresetKey[] = ['membership', 'affiliation', 'license', 'subscription', 'pass']

// Does a saved term map exactly equal one of the presets? (so editing re-selects it)
function detectTermPreset(m: Partial<Record<string, string>>): TermPresetKey | null {
  for (const k of TERM_PRESET_KEYS) {
    const dict = AFFILIATION_TERM_PRESETS[k]
    if (LOCALES.every(({ key }) => (m[key] ?? '') === dict[key])) return k
  }
  return null
}

export function TerminologyCard({
  orgId,
  org,
  isAdmin,
  onSaved,
}: {
  orgId: string
  org: Organization | null
  isAdmin: boolean
  onSaved: (msg: string) => void
}) {
  const t = useTranslations('OrgSettings')
  const locale = useLocale()
  const qc = useQueryClient()

  // '' = default (cleared), a preset key, or 'custom'.
  const [preset, setPreset] = useState<TermPresetKey | 'custom' | ''>('')
  const [def, setDef] = useState('') // custom default term (used for every language)
  const [translations, setTranslations] = useState<Partial<Record<'en' | 'de' | 'fr' | 'it', string>>>({})
  const [showTranslations, setShowTranslations] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const m = org?.affiliation_term ?? {}
    const detected = detectTermPreset(m)
    if (detected) {
      setPreset(detected)
      setDef('')
      setTranslations({})
      setShowTranslations(false)
    } else if (Object.keys(m).length > 0) {
      const d = m.en ?? Object.values(m).find((v) => v && v.trim()) ?? ''
      const overrides: Partial<Record<'en' | 'de' | 'fr' | 'it', string>> = {}
      for (const { key } of LOCALES) if (m[key] && m[key] !== d) overrides[key] = m[key]!
      setPreset('custom')
      setDef(d)
      setTranslations(overrides)
      setShowTranslations(Object.keys(overrides).length > 0)
    } else {
      setPreset('')
      setDef('')
      setTranslations({})
      setShowTranslations(false)
    }
  }, [org])

  const isCustom = preset === 'custom'
  const presetLabel = (k: TermPresetKey) =>
    AFFILIATION_TERM_PRESETS[k][locale as 'en'] ?? AFFILIATION_TERM_PRESETS[k].en

  function onPresetChange(p: TermPresetKey | 'custom' | '') {
    setPreset(p)
    if (p === 'custom') {
      // Seed the default with the current resolved term so the user can tweak it.
      if (!def.trim()) {
        const current = LOCALES.map(({ key }) => org?.affiliation_term?.[key]).find((v) => v && v.trim())
        setDef(current ?? '')
      }
    } else {
      setTranslations({})
      setShowTranslations(false)
    }
  }

  function updateTranslation(loc: 'en' | 'de' | 'fr' | 'it', value: string) {
    setTranslations((prev) => ({ ...prev, [loc]: value }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      let value: Partial<Record<string, string>> | ReturnType<typeof deleteField>
      if (preset === '') {
        value = deleteField()
      } else if (preset !== 'custom') {
        value = { ...AFFILIATION_TERM_PRESETS[preset] }
      } else {
        const d = def.trim()
        if (!d) {
          setSaving(false)
          return
        }
        // Every language gets its override or the default — so one term is enough.
        const map: Partial<Record<string, string>> = {}
        for (const { key } of LOCALES) map[key] = translations[key]?.trim() || d
        value = map
      }
      await updateDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId), { affiliation_term: value })
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      qc.invalidateQueries({ queryKey: ['org-membership-term'] })
      onSaved(t('terminologySaveSuccess'))
    } catch {
      onSaved(t('terminologySaveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Languages className="h-4 w-4" />
          {t('terminologyTitle')}
        </CardTitle>
        <CardDescription>{t('terminologyDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>{t('terminologyTermLabel')}</Label>
          <Select
            value={preset}
            onValueChange={(v) => onPresetChange(v as TermPresetKey | 'custom' | '')}
            disabled={!isAdmin}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('terminologyPresetDefault')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('terminologyPresetDefault')}</SelectItem>
              {TERM_PRESET_KEYS.map((k) => (
                <SelectItem key={k} value={k}>{presetLabel(k)}</SelectItem>
              ))}
              <SelectItem value="custom">{t('terminologyPresetCustom')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isCustom && (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label>{t('terminologyDefaultLabel')}</Label>
              <Input
                value={def}
                onChange={(e) => setDef(e.target.value)}
                placeholder="Affiliation"
                maxLength={30}
                disabled={!isAdmin}
              />
              <p className="text-xs text-muted-foreground">{t('terminologyDefaultHint')}</p>
            </div>
            <button
              type="button"
              onClick={() => setShowTranslations((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showTranslations ? '' : '-rotate-90'}`} />
              {t('terminologyAddTranslations')}
            </button>
            {showTranslations && (
              <div className="space-y-2 rounded-lg border p-3">
                {LOCALES.map(({ key, flag, label }) => (
                  <div key={key} className="grid grid-cols-[3rem_1fr] items-center gap-2">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <span>{flag}</span>
                      <span>{label}</span>
                    </span>
                    <Input
                      value={translations[key] ?? ''}
                      onChange={(e) => updateTranslation(key, e.target.value)}
                      placeholder={def || 'Affiliation'}
                      maxLength={30}
                      disabled={!isAdmin}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">{t('affiliationTermHint')}</p>
        {isAdmin && (
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? '…' : t('saveButton')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ─── membership lock card ─────────────────────────────────────────────────────

export function MembershipLockCard({
  orgId,
  org,
  isAdmin,
  onSaved,
}: {
  orgId: string
  org: Organization | null
  isAdmin: boolean
  onSaved: (msg: string, type?: 'success' | 'error') => void
}) {
  const t = useTranslations('OrgSettings')
  const qc = useQueryClient()
  const [saving, setSaving] = useState(false)
  const locked = org?.lock_affiliation ?? false

  async function handleToggle(next: boolean) {
    setSaving(true)
    try {
      await updateDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId), { lock_affiliation: next })
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      onSaved(t('lockAffiliationSaved'))
    } catch {
      onSaved(t('lockAffiliationError'), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!isAdmin) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4" />
          {t('lockAffiliationTitle')}
        </CardTitle>
        <CardDescription>{t('lockAffiliationDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {locked ? t('lockAffiliationEnabled') : t('lockAffiliationDisabled')}
          </p>
          <Switch
            checked={locked}
            onCheckedChange={handleToggle}
            disabled={saving}
            aria-label={t('lockAffiliationTitle')}
          />
        </div>
      </CardContent>
    </Card>
  )
}


// ─── org social links card ────────────────────────────────────────────────────
