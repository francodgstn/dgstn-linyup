'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Trash2 } from 'lucide-react'
import { useResetOnOpen } from '@/hooks/useResetOnOpen'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { TimePicker } from '@/components/ui/date-picker'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { PROGRAM_ITEM_KINDS, sortedDays, sortedTracks } from '@linyup/shared'
import type {
  EventProgramConfig, EventProgramItem, ProgramItemKind,
} from '@linyup/shared'
import type { ProgramItemDraft } from './useProgram'

// Create / edit one program item. Free text throughout by design: an event is
// frequently off-site and staffed by people who are not team members, so
// location and people are plain strings rather than links to Places/Coaches.

const PLENARY = '__plenary__'
const NO_KIND = '__none__'

const schema = z.object({
  dayId: z.string().min(1),
  trackId: z.string(),
  allDay: z.boolean(),
  startTime: z.string(),
  endTime: z.string(),
  title: z.string().trim().min(1),
  subtitle: z.string(),
  description: z.string(),
  locationText: z.string(),
  peopleText: z.string(),
  kind: z.string(),
  internalNote: z.string(),
  isHighlight: z.boolean(),
})

type FormValues = z.infer<typeof schema>

export interface ProgramItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: EventProgramConfig
  /** The day to preselect when creating. */
  defaultDayId?: string
  /** Present when editing an existing item. */
  item?: EventProgramItem | null
  /** Order to assign to a newly created item (append at the end of its day). */
  /** Next free `order` for a given day. A FUNCTION, not a number: the Day picker
   *  lets the user file the item under a different day than the one on screen,
   *  and the answer must come from the day actually chosen. */
  nextOrderFor: (dayId: string) => number
  onSubmit: (draft: ProgramItemDraft) => Promise<void> | void
  onDelete?: () => Promise<void> | void
  saving?: boolean
  /** Label days "Day 1" rather than by date — see ProgramTimeline.hideDayDates. */
  hideDayDates?: boolean
}

