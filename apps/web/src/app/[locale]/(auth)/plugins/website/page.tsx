'use client'

import { useEffect, useState } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { toast } from 'sonner'
import {
  Globe,
  Plus,
  GripVertical,
  Pencil,
  Copy,
  Trash2,
  Eye,
  ListTree,
  ListPlus,
  EyeOff,
  ExternalLink,
  Check,
} from 'lucide-react'
import { ThemePresetPicker } from '@/components/theme/ThemePresetPicker'
import { ThemePreview } from '@/components/theme/ThemePreview'
import { SortableList, SortableItem } from '@/components/ui/sortable'
import { arrayMove } from '@dnd-kit/sortable'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { ColorPicker } from '@/components/ui/color-picker'
import type {
  PublicSurface,
  SiteDraft,
  SiteMenuItem,
  SiteMeta,
  WebsiteSection,
  WebsiteSectionType,
} from '@linyup/shared'
import {
  deriveSiteMenu,
  resolveThemePreset,
} from '@linyup/shared'
import { usePublicSurfaces } from '@/hooks/usePublicSurfaces'
import { type RenderableSite } from '@/components/site/WebsiteRenderer'
import { PreviewOverlay } from '@/plugins/website/PreviewOverlay'
import { MenuPanel } from '@/plugins/website/MenuPanel'
import { sectionNavLabel } from '@/components/site/sections'
import { SectionEditor } from '@/plugins/website/SectionEditor'
import { useSiteDraft, saveSiteDraft, publishSite, unpublishSite, uploadSiteImage } from '@/plugins/website/hooks'
import { BrandFields } from '@/components/website/BrandFields'
import { EmbedWidgets } from '@/plugins/website/EmbedWidgets'
import { SECTION_LIBRARY, newSection, newSectionId, emptyDraft } from '@/plugins/website/defaults'
import { getWebsiteLimits } from '@/plugins/website/limits'
import { Tip } from '@/components/ui/tip'

const limits = getWebsiteLimits()

// ─── appearance panel ─────────────────────────────────────────────────────────

