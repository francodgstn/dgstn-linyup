'use client'

// Brand controls for a public website — logo, typefaces, heading case, button
// shape and color, the top bar, and the footer. ONE component, mounted by both
// the studio builder and the organization builder, so the two cannot drift
// apart the way their appearance panels once did (docs/open-defects.md).
//
// The link lists here (top bar, footer columns, legal row) are deliberately
// FLAT label + destination rows, not the header's menu tree: the publish
// sanitizer drops any nesting in them anyway. Every link item gets an id minted
// with a list-specific prefix, because ids share one translation key space
// with the header menu (`menu.{itemId}`, utils/siteTranslation.ts).

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ImagePlus, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { SITE_FONTS } from '@linyup/shared'
import type { SiteFont, SiteFooter, SiteFooterColumn, SiteHeader, SiteMenuItem, SiteMeta } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ColorPicker } from '@/components/ui/color-picker'

/** Font ids are stored; their display names are the families' own names. */
const FONT_LABELS: Record<SiteFont, string> = {
  sans: 'Sans',
  serif: 'Serif',
  rounded: 'Rounded',
  montserrat: 'Montserrat',
  inter: 'Inter',
  poppins: 'Poppins',
  oswald: 'Oswald',
  playfair: 'Playfair Display',
  'dm-sans': 'DM Sans',
}

const SAME_AS_BODY = '__same__'

const mintId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

export interface BrandFieldsProps {
  meta: SiteMeta
  onChange: (patch: Partial<SiteMeta>) => void
  /** Sections a link can point at — id + the label the editor shows for it. */
  sections: { id: string; label: string }[]
  /** The site's other pages — a link can point at one of these too. Absent ⇒
   *  no page destinations offered (the org builder, which has no pages yet). */
  pages?: { id: string; label: string }[]
  /** Uploads a brand image (logo, partner logo) and resolves to its URL. */
  uploadImage: (file: File) => Promise<string>
}

