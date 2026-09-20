'use client'

import type { Route } from 'next'
import { ListPlus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { CustomFieldDefinition } from '@linyup/shared'
import { CustomFieldValueInput, type CustomFieldValue } from './CustomFieldInput'

export interface CustomFieldsCardBodyProps {
  /** Whether the custom-fields plugin is installed for the current team. */
  installed: boolean
  /** Account-wide field definitions (from Team.custom_field_definitions). */
  definitions: CustomFieldDefinition[]
  /** Current per-contact values (Contact.custom_fields), keyed by definition id. */
  value: Record<string, CustomFieldValue>
  onChange: (next: Record<string, CustomFieldValue>) => void
}

/**
 * Body of the "Custom Fields" card on the contact form. Renders one of three
 * states: an activation upsell when the plugin isn't installed, a setup prompt
 * when installed but no fields are defined yet, or the editable inputs. Mirrors
 * the Ranks card's empty-state pattern.
 */
export function CustomFieldsCardBody({
  installed,
  definitions,
  value,
  onChange,
}: CustomFieldsCardBodyProps) {
  const t = useTranslations('Contacts')

  // ── Not installed → activation upsell (shown to all plans) ──
  if (!installed) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <ListPlus className="h-6 w-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t('customFieldsActivatePrompt')}</p>
        <Link
          href="/plugins"
          className="text-sm text-primary hover:underline underline-offset-2"
        >
          {t('customFieldsActivateLink')}
        </Link>
      </div>
    )
  }

  // ── Installed but no definitions → setup prompt (link to settings tab) ──
  if (definitions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <ListPlus className="h-6 w-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t('customFieldsNoFieldsPrompt')}</p>
        <Link
          href={'/settings/team?tab=custom-fields' as Route}
          className="text-sm text-primary hover:underline underline-offset-2"
        >
          {t('customFieldsConfigureLink')}
        </Link>
      </div>
    )
  }

  const setField = (id: string, v: CustomFieldValue | undefined) => {
    const next = { ...value }
    if (v === undefined || v === '') {
      delete next[id]
    } else {
      next[id] = v
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {definitions.map((def) => (
        <div key={def.id} className="space-y-1">
          <label className="text-sm font-medium">
            {def.label}
            {def.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <CustomFieldValueInput
            def={def}
            value={value[def.id]}
            onChange={(v) => setField(def.id, v)}
          />
        </div>
      ))}
    </div>
  )
}
