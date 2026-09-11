'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Copy, Trash2, Pencil } from 'lucide-react'
import type {
  EmbedWidget,
  WidgetTheme,
  WebsiteSectionType,
  WebsiteSection,
  SocialLink,
  SiteFont,
  SiteTheme,
  UiLanguage,
} from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker, DEFAULT_ACCENT } from '@/components/ui/color-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DynamicIcon } from '@/components/ui/icon-picker'
import { useAuth } from '@/contexts/AuthContext'
import { SectionEditor } from './SectionEditor'
import { SECTION_LIBRARY, newSection } from './defaults'
import { useEmbedWidgets, saveEmbedWidgets } from './hooks'

// Field labels here are intentionally hardcoded English to match the rest of the
// builder (AppearancePanel / SectionEditor), which is English-only; tab/CTA-level
// strings still go through next-intl.
const THEME_OPTS: { value: SiteTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
]
const FONT_OPTS: { value: SiteFont; label: string }[] = [
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'rounded', label: 'Rounded' },
]
const LANGUAGE_OPTS: { value: 'auto' | UiLanguage; label: string }[] = [
  { value: 'auto', label: "Auto (visitor's language)" },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
]

function defaultTheme(accent?: string): WidgetTheme {
  return { theme: 'light', accentColor: accent, font: 'sans', background: 'solid' }
}

/**
 * Standalone embed widgets — sections a studio can drop into their OWN website
 * without building or publishing a Linyup site. Self-contained: loads/saves
 * embed_widgets/{teamId} directly ("save = live"), independent of the site draft.
 */
