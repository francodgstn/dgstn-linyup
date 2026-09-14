'use client'

/**
 * THE SECTION FIELD EDITORS BOTH SITE BUILDERS SHARE.
 *
 * A studio's website and an organisation's are authored by two components —
 * `plugins/website/SectionEditor.tsx` and `org/[orgId]/website/OrgSectionEditor.tsx`
 * — and four of their section types are literally the same type: `HeroSection`,
 * `ContentSection`, `GallerySection` and `ContactSection` are declared once in
 * `@linyup/shared` and admitted by both unions. The render layer, the type layer
 * and the sanitiser were shared already; only the authoring SHELL was copied,
 * and a copy drifts.
 *
 * It had drifted, in ways that were invisible until the two were read side by
 * side (all three fixed by this move):
 *
 *   • The org copy was missing translations the team copy had — `Center`,
 *     `Left`, `Right`, `Overlay (40%)` and "Call-to-action button" were
 *     hardcoded English in a file whose every other label went through
 *     `useTranslations`. A German org admin authored their site half in English.
 *   • Its image-size limit was a bare `const MAX_IMAGE_SIZE_MB = 5` where the
 *     team's goes through `getWebsiteLimits()`, the seam that exists so an
 *     operator can raise it. Same number today, one of them unreachable.
 *   • `ContactFields` was identical in behaviour and different in whitespace,
 *     which is the state a copy reaches just before someone edits one of them.
 *
 * ── THE DISCRIMINATOR CARRIES BEHAVIOUR, NOT A LABEL ────────────────────────
 * `SiteEditorTenant.kind` exists for anything that must branch on which tenant
 * is authoring — but the thing that actually differs between them is WHERE AN
 * IMAGE GOES, so the tenant carries its own `uploadImage` rather than this
 * module importing both upload helpers and switching on the enum. That also
 * keeps a shared component from importing out of an app route.
 *
 * ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
 * The sections only one tenant has: Activities, Pricing, Schedule and Places are
 * team-scoped commerce, and Clubs, Locations and Coaches are org aggregates.
 * Neither set belongs in the other's union, so neither belongs here.
 *
 * The HERO'S CALL TO ACTION is a SLOT for the same reason. A studio's can point
 * at its booking page or its signup form; an organisation has neither surface,
 * so its CTA is a plain URL. That is a real difference in what the tenants CAN
 * do, not drift, so each builder passes its own control in.
 */

import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ImageIcon, X, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconPicker } from '@/components/ui/icon-picker'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/ui/color-picker'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type {
  FeaturesSection,
  CtaBannerSection,
  FaqSection,
  TestimonialsSection,
  VideoSection,
  HeroSection, ContentSection, GallerySection, ContactSection,
} from '@linyup/shared'
import { parseVideoUrl } from '@linyup/shared'
import { RichTextEditor } from '@/components/RichTextEditor'
import { getWebsiteLimits } from '@/plugins/website/limits'

const limits = getWebsiteLimits()

export type Patch = Record<string, unknown>

/** Who is authoring, and the one thing that differs between them. */
export interface SiteEditorTenant {
  kind: 'team' | 'org'
  id: string
  /** Where an image uploaded from this editor is stored. */
  uploadImage: (sectionId: string, file: File) => Promise<string>
}

// ─── small field helper ─────────────────────────────────────────────────────

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

// ─── image field ────────────────────────────────────────────────────────────

/**
 * The image box, filled or empty — ONE definition, so the form does not move
 * when a picture arrives.
 *
 * TWO THINGS WERE WRONG. The wide variant was `h-28 w-full`: a fixed 112px tall
 * band stretched across whatever the column happened to be, which after the
 * preview pane moved into an overlay is roughly 5:1 — a letterbox that shows
 * almost nothing of a photograph and looks broken beside the fields around it.
 * And the empty state was `h-20` against the filled `h-28`, so uploading an
 * image shifted every field below it down by 32px.
 *
 * `aspect-video` because that is what these images ARE — a hero background and a
 * section side image both publish wide — and a width cap so the box sits inline
 * with the inputs above it rather than spanning the panel.
 */
const BOX = {
  wide: 'aspect-video w-full max-w-xs',
  square: 'aspect-square w-20',
} as const

