'use client'

// The editable controls for ONE ranking level, shared by both ranking editors.
//
// There are two — the organisation's (`org/[orgId]/ranking`) and the team's
// (`settings/team`) — and they had already diverged: only one of them assigns a
// new level a value that cannot collide with an existing one. Adding four more
// visual fields to each separately would have doubled that. One component, used
// twice.
//
// A club identifies a level the way its sport does, so all four ways sit here
// together: a colour, a second colour for a split belt, an emoji (a swim
// school's sea animal), or the club's own uploaded artwork. Precedence when more
// than one is set is decided by `rankLevelBadge` in @linyup/shared, never here.
//
// ORDER IS THE ROW'S PLACE IN THE LIST (docs/rank-scale-decoupling.md, Phase
// 5): the host renders the rows inside a SortableList and hands each one its
// drag `handle`; "insert a level below" splices a fresh one in at that place.
// Neither moves anything a contact holds — a level is named by its id, and the
// ladder's array order is the order.

import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ColorPicker } from '@/components/ui/color-picker'
import { RankBadge } from '@/components/ranking/RankBadge'
import { Trash2, ImagePlus, Loader2, X, Plus } from 'lucide-react'
import type { RankLevel } from '@linyup/shared'

/** Badge artwork is small by design — the Storage rule caps it at 2 MB. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export function RankLevelFields({
  level,
  index,
  storagePath,
  canRemove,
  onChange,
  onRemove,
  onInsertBelow,
  handle,
}: {
  level: RankLevel
  index: number
  /** Folder for uploaded artwork — `teams/{id}/ranking` or
   *  `organizations/{id}/ranking`, matching the two Storage rules. */
  storagePath: string
  canRemove: boolean
  onChange: (field: keyof RankLevel, value: string | number | undefined) => void
  onRemove: () => void
  /** Splice a new level in right after this one. */
  onInsertBelow?: () => void
  /** The drag handle the host's SortableItem renders — first thing in the row. */
  handle?: ReactNode
}) {
  const t = useTranslations('Ranking')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const split = level.secondColor != null

  async function handleFile(file: File | undefined) {
    if (!file) return
    setError(null)
    if (file.size > MAX_IMAGE_BYTES) {
      // Refused here as well as by the Storage rule, so the studio is told why
      // rather than watching an upload fail.
      setError(t('imageTooLarge'))
      return
    }
    setUploading(true)
    try {
      const ext = file.name.split('.').pop() ?? 'png'
      // Named by the level's IDENTITY, so a reorder or an insert never repoints
      // a badge at a different grade. An existing image keeps its stored URL.
      const sRef = storageRef(storage, `${storagePath}/level-${level.id}.${ext}`)
      await uploadBytes(sRef, file)
      onChange('imageUrl', await getDownloadURL(sRef))
    } catch (err) {
      console.error('[RankLevelFields] upload failed:', err)
      setError(t('imageUploadFailed'))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-1.5 rounded-md border bg-background p-2">
      <div className="flex items-center gap-2">
        {handle}
        {/* Live preview — the same component every read-only surface uses, so
            what the studio picks here is exactly what a member will see. */}
        <RankBadge level={level} size="md" />

        <Input
          value={level.label}
          onChange={(e) => onChange('label', e.target.value)}
          placeholder={t('levelPlaceholder', { number: index })}
          className="flex-1"
          required
        />

        {onInsertBelow && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onInsertBelow}
            aria-label={t('insertLevelBelow')}
            title={t('insertLevelBelow')}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
        {canRemove && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label={t('removeLevel')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-8">
        <ColorPicker
          value={level.color ?? '#6b7280'}
          onChange={(hex) => onChange('color', hex)}
          className="h-7 w-7"
        />

        {split ? (
          <>
            <ColorPicker
              value={level.secondColor ?? '#6b7280'}
              onChange={(hex) => onChange('secondColor', hex)}
              className="h-7 w-7"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => onChange('secondColor', undefined)}
            >
              {t('splitOff')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onChange('secondColor', level.color ?? '#6b7280')}
          >
            {t('splitOn')}
          </Button>
        )}

        {/* One emoji. Not an icon NAME: this product renders lucide on the web
            and MaterialCommunityIcons in the member app, so a name valid in one
            is not necessarily valid in the other. An emoji is text. */}
        <Input
          value={level.emoji ?? ''}
          onChange={(e) => onChange('emoji', e.target.value.slice(0, 4) || undefined)}
          placeholder={t('emojiPlaceholder')}
          aria-label={t('emojiLabel')}
          className="h-7 w-14 text-center"
        />

        {level.imageUrl ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onChange('imageUrl', undefined)}
          >
            <X className="mr-1 h-3 w-3" />
            {t('imageRemove')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <ImagePlus className="mr-1 h-3 w-3" />
            )}
            {t('imageAdd')}
          </Button>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      {error && <p className="pl-8 text-xs text-destructive">{error}</p>}
    </div>
  )
}
