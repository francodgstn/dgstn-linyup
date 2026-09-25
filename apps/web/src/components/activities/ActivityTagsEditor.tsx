'use client'

// Editor for an activity's free-text display labels (`Activity.tags`) — the
// chips a visitor sees on the public booking card ("Beginner friendly", "Gi",
// "Kids").
//
// Free text, not a vocabulary: the enum this replaced (`level`) offered four
// words a studio mostly did not use, and every studio grades its classes in its
// own. Nothing enforces a tag anywhere — it is display, like `prerequisites`.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  MAX_ACTIVITY_TAGS,
  MAX_ACTIVITY_TAG_LENGTH,
  normalizeActivityTags,
} from '@linyup/shared'

export function ActivityTagsEditor({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const t = useTranslations('Activities')
  const [draft, setDraft] = useState('')
  const full = value.length >= MAX_ACTIVITY_TAGS

  // COMMITS THROUGH THE SHARED NORMALIZER, never straight onto the list: the
  // trim, the length cap, the case-insensitive dedupe and the count are the
  // public mirror's rules too, so a tag that would be dropped on the way out is
  // never shown here as accepted.
  function commit(text: string) {
    if (!text.trim()) {
      setDraft('')
      return
    }
    onChange(normalizeActivityTags([...value, ...text.split(',')]))
    setDraft('')
  }

  function remove(tag: string) {
    onChange(value.filter((v) => v !== tag))
  }

  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor="act-tags">{t('fieldTags')}</Label>
        <p id="act-tags-hint" className="text-xs text-muted-foreground">
          {t('tagsHint')}
        </p>
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
              <button
                type="button"
                onClick={() => remove(tag)}
                aria-label={t('tagRemove', { tag })}
                className="transition-colors hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {full && (
        <p className="text-xs text-muted-foreground">{t('tagsMax', { max: MAX_ACTIVITY_TAGS })}</p>
      )}

      {/* The box stays MOUNTED at the cap, disabled — swapping it for the cap
          message left the field's label pointing at a control that was no longer
          there, and a paste that overflows the cap is silently trimmed by the
          normalizer, so the message beside a still-visible box is the only place
          the studio learns why. Removing a chip re-enables it. */}
      <Input
        id="act-tags"
        disabled={full}
        aria-describedby="act-tags-hint"
        value={draft}
        // Bounded by what a WHOLE commit may carry, not by one tag: the draft
        // is split on commas, so capping it at a single tag's length silently
        // truncated a pasted list mid-word before the split ever ran. Each
        // tag is still cut to MAX_ACTIVITY_TAG_LENGTH by the normalizer, where
        // the studio can see the result in the chip.
        maxLength={MAX_ACTIVITY_TAGS * (MAX_ACTIVITY_TAG_LENGTH + 2)}
        onChange={(e) => setDraft(e.target.value)}
        // A comma finishes a tag as well as Enter, because a studio typing a
        // list types the commas. Enter must not reach the form — this control
        // lives inside the activity dialog, whose Enter submits it.
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit(draft)
            return
          }
          if (e.key === 'Backspace' && draft === '' && value.length) {
            e.preventDefault()
            remove(value[value.length - 1])
          }
        }}
        // Typed and then left alone still counts. Losing a half-committed tag
        // to a click elsewhere is the one failure the studio never sees.
        onBlur={() => commit(draft)}
        placeholder={t('tagsPlaceholder')}
        className="text-sm"
      />
    </div>
  )
}