export function ImageField({
  label, url, tenant, sectionId, onChange, aspect = 'wide',
}: {
  label: string
  url?: string
  tenant: SiteEditorTenant
  sectionId: string
  onChange: (url: string | undefined) => void
  aspect?: 'wide' | 'square'
}) {
  const t = useTranslations('Website')
  const ref = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function handle(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > limits.maxImageSizeMB * 1024 * 1024) {
      toast.error(t('editorImageTooLarge', { mb: limits.maxImageSizeMB }))
      return
    }
    setUploading(true)
    try {
      const u = await tenant.uploadImage(sectionId, file)
      onChange(u)
    } catch {
      toast.error(t('editorUploadFailed'))
    } finally {
      setUploading(false)
      if (ref.current) ref.current.value = ''
    }
  }

  return (
    <Field label={label}>
      {url ? (
        <div className={`relative overflow-hidden rounded-lg border bg-muted ${BOX[aspect]}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 hover:bg-background"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          disabled={uploading}
          className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:opacity-50 ${BOX[aspect]}`}
        >
          <ImageIcon className="h-4 w-4" />
          {uploading ? t('editorUploading') : t('editorUpload')}
        </button>
      )}
      <input ref={ref} type="file" accept="image/*" onChange={handle} className="hidden" />
    </Field>
  )
}

// ─── the four shared section types ──────────────────────────────────────────

