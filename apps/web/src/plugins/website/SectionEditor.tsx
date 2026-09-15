'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type {
  WebsiteSection, ActivitiesSection, PricingSection, ScheduleSection, PlacesSection, FormSection,
  SiteCta,
} from '@linyup/shared'
import { uploadSiteImage } from './hooks'
import { usePlaces } from '@/hooks/usePlaces'
import { useActivities } from '@/hooks/useActivities'
import { useAuth } from '@/contexts/AuthContext'
import { useForms } from '@/plugins/custom-forms/hooks'
import {
  ContactFields,
  ContentFields,
  CtaBannerFields,
  FaqFields,
  FeaturesFields,
  Field,
  GalleryFields,
  HeroFields,
  TeamFields,
  TestimonialsFields,
  VideoFields,
  type SiteEditorTenant,
} from '@/components/website/SiteSectionFields'

// ─── the team's own CTA, and the sections only a studio has ─────────────────
//
// The four section types both builders share — hero, content, gallery, contact —
// and their field helpers now live in `components/website/SiteSectionFields`.
// What stays here is what a STUDIO can do and an organisation cannot: a CTA that
// can point at the booking page or the signup form, and the four commerce
// sections (activities, pricing, schedule, places) an org has no equivalent of.

type Patch = Record<string, unknown>

