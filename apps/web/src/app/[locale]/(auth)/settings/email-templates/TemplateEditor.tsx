'use client'

// Email template editor — subject + markdown body are the studio's to
// customise; the branded layout (ring card, header, footer, powered-by) is
// applied at send time and shown here read-only via the live preview, rendered
// with the SAME wrapInLayout/buildTeamFooter the Cloud Functions use
// (@linyup/shared — single source of truth, no drift).
//
// Moved here from settings/emails/ (2026-08-27) when Settings → Emails split
// into Emails (sender identity, system emails, SMS, booking instructions) and
// Email templates (this editor + the placeholder reference below) — the two
// no longer share a page, but the editor's dependencies were already
// self-contained (no relative imports into the old folder), so the move was a
// straight file relocation.
import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import type { RegionalFormatter } from '@linyup/shared'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { marked } from 'marked'
import { db } from '@/lib/firebase'
import {  TEAMS_COLLECTION, wrapInLayout, buildTeamFooter, OUTREACH_TEMPLATES_SUBCOLLECTION } from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'

// Language endonyms — intentionally not translated, same convention as
// UserMenu's locale switcher.
const LANGUAGE_ENDONYMS: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
}

export interface OutreachTemplate {
  id: string
  name: string
  subject: string
  body: string
  body_mode?: string
  language: string
  active: boolean
  system_key?: string
}

// ─── sample substitution for the preview ─────────────────────────────────────
// Mirrors the placeholder set of substituteVariables (functions) with fixed
// sample values — the preview shows shape and layout, not real contact data.
function substituteSample(
  str: string,
  teamName: string,
  custom: Record<string, string>,
  fmt: RegionalFormatter
): string {
  return (str || '')
    .replaceAll('{{firstname}}', 'Alex')
    .replaceAll('{{lastname}}', 'Muster')
    .replaceAll('{{teamName}}', teamName)
    .replaceAll('{{acquisition_stage}}', 'Trial attended')
    .replaceAll('{{affiliation_summary}}', 'Active member')
    .replaceAll('{{sessions_count}}', '5')
    .replace(/\{\{date([+-]\d+)?\}\}/g, (_, offset) => {
      const d = new Date()
      if (offset) d.setDate(d.getDate() + parseInt(offset, 10))
      // MATCH THE SENDER, NOT THE DASHBOARD. `substituteVariables`
      // (packages/functions/src/utils/outreachEmail.ts) renders this
      // placeholder with date-fns `format(d, 'd MMMM yyyy')` — long month,
      // English, no weekday — whatever the template's language and whatever
      // numeric order the studio picked. A preview exists to show what will
      // arrive, so it copies that shape rather than `fmt.date()`'s numeric one.
      // The studio's display zone is used to pick WHICH day, which is the one
      // axis the two can still differ on (the sender uses the function
      // runtime's zone); wiring the sender to the team's regional settings is a
      // server change and has not been made.
      return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: fmt.timeZone,
      }).format(d)
    })
    .replace(/\{\{(bookingUrl|membershipUrl|bioLinkUrl|websiteUrl|reviewUrl)\}\}/g, '#')
    .replace(/\{\{(\w+)\}\}/g, (match, key) => custom[key] ?? match)
}

// ─── PlaceholderPanel ────────────────────────────────────────────────────────

const PLACEHOLDER_GROUPS = [
  {
    groupKey: 'contact',
    items: ['firstname', 'lastname', 'acquisition_stage', 'affiliation_summary', 'sessions_count'],
  },
  {
    groupKey: 'team',
    items: ['teamName', 'bookingUrl', 'membershipUrl', 'bioLinkUrl', 'websiteUrl', 'reviewUrl'],
  },
  {
    groupKey: 'dates',
    items: ['date', 'date+7', 'date-7'],
  },
] as const