export function ProgramItemDialog({
  open,
  onOpenChange,
  config,
  defaultDayId,
  item,
  nextOrderFor,
  onSubmit,
  onDelete,
  saving,
  hideDayDates,
}: ProgramItemDialogProps) {
  const t = useTranslations('EventProgram')

  // Sorted to match the agenda, and memoised so the reset effect below does not
  // see a fresh array identity on every render of the parent.
  const days = useMemo(() => sortedDays(config), [config])
  const tracks = useMemo(() => sortedTracks(config), [config])
  const firstDayId = days[0]?.id ?? ''

  const {
    register, handleSubmit, control, reset, watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      dayId: '', trackId: PLENARY, allDay: false, startTime: '09:00', endTime: '',
      title: '', subtitle: '', description: '', locationText: '', peopleText: '',
      kind: NO_KIND, internalNote: '', isHighlight: false,
    },
  })

  useResetOnOpen(open, () => {
    reset({
      dayId: item?.dayId ?? defaultDayId ?? firstDayId,
      trackId: item?.trackId ?? PLENARY,
      allDay: item?.allDay ?? false,
      startTime: item?.startTime ?? '09:00',
      endTime: item?.endTime ?? '',
      title: item?.title ?? '',
      subtitle: item?.subtitle ?? '',
      description: item?.description ?? '',
      locationText: item?.locationText ?? '',
      peopleText: item?.peopleText ?? '',
      kind: item?.kind ?? NO_KIND,
      internalNote: item?.internalNote ?? '',
      isHighlight: item?.isHighlight ?? false,
    })
  })

  const allDay = watch('allDay')

  async function submit(values: FormValues) {
    // Normalize empties to absent rather than writing empty strings, matching
    // how the event edit dialog nulls out unset optional fields.
    const draft: ProgramItemDraft = {
      dayId: values.dayId,
      trackId: values.trackId === PLENARY ? null : values.trackId,
      startTime: values.allDay ? '00:00' : values.startTime || '09:00',
      title: values.title.trim(),
      // A new item, or an existing one MOVED to another day, needs a fresh order
      // in its destination — keeping the old one can collide with an item already
      // there and make two items at the same time swap places unpredictably.
      order:
        item && item.dayId === values.dayId ? item.order : nextOrderFor(values.dayId),
      ...(values.allDay ? { allDay: true } : {}),
      ...(!values.allDay && values.endTime ? { endTime: values.endTime } : {}),
      ...(values.subtitle.trim() ? { subtitle: values.subtitle.trim() } : {}),
      ...(values.description.trim() ? { description: values.description.trim() } : {}),
      ...(values.locationText.trim() ? { locationText: values.locationText.trim() } : {}),
      ...(values.peopleText.trim() ? { peopleText: values.peopleText.trim() } : {}),
      ...(values.kind !== NO_KIND ? { kind: values.kind as ProgramItemKind } : {}),
      ...(values.internalNote.trim() ? { internalNote: values.internalNote.trim() } : {}),
      ...(values.isHighlight ? { isHighlight: true } : {}),
    }
    await onSubmit(draft)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? t('editItem') : t('newItem')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="program-day">{t('fieldDay')}</Label>
              <Controller
                name="dayId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="program-day">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {days.map((d, index) => (
                        // `label` (not children) carries the text: select.tsx can
                        // only derive a label from a plain STRING child, and this
                        // one is composed — without it the trigger falls back to
                        // printing the raw day id. Passing children as well would
                        // repeat the text as a muted second line, which is what
                        // that prop pair means here.
                        <SelectItem
                          key={d.id}
                          value={d.id}
                          label={
                            hideDayDates
                              ? d.title || t('dayN', { n: index + 1 })
                              : `${d.title || t('dayN', { n: index + 1 })} · ${d.date}`
                          }
                        />
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="program-track">{t('fieldTrack')}</Label>
              <Controller
                name="trackId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="program-track">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PLENARY}>{t('trackPlenary')}</SelectItem>
                      {tracks.map((tr) => (
                        <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="program-allday" className="text-sm font-normal">
              {t('fieldAllDay')}
            </Label>
            <Controller
              name="allDay"
              control={control}
              render={({ field }) => (
                <Switch id="program-allday" checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>

          {!allDay && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('fieldStart')}</Label>
                <Controller
                  name="startTime"
                  control={control}
                  render={({ field }) => (
                    <TimePicker value={field.value} onChange={field.onChange} className="w-full" />
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('fieldEnd')}</Label>
                <Controller
                  name="endTime"
                  control={control}
                  render={({ field }) => (
                    <TimePicker
                      value={field.value || undefined}
                      onChange={field.onChange}
                      placeholder={t('fieldEndOptional')}
                      className="w-full"
                    />
                  )}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="program-title">{t('fieldTitle')}</Label>
            <Input id="program-title" {...register('title')} placeholder={t('fieldTitlePlaceholder')} />
            {errors.title && <p className="text-xs text-destructive">{t('errorTitleRequired')}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="program-subtitle">{t('fieldSubtitle')}</Label>
            <Input id="program-subtitle" {...register('subtitle')} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="program-location">{t('fieldLocation')}</Label>
              <Input
                id="program-location"
                {...register('locationText')}
                placeholder={t('fieldLocationPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="program-people">{t('fieldPeople')}</Label>
              <Input
                id="program-people"
                {...register('peopleText')}
                placeholder={t('fieldPeoplePlaceholder')}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="program-kind">{t('fieldKind')}</Label>
            <Controller
              name="kind"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="program-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_KIND}>{t('kindNone')}</SelectItem>
                    {PROGRAM_ITEM_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>{t(`kind_${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="program-description">{t('fieldDescription')}</Label>
            <Textarea id="program-description" rows={3} {...register('description')} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="program-note">{t('fieldInternalNote')}</Label>
            <Textarea id="program-note" rows={2} {...register('internalNote')} />
            <p className="text-xs text-muted-foreground">{t('internalNoteHint')}</p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="program-highlight" className="text-sm font-normal">
              {t('fieldHighlight')}
            </Label>
            <Controller
              name="isHighlight"
              control={control}
              render={({ field }) => (
                <Switch id="program-highlight" checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {item && onDelete ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={onDelete}
                disabled={saving}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                {t('deleteItem')}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? t('saving') : t('save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
