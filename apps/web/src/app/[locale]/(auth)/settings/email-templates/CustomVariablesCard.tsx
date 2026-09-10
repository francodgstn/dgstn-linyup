'use client'

// The studio's own `{{placeholders}}`, editable as key/value rows.
//
// It sits HERE, above the template list, and not on Settings → Emails where it
// used to live: these variables exist to be typed into a template, so the thing
// they belong to is the templates, not the sender. Reading the page top to
// bottom now goes "what you can write" → "where you write it". Moved 2026-09-08.
//
// Copy stays in the `EmailSettings` namespace — the keys are unchanged and
// renaming them would be churn in four locale files for no reader's benefit.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, updateDoc } from 'firebase/firestore'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, type Team } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/** A placeholder name has to be a bare identifier — it is substituted, not parsed. */
const KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function CustomVariablesCard({ teamId, team }: { teamId: string; team: Team }) {
  const t = useTranslations('EmailSettings')
  const qc = useQueryClient()

  type VarRow = { key: string; value: string }
  const [vars, setVars] = useState<VarRow[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (team?.outreach_placeholders) {
      setVars(
        Object.entries(team.outreach_placeholders).map(([key, value]) => ({
          key,
          value: value as string,
        }))
      )
    }
  }, [team?.outreach_placeholders])

  const addRow = () => setVars((prev) => [...prev, { key: '', value: '' }])

  const removeRow = (idx: number) => setVars((prev) => prev.filter((_, i) => i !== idx))

  const updateRow = (idx: number, field: 'key' | 'value', val: string) =>
    setVars((prev) => prev.map((row, i) => (i === idx ? { ...row, [field]: val } : row)))

  const onSave = async () => {
    setSaveError('')
    const invalid = vars.filter((v) => v.key && !KEY_REGEX.test(v.key))
    if (invalid.length > 0) {
      setSaveError(t('customVariablesInvalidKeys', { keys: invalid.map((v) => v.key).join(', ') }))
      return
    }
    const payload = Object.fromEntries(
      vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value])
    )
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { outreach_placeholders: payload })
      await qc.invalidateQueries({ queryKey: ['team', teamId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-6 space-y-5">
        <div>
          <h3 className="font-semibold text-sm">{t('customVariablesTitle')}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t.rich('customVariablesDescription', {
              code: (chunks) => (
                <code className="font-mono text-xs bg-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
        </div>

        <div className="space-y-2">
          {vars.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div className="flex items-center border rounded-md overflow-hidden flex-1">
                <span className="px-2 py-2 text-xs text-muted-foreground bg-muted border-r select-none font-mono">
                  {'{{'}
                </span>
                <input
                  value={row.key}
                  onChange={(e) => updateRow(idx, 'key', e.target.value)}
                  placeholder="variableName"
                  className="flex-1 px-2 py-2 text-sm font-mono outline-none bg-background"
                />
                <span className="px-2 py-2 text-xs text-muted-foreground bg-muted border-l select-none font-mono">
                  {'}}'}
                </span>
              </div>
              <input
                value={row.value}
                onChange={(e) => updateRow(idx, 'value', e.target.value)}
                placeholder={t('customVariablesValuePlaceholder')}
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => removeRow(idx)}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1.5" />
          {t('customVariablesAddButton')}
        </Button>

        {saveError && <p className="text-xs text-destructive">{saveError}</p>}

        <div className="flex items-center justify-end gap-3">
          {saved && !saving && (
            <span className="text-xs text-muted-foreground">{t('customVariablesSaved')}</span>
          )}
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t('customVariablesSaving') : t('customVariablesSaveButton')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
