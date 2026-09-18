'use client'

// The organisation site builder's per-type editor forms — the sections only an
// ORGANISATION has (clubs / locations / coaches) and its own call-to-action.
//
// The four types both builders share — hero, content, gallery, contact — come
// from `components/website/SiteSectionFields`, which is also where the image box
// and the size limits live. This file kept private copies of all of it until
// 2026-08-28; see that module's header for what had drifted in the meantime.

import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  OrgSiteSection,
  ClubsSection,
  LocationsSection,
  CoachesSection,
  SiteCta,
} from '@linyup/shared'
import { uploadOrgSiteImage } from './hooks'
import { newSectionId } from '@/plugins/website/defaults'
import {
  ContactFields,
  ContentFields,
  CtaBannerFields,
  FaqFields,
  FeaturesFields,
  Field,
  PostsFields,
  GalleryFields,
  HeroFields,
  TestimonialsFields,
  VideoFields,
  type SiteEditorTenant,
} from '@/components/website/SiteSectionFields'

// ─── small field helper ─────────────────────────────────────────────────────

// ─── the organisation's CTA, and the sections only an org has ──────────────
//
// The four section types both builders share — hero, content, gallery, contact —
// and their field helpers live in `components/website/SiteSectionFields`. This
// file kept its own copies until 2026-08-28, and they had drifted: four labels
// were hardcoded English in a file whose every other label was translated, and
// the image-size limit was a bare constant where the team's went through the
// operator-override seam.
//
// WHAT STAYS IS WHAT AN ORGANISATION CAN DO AND A STUDIO CANNOT: the three
// aggregate sections below, and a call-to-action that is a plain URL. A studio's
// CTA can name its booking page or its signup form; an organisation has neither
// surface, so offering those actions would render a button pointing nowhere.

type Patch = Record<string, unknown>

/**
 * An org button's destination — a page of the org's own site, or an external
 * link. Never booking, signup or an appointment: an organisation has none of
 * those surfaces, and the publish sanitizer drops such a button anyway.
 */
