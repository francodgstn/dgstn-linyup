'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
  Settings,
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  SitePageRef,
  WebsiteSection,
  WebsiteSectionType,
} from '@linyup/shared'
import {
  applySiteTheme,
  deriveSiteMenu,
  findSiteTheme,
  resolveThemePreset,
  themedSection,
  isValidSiteDate,
  SITE_PAGE_LIMITS,
  SITE_THEMES,
  CLIENT_SITE_PARTS,
  sitePartOffered,
  type SiteThemeDef,
} from '@linyup/shared'
import { usePublicSurfaces } from '@/hooks/usePublicSurfaces'
import { type RenderableSite } from '@/components/site/WebsiteRenderer'
import { PreviewOverlay } from '@/plugins/website/PreviewOverlay'
import { MenuPanel } from '@/plugins/website/MenuPanel'
import { sectionNavLabel } from '@/components/site/sections'
import { SectionEditor } from '@/plugins/website/SectionEditor'
import {
  useSiteDraft,
  useSitePageDocs,
  saveSiteDraft,
  saveSitePages,
  publishSite,
  unpublishSite,
  uploadSiteImage,
} from '@/plugins/website/hooks'
import { BrandFields } from '@/components/website/BrandFields'
import { ThemePicker } from '@/components/website/ThemePicker'
import { EmbedWidgets } from '@/plugins/website/EmbedWidgets'
import { SECTION_LIBRARY, newSection, newSectionId, emptyDraft, starterSections, type PageStarter } from '@/plugins/website/defaults'
import { SectionPicker } from '@/components/website/SectionPicker'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useAutosave } from '@/hooks/useAutosave'
import { getWebsiteLimits } from '@/plugins/website/limits'
import { Tip } from '@/components/ui/tip'
import {
  AddPageDialog,
  HomeSettingsDialog,
  PageSettingsDialog,
  PagesRail,
  PostHeaderCard,
  removeMenuItemsTargetingPage,
  removeHeaderButtonTargetingPage,
  useCurrentPageParam,
} from '@/components/website/pages/SitePageTools'

const limits = getWebsiteLimits()


// ─── appearance panel ─────────────────────────────────────────────────────────

function AppearancePanel({
  meta,
  onChange,
  sections,
  pages,
  uploadImage,
  themes,
  onApplyTheme,
}: {
  meta: SiteMeta
  onChange: (patch: Partial<SiteMeta>) => void
  sections: { id: string; label: string }[]
  /** The site's other pages — offered as link destinations alongside sections. */
  pages: { id: string; label: string }[]
  uploadImage: (file: File) => Promise<string>
  /** The Site Themes plugin unlocks the picker. */
  /** Themes this tenant may apply; the picker is hidden when there are none. */
  themes: readonly SiteThemeDef[]
  /** Applies a theme to the WHOLE draft — look and section styles. */
  onApplyTheme: (theme: SiteThemeDef) => void
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

      {/* Themes first: a theme sets most of what follows, so picking one before
          fine-tuning is the order that does not undo a studio's own edits.
          Only when this studio has a theme to pick — every theme is currently
          a client's own. */}
      {themes.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">{t('themesTitle')}</Label>
          <ThemePicker appliedTheme={meta.appliedTheme} themes={themes} onApply={onApplyTheme} />
        </div>
      )}

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
              <SelectItem value="page">{t('editorCtaActionPage')}</SelectItem>
              <SelectItem value="url">External link</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {meta.header.ctaAction === 'page' && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('editorCtaPage')}</Label>
            <Select
              value={meta.header.ctaPageId ?? ''}
              onValueChange={(v) => setHeader({ ctaPageId: v || undefined })}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={t('editorCtaPagePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {pages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
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

      <BrandFields meta={meta} onChange={onChange} sections={sections} pages={pages} uploadImage={uploadImage} />

      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('apShowSocialFooter')}</span>
        <Switch
          checked={meta.footer.showSocial}
          onCheckedChange={(v) => onChange({ footer: { ...meta.footer, showSocial: v } })}
        />
      </label>

      {/* NO SEO BLOCK HERE ANY MORE. These two fields were never site-wide —
          they are the HOME page's title and description (the public route reads
          them only for the site root), sitting in a tab a studio reads as
          global, while every other page had its own pair behind Page settings.
          A manager tuning her About page had two identical-looking forms and no
          way to tell which one she was in. Home now uses the same Page-settings
          entry point as every other page. */}
    </div>
  )
}


