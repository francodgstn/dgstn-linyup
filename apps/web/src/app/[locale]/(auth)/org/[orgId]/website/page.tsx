'use client'

import { useEffect, useState } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { toast } from 'sonner'
import { Globe, Plus, GripVertical, Pencil, Trash2, Eye, EyeOff, ExternalLink, Check, ListTree } from 'lucide-react'
import { ThemePresetPicker } from '@/components/theme/ThemePresetPicker'
import { SortableList, SortableItem } from '@/components/ui/sortable'
import { arrayMove } from '@dnd-kit/sortable'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { db } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { ORGANIZATIONS_COLLECTION, ORG_TEAMS_SUBCOLLECTION, TEAMS_COLLECTION, deriveSiteMenu } from '@linyup/shared'
import type { OrgSiteDraft, OrgSiteSection, OrgSiteSectionType, OrgSiteTeamRef, SiteMeta, SiteMenuItem } from '@linyup/shared'
import { MenuPanel } from '@/plugins/website/MenuPanel'
import { PreviewOverlay } from '@/plugins/website/PreviewOverlay'
import { sectionNavLabel } from '@/components/site/sections'
import { type RenderableSite } from '@/components/site/WebsiteRenderer'
import { OrgSectionEditor } from './OrgSectionEditor'
import { useOrgSiteDraft, saveOrgSiteDraft, publishOrgSite, unpublishOrgSite, uploadOrgSiteImage } from './hooks'
import { BrandFields } from '@/components/website/BrandFields'
import { ORG_SECTION_LIBRARY, newOrgSection, emptyOrgDraft } from './defaults'
import { SectionPicker } from '@/components/website/SectionPicker'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { Tip } from '@/components/ui/tip'

const MAX_SECTIONS = 12

// ─── lightweight org-teams read for the live preview ──────────────────────────
// The builder has no published snapshot to preview against, so it resolves the
// org's active member teams directly (same source publishOrgWebsite embeds:
// org_teams docs keyed by teamId → each team's slug/name).

function useOrgPreviewTeams(orgId: string | null) {
  return useQuery<OrgSiteTeamRef[]>({
    queryKey: ['org-site-preview-teams', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const orgTeamsSnap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId!, ORG_TEAMS_SUBCOLLECTION),
          where('status', '==', 'active')
        )
      )
      if (orgTeamsSnap.empty) return []
      const teamDocs = await Promise.all(
        orgTeamsSnap.docs.map((d) => getDoc(doc(db, TEAMS_COLLECTION, d.id)))
      )
      const teams: OrgSiteTeamRef[] = []
      for (const teamDoc of teamDocs) {
        if (!teamDoc.exists()) continue
        const t = teamDoc.data() as { slug?: string; name?: string }
        if (!t.slug) continue
        teams.push({ teamId: teamDoc.id, slug: t.slug, name: t.name ?? '' })
      }
      return teams
    },
  })
}

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

  const setHeader = (p: Partial<SiteMeta['header']>) => onChange({ header: { ...meta.header, ...p } })
  const setSeo = (p: Partial<NonNullable<SiteMeta['seo']>>) => onChange({ seo: { ...meta.seo, ...p } })

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">{t('apSiteTitle')}</Label>
        <Input value={meta.title} onChange={(e) => onChange({ title: e.target.value })} className="h-9" />
      </div>

      {/* Theme — ONE control carrying both colour schemes. It replaces a
          light/dark/auto select that crossed with `meta.background`: "auto"
          followed the viewer for the text and not for the page, and a light
          theme over a dark background was patched by a luminance check that
          silently overrode the choice. See
          packages/shared/src/types/themePreset.ts for the full list, and for
          the hooks a custom theme will use later. */}
      <div className="space-y-2">
        <Label className="text-xs">{t('apTheme')}</Label>
        <ThemePresetPicker
          value={meta.themePreset ?? ''}
          onChange={(id) => onChange({ themePreset: id })}
          accentColor={meta.accentColor}
        />
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
          <Switch checked={meta.header.showNav} onCheckedChange={(v) => setHeader({ showNav: v })} />
        </label>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('apHeaderCtaLabel')}</Label>
          <Input
            value={meta.header.ctaLabel ?? ''}
            onChange={(e) => setHeader({ ctaLabel: e.target.value })}
            placeholder={t('apHeaderCtaPlaceholderOrg')}
            className="h-9"
          />
        </div>
        {meta.header.ctaLabel && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('apHeaderCtaUrl')}</Label>
            <Input
              value={meta.header.ctaUrl ?? ''}
              onChange={(e) => setHeader({ ctaAction: 'url', ctaUrl: e.target.value })}
              placeholder="https://"
              className="h-9 font-mono text-xs"
            />
          </div>
        )}
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
          <Input value={meta.seo?.title ?? ''} onChange={(e) => setSeo({ title: e.target.value })} className="h-9" />
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