export function EmbedWidgets({
  teamId,
  slug,
  brandAccent,
  socialLinks,
}: {
  teamId: string
  slug: string
  brandAccent?: string
  socialLinks?: SocialLink[]
}) {
  const t = useTranslations('Website')
  const { user } = useAuth()
  const qc = useQueryClient()
  const { data: saved, isLoading } = useEmbedWidgets(teamId)

  const [widgets, setWidgets] = useState<EmbedWidget[] | null>(null)
  const [dirty, setDirty] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (widgets || isLoading) return
    setWidgets(saved?.widgets ?? [])
  }, [widgets, isLoading, saved])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  function mutate(fn: (w: EmbedWidget[]) => EmbedWidget[]) {
    setWidgets((w) => (w ? fn(w) : w))
    setDirty(true)
  }
  function addWidget(type: WebsiteSectionType) {
    const base = { ...(newSection(type) as WebsiteSection), theme: defaultTheme(brandAccent) } as EmbedWidget
    mutate((w) => [...w, base])
    setOpenId(base.id)
  }
  const patchWidget = (id: string, patch: Record<string, unknown>) =>
    mutate((w) => w.map((x) => (x.id === id ? ({ ...x, ...patch } as EmbedWidget) : x)))
  const patchTheme = (id: string, patch: Partial<WidgetTheme>) =>
    mutate((w) =>
      w.map((x) =>
        x.id === id
          ? ({ ...x, theme: { ...defaultTheme(brandAccent), ...x.theme, ...patch } } as EmbedWidget)
          : x
      )
    )
  const removeWidget = (id: string) => mutate((w) => w.filter((x) => x.id !== id))

  async function save() {
    if (!user || !slug || !widgets) return
    setSaving(true)
    try {
      await saveEmbedWidgets(teamId, user.uid, slug, widgets, socialLinks, saved?.i18n)
      setDirty(false)
      await qc.invalidateQueries({ queryKey: ['embed-widgets', teamId] })
      toast.success(t('embedSaved'))
    } catch {
      toast.error(t('embedSaveError'))
    } finally {
      setSaving(false)
    }
  }

  // 'auto'/absent — the widget follows the visitor's Accept-Language, same URL
  // as before this feature existed. 'de'/'fr'/'it' bake the locale into the
  // path (as-needed prefix). 'en' is the UNPREFIXED default locale under
  // localePrefix 'as-needed', so pinning it needs the `?hl=en` escape hatch —
  // proxy.ts rewrites that marker to the English page before next-intl would
  // otherwise Accept-Language-redirect an unprefixed request elsewhere.
  const embedPathFor = (id: string, locale?: 'auto' | UiLanguage) => {
    if (locale === 'de' || locale === 'fr' || locale === 'it') {
      return `${origin}/${locale}/embed/${slug}/${id}`
    }
    if (locale === 'en') {
      return `${origin}/embed/${slug}/${id}?hl=en`
    }
    return `${origin}/embed/${slug}/${id}`
  }
  const snippetFor = (id: string, locale?: 'auto' | UiLanguage) =>
    `<iframe src="${embedPathFor(id, locale)}" data-linyup-embed style="width:100%;border:0" loading="lazy"></iframe>\n<script src="${origin}/embed.js" async></script>`

  // The booking launcher. It is an ORDINARY LINK to the canonical booking page,
  // marked for embed.js to intercept — so with the script it opens the funnel in
  // a pop-up over the studio's own page, and without it (still loading, blocked,
  // JS off, a middle-click) it is a link that works. Same principle as
  // `bookProps` in components/site/sections.tsx: the href always stays.
  const bookSnippet = `<a href="${origin}/public/${slug}/booking" data-linyup-book>Book now</a>\n<script src="${origin}/embed.js" async></script>`

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('embedCopied'))
    } catch {
      toast.error(t('embedCopyError'))
    }
  }
  const copy = (id: string, locale?: 'auto' | UiLanguage) => copyText(snippetFor(id, locale))

  if (isLoading || !widgets) {
    return <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('embedIntro')}</p>
        <Button size="sm" onClick={save} disabled={!dirty || saving || !slug}>
          {saving ? t('saving') : t('embedSave')}
        </Button>
      </div>

      {!slug && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {t('errorNoSlug')}
        </div>
      )}

      {widgets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('embedNoWidgets')}</p>
      ) : (
        <div className="space-y-3">
          {widgets.map((wdg) => {
            const lib = SECTION_LIBRARY.find((l) => l.type === wdg.type)
            const open = openId === wdg.id
            const themeLabel = THEME_OPTS.find((o) => o.value === (wdg.theme?.theme ?? 'light'))?.label
            return (
              <div key={wdg.id} className="rounded-lg border bg-card">
                <div className="flex items-center gap-2 p-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <DynamicIcon name={lib?.icon ?? 'Square'} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {wdg.label || (lib ? t(lib.labelKey as Parameters<typeof t>[0]) : wdg.type)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {themeLabel}
                      {wdg.theme?.background === 'transparent' ? ' · transparent' : ''}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!slug}
                    onClick={() => copy(wdg.id, wdg.theme?.locale)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {t('embedCopy')}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : wdg.id)}
                    className="rounded p-1.5 hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteId(wdg.id)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {open && (
                  <div className="space-y-4 border-t p-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={wdg.label ?? ''}
                        onChange={(e) => patchWidget(wdg.id, { label: e.target.value })}
                        placeholder={lib ? t(lib.labelKey as Parameters<typeof t>[0]) : wdg.type}
                        className="h-9"
                      />
                    </div>

                    <SectionEditor
                      section={wdg}
                      teamId={teamId}
                      onChange={(patch) => patchWidget(wdg.id, patch)}
                    />

                    <div className="space-y-3 rounded-lg border p-3">
                      <p className="text-xs font-medium text-muted-foreground">{t('embedTheme')}</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Theme</Label>
                          <Select
                            value={wdg.theme?.theme ?? 'light'}
                            onValueChange={(v) => patchTheme(wdg.id, { theme: v as SiteTheme })}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {THEME_OPTS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Font</Label>
                          <Select
                            value={wdg.theme?.font ?? 'sans'}
                            onValueChange={(v) => patchTheme(wdg.id, { font: v as SiteFont })}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FONT_OPTS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Language</Label>
                          <Select
                            value={wdg.theme?.locale ?? 'auto'}
                            onValueChange={(v) =>
                              patchTheme(wdg.id, { locale: v as 'auto' | UiLanguage })
                            }
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {LANGUAGE_OPTS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Accent color</Label>
                          <ColorPicker
                            value={wdg.theme?.accentColor ?? brandAccent ?? DEFAULT_ACCENT}
                            onChange={(hex) => patchTheme(wdg.id, { accentColor: hex })}
                            className="h-9 w-full"
                            aria-label="Accent color"
                          />
                        </div>
                        <label className="flex items-end justify-between gap-2 pb-1.5">
                          <span className="text-xs">Transparent background</span>
                          <Switch
                            checked={wdg.theme?.background === 'transparent'}
                            onCheckedChange={(v) =>
                              patchTheme(wdg.id, { background: v ? 'transparent' : 'solid' })
                            }
                          />
                        </label>
                      </div>
                    </div>

                    <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs text-muted-foreground">
                      <code>{snippetFor(wdg.id, wdg.theme?.locale)}</code>
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-input py-3 text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground">
          <Plus className="h-4 w-4" />
          {t('embedAddWidget')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {SECTION_LIBRARY.map((lib) => (
            <DropdownMenuItem key={lib.type} onClick={() => addWidget(lib.type)} className="gap-2">
              <DynamicIcon name={lib.icon} className="h-4 w-4 text-muted-foreground" />
              <span className="flex flex-col">
                <span className="text-sm">{t(lib.labelKey as Parameters<typeof t>[0])}</span>
                <span className="text-xs text-muted-foreground">
                  {t(lib.descKey as Parameters<typeof t>[0])}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="space-y-2 rounded-lg border bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('embedBookTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('embedBookBody')}</p>
          </div>
          <Button variant="outline" size="sm" disabled={!slug} onClick={() => copyText(bookSnippet)}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t('embedCopy')}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs text-muted-foreground">
          <code>{bookSnippet}</code>
        </pre>
      </div>

      <p className="text-xs text-muted-foreground">{t('embedScriptNote')}</p>
      <p className="text-xs text-muted-foreground">{t('embedModalNote')}</p>

      <AlertDialog
        open={!!deleteId}
        onOpenChange={(v) => {
          if (!v) setDeleteId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('embedDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('embedDeleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteId) removeWidget(deleteId)
                setDeleteId(null)
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