function OrgCtaEditor({
  cta,
  pages,
  onChange,
}: {
  cta?: SiteCta
  /** The site's other pages, offered as a destination. */
  pages?: { id: string; label: string }[]
  onChange: (p: Patch) => void
}) {
  const t = useTranslations('Website')
  const action = cta?.action === 'page' ? 'page' : 'url'
  const set = (next: Partial<SiteCta>) => {
    const merged = { label: cta?.label ?? '', action, ...cta, ...next } as SiteCta
    onChange({ cta: merged.label ? merged : undefined })
  }
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground">{t('editorCtaTitle')}</p>
      <Field label={t('editorCtaLabel')}>
        <Input
          value={cta?.label ?? ''}
          onChange={(e) => set({ label: e.target.value, action })}
          placeholder={t('editorOrgCtaPlaceholder')}
          className="h-9"
        />
      </Field>
      {cta?.label && (
        <>
          {(pages?.length ?? 0) > 0 && (
            <Field label={t('editorCtaAction')}>
              <Select value={action} onValueChange={(v) => set({ action: v as SiteCta['action'] })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="page">{t('editorCtaActionPage')}</SelectItem>
                  <SelectItem value="url">{t('editorCtaActionUrl')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {action === 'page' ? (
            <Field label={t('editorCtaPage')}>
              <Select value={cta.pageId ?? ''} onValueChange={(v) => set({ pageId: v || undefined })}>
                <SelectTrigger className="h-9"><SelectValue placeholder={t('editorCtaPagePlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {(pages ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <Field label={t('editorCtaUrl')}>
              <Input
                value={cta.url ?? ''}
                onChange={(e) => set({ url: e.target.value })}
                placeholder="https://"
                className="h-9 font-mono text-xs"
              />
            </Field>
          )}
        </>
      )}
    </div>
  )
}


// ─── org-only aggregate editors ────────────────────────────────────────────────

function ColumnsField({
  columns,
  onChange,
}: {
  columns: 2 | 3 | 4
  onChange: (v: number) => void
}) {
  const t = useTranslations('Website')
  return (
    <Field label={t('editorColumns')}>
      <Select value={String(columns)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="h-9 w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="2">2</SelectItem>
          <SelectItem value="3">3</SelectItem>
          <SelectItem value="4">4</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
}

function ClubsFields({ s, onChange }: { s: ClubsSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {t('editorOrgClubsNote')}
      </p>
      <Field label={t('editorHeading')}>
        <Input
          value={s.heading ?? ''}
          onChange={(e) => onChange({ heading: e.target.value })}
          placeholder={t('editorOrgClubsHeadingPlaceholder')}
          className="h-9"
        />
      </Field>
      <Field label={t('editorSubheading')}>
        <Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorOrgClubsLayout')}>
        <Select
          value={s.layout ?? 'cards'}
          onValueChange={(v) => onChange({ layout: v as 'cards' | 'list' })}
        >
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cards">{t('editorOrgClubsLayoutCards')}</SelectItem>
            <SelectItem value="list">{t('editorOrgClubsLayoutList')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {/* Columns only mean something in the grid — a list has one. */}
      {(s.layout ?? 'cards') === 'cards' && (
        <ColumnsField columns={s.columns} onChange={(v) => onChange({ columns: v })} />
      )}
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('editorOrgShowAddressOnCards')}</span>
        <Switch checked={s.showAddress ?? false} onCheckedChange={(v) => onChange({ showAddress: v })} />
      </label>
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('editorOrgClubsSearchable')}</span>
        <Switch checked={s.searchable ?? false} onCheckedChange={(v) => onChange({ searchable: v })} />
      </label>
    </div>
  )
}

function LocationsFields({ s, onChange }: { s: LocationsSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  const extra = s.extra ?? []

  function addExtra() {
    onChange({ extra: [...extra, { id: newSectionId(), name: '' }] })
  }
  function updateExtra(id: string, patch: Partial<{ name: string; address: string; mapsLink: string }>) {
    onChange({ extra: extra.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
  }
  function removeExtra(id: string) {
    onChange({ extra: extra.filter((e) => e.id !== id) })
  }

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {t('editorOrgLocationsNote')}
      </p>
      <Field label={t('editorHeading')}>
        <Input
          value={s.heading ?? ''}
          onChange={(e) => onChange({ heading: e.target.value })}
          placeholder={t('editorPlacesHeadingPlaceholder')}
          className="h-9"
        />
      </Field>
      <Field label={t('editorSubheading')}>
        <Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" />
      </Field>
      <ColumnsField columns={s.columns} onChange={(v) => onChange({ columns: v })} />

      <div className="space-y-2">
        <Label className="text-xs">{t('editorOrgExtraVenues')}</Label>
        {extra.map((e) => (
          <div key={e.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <Input
                  value={e.name}
                  onChange={(ev) => updateExtra(e.id, { name: ev.target.value })}
                  placeholder={t('editorOrgVenueName')}
                  className="h-9"
                />
                <Textarea
                  value={e.address ?? ''}
                  onChange={(ev) => updateExtra(e.id, { address: ev.target.value })}
                  placeholder={t('editorAddress')}
                  rows={2}
                />
                <Input
                  value={e.mapsLink ?? ''}
                  onChange={(ev) => updateExtra(e.id, { mapsLink: ev.target.value })}
                  placeholder={t('editorOrgMapsLink')}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeExtra(e.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={addExtra}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-input py-2.5 text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
          {t('editorOrgAddVenue')}
        </button>
      </div>
    </div>
  )
}

function CoachesFields({ s, onChange }: { s: CoachesSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {t('editorOrgCoachesNote')}
      </p>
      <Field label={t('editorHeading')}>
        <Input
          value={s.heading ?? ''}
          onChange={(e) => onChange({ heading: e.target.value })}
          placeholder={t('editorOrgCoachesHeadingPlaceholder')}
          className="h-9"
        />
      </Field>
      <Field label={t('editorSubheading')}>
        <Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" />
      </Field>
      <ColumnsField columns={s.columns} onChange={(v) => onChange({ columns: v })} />
    </div>
  )
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export function OrgSectionEditor({
  section,
  orgId,
  pages,
  onChange,
}: {
  section: OrgSiteSection
  orgId: string
  /** The site's other pages — offered as button destinations. */
  pages?: { id: string; label: string }[]
  onChange: (patch: Patch) => void
}) {
  const tenant: SiteEditorTenant = {
    kind: 'org',
    id: orgId,
    uploadImage: (sectionId, file) => uploadOrgSiteImage(orgId, sectionId, file),
  }
  switch (section.type) {
    case 'hero':
      return (
        <HeroFields
          s={section}
          tenant={tenant}
          onChange={onChange}
          cta={<OrgCtaEditor cta={section.cta} pages={pages} onChange={onChange} />}
        />
      )
    case 'content':
      return <ContentFields s={section} tenant={tenant} onChange={onChange} />
    case 'gallery':
      return <GalleryFields s={section} tenant={tenant} onChange={onChange} />
    case 'contact':
      return <ContactFields s={section} onChange={onChange} />
    // The presentational sections, from the shared module — the same components
    // the team builder mounts. `OrgCtaEditor` is passed in for the same reason
    // the hero above takes it: an org's call to action has no booking page to
    // point at, so the TARGETS differ while the fields do not.
    case 'features':
      return <FeaturesFields s={section} tenant={tenant} onChange={onChange} />
    case 'cta_banner':
      return (
        <CtaBannerFields
          s={section}
          tenant={tenant}
          onChange={onChange}
          cta={<OrgCtaEditor cta={section.cta} pages={pages} onChange={onChange} />}
        />
      )
    case 'faq':
      return <FaqFields s={section} onChange={onChange} />
    case 'testimonials':
      return <TestimonialsFields s={section} onChange={onChange} />
    case 'video':
      return <VideoFields key={section.id} s={section} tenant={tenant} onChange={onChange} />
    case 'clubs':
      return <ClubsFields s={section} onChange={onChange} />
    case 'locations':
      return <LocationsFields s={section} onChange={onChange} />
    case 'coaches':
      return <CoachesFields s={section} onChange={onChange} />
    case 'posts':
      return <PostsFields s={section} onChange={onChange} />
    default:
      return null
  }
}