function AppearancePanel({
  meta,
  onChange,
  sections,
  uploadImage,
}: {
  meta: SiteMeta
  onChange: (patch: Partial<SiteMeta>) => void
  sections: { id: string; label: string }[]
  uploadImage: (file: File) => Promise<string>
}) {
  const t = useTranslations('Website')

  // Resolved through the SAME function the renderer uses, so the preview and the
  // "does this theme have two halves" check are the one truth. Null for a legacy
  // surface — its page follows the old `theme: 'auto'` field, and its preview
  // says "save a theme to see it".
  const resolvedTheme = resolveThemePreset({
    presetId: meta.themePreset,
    light: meta.themeLight,
    dark: meta.themeDark,
    single: meta.themeSingle,
    lighting: meta.themeLighting,
  })
  const themeIsAdaptive = resolvedTheme ? resolvedTheme.adaptive : meta.theme === 'auto'
  const previewAccent = meta.accentColor || resolvedTheme?.defaultAccent || '#6366f1'

  const setHeader = (p: Partial<SiteMeta['header']>) =>
    onChange({ header: { ...meta.header, ...p } })
  const setSeo = (p: Partial<NonNullable<SiteMeta['seo']>>) =>
    onChange({ seo: { ...meta.seo, ...p } })

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">{t('apSiteTitle')}</Label>
        <Input
          value={meta.title}
          onChange={(e) => onChange({ title: e.target.value })}
          className="h-9"
        />
      </div>

      {/* Theme — TWO COLUMNS: the controls on the left (2/3), a live preview on
          the right (1/3). A studio changing colours wants to watch them decide
          something; a preview beside the controls is that, and it is why the
          strength dials the first cut had are gone — the preview does the job
          they were pretending to (Franco, 2026-09-03). */}
      <div className="space-y-2">
        <Label className="text-xs">{t('apTheme')}</Label>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <ThemePresetPicker
              value={meta.themePreset ?? ''}
              onChange={(id) => onChange({ themePreset: id })}
              accentColor={meta.accentColor}
              light={meta.themeLight}
              dark={meta.themeDark}
              single={meta.themeSingle}
              lighting={meta.themeLighting}
              // ONE WRITE for the custom fields — they are one choice.
              onCustomChange={(next) =>
                onChange({
                  themeLight: next.light,
                  themeDark: next.dark,
                  themeSingle: next.single,
                  themeLighting: next.lighting,
                })
              }
            />

            {/* THE VISITOR'S SWITCH — off by default, and only meaningful on a
                theme with two halves. On a single-look theme there is nothing to
                switch to, so the row disables itself and says why. */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('apThemeToggle')}</Label>
              <div className="flex items-start gap-2.5 rounded-md border p-2.5">
                <Switch
                  checked={!!meta.themeToggle}
                  disabled={!themeIsAdaptive}
                  onCheckedChange={(v) => onChange({ themeToggle: v })}
                />
                <p className="text-xs text-muted-foreground">
                  {themeIsAdaptive ? t('apThemeToggleHint') : t('apThemeToggleFixed')}
                </p>
              </div>
            </div>
          </div>

          {/* THE PREVIEW — light over dark, each with a page, a heading, text and
              a button. Not a copy of any real component; just every role a
              palette fills. */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('apThemePreview')}</Label>
            {resolvedTheme ? (
              <ThemePreview
                light={resolvedTheme.light}
                dark={resolvedTheme.dark}
                accent={previewAccent}
                adaptive={resolvedTheme.adaptive}
              />
            ) : (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {t('apThemePreviewNone')}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('apAccentColor')}</Label>
        <ColorPicker
          value={meta.accentColor}
          onChange={(hex) => onChange({ accentColor: hex })}
          aria-label={t('apAccentColor')}
        />
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-xs font-medium text-muted-foreground">Header</p>
        <label className="flex items-center justify-between">
          <span className="text-sm">{t('apShowNav')}</span>
          <Switch
            checked={meta.header.showNav}
            onCheckedChange={(v) => setHeader({ showNav: v })}
          />
        </label>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('apHeaderCtaLabel')}</Label>
          <Input
            value={meta.header.ctaLabel ?? ''}
            onChange={(e) => setHeader({ ctaLabel: e.target.value })}
            placeholder={t('apHeaderCtaPlaceholderTeam')}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('apHeaderCtaAction')}</Label>
          <Select
            value={meta.header.ctaAction ?? 'booking'}
            onValueChange={(v) => setHeader({ ctaAction: v as SiteMeta['header']['ctaAction'] })}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="booking">Open booking</SelectItem>
              <SelectItem value="signup">Sign-up</SelectItem>
              <SelectItem value="url">External link</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {meta.header.ctaAction === 'url' && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('apHeaderCtaUrl')}</Label>
            <Input
              value={meta.header.ctaUrl ?? ''}
              onChange={(e) => setHeader({ ctaUrl: e.target.value })}
              placeholder="https://"
              className="h-9 font-mono text-xs"
            />
          </div>
        )}

        <div className="border-t pt-3">
          <label className="flex items-center justify-between">
            <span className="text-sm">Show member sign-in</span>
            <Switch
              checked={meta.header.showSignIn !== false}
              onCheckedChange={(v) => setHeader({ showSignIn: v })}
            />
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Lets a member sign in and reach their Space from your website.
          </p>
        </div>

        {/* Shop / My space / Documents USED TO BE CONFIGURED HERE, as a list of
            per-surface hide/relabel/reorder overrides. They were only ever in
            appearance because there was nowhere else: they were derived links in
            a run of their own, orderable among themselves and nothing else.
            They are ordinary menu items now — added, renamed, nested and ordered
            beside everything else in the Menu editor, which is where a studio
            looks for them. `SiteHeader.surfaceLinks` stays in the type and is
            still honoured when deriving a menu for a site that has never been
            edited, so no existing header changes. */}
      </div>

      <BrandFields meta={meta} onChange={onChange} sections={sections} uploadImage={uploadImage} />

      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('apShowSocialFooter')}</span>
        <Switch
          checked={meta.footer.showSocial}
          onCheckedChange={(v) => onChange({ footer: { ...meta.footer, showSocial: v } })}
        />
      </label>

      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-xs font-medium text-muted-foreground">SEO (optional)</p>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('apPageTitle')}</Label>
          <Input
            value={meta.seo?.title ?? ''}
            onChange={(e) => setSeo({ title: e.target.value })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('apMetaDescription')}</Label>
          <Input
            value={meta.seo?.description ?? ''}
            onChange={(e) => setSeo({ description: e.target.value })}
            className="h-9"
          />
        </div>
      </div>
    </div>
  )
}