/** See the team builder's copy of this: an un-headed section says nothing
 *  rather than repeating its own type name in English under a translated one. */
function sectionSummary(s: OrgSiteSection, t: (key: string, values?: Record<string, number>) => string): string {
  switch (s.type) {
    case 'hero':
      return s.headline
    case 'gallery':
      return t('summaryPhotos', { count: s.images.length })
    case 'content':
    case 'contact':
    case 'clubs':
    case 'locations':
    case 'coaches':
      return s.heading ?? ''
    default:
      return ''
  }
}

// ─── page ─────────────────────────────────────────────────────────────────────

const SITE_TABS = ['sections', 'appearance'] as const

export default function OrgWebsiteBuilderPage() {
  const t = useTranslations('OrgWebsite')
  const { orgId } = useParams<{ orgId: string }>()
  const { user } = useAuth()
  const { org, isAdmin, loading: orgLoading } = useOrg()
  const qc = useQueryClient()

  const { data: savedDraft, isLoading: draftLoading } = useOrgSiteDraft(orgId)
  const { data: previewTeams = [] } = useOrgPreviewTeams(orgId)

  const [draft, setDraft] = useState<OrgSiteDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  // A draft lives in this component's state until Save writes it, so leaving
  // the page throws the work away — silently, which is the part that makes it
  // expensive. See the hook for what it can and cannot intercept.
  useUnsavedChangesGuard(dirty, t('unsavedLeaveConfirm'))
  const [tab, setTab] = useTabParam(SITE_TABS, 'sections')
  const tSite = useTranslations('Site')
  // The `Website` namespace, for the copy this page shares with the studio's
  // builder. `MenuPanel` reads all of its own strings from there, so its heading
  // must come from the same place — pulled through `OrgWebsite` it rendered the
  // raw key id, which is what an untyped miss does (Franco, 2026-08-28).
  const tWeb = useTranslations('Website')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  // Same act, same treatment as the team-tier website (UX-50/UX-100): taking a
  // public site offline in one click. Fully REVERSIBLE and LOSSLESS —
  // `unpublishOrgSite` deletes the published copy and merges `enabled: false`
  // onto the draft, leaving its pages, wording and images alone — so the copy
  // says so instead of implying destruction.
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  // Initialise the working draft once data has settled.
  useEffect(() => {
    if (draft || draftLoading || !org) return
    setDraft(savedDraft ?? emptyOrgDraft({ id: org.id, name: org.name, slug: org.slug }))
  }, [draft, draftLoading, savedDraft, org])

  // ── mutators ──
  function mutate(updater: (d: OrgSiteDraft) => OrgSiteDraft) {
    setDraft((d) => (d ? updater(d) : d))
    setDirty(true)
  }
  const patchMeta = (patch: Partial<SiteMeta>) => mutate((d) => ({ ...d, meta: { ...d.meta, ...patch } }))
  const updateSection = (id: string, patch: Record<string, unknown>) =>
    mutate((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === id ? ({ ...s, ...patch } as OrgSiteSection) : s)),
    }))
  function addSection(type: OrgSiteSectionType) {
    if (draft && draft.sections.length >= MAX_SECTIONS) {
      toast.error(t('limitSections', { max: MAX_SECTIONS }))
      return
    }
    const sec = newOrgSection(type, org)
    mutate((d) => ({ ...d, sections: [...d.sections, sec] }))
    setOpenId(sec.id)
    setTab('sections')
  }
  const removeSection = (id: string) => mutate((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }))
  function reorderSections(from: number, to: number) {
    mutate((d) => ({ ...d, sections: arrayMove(d.sections, from, to) }))
  }

  // ── save / publish ──
  async function handleSave(): Promise<boolean> {
    if (!orgId || !user || !draft) return false
    setSaving(true)
    try {
      await saveOrgSiteDraft(orgId, user.uid, draft)
      setDirty(false)
      await qc.invalidateQueries({ queryKey: ['org-site-draft', orgId] })
      return true
    } catch {
      toast.error(t('errorSave'))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handlePublish() {
    if (!orgId || !draft) return
    if (!org?.slug) {
      toast.error(t('errorNoSlug'))
      return
    }
    setPublishing(true)
    try {
      const ok = await handleSave()
      if (!ok) return
      await publishOrgSite(orgId)
      setDraft((d) => (d ? { ...d, enabled: true } : d))
      await qc.invalidateQueries({ queryKey: ['org-published-site', orgId] })
      toast.success(t('published'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('errorPublish'))
    } finally {
      setPublishing(false)
    }
  }

  async function handleUnpublish() {
    if (!orgId) return
    setPublishing(true)
    try {
      await unpublishOrgSite(orgId)
      setDraft((d) => (d ? { ...d, enabled: false } : d))
      await qc.invalidateQueries({ queryKey: ['org-published-site', orgId] })
      toast.success(t('unpublished'))
    } catch {
      toast.error(t('errorPublish'))
    } finally {
      setPublishing(false)
    }
  }

  // ── gates ──
  if (orgLoading || draftLoading || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-10 text-center">
        <Globe className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{t('adminOnlyTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('adminOnlyBody')}</p>
      </div>
    )
  }

  const slug = org?.slug ?? draft.slug
  const siteUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/public/org/${slug}`
      : `/public/org/${slug}`
  const status = dirty ? t('statusUnsaved') : draft.enabled ? t('statusPublished') : t('statusDraft')
  // THE HEADER MENU — the same stored tree a studio edits, through the same
  // panel and the same sanitiser. Absent until the org first touches it, and
  // `deriveSiteMenu` then produces exactly the header it had before, which is
  // what makes this additive rather than a migration.
  //
  // `surfaceLinks: []` because an organisation has no cross-surface links to
  // offer: Shop, My space and Documents are studio surfaces. The panel simply
  // shows no surface rows.
  const menu: SiteMenuItem[] =
    draft.menu ?? deriveSiteMenu({ sections: draft.sections, surfaceLinks: [] })

  function setMenu(next: SiteMenuItem[]) {
    setDraft((d) => (d ? { ...d, menu: next } : d))
    setDirty(true)
  }

  const previewSite: RenderableSite = {
    name: draft.name,
    slug: draft.slug,
    meta: draft.meta,
    sections: draft.sections,
    menu,
    // From the ORG document, exactly as `publishOrgWebsite` reads it — so the
    // preview shows the social icons the published page will, rather than the
    // author discovering them only after publishing.
    socialLinks: org?.socialLinks,
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
          {/* The preview moved out of the sidebar column and into an overlay,
              so it needs a way in — same button, same place, as the studio's. */}
          <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(true)}>
            <Eye className="mr-1 h-4 w-4" />
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
              uploadImage={(file) => uploadOrgSiteImage(orgId, 'brand', file)}
            />
          ) : (
            <div className="space-y-2.5">
              <SortableList ids={draft.sections.map((s) => s.id)} onReorder={reorderSections}>
                {draft.sections.map((s) => {
                  const lib = ORG_SECTION_LIBRARY.find((l) => l.type === s.type)
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
                                {sectionSummary(s, tWeb as (k: string, v?: Record<string, number>) => string)}
                              </p>
                            </button>
                            <div className="flex items-center gap-0.5">
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
                              <button
                                type="button"
                                onClick={() => setDeleteId(s.id)}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                          {open && orgId && (
                            <div className="space-y-3 border-t p-3">
                              <OrgSectionEditor
                                section={s}
                                orgId={orgId}
                                onChange={(patch) => updateSection(s.id, patch)}
                              />
                              {s.type !== 'hero' && (
                                <label className="flex items-center justify-between rounded-lg border p-3">
                                  <span className="text-sm">{t('showInMenu')}</span>
                                  <Switch
                                    checked={s.showInNav !== false}
                                    onCheckedChange={(v) => updateSection(s.id, { showInNav: v })}
                                  />
                                </label>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </SortableItem>
                  )
                })}
              </SortableList>

              {/* Add section — the same grouped-tile dialog the team builder
                  opens. 'managed' sections (none today) are authored by Linyup,
                  not offered here — but stay editable once present. */}
              <SectionPicker
                entries={ORG_SECTION_LIBRARY.filter((lib) => lib.maturity !== 'managed')}
                t={(key) => t(key as Parameters<typeof t>[0])}
                onPick={addSection}
              />
            </div>
          )}
        </div>

        {/* Right: the MENU EDITOR, where the sticky preview column used to be.
            That column showed a permanently-narrow rendering of a site whose
            header collapses below the width it was pinned at — see
            PreviewOverlay's header for the full argument. The preview opens over
            the page now, and the width it freed is what the menu tree needs.

            Beside the Sections tab only: a header menu is a list of sections, so
            next to Appearance it would answer a question nobody asked. */}
        {tab === 'sections' && (
          <div className="space-y-2 lg:w-[420px] lg:flex-shrink-0 lg:self-start">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ListTree className="h-3.5 w-3.5" />
              {tWeb('tabMenu')}
            </div>
            <MenuPanel
              menu={menu}
              sections={draft.sections}
              surfaces={[]}
              surfaceLabel={() => ''}
              sectionLabel={(sec) => sectionNavLabel(sec, tSite)}
              onChange={setMenu}
            />
          </div>
        )}
      </div>

      {/* `orgId` + `orgTeams` are what the clubs, locations and coaches blocks
          aggregate over — without them the preview would silently drop three of
          the seven section types. */}
      <PreviewOverlay
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        site={previewSite}
        orgId={orgId}
        orgTeams={previewTeams}
      />

      {/* Unpublish confirmation. States the consequence in the visitor's terms
          — the site goes offline now — and then states, equally plainly, that
          nothing is lost. NOT styled destructive: this deletes no work. */}
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
    </div>
  )
}