function PlaceholderPanel({ customPlaceholders }: { customPlaceholders: Record<string, string> }) {
  const t = useTranslations('Automations')
  const [copied, setCopied] = useState<string>('')

  const copyToken = (key: string) => {
    const token = `{{${key}}}`
    navigator.clipboard.writeText(token).catch(() => {})
    setCopied(key)
    setTimeout(() => setCopied(''), 2000)
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('placeholders.clickToCopy')}</p>

      {PLACEHOLDER_GROUPS.map((group) => (
        <div key={group.groupKey}>
          <p className="text-xs font-medium text-foreground mb-1">
            {t(`placeholders.groups.${group.groupKey}` as Parameters<typeof t>[0])}
          </p>
          <div className="space-y-0.5">
            {group.items.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => copyToken(key)}
                className="w-full text-left px-2 py-1 rounded hover:bg-accent transition-colors group"
              >
                <span className="font-mono text-xs text-primary group-hover:underline">
                  {copied === key ? t('placeholders.copied') : `{{${key}}}`}
                </span>
                <span className="block text-xs text-muted-foreground leading-tight">
                  {t(`placeholders.hints.${key}` as Parameters<typeof t>[0])}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Custom variables */}
      <div>
        <p className="text-xs font-medium text-foreground mb-1">{t('placeholders.customTitle')}</p>
        {Object.keys(customPlaceholders).length === 0 ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground italic">{t('placeholders.noCustomVars')}</p>
            <Link href="/settings/team" className="text-xs text-primary hover:underline">
              {t('placeholders.manageInSettings')}
            </Link>
          </div>
        ) : (
          <div className="space-y-0.5">
            {Object.entries(customPlaceholders).map(([key, value]) => (
              <button
                key={key}
                type="button"
                onClick={() => copyToken(key)}
                className="w-full text-left px-2 py-1 rounded hover:bg-accent transition-colors group"
              >
                <span className="font-mono text-xs text-primary group-hover:underline">
                  {copied === key ? t('placeholders.copied') : `{{${key}}}`}
                </span>
                <span className="block text-xs text-muted-foreground leading-tight truncate">
                  {value}
                </span>
              </button>
            ))}
            <Link
              href="/settings/team"
              className="block text-xs text-muted-foreground hover:underline mt-1 px-2"
            >
              {t('placeholders.manageInSettings')}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── TemplateEditor ──────────────────────────────────────────────────────────

function createTmplSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    name: z.string().min(1, t('validation.required')),
    subject: z.string().min(1, t('validation.required')),
    body: z.string().min(1, t('validation.required')),
    language: z.string().min(1),
  })
}
type TmplFormValues = z.infer<ReturnType<typeof createTmplSchema>>

export function TemplateEditor({
  open,
  onOpenChange,
  teamId,
  editing,
  duplicating,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  editing: OutreachTemplate | null
  /** The template a NEW one is being copied from. `editing` stays null, so the
   *  save is an `addDoc` — and a copy therefore carries NO `system_key`: that
   *  marks a stock template, is what "Reset to default" keys off, and is what
   *  stops the library seeding it twice. A copy is the studio's own. */
  duplicating?: OutreachTemplate | null
  onSaved: () => void
}) {
  const t = useTranslations('Automations')
  const te = useTranslations('SettingsEmails')
  const tCommon = useTranslations('Common')
  const fmt = useTeamFormat()
  const [submitErr, setSubmitErr] = useState('')
  const [sideTab, setSideTab] = useState<'preview' | 'placeholders'>('preview')

  // Team data — custom placeholders, name and footer fields for the preview
  const { data: teamDoc } = useQuery({
    queryKey: ['team_for_templates', teamId],
    enabled: open && !!teamId,
    staleTime: 60_000,
    queryFn: async () => {
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return snap.data() ?? {}
    },
  })
  const customPlaceholders = (teamDoc?.outreach_placeholders as Record<string, string>) ?? {}
  const teamName = (teamDoc?.name as string) || 'Linyup'

  const tmplSchema = useMemo(() => createTmplSchema(t), [t])
  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<TmplFormValues>({
    resolver: zodResolver(tmplSchema),
    defaultValues: { name: '', subject: '', body: '', language: 'en' },
  })

  useEffect(() => {
    if (!open) return
    setSubmitErr('')
    setSideTab('preview')
    const seed = editing ?? duplicating
    if (seed) {
      reset({
        name: duplicating ? tCommon('copyName', { name: seed.name }) : seed.name,
        subject: seed.subject,
        body: seed.body,
        language: seed.language,
      })
    } else {
      reset({ name: '', subject: '', body: '', language: 'en' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, duplicating, reset])

  // Live preview — the real production layout around the editable content.
  const body = watch('body')
  const subject = watch('subject')
  const language = watch('language')
  const previewDoc = useMemo(() => {
    const substituted = substituteSample(body, teamName, customPlaceholders, fmt)
    const html = marked.parse(substituted) as string
    return wrapInLayout({
      language,
      headerTitle: teamName,
      content: html,
      footerContent: buildTeamFooter(teamDoc ?? {}, language),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, language, teamName, teamDoc, fmt])
  const previewSubject = substituteSample(subject, teamName, customPlaceholders, fmt)

  const onSave = async (vals: TmplFormValues) => {
    setSubmitErr('')
    try {
      const tmplRef = collection(db, TEAMS_COLLECTION, teamId, OUTREACH_TEMPLATES_SUBCOLLECTION)
      if (editing) {
        await updateDoc(doc(tmplRef, editing.id), { ...vals, active: true })
      } else {
        await addDoc(tmplRef, {
          ...vals,
          body_mode: 'markdown',
          active: true,
          created_at: serverTimestamp(),
        })
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setSubmitErr((err as Error).message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1080px] max-h-[88dvh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 shrink-0 border-b">
          <DialogTitle>
            {editing
              ? editing.name
              : duplicating
                ? tCommon('duplicate')
                : t('dialogs.templates.newTemplate')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* Left: form */}
          <form
            onSubmit={handleSubmit(onSave)}
            className="flex-1 overflow-y-auto px-6 py-5 space-y-4"
          >
            <div>
              <Label className="text-xs">{t('dialogs.templates.nameLabel')}</Label>
              <Input
                {...register('name')}
                placeholder={t('dialogs.templates.namePlaceholder')}
                className="mt-1"
              />
              {errors.name && (
                <p className="text-xs text-destructive mt-1">{errors.name.message}</p>
              )}
            </div>
            <div>
              <Label className="text-xs">{t('dialogs.templates.subjectLabel')}</Label>
              <Input
                {...register('subject')}
                placeholder={t('dialogs.templates.subjectPlaceholder')}
                className="mt-1"
              />
              {errors.subject && (
                <p className="text-xs text-destructive mt-1">{errors.subject.message}</p>
              )}
            </div>
            <div>
              <Label className="text-xs">{t('dialogs.templates.bodyLabel')}</Label>
              <Textarea
                {...register('body')}
                rows={14}
                placeholder={t('dialogs.templates.bodyPlaceholder')}
                className="mt-1 font-mono text-xs"
              />
              {errors.body && (
                <p className="text-xs text-destructive mt-1">{errors.body.message}</p>
              )}
            </div>
            <div className="w-36">
              <Label className="text-xs">{t('dialogs.templates.languageLabel')}</Label>
              {/* Language endonyms — intentionally not translated, same convention as UserMenu's locale switcher */}
              <Controller
                control={control}
                name="language"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="mt-1 h-9 w-full">
                      <span className="flex flex-1 text-left text-sm truncate">
                        {LANGUAGE_ENDONYMS[field.value] ?? field.value}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(LANGUAGE_ENDONYMS).map(([code, label]) => (
                        <SelectItem key={code} value={code}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            {submitErr && <p className="text-xs text-destructive">{submitErr}</p>}
            <div className="flex justify-between pt-1 pb-4">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t('dialogs.templates.back')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : editing
                    ? t('dialogs.templates.saveChanges')
                    : t('dialogs.templates.createTemplate')}
              </Button>
            </div>
          </form>

          {/* Right: preview / placeholders */}
          <div className="w-[400px] shrink-0 border-l flex flex-col min-h-0">
            <div className="px-3 pt-3 shrink-0">
              <div className="inline-flex gap-0.5 rounded-lg border bg-background p-0.5">
                {(['preview', 'placeholders'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSideTab(key)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      sideTab === key
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {key === 'preview' ? te('preview') : t('placeholders.title')}
                  </button>
                ))}
              </div>
            </div>
            {sideTab === 'preview' ? (
              <div className="flex-1 min-h-0 flex flex-col px-3 py-3 gap-2">
                <p className="text-xs text-muted-foreground shrink-0">
                  <span className="font-medium text-foreground">{te('subjectPreviewLabel')}:</span>{' '}
                  {previewSubject || '—'}
                </p>
                <iframe
                  title={te('preview')}
                  sandbox=""
                  srcDoc={previewDoc}
                  className="flex-1 w-full rounded-lg border bg-white"
                />
                <p className="text-[11px] text-muted-foreground shrink-0">{te('previewNote')}</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-3 py-3">
                <PlaceholderPanel customPlaceholders={customPlaceholders} />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
