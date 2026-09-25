'use client'

// Bulk "set custom field" dialog used by the contacts list bulk bar. Mirrors
// BulkSetRankDialog: pick WHICH field (when there's more than one), then a
// value for it, then apply to every selected contact. The write itself
// (contacts/page.tsx's `bulkSetCustomField`) uses the same
// `custom_fields.{id}` dotted-path `updateDoc` the single-contact form's
// whole-object write and the book-form patch (`buildContactFieldPatch`) both
// key by — see CLAUDE.md "Book-form fields".

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CustomFieldDefinition } from '@linyup/shared'
import { CustomFieldValueInput, type CustomFieldValue } from './CustomFieldInput'

export function BulkSetCustomFieldDialog({
  open, onOpenChange, definitions, count, onConfirm,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  definitions: CustomFieldDefinition[]; count: number
  /** `value === null` means "clear this field" (deleteField), not "leave alone" —
   *  the dialog is never invoked for a field nobody touched. */
  onConfirm: (fieldId: string, value: CustomFieldValue | null) => Promise<void>
}) {
  const t = useTranslations('Contacts')
  const [fieldId, setFieldId] = useState(definitions[0]?.id ?? '')
  // Tri-state, same shape as BulkSetRankDialog's `level`: untouched (nothing to
  // apply yet) vs. touched-with-a-value vs. touched-and-cleared. Apply stays
  // disabled until the admin has made an explicit choice for THIS field.
  const [touched, setTouched] = useState(false)
  const [value, setValue] = useState<CustomFieldValue | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setFieldId(definitions[0]?.id ?? '')
      setTouched(false)
      setValue(undefined)
    }
  }, [open, definitions])

  const def = definitions.find((d) => d.id === fieldId)

  const selectField = (id: string) => {
    setFieldId(id)
    setTouched(false)
    setValue(undefined)
  }

  // An empty string from the text widget means "no answer" everywhere else in
  // this codebase (CustomFieldsCardBody.setField, buildContactFieldPatch) — so
  // it normalizes to `undefined` here too, which this dialog treats as "clear".
  const handleChange = (v: CustomFieldValue | undefined) => {
    setTouched(true)
    setValue(v === '' ? undefined : v)
  }

  const clearValue = () => {
    setTouched(true)
    setValue(undefined)
  }

  const handleConfirm = async () => {
    if (!def || !touched) return
    setBusy(true)
    try {
      await onConfirm(def.id, value === undefined ? null : value)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{t('bulkSetCustomFieldTitle')}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          {definitions.length > 1 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('bulkCustomFieldPicker')}
              </p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {definitions.map((d) => (
                  <button key={d.id} type="button"
                    onClick={() => selectField(d.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                      fieldId === d.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {def && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {def.label}
              </label>
              <CustomFieldValueInput def={def} value={value} onChange={handleChange} />
              <button
                type="button"
                onClick={clearValue}
                className={`text-xs transition-colors ${
                  touched && value === undefined
                    ? 'text-destructive font-medium'
                    : 'text-muted-foreground hover:text-destructive'
                }`}
              >
                {t('bulkClearCustomField')}
              </button>
            </div>
          )}
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)} className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">{t('cancel')}</button>
          <button onClick={handleConfirm} disabled={busy || !def || !touched}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {t('bulkApplyTo', { count })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