// ─── section list row ──────────────────────────────────────────────────────────

function sectionSummary(s: WebsiteSection): string {
  switch (s.type) {
    case 'hero':
      return s.headline
    case 'content':
    case 'about':
      return s.heading || 'Content'
    case 'gallery':
      return `${s.images.length} photo(s)`
    case 'activities':
      return s.heading ?? 'Activities'
    case 'pricing':
      return s.heading ?? 'Membership plans'
    case 'schedule':
      return s.heading ?? 'Upcoming sessions'
    case 'contact':
      return s.heading ?? 'Contact details'
    default:
      return ''
  }
}

// ─── page ─────────────────────────────────────────────────────────────────────

const SITE_TABS = ['sections', 'appearance', 'embed'] as const

export default function WebsiteBuilderPage() {
  const t = useTranslations('Website')
  // The published site's own chrome namespace — the builder shows the same
  // last-resort nav labels a visitor would see when a section has no heading.
  const tSite = useTranslations('Site')
  const tCommon = useTranslations('Common')
  // Same namespace the live site nav uses, so a menu row reads as it will publish.
  const tSurface = useTranslations('PublicSurfaceNav')
  const { flags: surfaceFlags } = usePublicSurfaces()
  const { user, currentTeamId, team } = useAuth()
  const qc = useQueryClient()
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()

  const { data: savedDraft, isLoading: draftLoading } = useSiteDraft(currentTeamId)

  const [draft, setDraft] = useState<SiteDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useTabParam(SITE_TABS, 'sections')
  const [openId, setOpenId] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  // Unpublishing is "take it off the internet" — it sat one unconfirmed click
  // from Publish (UX-50). It is however fully REVERSIBLE and loses nothing
  // (unpublishSiteForTeam deletes site_published/{teamId} and merges
  // `enabled: false` onto the draft — the draft's pages, wording and images are
  // untouched), so the copy says so. An overstated warning trains people to
  // click through the next one.
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  // Initialise the working draft once data has settled.
  useEffect(() => {
    if (draft || draftLoading || !currentTeamId || !team) return
    setDraft(
      savedDraft ??
        emptyDraft({
          id: currentTeamId,
          name: team.name,
          slug: team.slug,
          bioLinkAccentColor: team.bioLinkAccentColor,
        })
    )
  }, [draft, draftLoading, savedDraft, currentTeamId, team])

  // ── mutators ──
  function mutate(updater: (d: SiteDraft) => SiteDraft) {
    setDraft((d) => (d ? updater(d) : d))
    setDirty(true)
  }
  const patchMeta = (patch: Partial<SiteMeta>) =>
    mutate((d) => ({ ...d, meta: { ...d.meta, ...patch } }))
  const updateSection = (id: string, patch: Record<string, unknown>) =>
    mutate((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === id ? ({ ...s, ...patch } as WebsiteSection) : s)),
    }))
  function addSection(type: WebsiteSectionType) {
    if (draft && draft.sections.length >= limits.maxSections) {
      toast.error(t('limitSections', { max: limits.maxSections }))
      return
    }
    const sec = newSection(type)
    mutate((d) => ({ ...d, sections: [...d.sections, sec] }))
    setOpenId(sec.id)
    setTab('sections')
  }
  /**
   * Copy a section, in place, right below the original.
   *
   * The ONLY thing reset is the `id` — and it has to be, because it is three
   * things at once: the React key, the on-page anchor and the storage path
   * segment new image uploads are written under. Everything else (including
   * image URLs, which stay valid download links) is copied as-is. The copy
   * lands in the DRAFT like every other edit here; the public site is untouched
   * until Publish, which is already its own explicit step.
   */
  function duplicateSection(id: string) {
    if (draft && draft.sections.length >= limits.maxSections) {
      toast.error(t('limitSections', { max: limits.maxSections }))
      return
    }
    const source = draft?.sections.find((s) => s.id === id)
    if (!source) return
    const copy = { ...source, id: newSectionId() } as WebsiteSection
    mutate((d) => {
      const at = d.sections.findIndex((s) => s.id === id)
      const next = [...d.sections]
      next.splice(at + 1, 0, copy)
      return { ...d, sections: next }
    })
    setOpenId(copy.id)
  }

  const removeSection = (id: string) =>
    mutate((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }))
  function reorderSections(from: number, to: number) {
    mutate((d) => ({ ...d, sections: arrayMove(d.sections, from, to) }))
  }

  // ── save / publish ──
  async function handleSave(): Promise<boolean> {
    if (!currentTeamId || !user || !draft) return false
    setSaving(true)
    try {
      await saveSiteDraft(currentTeamId, user.uid, draft)
      setDirty(false)
      await qc.invalidateQueries({ queryKey: ['site-draft', currentTeamId] })
      return true
    } catch {
      toast.error(t('errorSave'))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handlePublish() {
    if (!currentTeamId || !draft) return
    if (!draft.slug) {
      toast.error(t('errorNoSlug'))
      return
    }
    setPublishing(true)
    try {
      const ok = await handleSave()
      if (!ok) return
      await publishSite(currentTeamId)
      setDraft((d) => (d ? { ...d, enabled: true } : d))
      await qc.invalidateQueries({ queryKey: ['published-site', currentTeamId] })
      toast.success(t('published'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('errorPublish'))
    } finally {
      setPublishing(false)
    }
  }

  async function handleUnpublish() {
    if (!currentTeamId) return
    setPublishing(true)
    try {
      await unpublishSite(currentTeamId)
      setDraft((d) => (d ? { ...d, enabled: false } : d))
      await qc.invalidateQueries({ queryKey: ['published-site', currentTeamId] })
      toast.success(t('unpublished'))
    } catch {
      toast.error(t('errorPublish'))
    } finally {
      setPublishing(false)
    }
  }

  // ── gates ──
  if (pluginsLoading || draftLoading || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  if (!isInstalled('website')) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-10 text-center">
        <Globe className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{t('notInstalledTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('notInstalledBody')}</p>
        <Link
          href={'/settings/plugins' as Route}
          className="mt-4 inline-block text-sm text-primary hover:underline"
        >
          {t('goToPlugins')} →
        </Link>
      </div>
    )
  }

  const slug = team?.slug ?? draft.slug
  const siteUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/public/${slug}/site`
      : `/public/${slug}/site`
  const status = dirty
    ? t('statusUnsaved')
    : draft.enabled
      ? t('statusPublished')
      : t('statusDraft')
  // THE MENU THE EDITOR WORKS ON. Absent in storage ⇒ derive today's layout, so
  // a studio that has never opened this tab sees exactly the menu their site
  // already has and can start rearranging it rather than rebuilding it. The
  // first save stores a tree and that wins from then on.
  // The linkable surfaces that are actually live — booking is excluded because it
  // has its own header CTA. Same list and same source the menu editor reads.
  const liveSurfaces: PublicSurface[] = (['shop', 'space', 'documents'] as const).filter(
    (sf) =>
      sf === 'shop'
        ? surfaceFlags.shopLive
        : sf === 'space'
          ? surfaceFlags.spaceLive
          : surfaceFlags.documentsLive
  )

  const menu: SiteMenuItem[] =
    draft?.menu ??
    deriveSiteMenu({ sections: draft?.sections ?? [], surfaceLinks: liveSurfaces.map((surface) => ({ surface })) })

  function setMenu(next: SiteMenuItem[]) {
    setDraft((d) => (d ? { ...d, menu: next } : d))
    setDirty(true)
  }

  /** Append a section to the end of the menu, from the section editor's button. */
  function addSectionToMenu(section: WebsiteSection) {
    setMenu([
      ...menu,
      { id: `m${Date.now().toString(36)}`, target: { kind: 'section', sectionId: section.id } },
    ])
  }

  const previewSite: RenderableSite = {
    teamId: draft.teamId,
    name: draft.name,
    slug: draft.slug,
    meta: draft.meta,
    sections: draft.sections,
    // The menu being edited, so the overlay previews the tree as it stands —
    // not the derived fallback it would show from an unsaved draft.
    menu,
    socialLinks: team?.socialLinks,
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            {slug ? (
              <a
                href={siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {siteUrl.replace(/^https?:\/\//, '')}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <p className="mt-0.5 text-sm text-muted-foreground">{t('errorNoSlug')}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {status}
          </Badge>
          {draft.enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setConfirmUnpublish(true)}
              disabled={publishing}
            >
              {t('unpublish')}
            </Button>
          )}
          {/* Opens the overlay. It sits with Save and Publish rather than over the
              editor because preview is now a deliberate act, not a thing in the
              corner of your eye — see PreviewOverlay for why the column went. */}
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
            <Eye className="h-4 w-4" />
            {t('preview')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? t('saving') : t('saveDraft')}
          </Button>
          <Button size="sm" onClick={handlePublish} disabled={publishing}>
            {publishing ? (
              t('publishing')
            ) : (
              <>
                <Check className="mr-1 h-4 w-4" />
                {t('publish')}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Two columns */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Left: editor */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* Tabs */}
          <div className="flex gap-0 border-b">
            {(
              [
                ['sections', t('tabSections')],
                ['appearance', t('tabAppearance')],
                ['embed', t('tabEmbed')],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'appearance' ? (
            <AppearancePanel
              meta={draft.meta}
              onChange={patchMeta}
              sections={draft.sections.map((sec) => ({ id: sec.id, label: sectionNavLabel(sec, tSite) }))}
              uploadImage={(file) => uploadSiteImage(currentTeamId!, 'brand', file)}
            />
          ) : tab === 'embed' ? (
            <EmbedWidgets
              teamId={currentTeamId!}
              slug={slug}
              brandAccent={team?.bioLinkAccentColor}
              socialLinks={team?.socialLinks}
            />
          ) : (
            <div className="space-y-2.5">
              <SortableList ids={draft.sections.map((s) => s.id)} onReorder={reorderSections}>
                {draft.sections.map((s) => {
                  const lib = SECTION_LIBRARY.find((l) => l.type === s.type)
                  const open = openId === s.id
                  return (
                    <SortableItem id={s.id} key={s.id}>
                      {({ setNodeRef, style, attributes, listeners, isDragging }) => (
                        <div
                          ref={setNodeRef}
                          style={style}
                          className={`rounded-lg border bg-card${s.hidden ? ' opacity-60' : ''}${
                            isDragging ? ' shadow-lg ring-1 ring-border' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1.5 p-3">
                            <button
                              type="button"
                              {...attributes}
                              {...listeners}
                              className="shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <DynamicIcon name={lib?.icon ?? 'Square'} className="h-4 w-4" />
                            </span>
                            <button
                              type="button"
                              onClick={() => setOpenId(open ? null : s.id)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <p className="text-sm font-medium">
                                {lib ? t(lib.labelKey as Parameters<typeof t>[0]) : s.type}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {sectionSummary(s)}
                              </p>
                            </button>
                            <div className="flex items-center gap-0.5">
                              {/* Adding a section to the menu is a ROW ACTION,
                                  beside edit and duplicate, not a control buried
                                  in the expanded body — you decide a section
                                  belongs in the menu while looking at the list,
                                  and it cost an expand-and-scroll to reach.
                                  Never for the hero: it is the top of the page
                                  and is not a menu destination. */}
                              {s.type !== 'hero' && (
                                <Tip label={t('addToMenu')}>
                                  <button
                                    type="button"
                                    onClick={() => addSectionToMenu(s)}
                                    aria-label={t('addToMenu')}
                                    className="rounded p-1 hover:bg-muted"
                                  >
                                    <ListPlus className="h-3.5 w-3.5" />
                                  </button>
                                </Tip>
                              )}
                              <Tip label={t('toggleVisible')}>
                                <button
                                  type="button"
                                  onClick={() => updateSection(s.id, { hidden: !s.hidden })}
                                  aria-label={t('toggleVisible')}
                                  className="rounded p-1 hover:bg-muted"
                                >
                                  {s.hidden ? (
                                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                                  ) : (
                                    <Eye className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              </Tip>
                              <button
                                type="button"
                                onClick={() => setOpenId(open ? null : s.id)}
                                className="rounded p-1 hover:bg-muted"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <Tip label={tCommon('duplicate')}>
                                <button
                                  type="button"
                                  onClick={() => duplicateSection(s.id)}
                                  aria-label={tCommon('duplicate')}
                                  className="rounded p-1 hover:bg-muted"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                              </Tip>
                              <button
                                type="button"
                                onClick={() => setDeleteId(s.id)}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                          {open && currentTeamId && (
                            <div className="space-y-3 border-t p-3">
                              <SectionEditor
                                section={s}
                                teamId={currentTeamId}
                                onChange={(patch) => updateSection(s.id, patch)}
                              />
                              {/* NO "menu label" FIELD HERE ANY MORE. A menu
                                  ENTRY carries its own label, and a section can
                                  now appear in the menu more than once — so a
                                  single field on the section could not say which
                                  entry it was naming, and two places to write one
                                  name is how they drift. The name is edited where
                                  the entry is.

                                  `SectionBase.menuLabel` survives in the type as
                                  the fallback `sectionNavLabel` reads when an
                                  entry has no label of its own; it is no longer
                                  authored here. */}
                            </div>
                          )}
                        </div>
                      )}
                    </SortableItem>
                  )
                })}
              </SortableList>

              {/* Add section */}
              <DropdownMenu>
                <DropdownMenuTrigger className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-input py-3 text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground">
                  <Plus className="h-4 w-4" />
                  {t('addSection')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {SECTION_LIBRARY.map((lib) => (
                    <DropdownMenuItem
                      key={lib.type}
                      onClick={() => addSection(lib.type)}
                      className="gap-2"
                    >
                      <DynamicIcon name={lib.icon} className="h-4 w-4 text-muted-foreground" />
                      <span className="flex flex-col">
                        <span className="text-sm">
                          {t(lib.labelKey as Parameters<typeof t>[0])}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(lib.descKey as Parameters<typeof t>[0])}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* ── THE MENU, BESIDE THE PAGE IT ORDERS ────────────────────────────
            This is the column the sticky preview used to occupy. It earns the
            space better: arranging a menu means looking at the sections it
            points at, and a separate tab made that a round trip. It shows only
            with the Sections tab for the same reason — beside Appearance or the
            embed snippets it would be answering a question nobody asked. */}
        {tab === 'sections' && (
          <div className="space-y-2 lg:w-[420px] lg:flex-shrink-0 lg:self-start">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ListTree className="h-3.5 w-3.5" />
              {t('tabMenu')}
            </div>
            <MenuPanel
              menu={menu}
              sections={draft.sections}
              surfaces={liveSurfaces}
              surfaceLabel={(sf) => tSurface(sf as Parameters<typeof tSurface>[0])}
              sectionLabel={(sec) => sectionNavLabel(sec, tSite)}
              onChange={setMenu}
            />
          </div>
        )}
      </div>

      {/* The preview opens over the page rather than living beside it — see the
          note on PreviewOverlay for why a 420px column was showing the wrong
          rendering, and what that column's width is now spent on. */}
      <PreviewOverlay
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        site={previewSite}
        // Labels are what a preview is read for; the hrefs are inert under
        // `preview` anyway, so they point at the real public paths without
        // needing the locale-aware builder the live site uses.
        surfaceLinks={liveSurfaces.map((surface) => ({
          surface,
          href: `/public/${slug}/${surface}`,
          label: tSurface(surface as Parameters<typeof tSurface>[0]),
        }))}
      />

      {/* Delete confirm */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(v) => {
          if (!v) setDeleteId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteSectionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteSectionBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteId) removeSection(deleteId)
                setDeleteId(null)
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unpublish confirmation. States the consequence in the visitor's terms —
          the site goes offline now, and any bio-link entry pointing at it stops
          being offered (BioLinkHome filters page links through
          `systemLinkIsLive`, UX-49) — and then states, equally plainly, that
          nothing is lost and it can be published again. NOT styled destructive:
          this deletes no work. */}
      <AlertDialog open={confirmUnpublish} onOpenChange={setConfirmUnpublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('unpublishConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('unpublishConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={publishing}
              onClick={() => {
                setConfirmUnpublish(false)
                void handleUnpublish()
              }}
            >
              {t('unpublishConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