function CtaEditor({
  cta,
  pages,
  onChange,
}: {
  cta?: SiteCta
  /** The site's other pages — offered as a CTA destination alongside booking,
   *  sign-up and an external URL. Absent/empty ⇒ the "Page" action still shows
   *  (it's a fixed option like the others), just with nothing to pick yet. */
  pages?: { id: string; label: string }[]
  onChange: (cta: SiteCta | undefined) => void
}) {
  const t = useTranslations('Website')
  const value = cta ?? { label: '', action: 'booking' as const }
  const set = (patch: Partial<SiteCta>) => {
    const next = { ...value, ...patch }
    onChange(next.label ? next : undefined)
  }
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground">{t('editorCtaTitle')}</p>
      <Field label={t('editorCtaLabel')}>
        <Input value={value.label} onChange={(e) => set({ label: e.target.value })} placeholder={t('editorCtaLabelPlaceholder')} className="h-9" />
      </Field>
      <Field label={t('editorCtaAction')}>
        <Select value={value.action} onValueChange={(v) => set({ action: v as SiteCta['action'] })}>
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="booking">{t('editorCtaActionBooking')}</SelectItem>
            <SelectItem value="signup">{t('editorCtaActionSignup')}</SelectItem>
            <SelectItem value="page">{t('editorCtaActionPage')}</SelectItem>
            <SelectItem value="url">{t('editorCtaActionUrl')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {value.action === 'page' && (
        <Field label={t('editorCtaPage')}>
          <Select value={value.pageId ?? ''} onValueChange={(v) => set({ pageId: v || undefined })}>
            <SelectTrigger className="h-9"><SelectValue placeholder={t('editorCtaPagePlaceholder')} /></SelectTrigger>
            <SelectContent>
              {(pages ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {value.action === 'url' && (
        <Field label={t('editorCtaUrl')}>
          <Input value={value.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://" className="h-9 font-mono text-xs" />
        </Field>
      )}
    </div>
  )
}

function ActivitiesFields({ s, onChange }: { s: ActivitiesSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {t('editorActivitiesNote')}
      </p>
      <Field label={t('editorHeading')}><Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} placeholder={t('editorActivitiesHeadingPlaceholder')} className="h-9" /></Field>
      <Field label={t('editorSubheading')}><Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" /></Field>
      <Field label={t('editorLayout')}>
        <Select
          value={s.layout ?? 'grid'}
          onValueChange={(v) => onChange({ layout: v as ActivitiesSection['layout'] })}
        >
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="grid">{t('editorLayoutGrid')}</SelectItem>
            <SelectItem value="list">{t('editorLayoutList')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {/* A stacked list is always one per row — the column count is meaningless
          there. Hidden rather than reset, so switching back to grid restores
          whatever the studio had picked. */}
      {(s.layout ?? 'grid') === 'grid' && (
        <Field label={t('editorColumns')}>
          <Select value={String(s.columns)} onValueChange={(v) => onChange({ columns: Number(v) })}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="4">4</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field label={t('fieldPricingDisplay')}>
        <Select
          value={s.pricingDisplay ?? 'list'}
          onValueChange={(v) => onChange({ pricingDisplay: v as ActivitiesSection['pricingDisplay'] })}
        >
          <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="list">{t('pricingDisplayList')}</SelectItem>
            <SelectItem value="compact">{t('pricingDisplayCompact')}</SelectItem>
            <SelectItem value="hidden">{t('pricingDisplayHidden')}</SelectItem>
          </SelectContent>
        </Select>
        {/* Said on the control, not in a doc comment: a studio picking "Hidden"
            is entitled to know what it does NOT hide, so it doesn't go looking
            for the bug. */}
        <p className="text-xs text-muted-foreground">{t('pricingDisplayHint')}</p>
      </Field>
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('editorShowBookingOnCards')}</span>
        <Switch checked={s.showBooking ?? false} onCheckedChange={(v) => onChange({ showBooking: v })} />
      </label>
    </div>
  )
}

function PricingFields({ s, onChange }: { s: PricingSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      {/* The destination moved with the copy: these cards read the SUBSCRIPTION
          PLANS, which live on the Plans page — the old line still sent studios to
          "Contacts → membership types", a path that has not existed for two
          reorganisations. */}
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {t('editorPricingNote')}
      </p>
      <Field label={t('editorHeading')}><Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} placeholder={t('editorPricingHeadingPlaceholder')} className="h-9" /></Field>
      <Field label={t('editorSubheading')}><Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" /></Field>
      <Field label={t('editorCtaLabel')}><Input value={s.ctaLabel ?? ''} onChange={(e) => onChange({ ctaLabel: e.target.value })} placeholder={t('editorPricingCtaPlaceholder')} className="h-9" /></Field>
      <Field label={t('fieldPricingLayout')}>
        <Select
          value={s.layout ?? 'cards'}
          onValueChange={(v) => onChange({ layout: v as PricingSection['layout'] })}
        >
          <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cards">{t('pricingLayoutCards')}</SelectItem>
            <SelectItem value="table">{t('pricingLayoutTable')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('pricingLayoutHint')}</p>
      </Field>
      {/* Term grouping is a CARD arrangement — the table already puts every
          plan side by side, so there is no "which term" question to group by. */}
      {(s.layout ?? 'cards') === 'cards' && (
        <label className="flex items-center justify-between rounded-lg border p-3">
          <span className="text-sm">{t('pricingGroupByTermLabel')}</span>
          <Switch
            checked={s.groupBy === 'term'}
            onCheckedChange={(v) => onChange({ groupBy: v ? 'term' : undefined })}
          />
        </label>
      )}
      {s.groupBy === 'term' && (s.layout ?? 'cards') === 'cards' && (
        <p className="text-xs text-muted-foreground">{t('pricingGroupByTermHint')}</p>
      )}
    </div>
  )
}

function ScheduleFields({ s, onChange }: { s: ScheduleSection; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        {t('editorScheduleNote')}
      </p>
      <Field label={t('editorHeading')}><Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} placeholder={t('editorScheduleHeadingPlaceholder')} className="h-9" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('editorDaysAhead')}>
          <Select value={String(s.windowDays ?? 7)} onValueChange={(v) => onChange({ windowDays: Number(v) })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t('editorDaysOption', { count: 7 })}</SelectItem>
              <SelectItem value="14">{t('editorDaysOption', { count: 14 })}</SelectItem>
              <SelectItem value="30">{t('editorDaysOption', { count: 30 })}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('editorMaxClasses')}>
          {/* 0 = no cap. Keeps a busy schedule from listing dozens of rows. */}
          <Select value={String(s.maxItems ?? 0)} onValueChange={(v) => onChange({ maxItems: Number(v) || undefined })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('editorNoLimit')}</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="5">5</SelectItem>
              <SelectItem value="8">8</SelectItem>
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="15">15</SelectItem>
              <SelectItem value="20">20</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t('editorDefaultView')}>
        {/* Visitors can still switch List ↔ Calendar on the live site; this sets the default. */}
        <Select value={s.displayMode ?? 'calendar'} onValueChange={(v) => onChange({ displayMode: v as ScheduleSection['displayMode'] })}>
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="list">{t('editorViewList')}</SelectItem>
            <SelectItem value="calendar">{t('editorViewCalendar')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-sm">{t('editorShowBookingOnSessions')}</span>
        <Switch checked={s.showBooking ?? false} onCheckedChange={(v) => onChange({ showBooking: v })} />
      </label>
    </div>
  )
}

function PlacesFields({ s, teamId, onChange }: { s: PlacesSection; teamId: string; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  const { team } = useAuth()
  const { data: places = [] } = usePlaces(teamId, team?.org_id ?? null)
  const selected = new Set(s.placeIds ?? [])
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange({ placeIds: Array.from(next) })
  }
  return (
    <div className="space-y-3">
      <Field label={t('editorHeading')}><Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} placeholder={t('editorPlacesHeadingPlaceholder')} className="h-9" /></Field>
      <Field label={t('editorSubheading')}><Input value={s.subheading ?? ''} onChange={(e) => onChange({ subheading: e.target.value })} className="h-9" /></Field>
      <Field label={t('editorColumns')}>
        <Select value={String(s.columns)} onValueChange={(v) => onChange({ columns: Number(v) })}>
          <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2</SelectItem>
            <SelectItem value="3">3</SelectItem>
            <SelectItem value="4">4</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="space-y-1.5">
        <Label className="text-xs">{t('editorPlacesToShow')}</Label>
        {places.length === 0 ? (
          /* Places moved to the Schedule section (UX-67); the old copy still sent
             studios to Settings. */
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            {t('editorNoPlaces')}
          </p>
        ) : (
          <div className="space-y-1">
            {places.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="flex-1 truncate">
                  {p.name}
                  {p.scope === 'org' ? (
                    <span className="text-muted-foreground"> · {t('editorPlaceOrgScope')}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Form (one of the team's own published forms, filled in on the page) ────

function FormFields({ s, teamId, onChange }: { s: FormSection; teamId: string; onChange: (p: Patch) => void }) {
  const t = useTranslations('Website')
  const { data: forms = [] } = useForms(teamId)
  const { data: activities = [] } = useActivities(teamId)
  // Appointment activities only — a class has no availability picker to open.
  const appointmentActivities = activities.filter((a) => a.type === 'appointment')
  // Archived forms drop out entirely; a draft stays listed but disabled, so a
  // studio mid-build sees why its own form isn't offered instead of it just
  // vanishing.
  const selectable = forms.filter((f) => f.status !== 'archived')
  const next = s.next

  return (
    <div className="space-y-3">
      <Field label={t('editorHeadingOptional')}>
        <Input value={s.heading ?? ''} onChange={(e) => onChange({ heading: e.target.value })} className="h-9" />
      </Field>
      <Field label={t('editorTextOptional')}>
        <Textarea value={s.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} rows={2} />
      </Field>
      <Field label={t('editorFormPicker')}>
        {selectable.length === 0 ? (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            {t('editorFormEmptyHint')}
          </p>
        ) : (
          <>
            <Select value={s.formId || undefined} onValueChange={(v) => onChange({ formId: v })}>
              <SelectTrigger className="h-9"><SelectValue placeholder={t('editorFormPickerPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {selectable.map((f) => (
                  <SelectItem key={f.id} value={f.id} disabled={f.status !== 'published'}>
                    {f.title}
                    {f.status !== 'published' ? t('editorFormDraftSuffix') : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* An empty formId is dropped at publish — the studio should know
                before it publishes, not after. */}
            {!s.formId && <p className="text-xs text-muted-foreground">{t('editorFormMissingHint')}</p>}
          </>
        )}
      </Field>
      <Field label={t('editorFormNext')}>
        <Select
          value={next?.kind ?? 'none'}
          onValueChange={(v) =>
            onChange({ next: v === 'appointment' ? { kind: 'appointment', activityId: '' } : undefined })
          }
        >
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t('editorFormNextNone')}</SelectItem>
            <SelectItem value="appointment">{t('editorFormNextAppointment')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {next?.kind === 'appointment' && (
        appointmentActivities.length === 0 ? (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            {t('editorFormNoActivitiesHint')}
          </p>
        ) : (
          <Field label={t('editorFormNextActivity')}>
            <Select
              value={next.activityId || undefined}
              onValueChange={(v) => onChange({ next: { kind: 'appointment', activityId: v } })}
            >
              <SelectTrigger className="h-9"><SelectValue placeholder={t('editorFormNextActivityPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {appointmentActivities.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )
      )}
    </div>
  )
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export function SectionEditor({
  section, teamId, pages, onChange,
}: {
  section: WebsiteSection
  teamId: string
  /** The site's other pages — threaded into the CTA editor (hero, CTA banner)
   *  as a destination option. Absent ⇒ no pages offered yet. */
  pages?: { id: string; label: string }[]
  onChange: (patch: Patch) => void
}) {
  const tenant: SiteEditorTenant = {
    kind: 'team',
    id: teamId,
    uploadImage: (sectionId, file) => uploadSiteImage(teamId, sectionId, file),
  }
  switch (section.type) {
    case 'hero':
      return (
        <HeroFields
          s={section}
          tenant={tenant}
          onChange={onChange}
          cta={<CtaEditor cta={section.cta} pages={pages} onChange={(cta) => onChange({ cta })} />}
        />
      )
    case 'content':
    case 'about':    return <ContentFields s={section} tenant={tenant} onChange={onChange} />
    case 'gallery':  return <GalleryFields s={section} tenant={tenant} onChange={onChange} />
    case 'activities': return <ActivitiesFields s={section} onChange={onChange} />
    case 'pricing':  return <PricingFields s={section} onChange={onChange} />
    case 'schedule': return <ScheduleFields s={section} onChange={onChange} />
    case 'contact':  return <ContactFields s={section} onChange={onChange} />
    case 'places':   return <PlacesFields s={section} teamId={teamId} onChange={onChange} />
    // Presentational — shared with the org builder via SiteSectionFields, since
    // none of these say anything commerce-specific about a studio.
    case 'features':    return <FeaturesFields s={section} tenant={tenant} pages={pages} onChange={onChange} />
    case 'cta_banner':
      return (
        <CtaBannerFields
          s={section}
          tenant={tenant}
          onChange={onChange}
          cta={<CtaEditor cta={section.cta} pages={pages} onChange={(cta) => onChange({ cta })} />}
        />
      )
    case 'faq':         return <FaqFields s={section} onChange={onChange} />
    case 'testimonials': return <TestimonialsFields s={section} onChange={onChange} />
    case 'video':        return <VideoFields key={section.id} s={section} tenant={tenant} onChange={onChange} />
    case 'team':         return <TeamFields s={section} tenant={tenant} onChange={onChange} />
    case 'form':         return <FormFields s={section} teamId={teamId} onChange={onChange} />
    default:         return null
  }
}