// ─── section list row ──────────────────────────────────────────────────────────

/**
 * The second line of a section's row: what THIS section says, under the type
 * name the row already shows above it.
 *
 * Every fallback here used to be an English noun ("Content", "Membership
 * plans", "3 photo(s)") sitting under a translated label — the only English
 * left in a German studio's builder. A section with no heading of its own now
 * says nothing rather than saying it twice in two languages; the two that
 * carry a real count keep it, translated.
 */
function sectionSummary(s: WebsiteSection, t: (key: string, values?: Record<string, number>) => string): string {
  switch (s.type) {
    case 'hero':
      return s.headline
    case 'gallery':
      return t('summaryPhotos', { count: s.images.length })
    case 'team':
      return s.heading ?? t('summaryPeople', { count: s.items?.length ?? 0 })
    case 'content':
    case 'about':
    case 'activities':
    case 'pricing':
    case 'schedule':
    case 'contact':
    case 'form':
    case 'posts':
    case 'split':
      return s.heading ?? ''
    default:
      return ''
  }
}





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
  const { data: pageDocs, isLoading: pagesLoading } = useSitePageDocs(currentTeamId)

  const [draft, setDraft] = useState<SiteDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  const editRev = useRef(0)
  const [revision, setRevision] = useState(0)
  // A draft lives in this component's state until Save writes it, so leaving
  // the page throws the work away — silently, which is the part that makes it
  // expensive. See the hook for what it can and cannot intercept.
  useUnsavedChangesGuard(dirty, t('unsavedLeaveConfirm'))
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

  // ── multi-page state ──
  // Each OTHER page's sections, keyed by page id — the home page's own live in
  // `draft.sections` like before. Seeded from `useSitePageDocs` once both it
  // and the draft (which names which pages exist) have settled; a page listed
  // in `draft.pages` with no doc yet (added this session, never saved) starts
  // at an empty list rather than waiting on a doc that will never arrive.
  const [pageSections, setPageSections] = useState<Record<string, WebsiteSection[]> | null>(null)
  // Pages removed this session — their doc is deleted on the next save
  // alongside every surviving page's overwrite (saveSitePages).
  const [removedPageIds, setRemovedPageIds] = useState<string[]>([])
  const pageIds = useMemo(() => draft?.pages?.map((p) => p.id) ?? null, [draft?.pages])
  const [currentPageId, setCurrentPageId] = useCurrentPageParam(pageIds)
  const [addPageOpen, setAddPageOpen] = useState(false)
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false)
  // Publish takes the WHOLE site live — every page, every post, every menu
  // change sitting in the draft, not just the typo you came to fix. So it says
  // what it is about to put in front of visitors before it does it.
  const [confirmPublish, setConfirmPublish] = useState(false)

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

  useEffect(() => {
    if (pageSections || pagesLoading || !draft) return
    const initial: Record<string, WebsiteSection[]> = {}
    for (const ref of draft.pages ?? []) {
      initial[ref.id] = pageDocs?.[ref.id] ?? []
    }
    setPageSections(initial)
  }, [pageSections, pagesLoading, draft, pageDocs])

  // ── mutators ──
  // Every change goes through markDirty, which also bumps the edit counter
  // autosave keys on — see useAutosave for why a boolean alone is not enough.
  function markDirty() {
    editRev.current += 1
    setRevision(editRev.current)
    setDirty(true)
  }
  function mutate(updater: (d: SiteDraft) => SiteDraft) {
    setDraft((d) => (d ? updater(d) : d))
    markDirty()
  }
  const patchMeta = (patch: Partial<SiteMeta>) =>
    mutate((d) => ({ ...d, meta: { ...d.meta, ...patch } }))

  // THE CURRENT PAGE'S sections, and the one place that writes them. Every
  // section mutator below goes through this rather than touching
  // `draft.sections` / `pageSections` directly, so none of them need to know
  // which page they're editing.
  const isHome = currentPageId === 'home'
  const currentSections: WebsiteSection[] = isHome
    ? (draft?.sections ?? [])
    : (pageSections?.[currentPageId] ?? [])
  function setCurrentSections(updater: (sections: WebsiteSection[]) => WebsiteSection[]) {
    if (isHome) {
      mutate((d) => ({ ...d, sections: updater(d.sections) }))
    } else {
      setPageSections((prev) => ({
        ...(prev ?? {}),
        [currentPageId]: updater((prev ?? {})[currentPageId] ?? []),
      }))
      markDirty()
    }
  }

  const updateSection = (id: string, patch: Record<string, unknown>) =>
    setCurrentSections((sections) =>
      sections.map((s) => (s.id === id ? ({ ...s, ...patch } as WebsiteSection) : s))
    )
  function addSection(type: WebsiteSectionType) {
    if (currentSections.length >= limits.maxSections) {
      toast.error(t('limitSections', { max: limits.maxSections }))
      return
    }
    // Under an applied theme a new section starts in the theme's style (a CTA as
    // a band, a video as a lightbox) — the same result as applying it afterwards.
    const theme = findSiteTheme(draft?.meta.appliedTheme)
    const sec = theme ? themedSection(newSection(type), theme) : newSection(type)
    setCurrentSections((sections) => [...sections, sec])
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
    if (currentSections.length >= limits.maxSections) {
      toast.error(t('limitSections', { max: limits.maxSections }))
      return
    }
    const source = currentSections.find((s) => s.id === id)
    if (!source) return
    const copy = { ...source, id: newSectionId() } as WebsiteSection
    setCurrentSections((sections) => {
      const at = sections.findIndex((s) => s.id === id)
      const next = [...sections]
      next.splice(at + 1, 0, copy)
      return next
    })
    setOpenId(copy.id)
  }

  const removeSection = (id: string) =>
    setCurrentSections((sections) => sections.filter((s) => s.id !== id))
  function reorderSections(from: number, to: number) {
    setCurrentSections((sections) => arrayMove(sections, from, to))
  }

  // ── pages ──
  function handleCreatePage({
    title,
    path,
    kind,
    publishedOn,
    starter,
  }: {
    title: string
    path: string
    kind: 'page' | 'post'
    publishedOn?: string
    starter: PageStarter
  }) {
    const id = `p-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`
    const ref: SitePageRef = {
      id,
      path,
      title,
      // Absent ⇒ 'page' (SitePageRef.kind) — omit the field entirely for an
      // ordinary page rather than writing 'page' explicitly.
      ...(kind === 'post' ? { kind: 'post' as const, publishedOn } : {}),
    }
    mutate((d) => ({ ...d, pages: [...(d.pages ?? []), ref] }))
    // A POST OPENS ON SOMETHING TO WRITE IN. An author who just named an
    // article should not have to know that a paragraph is a "section" and pick
    // it out of a library before typing the first word; an ordinary page, whose
    // shape is the author's choice, starts from the starter they picked.
    const first =
      kind === 'post'
        ? [newSection('content')]
        : starterSections(starter, title, {
            offerHeading: t('starterOfferHeading'),
            offerItemWhat: t('starterOfferItemWhat'),
            offerItemWho: t('starterOfferItemWho'),
            itemText: t('starterItemText'),
            factsHeading: t('starterFactsHeading'),
            ctaHeading: t('starterCtaHeading'),
            ctaText: t('starterCtaText'),
            ctaLabel: t('starterCtaLabel'),
          })
    setPageSections((prev) => ({ ...(prev ?? {}), [id]: first }))
    // Open the block the author writes in first — the post's text, or the
    // section under a starter's hero (the hero already carries the title).
    setOpenId((kind === 'post' ? first[0] : first[1] ?? first[0])?.id ?? null)
    setAddPageOpen(false)
    setCurrentPageId(id)
  }
  function patchPage(id: string, patch: Partial<SitePageRef>) {
    mutate((d) => ({
      ...d,
      pages: (d.pages ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }
  /** Removes the page's ref, its local sections and every menu item pointing
   *  at it (whole-branch — a `page` target names ONE page, so a subtree under
   *  a deleted page has nothing left to point at either). The page's own doc
   *  is deleted on the next save via `removedPageIds`. */
  function deletePage(id: string) {
    mutate((d) => ({
      ...d,
      pages: (d.pages ?? []).filter((p) => p.id !== id),
      menu: d.menu ? removeMenuItemsTargetingPage(d.menu, id) : d.menu,
      meta: removeHeaderButtonTargetingPage(d.meta, id),
    }))
    setPageSections((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRemovedPageIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
    setPageSettingsOpen(false)
    if (currentPageId === id) setCurrentPageId('home')
  }

  // ── save / publish ──
  async function handleSave({ silent = false }: { silent?: boolean } = {}): Promise<boolean> {
    if (!currentTeamId || !user || !draft) return false
    // What this save is about to write. An edit that lands while it is in
    // flight bumps the counter, and must stay dirty for the next save.
    const rev = editRev.current
    const removed = removedPageIds
    // A post's date is what it sorts and displays by — catch a hand-typed or
    // carried-over bad value here rather than at publish, where sitePosts()
    // would silently sort it last instead of saying why.
    const badDate = (draft.pages ?? []).find(
      (p) => p.kind === 'post' && p.publishedOn && !isValidSiteDate(p.publishedOn)
    )
    if (badDate) {
      toast.error(t('pagesPostDateInvalid'))
      return false
    }
    setSaving(true)
    try {
      await saveSiteDraft(currentTeamId, user.uid, draft)
      const pagesToSave = (draft.pages ?? []).map((ref) => ({
        id: ref.id,
        sections: pageSections?.[ref.id] ?? [],
      }))
      await saveSitePages(currentTeamId, user.uid, pagesToSave, removed)
      setRemovedPageIds((ids) => ids.filter((id) => !removed.includes(id)))
      if (editRev.current === rev) setDirty(false)
      await qc.invalidateQueries({ queryKey: ['site-draft', currentTeamId] })
      await qc.invalidateQueries({ queryKey: ['site-pages', currentTeamId] })
      return true
    } catch {
      // An autosave failure is shown as a status with a retry, not a toast —
      // a toast per attempt is noise, and autosave stops after one failure.
      if (!silent) toast.error(t('errorSave'))
      return false
    } finally {
      setSaving(false)
    }
  }

  const autosave = useAutosave({
    revision,
    dirty,
    paused: saving || publishing,
    save: () => handleSave({ silent: true }),
  })

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
  if (pluginsLoading || draftLoading || !draft || pagesLoading || !pageSections) {
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
          href={'/plugins' as Route}
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
  // Whether the site is live. Saving is its own line beside it now — with
  // autosave, "unsaved" is a few seconds long and says nothing about publishing.
  const status = draft.enabled ? t('statusPublished') : t('statusDraft')
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
    deriveSiteMenu({
      sections: draft?.sections ?? [],
      surfaceLinks: liveSurfaces.map((surface) => ({ surface })),
      pages: draft?.pages,
    })

  function setMenu(next: SiteMenuItem[]) {
    setDraft((d) => (d ? { ...d, menu: next } : d))
    markDirty()
  }

  /** Append a section to the end of the menu, from the section editor's button.
   *  A home section is a direct anchor; a section on another page is scoped TO
   *  that page — `page` is the only target kind that can name a section
   *  outside the home page. */
  function addSectionToMenu(section: WebsiteSection) {
    const target: SiteMenuItem['target'] = isHome
      ? { kind: 'section', sectionId: section.id }
      : { kind: 'page', pageId: currentPageId, sectionId: section.id }
    setMenu([...menu, { id: `m${Date.now().toString(36)}`, target }])
  }

  // The site's other pages, as the id+label pairs every picker here wants
  // (menu editor, CTA editor, brand link lists, card link pickers). These are
  // all FLAT lists — a post is suffixed rather than grouped, so it stays
  // pickable everywhere a page already is without a second UI for it.
  const menuPages = (draft.pages ?? []).map((p) => ({
    id: p.id,
    label: (p.navLabel || p.title) + (p.kind === 'post' ? ` · ${t('pagesPostSuffix')}` : ''),
  }))
  const currentPageRef = isHome ? null : (draft.pages ?? []).find((p) => p.id === currentPageId) ?? null
  const hiddenPageCount = (draft.pages ?? []).filter((p) => p.hidden).length
  // Does ANY page of the site list posts? Home's sections live on the draft,
  // every other page's in the loaded page docs — a post is findable if either
  // carries a 'posts' section.
  // Unknown until the page docs are in — an empty map would otherwise read as
  // "no page lists posts" and flash the wrong advice while they load.
  const hasPostsSection =
    pageSections === null ||
    draft.sections.some((s) => s.type === 'posts') ||
    Object.values(pageSections).some((list) => list.some((s) => s.type === 'posts'))
  const nonPostPages = (draft.pages ?? []).filter((p) => p.kind !== 'post')
  // Newest first, like the live site's `sitePosts` — but WITHOUT its hidden
  // filter: a studio editing a hidden draft post still needs to find it here.
  const postPages = (draft.pages ?? [])
    .filter((p) => p.kind === 'post')
    .sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? '') || a.title.localeCompare(b.title))
  const pagesFull = nonPostPages.length >= SITE_PAGE_LIMITS.maxPages
  const postsFull = postPages.length >= SITE_PAGE_LIMITS.maxPosts

  const previewSite: RenderableSite = {
    teamId: draft.teamId,
    name: draft.name,
    slug: draft.slug,
    meta: draft.meta,
    sections: draft.sections,
    // The menu being edited, so the overlay previews the tree as it stands —
    // not the derived fallback it would show from an unsaved draft.
    menu,
    pages: draft.pages,
    socialLinks: team?.socialLinks,
  }
  // The page being previewed, when it isn't Home — WebsiteRenderer swaps its
  // main area for this instead of `site.sections`. Reads the SAME
  // `currentSections` the editor itself is showing, so the preview never lags
  // an unsaved edit.
  const previewPage = currentPageRef ? { ref: currentPageRef, sections: currentSections } : undefined

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
          {/* SAVE STATE, NOT A SAVE BUTTON. The draft saves itself a moment
              after the last edit; a button appears only when that failed. */}
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {autosave.failed ? (
              <span className="text-destructive">{t('autosaveFailed')}</span>
            ) : saving || dirty ? (
              t('autosaveSaving')
            ) : (
              t('autosaveSaved')
            )}
          </span>
          {autosave.failed && (
            <Button variant="outline" size="sm" onClick={() => handleSave()} disabled={saving}>
              {t('autosaveRetry')}
            </Button>
          )}
          <Button size="sm" onClick={() => setConfirmPublish(true)} disabled={publishing || saving}>
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

      {/* Rail | editor | menu. The rail is beside every tab; the menu only
          beside Sections, and below the editor until the screen is wide
          enough for three columns. */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <PagesRail
          currentPageId={currentPageId}
          pages={nonPostPages}
          posts={postPages}
          onSelect={(id) => {
            setCurrentPageId(id)
            setTab('sections')
          }}
          onAdd={() => setAddPageOpen(true)}
          addDisabled={pagesFull && postsFull}
          addDisabledReason={t('pagesAndPostsLimitReached', {
            maxPages: SITE_PAGE_LIMITS.maxPages,
            maxPosts: SITE_PAGE_LIMITS.maxPosts,
          })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6 xl:flex-row xl:items-start">
        {/* Editor */}
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
              pages={menuPages}
              uploadImage={(file) => uploadSiteImage(currentTeamId!, 'brand', file)}
              themes={SITE_THEMES.filter((theme) =>
                sitePartOffered(CLIENT_SITE_PARTS.themes[theme.id], isInstalled)
              )}
              onApplyTheme={(theme) => {
                mutate((d) => applySiteTheme(d, theme))
                toast.success(t('themeAppliedToast'))
              }}
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
              {/* THE CURRENT PAGE. Every mutator below (add/duplicate/remove/
                  reorder/update section, the section limit, "add to menu") acts
                  on whichever page is selected here — see `currentSections` /
                  `setCurrentSections`. */}
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2.5 lg:hidden">
                {/* A studio thinking "my website has these pages" had nothing
                    on screen saying "pages" — only an unlabelled dropdown in a
                    grey strip. The count is here for the same reason: the caps
                    (30 pages, 100 posts) were only ever mentioned by the error
                    you got when you hit one. */}
                <Label className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t('pagesGroupLabel')} · {nonPostPages.length + 1}/{SITE_PAGE_LIMITS.maxPages}
                </Label>
                <Select value={currentPageId} onValueChange={(v) => v && setCurrentPageId(v)}>
                  <SelectTrigger className="h-8 w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="home">{t('pagesHome')}</SelectItem>
                    {nonPostPages.map((p) => (
                      // The title is the LABEL (what the closed trigger shows);
                      // the path rides along as the item's sublabel. Without
                      // that split the trigger printed the page's id.
                      <SelectItem key={p.id} value={p.id} label={p.title}>
                        /{p.path}
                      </SelectItem>
                    ))}
                    {postPages.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>{t('pagesPostsGroup')}</SelectLabel>
                        {postPages.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.title}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // The kind is chosen INSIDE the dialog, so only the rare case
                  // where NEITHER kind has room left disables the trigger —
                  // each kind's own cap is enforced at creation time instead
                  // (AddPageDialog's `pagesFull` / `postsFull`).
                  disabled={pagesFull && postsFull}
                  // Native title, not <Tip>: the button already carries a visible
                  // label ("Add page") — this only extends it, and only while
                  // disabled, with the reason.
                  title={
                    pagesFull && postsFull
                      ? t('pagesAndPostsLimitReached', {
                          maxPages: SITE_PAGE_LIMITS.maxPages,
                          maxPosts: SITE_PAGE_LIMITS.maxPosts,
                        })
                      : undefined
                  }
                  onClick={() => setAddPageOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('pagesAdd')}
                </Button>
              </div>

              {/* WHICH PAGE THIS IS. With the list in the rail, the editor
                  itself has to say what it is editing — and settings belong to
                  the page, so they sit on its header, not in the list. */}
              <div className="flex items-center gap-3 border-b pb-2.5">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold">
                    {currentPageRef ? currentPageRef.title : t('pagesHome')}
                  </h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    /site{currentPageRef ? `/${currentPageRef.path}` : ''}
                    {currentPageRef?.hidden ? ` · ${t('pagesHiddenField')}` : ''}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setPageSettingsOpen(true)}>
                  <Settings className="h-3.5 w-3.5" />
                  {t('pagesSettings')}
                </Button>
              </div>

              {/* A POST NOBODY CAN FIND. Writing one puts it at its own
                  address and nowhere else: unless some page carries a "Blog
                  posts" section, the only way to the article is the link the
                  author has not shared yet. The builder knows this the moment
                  the post is opened, so it says so once, quietly, instead of
                  letting a studio publish into a void. */}
              {currentPageRef?.kind === 'post' && !hasPostsSection && (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  {t('pagesPostOrphanHint')}
                </p>
              )}

              {currentPageRef?.kind === 'post' && currentTeamId && (
                <PostHeaderCard
                  page={currentPageRef}
                  tenant={{
                    kind: 'team',
                    id: currentTeamId,
                    uploadImage: (sectionId, file) => uploadSiteImage(currentTeamId, sectionId, file),
                  }}
                  onChange={(patch) => patchPage(currentPageRef.id, patch)}
                />
              )}

              {/* A brand-new page is a dashed button and nothing else, which
                  reads as "something failed to load" rather than "this page is
                  yours to fill". One line is enough to say which it is. */}
              {currentSections.length === 0 && (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t('pagesEmptyHint')}
                </p>
              )}

              <SortableList ids={currentSections.map((s) => s.id)} onReorder={reorderSections}>
                {currentSections.map((s) => {
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
                              aria-label={t('menuReorder')}
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
                                {sectionSummary(s, t as (k: string, v?: Record<string, number>) => string)}
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
                              {/* The pencil and the bin were the only two
                                  row actions with no name — hovered, they said
                                  nothing, and to a screen reader they were two
                                  unlabelled buttons beside three labelled ones. */}
                              <Tip label={t('editSection')}>
                                <button
                                  type="button"
                                  onClick={() => setOpenId(open ? null : s.id)}
                                  aria-label={t('editSection')}
                                  className="rounded p-1 hover:bg-muted"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              </Tip>
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
                              <Tip label={t('delete')}>
                                <button
                                  type="button"
                                  onClick={() => setDeleteId(s.id)}
                                  aria-label={t('delete')}
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </Tip>
                            </div>
                          </div>
                          {open && currentTeamId && (
                            <div className="space-y-3 border-t p-3">
                              <SectionEditor
                                section={s}
                                teamId={currentTeamId}
                                pages={menuPages}
                                hasPlugin={isInstalled}
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

              {/* Add section — a dialog of grouped tiles, not a dropdown of
                  seventeen rows. 'managed' sections (none today) are authored by
                  Linyup, not offered here — but stay editable once present. */}
              <SectionPicker
                entries={SECTION_LIBRARY.filter(
                  (lib) =>
                    lib.maturity !== 'managed' &&
                    // A client-owned section type is offered to its client only;
                    // one already on the page stays listed and editable.
                    sitePartOffered(CLIENT_SITE_PARTS.sectionTypes[lib.type], isInstalled)
                )}
                t={(key) => t(key as Parameters<typeof t>[0])}
                onPick={addSection}
              />
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
          <div className="space-y-2 xl:w-[380px] xl:flex-shrink-0 xl:self-start">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ListTree className="h-3.5 w-3.5" />
              {t('tabMenu')}
            </div>
            <MenuPanel
              menu={menu}
              sections={draft.sections}
              pages={menuPages}
              surfaces={liveSurfaces}
              surfaceLabel={(sf) => tSurface(sf as Parameters<typeof tSurface>[0])}
              sectionLabel={(sec) => sectionNavLabel(sec, tSite)}
              onChange={setMenu}
            />
          </div>
        )}
        </div>
      </div>

      {/* The preview opens over the page rather than living beside it — see the
          note on PreviewOverlay for why a 420px column was showing the wrong
          rendering, and what that column's width is now spent on. */}
      <PreviewOverlay
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        site={previewSite}
        page={previewPage}
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

      {/* Publish confirmation — what is about to go live, counted from the
          draft in hand. Not a diff against what is published today (that needs
          a field-by-field comparison against the published snapshot); this is
          the honest half that can be said with no new machinery, and it is
          already the difference between "I clicked the big button" and "I put
          three pages and a half-finished post in front of my members". */}
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('publishConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('publishConfirmBody', { pages: nonPostPages.length, posts: postPages.length })}
              {hiddenPageCount > 0 ? ` ${t('publishConfirmHidden', { count: hiddenPageCount })}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPublish(false)
                void handlePublish()
              }}
            >
              {t('publish')}
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

      <AddPageDialog
        open={addPageOpen}
        onOpenChange={setAddPageOpen}
        existingPaths={(draft.pages ?? []).map((p) => p.path)}
        pagesFull={pagesFull}
        postsFull={postsFull}
        onCreate={handleCreatePage}
      />

      {isHome && (
        <HomeSettingsDialog
          open={pageSettingsOpen}
          onOpenChange={setPageSettingsOpen}
          meta={draft.meta}
          onChange={(patch) => mutate((d) => ({ ...d, meta: { ...d.meta, ...patch } }))}
        />
      )}

      {currentPageRef && (
        <PageSettingsDialog
          open={pageSettingsOpen}
          onOpenChange={setPageSettingsOpen}
          page={currentPageRef}
          existingPaths={(draft.pages ?? [])
            .filter((p) => p.id !== currentPageRef.id)
            .map((p) => p.path)}
          onChange={(patch) => patchPage(currentPageRef.id, patch)}
          onDelete={() => deletePage(currentPageRef.id)}
        />
      )}
    </div>
  )
}