export function HeroFields({
  s, tenant, onChange, cta,
}: {
  s: HeroSection
  tenant: SiteEditorTenant
  onChange: (p: Patch) => void
  /** The tenant's own call-to-action control — see the note at the top. */
  cta: React.ReactNode
}) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      <Field label={t('editorHeadline')}>
        <Input value={s.headline} onChange={(e) => onChange({ headline: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorSubheadline')}>
        <Textarea value={s.subheadline ?? ''} onChange={(e) => onChange({ subheadline: e.target.value })} rows={2} />
      </Field>
      <ImageField label={t('editorBackgroundImage')} url={s.bgImageUrl} tenant={tenant} sectionId={s.id} onChange={(u) => onChange({ bgImageUrl: u })} />
      <Field label={t('editorBgVideoUrl')}>
        <Input
          value={s.bgVideoUrl ?? ''}
          onChange={(e) => onChange({ bgVideoUrl: e.target.value || undefined })}
          placeholder={t('editorBgVideoUrlPlaceholder')}
          className="h-9 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">{t('editorHeroBgVideoHint')}</p>
      </Field>
      {/* The colour is read only WHEN THERE IS NO IMAGE (see HeroSection.bgColor) —
          hidden here the moment one is uploaded, so the control never implies it
          does something it does not. */}
      {!s.bgImageUrl && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t('editorHeroBgColor')}</Label>
            {s.bgColor && (
              <button
                type="button"
                onClick={() => onChange({ bgColor: undefined })}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t('editorHeroBgColorClear')}
              </button>
            )}
          </div>
          <ColorPicker value={s.bgColor} onChange={(hex) => onChange({ bgColor: hex })} aria-label={t('editorHeroBgColor')} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('editorAlignment')}>
          <Select value={s.align} onValueChange={(v) => onChange({ align: v })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="center">{t('editorCenter')}</SelectItem>
              <SelectItem value="left">{t('editorLeft')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('editorHeroLayout')}>
          <Select
            value={s.layout ?? 'full'}
            onValueChange={(v) => onChange({ layout: v === 'full' ? undefined : (v as HeroSection['layout']) })}
          >
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="full">{t('editorHeroLayoutFull')}</SelectItem>
              <SelectItem value="card">{t('editorHeroLayoutCard')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t('editorOverlay', { percent: s.overlay ?? 40 })}>
        <input
          type="range" min={0} max={100} value={s.overlay ?? 40}
          onChange={(e) => onChange({ overlay: Number(e.target.value) })}
          className="w-full accent-primary"
        />
      </Field>
      {/* How the shading lies over the photo, and its colour. Only meaningful with
          a background image or video — a solid colour hero has nothing to shade. */}
      {(s.bgImageUrl || s.bgVideoUrl) && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('editorHeroOverlayStyle')}>
            <Select
              value={s.overlayStyle ?? 'solid'}
              onValueChange={(v) =>
                onChange({ overlayStyle: v === 'solid' ? undefined : (v as HeroSection['overlayStyle']) })
              }
            >
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">{t('editorHeroOverlaySolid')}</SelectItem>
                <SelectItem value="gradient-left">{t('editorHeroOverlayGradientLeft')}</SelectItem>
                <SelectItem value="gradient-bottom">{t('editorHeroOverlayGradientBottom')}</SelectItem>
                <SelectItem value="gradient-left-bottom">{t('editorHeroOverlayGradientLeftBottom')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('editorHeroOverlayTone')}>
            <Select
              value={s.overlayTone ?? 'dark'}
              onValueChange={(v) =>
                onChange({ overlayTone: v === 'dark' ? undefined : (v as HeroSection['overlayTone']) })
              }
            >
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">{t('editorHeroOverlayDark')}</SelectItem>
                <SelectItem value="light">{t('editorHeroOverlayLight')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      {cta}
    </div>
  )
}

export function ContentFields({
  s, tenant, onChange,
}: {
  s: ContentSection
  tenant: SiteEditorTenant
  onChange: (p: Patch) => void
}) {
  // RichTextEditor is uncontrolled after mount and memoized: pass STABLE
  // callbacks (latest onChange via a ref) so typing never re-mounts it, and key
  // it by section id so switching sections loads the right body.
  const t = useTranslations('Website')
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const handleBody = useCallback((html: string) => onChangeRef.current({ body: html }), [])
  const upload = tenant.uploadImage
  const handleUpload = useCallback((file: File) => upload(s.id, file), [upload, s.id])

  return (
    <div className="space-y-3">
      <Field label={t('editorTitleOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorContent')}>
        <RichTextEditor
          key={s.id}
          value={s.body}
          onChange={handleBody}
          onUploadImage={handleUpload}
          minHeight={240}
          placeholder={t('editorContentPlaceholder')}
        />
      </Field>
      <ImageField label={t('editorImageOptional')} url={s.imageUrl} tenant={tenant} sectionId={s.id} onChange={(u) => onChange({ imageUrl: u })} />
      {s.imageUrl && (
        <Field label={t('editorImageSide')}>
          <Select value={s.imageSide} onValueChange={(v) => onChange({ imageSide: v })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="left">{t('editorLeft')}</SelectItem>
              <SelectItem value="right">{t('editorRight')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
    </div>
  )
}

export function GalleryFields({
  s, tenant, onChange,
}: {
  s: GallerySection
  tenant: SiteEditorTenant
  onChange: (p: Patch) => void
}) {
  const t = useTranslations('Website')
  const addRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const layout = s.layout ?? 'grid'
  const setCaption = (i: number, caption: string) =>
    onChange({ images: s.images.map((img, j) => (j === i ? { ...img, caption: caption || undefined } : img)) })

  async function addImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (s.images.length >= limits.maxGalleryImages) {
      toast.error(t('editorGalleryLimit', { count: limits.maxGalleryImages }))
      return
    }
    if (file.size > limits.maxImageSizeMB * 1024 * 1024) {
      toast.error(t('editorImageTooLarge', { mb: limits.maxImageSizeMB }))
      return
    }
    setUploading(true)
    try {
      const url = await tenant.uploadImage(s.id, file)
      onChange({ images: [...s.images, { url }] })
    } catch {
      toast.error(t('editorUploadFailed'))
    } finally {
      setUploading(false)
      if (addRef.current) addRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      <Field label={t('editorHeadingOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('editorGalleryLayout')}>
          <Select
            value={layout}
            onValueChange={(v) => onChange({ layout: v === 'grid' ? undefined : (v as GallerySection['layout']) })}
          >
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="grid">{t('editorGalleryLayoutGrid')}</SelectItem>
              <SelectItem value="marquee">{t('editorGalleryLayoutMarquee')}</SelectItem>
              <SelectItem value="logos">{t('editorGalleryLayoutLogos')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {/* Logos are never cropped or arranged into columns — the setting would
            be meaningless there, so it's hidden rather than reset (switching
            back to grid restores whatever the studio had picked). */}
        {layout !== 'logos' && (
          <Field label={t('editorColumns')}>
            <Select value={String(s.columns)} onValueChange={(v) => onChange({ columns: Number(v) })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
                <SelectItem value="4">4</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      <Field label={t('editorPhotos', { count: s.images.length, max: limits.maxGalleryImages })}>
        <div className="grid grid-cols-3 gap-2">
          {s.images.map((img, i) => (
            <div key={i} className="space-y-1">
              <div className="relative aspect-square overflow-hidden rounded-md border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onChange({ images: s.images.filter((_, j) => j !== i) })}
                  className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 hover:bg-background"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <Input
                value={img.caption ?? ''}
                onChange={(e) => setCaption(i, e.target.value)}
                placeholder={t('editorGalleryCaption')}
                className="h-7 text-[11px]"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => addRef.current?.click()}
            disabled={uploading}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-input text-xs text-muted-foreground hover:border-primary/50 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {uploading ? '…' : t('editorAdd')}
          </button>
        </div>
        <input ref={addRef} type="file" accept="image/*" onChange={addImage} className="hidden" />
      </Field>
    </div>
  )
}

export function ContactFields({ s, onChange }: { s: ContactSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      <Field label={t('editorHeading')}><Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} placeholder={t('editorContactHeadingPlaceholder')} className="h-9" /></Field>
      <Field label={t('editorAddress')}><Textarea value={s.address ?? ''} onChange={(e) => onChange({ address: e.target.value })} rows={2} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('editorPhone')}><Input value={s.phone ?? ''} onChange={(e) => onChange({ phone: e.target.value })} className="h-9" /></Field>
        <Field label={t('editorEmail')}><Input value={s.email ?? ''} onChange={(e) => onChange({ email: e.target.value })} className="h-9" /></Field>
      </div>
      <Field label={t('editorHours')}><Textarea value={s.hours ?? ''} onChange={(e) => onChange({ hours: e.target.value })} rows={2} placeholder={t('editorHoursPlaceholder')} /></Field>
      {/* The map placeholder stays a REAL Swiss address rather than becoming
          "Street 1, City": it is an example of the format the lookup wants, and a
          translated abstraction stops showing that. */}
      <Field label={t('editorMapLocation')}><Input value={s.mapQuery ?? ''} onChange={(e) => onChange({ mapQuery: e.target.value })} className="h-9" placeholder={t('editorMapPlaceholder')} /></Field>
      {/* Both tenants can show social links now. The org's switch was removed on
          2026-08-28 because `Organization` had no such field and nothing could
          set any — then put back the same day with the field, an editor in
          Organisation settings, and `publishOrgWebsite` (which had been reading
          `org.socialLinks` defensively all along) finally having something to
          read. */}
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('editorShowSocial')}</span>
        <Switch checked={s.showSocial ?? false} onCheckedChange={(v) => onChange({ showSocial: v })} />
      </label>
    </div>
  )
}

// ─── presentational sections, shared by BOTH builders ───────────────────────
//
// Features, CTA banner, FAQ and testimonials say something about whoever owns
// the site; none of them is commerce, so none is studio-only. They lived in the
// team editor purely because that is where they were written, and the org
// builder simply predated them.

export function FeaturesFields({
  s, tenant, onChange,
}: {
  s: FeaturesSection
  tenant: SiteEditorTenant
  onChange: (p: Patch) => void
}) {
  const t = useTranslations('Website')
  const items = s.items ?? []
  const style = s.style ?? 'cards'
  const set = (i: number, patch: Partial<(typeof items)[number]>) =>
    onChange({ items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) })
  return (
    <div className="space-y-3">
      <Field label={t('editorHeadingOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorSubheadingOptional')}>
        <Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('editorColumns')}>
          <Select value={String(s.columns)} onValueChange={(v) => onChange({ columns: Number(v) })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="4">4</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('editorFeaturesStyle')}>
          <Select
            value={style}
            onValueChange={(v) => onChange({ style: v === 'cards' ? undefined : (v as FeaturesSection['style']) })}
          >
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cards">{t('editorFeaturesStyleCards')}</SelectItem>
              <SelectItem value="stats">{t('editorFeaturesStyleStats')}</SelectItem>
              <SelectItem value="checklist">{t('editorFeaturesStyleChecklist')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              {/* A stats row is figures, not icons — the icon picker only
                  makes sense for a card or a checklist tick. */}
              {style !== 'stats' && <IconPicker value={item.icon} onChange={(name) => set(i, { icon: name })} />}
              <Input
                value={item.title}
                placeholder={style === 'stats' ? t('editorFeatureFigure') : t('editorFeatureTitle')}
                onChange={(e) => set(i, { title: e.target.value })}
                className="h-9"
              />
              <button
                type="button"
                onClick={() => onChange({ items: items.filter((_, j) => j !== i) })}
                disabled={items.length <= 1}
                className="mt-1.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                aria-label={t('editorItemRemove')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <Textarea
              value={item.text ?? ''}
              placeholder={style === 'stats' ? t('editorFeatureCaption') : t('editorFeatureText')}
              onChange={(e) => set(i, { text: e.target.value })}
              rows={2}
            />
            {/* An image replaces the icon, so it only means something for the
                card style — a checklist tick or a stat figure has no top slot
                to put it in. */}
            {style === 'cards' && (
              <ImageField
                label={t('editorImageOptional')}
                url={item.imageUrl}
                tenant={tenant}
                sectionId={s.id}
                onChange={(u) => set(i, { imageUrl: u })}
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={item.linkLabel ?? ''}
                placeholder={t('editorLinkLabel')}
                onChange={(e) => set(i, { linkLabel: e.target.value })}
                className="h-9"
              />
              <Input
                value={item.linkUrl ?? ''}
                placeholder="https://…"
                onChange={(e) => set(i, { linkUrl: e.target.value })}
                className="h-9"
              />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('editorFeatureLinkHint')}</p>
      <AddItemButton
        label={t('editorAddFeature')}
        onClick={() => onChange({ items: [...items, { icon: 'Sparkles', title: '' }] })}
      />
    </div>
  )
}

export function CtaBannerFields({
  s,
  tenant,
  onChange,
  cta,
}: {
  s: CtaBannerSection
  tenant: SiteEditorTenant
  onChange: (p: Patch) => void
  /** The tenant's own call-to-action control, passed in for the same reason
   *  `HeroFields` takes one: a studio's CTA can point at its booking page or
   *  signup form, and an organisation has neither. */
  cta: React.ReactNode
}) {
  const t = useTranslations('Website')
  const style = s.style ?? 'card'
  return (
    <div className="space-y-3">
      <Field label={t('editorHeading')}>
        <Input value={s.heading} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorTextOptional')}>
        <Textarea value={s.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} rows={2} />
      </Field>
      <Field label={t('editorCtaBannerStyle')}>
        <Select
          value={style}
          onValueChange={(v) => onChange({ style: v === 'card' ? undefined : (v as CtaBannerSection['style']) })}
        >
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="card">{t('editorCtaBannerStyleCard')}</SelectItem>
            <SelectItem value="band">{t('editorCtaBannerStyleBand')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {/* A band spans the page and can carry a background image (dimmed so the
          text stays readable); a centred card has no edge-to-edge surface for
          one to sit on. */}
      {style === 'band' && (
        <ImageField
          label={t('editorBackgroundImage')}
          url={s.bgImageUrl}
          tenant={tenant}
          sectionId={s.id}
          onChange={(u) => onChange({ bgImageUrl: u })}
        />
      )}
      {cta}
    </div>
  )
}

/**
 * A YouTube/Vimeo film. Only `provider` + `videoId` are ever written — never an
 * embed URL — so the studio pastes an ordinary share link and `parseVideoUrl`
 * (the ONE parser, `@linyup/shared`) turns it into the stored pair. The raw
 * text lives in local state so typing (or a link that briefly looks invalid
 * mid-paste) is never fought; an empty box clears both stored fields.
 */
export function VideoFields({
  s, tenant, onChange,
}: {
  s: VideoSection
  tenant: SiteEditorTenant
  onChange: (p: Patch) => void
}) {
  const t = useTranslations('Website')
  const [draft, setDraft] = useState('')
  const [touched, setTouched] = useState(false)
  const display = s.display ?? 'inline'

  function handleLink(value: string) {
    setDraft(value)
    setTouched(true)
    const trimmed = value.trim()
    if (!trimmed) {
      onChange({ provider: undefined, videoId: undefined })
      return
    }
    const parsed = parseVideoUrl(trimmed)
    if (parsed) onChange({ provider: parsed.provider, videoId: parsed.videoId })
  }

  const invalid = touched && draft.trim() !== '' && !parseVideoUrl(draft.trim())
  const providerLabel = s.provider === 'youtube' ? 'YouTube' : s.provider === 'vimeo' ? 'Vimeo' : null

  return (
    <div className="space-y-3">
      <Field label={t('editorVideoLink')}>
        <Input
          value={draft}
          onChange={(e) => handleLink(e.target.value)}
          placeholder={t('editorVideoLinkPlaceholder')}
          className="h-9 font-mono text-xs"
        />
        {invalid && <p className="text-xs text-destructive">{t('editorVideoLinkInvalid')}</p>}
        {!invalid && providerLabel && s.videoId && (
          <p className="text-xs text-muted-foreground">
            {t('editorVideoCurrent', { provider: providerLabel, id: s.videoId })}
          </p>
        )}
      </Field>
      <Field label={t('editorHeadingOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorTextOptional')}>
        <Textarea value={s.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} rows={2} />
      </Field>
      <Field label={t('editorVideoDisplay')}>
        <Select
          value={display}
          onValueChange={(v) => onChange({ display: v === 'inline' ? undefined : (v as VideoSection['display']) })}
        >
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inline">{t('editorVideoDisplayInline')}</SelectItem>
            <SelectItem value="lightbox">{t('editorVideoDisplayLightbox')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {display === 'lightbox' && (
        <Field label={t('editorVideoPlayLabel')}>
          <Input
            value={s.playLabel ?? ''}
            onChange={(e) => onChange({ playLabel: e.target.value })}
            placeholder={t('editorVideoPlayLabelPlaceholder')}
            className="h-9"
          />
        </Field>
      )}
      <Field label={t('editorBgVideoUrl')}>
        <Input
          value={s.bgVideoUrl ?? ''}
          onChange={(e) => onChange({ bgVideoUrl: e.target.value || undefined })}
          placeholder={t('editorBgVideoUrlPlaceholder')}
          className="h-9 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">{t('editorVideoBgVideoHint')}</p>
      </Field>
      <ImageField
        label={t('editorVideoPoster')}
        url={s.posterUrl}
        tenant={tenant}
        sectionId={s.id}
        onChange={(u) => onChange({ posterUrl: u })}
      />
    </div>
  )
}

export function FaqFields({ s, onChange }: { s: FaqSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  const items = s.items ?? []
  const set = (i: number, patch: Partial<(typeof items)[number]>) =>
    onChange({ items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) })
  return (
    <div className="space-y-3">
      <Field label={t('editorHeadingOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <Input
                value={item.question}
                placeholder={t('editorFaqQuestion')}
                onChange={(e) => set(i, { question: e.target.value })}
                className="h-9"
              />
              <button
                type="button"
                onClick={() => onChange({ items: items.filter((_, j) => j !== i) })}
                disabled={items.length <= 1}
                className="mt-1.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                aria-label={t('editorItemRemove')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <Textarea
              value={item.answer}
              placeholder={t('editorFaqAnswer')}
              onChange={(e) => set(i, { answer: e.target.value })}
              rows={2}
            />
          </div>
        ))}
      </div>
      <AddItemButton
        label={t('editorAddFaq')}
        onClick={() => onChange({ items: [...items, { question: '', answer: '' }] })}
      />
    </div>
  )
}

export function TestimonialsFields({ s, onChange }: { s: TestimonialsSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  const items = s.items ?? []
  const set = (i: number, patch: Partial<(typeof items)[number]>) =>
    onChange({ items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) })
  return (
    <div className="space-y-3">
      <Field label={t('editorHeadingOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <Input
                value={item.name}
                placeholder={t('editorTestimonialName')}
                onChange={(e) => set(i, { name: e.target.value })}
                className="h-9"
              />
              <Input
                value={item.activity ?? ''}
                placeholder={t('editorTestimonialActivity')}
                onChange={(e) => set(i, { activity: e.target.value })}
                className="h-9"
              />
              <button
                type="button"
                onClick={() => onChange({ items: items.filter((_, j) => j !== i) })}
                disabled={items.length <= 1}
                className="mt-1.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                aria-label={t('editorItemRemove')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <Textarea
              value={item.feedback}
              placeholder={t('editorTestimonialFeedback')}
              onChange={(e) => set(i, { feedback: e.target.value })}
              rows={2}
            />
          </div>
        ))}
      </div>
      <AddItemButton
        label={t('editorAddTestimonial')}
        onClick={() => onChange({ items: [...items, { name: '', feedback: '' }] })}
      />
    </div>
  )
}

function AddItemButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} className="w-full">
      <Plus className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  )
}