export function BrandFields({ meta, onChange, sections, pages, uploadImage }: BrandFieldsProps) {
  const t = useTranslations('Website')
  const header = meta.header
  const footer = meta.footer

  const setHeader = (patch: Partial<SiteHeader>) => onChange({ header: { ...header, ...patch } })
  const setFooter = (patch: Partial<SiteFooter>) => onChange({ footer: { ...footer, ...patch } })

  return (
    <div className="space-y-5">
      {/* ── Logo ─────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('brandLogo')}</Label>
        <ImageField
          value={meta.logoUrl}
          onChange={(url) => onChange({ logoUrl: url })}
          uploadImage={uploadImage}
          uploadLabel={t('brandLogoUpload')}
        />
        <p className="text-xs text-muted-foreground">{t('brandLogoHint')}</p>
      </div>

      {/* ── Typefaces ────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('brandBodyFont')}</Label>
          <FontSelect value={meta.font} onChange={(font) => onChange({ font: font ?? 'sans' })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('brandHeadingFont')}</Label>
          <FontSelect
            value={meta.headingFont}
            allowSame={t('brandHeadingFontSame')}
            onChange={(headingFont) => onChange({ headingFont })}
          />
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <span className="text-sm">{t('brandCapitals')}</span>
        <Switch
          checked={meta.headingCase === 'uppercase'}
          onCheckedChange={(v) => onChange({ headingCase: v ? 'uppercase' : undefined })}
        />
      </label>

      {/* ── Layout ───────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('brandContentWidth')}</Label>
          <Select
            value={meta.contentWidth ?? 'standard'}
            onValueChange={(v) => onChange({ contentWidth: v === 'standard' ? undefined : (v as SiteMeta['contentWidth']) })}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">{t('brandContentWidthStandard')}</SelectItem>
              <SelectItem value="wide">{t('brandContentWidthWide')}</SelectItem>
              <SelectItem value="full">{t('brandContentWidthFull')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span className="text-sm">{t('brandNavCapitals')}</span>
          <Switch
            checked={meta.navCase === 'uppercase'}
            onCheckedChange={(v) => onChange({ navCase: v ? 'uppercase' : undefined })}
          />
        </label>
      </div>

      {/* The language the SITE is written in — a studio may run its back office
          in one language and publish its site in another. Absent ⇒ the studio's
          own language, which is what every existing site keeps. */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('brandSiteLanguage')}</Label>
        <Select
          value={meta.language ?? 'team'}
          onValueChange={(v) => onChange({ language: v === 'team' ? undefined : (v as SiteMeta['language']) })}
        >
          <SelectTrigger className="h-9 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="team">{t('brandSiteLanguageTeam')}</SelectItem>
            {/* Language names are proper nouns — the same in every locale. */}
            <SelectItem value="de">Deutsch</SelectItem>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="fr">Français</SelectItem>
            <SelectItem value="it">Italiano</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('brandSiteLanguageHint')}</p>
      </div>

      {/* ── Buttons ──────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('brandButtonShape')}</Label>
            <Select
              value={meta.buttonShape ?? 'pill'}
              onValueChange={(v) => onChange({ buttonShape: v as SiteMeta['buttonShape'] })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pill">{t('brandButtonPill')}</SelectItem>
                <SelectItem value="rounded">{t('brandButtonRounded')}</SelectItem>
                <SelectItem value="square">{t('brandButtonSquare')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('brandCardShape')}</Label>
            <Select
              value={meta.cardShape ?? 'rounded'}
              onValueChange={(v) => onChange({ cardShape: v === 'rounded' ? undefined : (v as SiteMeta['cardShape']) })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rounded">{t('brandCardRounded')}</SelectItem>
                <SelectItem value="square">{t('brandCardSquare')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">{t('brandButtonColor')}</span>
          <Switch
            checked={!!meta.buttonColor}
            onCheckedChange={(v) => onChange({ buttonColor: v ? '#000000' : undefined })}
          />
        </label>
        {meta.buttonColor ? (
          <ColorPicker
            value={meta.buttonColor}
            onChange={(hex) => onChange({ buttonColor: hex })}
            aria-label={t('brandButtonColor')}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{t('brandButtonColorHint')}</p>
        )}
      </div>

      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('brandTopBar')}</p>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('brandTopBarText')}</Label>
          <Input
            value={header.topBar?.text ?? ''}
            onChange={(e) => setHeader({ topBar: { ...header.topBar, text: e.target.value } })}
            placeholder={t('brandTopBarTextPlaceholder')}
            className="h-9"
          />
        </div>
        <LinkListEditor
          items={header.topBar?.items ?? []}
          onChange={(items) => setHeader({ topBar: { ...header.topBar, items } })}
          sections={sections}
          pages={pages}
          idPrefix="tb-"
        />
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <div className="space-y-4 rounded-lg border p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('brandFooter')}</p>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('brandFooterText')}</Label>
          <textarea
            value={footer.text ?? ''}
            onChange={(e) => setFooter({ text: e.target.value })}
            rows={3}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t('brandFooterColumns')}</Label>
          {(footer.columns ?? []).map((column, index) => (
            <FooterColumnEditor
              key={column.id}
              column={column}
              sections={sections}
              pages={pages}
              onChange={(next) =>
                setFooter({ columns: (footer.columns ?? []).map((c, i) => (i === index ? next : c)) })
              }
              onRemove={() => setFooter({ columns: (footer.columns ?? []).filter((_, i) => i !== index) })}
            />
          ))}
          {(footer.columns ?? []).length < 5 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setFooter({ columns: [...(footer.columns ?? []), { id: mintId('col-'), heading: '', items: [] }] })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('brandAddColumn')}
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t('brandFooterLogos')}</Label>
          {(footer.logos ?? []).map((logo, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo.url} alt={logo.alt ?? ''} className="h-8 w-16 object-contain" />
              <Input
                value={logo.alt ?? ''}
                onChange={(e) =>
                  setFooter({
                    logos: (footer.logos ?? []).map((l, i) => (i === index ? { ...l, alt: e.target.value } : l)),
                  })
                }
                placeholder={t('brandLogoAlt')}
                className="h-8 min-w-0 flex-1"
              />
              <Input
                value={logo.link ?? ''}
                onChange={(e) =>
                  setFooter({
                    logos: (footer.logos ?? []).map((l, i) => (i === index ? { ...l, link: e.target.value } : l)),
                  })
                }
                placeholder={t('brandLogoLink')}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('brandRemove')}
                onClick={() => setFooter({ logos: (footer.logos ?? []).filter((_, i) => i !== index) })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <ImageField
            onChange={(url) => url && setFooter({ logos: [...(footer.logos ?? []), { url }] })}
            uploadImage={uploadImage}
            uploadLabel={t('brandAddLogo')}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">App Store</Label>
            <Input
              value={footer.appLinks?.ios ?? ''}
              onChange={(e) => setFooter({ appLinks: { ...footer.appLinks, ios: e.target.value } })}
              placeholder="https://apps.apple.com/…"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Google Play</Label>
            <Input
              value={footer.appLinks?.android ?? ''}
              onChange={(e) => setFooter({ appLinks: { ...footer.appLinks, android: e.target.value } })}
              placeholder="https://play.google.com/…"
              className="h-9 font-mono text-xs"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t('brandLegal')}</Label>
          <LinkListEditor
            items={footer.legal ?? []}
            onChange={(legal) => setFooter({ legal })}
            sections={sections}
            pages={pages}
            idPrefix="lg-"
          />
        </div>
      </div>
    </div>
  )
}

// ─── pieces ─────────────────────────────────────────────────────────────────

function FontSelect({
  value,
  onChange,
  allowSame,
}: {
  value: SiteFont | undefined
  /** `undefined` only ever comes back from the "same as body" option. */
  onChange: (font: SiteFont | undefined) => void
  /** When set, offers a "same as body" option that clears the value. */
  allowSame?: string
}) {
  return (
    <Select
      value={value ?? (allowSame ? SAME_AS_BODY : 'sans')}
      onValueChange={(v) => {
        if (v == null) return
        onChange(v === SAME_AS_BODY ? undefined : (v as SiteFont))
      }}
    >
      <SelectTrigger className="h-9">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowSame && <SelectItem value={SAME_AS_BODY}>{allowSame}</SelectItem>}
        {/* Plain text on purpose: the trigger shows the selected item's text,
            and it cannot read one out of a styled wrapper — it fell back to the
            raw stored id ("montserrat"). */}
        {SITE_FONTS.map((font) => (
          <SelectItem key={font} value={font}>
            {FONT_LABELS[font]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ImageField({
  value,
  onChange,
  uploadImage,
  uploadLabel,
}: {
  value?: string
  onChange: (url: string | undefined) => void
  uploadImage: (file: File) => Promise<string>
  uploadLabel: string
}) {
  const t = useTranslations('Website')
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function handleFile(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      onChange(await uploadImage(file))
    } catch {
      toast.error(t('brandUploadFailed'))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="h-10 max-w-[160px] rounded border bg-muted/30 object-contain p-1" />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="mr-1 h-3.5 w-3.5" />}
        {uploadLabel}
      </Button>
      {value && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
          {t('brandRemove')}
        </Button>
      )}
    </div>
  )
}

function FooterColumnEditor({
  column,
  sections,
  pages,
  onChange,
  onRemove,
}: {
  column: SiteFooterColumn
  sections: { id: string; label: string }[]
  pages?: { id: string; label: string }[]
  onChange: (column: SiteFooterColumn) => void
  onRemove: () => void
}) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Input
          value={column.heading ?? ''}
          onChange={(e) => onChange({ ...column, heading: e.target.value })}
          placeholder={t('brandColumnHeading')}
          className="h-8"
        />
        <Button type="button" variant="ghost" size="icon" aria-label={t('brandRemove')} onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <LinkListEditor
        items={column.items}
        onChange={(items) => onChange({ ...column, items })}
        sections={sections}
        pages={pages}
        idPrefix="fc-"
      />
    </div>
  )
}

const URL_TARGET = '__url__'
// Sections and pages share one flat Select, so their ids are namespaced —
// a section and a page can otherwise mint the same random id and collide.
const SECTION_PREFIX = 's:'
const PAGE_PREFIX = 'p:'

/** Flat label + destination rows. A destination is a section of the page, one
 *  of the site's other pages, or an external URL. */
function LinkListEditor({
  items,
  onChange,
  sections,
  pages,
  idPrefix,
}: {
  items: SiteMenuItem[]
  onChange: (items: SiteMenuItem[]) => void
  sections: { id: string; label: string }[]
  /** Absent ⇒ no page destinations offered (the org builder). */
  pages?: { id: string; label: string }[]
  idPrefix: string
}) {
  const t = useTranslations('Website')
  const update = (index: number, patch: Partial<SiteMenuItem>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  return (
    <div className="space-y-2">
      {items.map((item, index) => {
        const target = item.target
        const selectValue =
          target.kind === 'section'
            ? `${SECTION_PREFIX}${target.sectionId}`
            : target.kind === 'page'
              ? `${PAGE_PREFIX}${target.pageId}`
              : URL_TARGET
        return (
          <div key={item.id} className="flex flex-wrap items-center gap-2">
            <Input
              value={item.label ?? ''}
              onChange={(e) => update(index, { label: e.target.value })}
              placeholder={t('brandLinkLabel')}
              className="h-8 w-36"
            />
            <Select
              value={selectValue}
              onValueChange={(v) => {
                if (!v || v === URL_TARGET) update(index, { target: { kind: 'url', url: '' } })
                else if (v.startsWith(PAGE_PREFIX))
                  update(index, { target: { kind: 'page', pageId: v.slice(PAGE_PREFIX.length) } })
                else update(index, { target: { kind: 'section', sectionId: v.slice(SECTION_PREFIX.length) } })
              }}
            >
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={URL_TARGET}>{t('brandLinkTargetUrl')}</SelectItem>
                {sections.map((section) => (
                  <SelectItem key={section.id} value={`${SECTION_PREFIX}${section.id}`}>
                    {section.label}
                  </SelectItem>
                ))}
                {(pages ?? []).map((page) => (
                  <SelectItem key={page.id} value={`${PAGE_PREFIX}${page.id}`}>
                    {page.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {target.kind === 'url' && (
              <Input
                value={target.url}
                onChange={(e) => update(index, { target: { kind: 'url', url: e.target.value } })}
                placeholder="https://"
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
            )}
            {/* A surface or group target (set by a seed or an older editor)
                keeps working; it just has no inline control here. */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('brandRemove')}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...items, { id: mintId(idPrefix), label: '', target: { kind: 'url', url: '' } }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t('brandAddLink')}
      </Button>
    </div>
  )
}
