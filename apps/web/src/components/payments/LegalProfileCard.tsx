'use client'

// Settings → Payments: the studio's legal profile — the creditor identity
// printed on every document it issues (Tarif 595 health-insurance receipts
// today, QR-bill invoices later). SHARED, not plugin-owned — see
// hooks/useLegalProfile.ts for the storage rationale.
//
// Owner-only WRITE (the settings/{settingId} rule), but the doc is
// MEMBER-readable, so a manager sees the same card read-only rather than not at
// all — the Tarif 595 settings page links here to explain whether receipts can
// be issued yet, and a manager following that link is entitled to see why.
//
// Plain-state card in the shape of settings/emails/SmsSenderCard.tsx: a local
// draft, a dirty flag, one Save button. No react-hook-form — the field count is
// small and every value round-trips through `validateLegalProfile` directly.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Landmark, Loader2 } from 'lucide-react'
import {
  SWISS_CANTONS,
  formatIban,
  normalizeIban,
  normalizeVatNumber,
  validateLegalProfile,
  type StudioLegalProfile,
  type SwissCanton,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { usePlaces } from '@/hooks/usePlaces'
import { useLegalProfile, saveLegalProfile, useInvalidateLegalProfile } from '@/hooks/useLegalProfile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface Draft {
  legal_name: string
  street_name: string
  house_no: string
  zip: string
  city: string
  canton: SwissCanton | ''
  iban: string
  qr_iban: string
  vat_number: string
  vat_rate: string
  phone: string
  email: string
}

function draftFromProfile(profile: StudioLegalProfile | null | undefined, fallbackName: string): Draft {
  return {
    legal_name: profile?.legal_name ?? fallbackName,
    street_name: profile?.postal?.street_name ?? '',
    house_no: profile?.postal?.house_no ?? '',
    zip: profile?.postal?.zip ?? '',
    city: profile?.postal?.city ?? '',
    canton: profile?.canton ?? '',
    // Displayed in print layout — matches what formatIban produces on blur, so
    // an unedited field never appears to change the moment it renders.
    iban: profile?.iban ? formatIban(profile.iban) : '',
    qr_iban: profile?.qr_iban ? formatIban(profile.qr_iban) : '',
    vat_number: profile?.vat_number ?? '',
    vat_rate: profile?.vat_rate != null ? String(profile.vat_rate) : '',
    phone: profile?.phone ?? '',
    email: profile?.email ?? '',
  }
}

/** The shape `validateLegalProfile` and `saveLegalProfile` both take. */
function draftToProfile(d: Draft): Partial<StudioLegalProfile> {
  return {
    legal_name: d.legal_name.trim(),
    postal: {
      street_name: d.street_name.trim(),
      house_no: d.house_no.trim(),
      zip: d.zip.trim(),
      city: d.city.trim(),
    },
    ...(d.canton ? { canton: d.canton } : {}),
    iban: normalizeIban(d.iban),
    qr_iban: d.qr_iban.trim() ? normalizeIban(d.qr_iban) : null,
    vat_number: d.vat_number.trim() ? normalizeVatNumber(d.vat_number) : null,
    vat_rate: d.vat_rate.trim() ? Number(d.vat_rate) : null,
    phone: d.phone.trim() || null,
    email: d.email.trim() || null,
  }
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function LegalProfileCard({ teamId }: { teamId: string }) {
  const t = useTranslations('LegalProfile')
  const { team, teamRole, user } = useAuth()
  const isOwner = teamRole === 'owner'
  const { data: profile, isLoading } = useLegalProfile(teamId)
  const invalidate = useInvalidateLegalProfile(teamId)
  const { data: places = [] } = usePlaces(teamId)
  const primaryPlace = places.find((p) => p.isPrimary) ?? places[0] ?? null

  const baseline = draftFromProfile(profile, team?.name ?? '')
  const [draft, setDraft] = useState<Draft>(baseline)
  const [touched, setTouched] = useState<Partial<Record<keyof Draft, boolean>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    setDraft(draftFromProfile(profile, team?.name ?? ''))
    setTouched({})
    setSubmitted(false)
    setSaved(false)
    // Re-derive the baseline whenever the stored profile (or the team's own
    // name, the empty-doc fallback) changes — never on local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, team?.name])

  const dirty = !draftsEqual(draft, baseline)
  const issues = validateLegalProfile(draftToProfile(draft))
  const issueFor = (path: string) => issues.find((i) => i.path === path)

  // Literal `t('key')` calls only — no template-literal keys.
  function issueText(code: (typeof issues)[number]['code']): string {
    if (code === 'required') return t('error.required')
    if (code === 'pattern') return t('error.pattern')
    if (code === 'checksum') return t('error.checksum')
    return t('error.length')
  }

  function errorMessage(path: string): string | null {
    const issue = issueFor(path)
    if (!issue) return null
    return issueText(issue.code)
  }

  function shouldShow(field: keyof Draft): boolean {
    return submitted || !!touched[field]
  }

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [field]: value }))
    setSaved(false)
  }

  function blur(field: keyof Draft) {
    setTouched((tset) => ({ ...tset, [field]: true }))
  }

  async function save() {
    if (!isOwner) return
    setSubmitted(true)
    if (issues.length > 0) return
    setSaving(true)
    setSaved(false)
    try {
      await saveLegalProfile(
        teamId,
        user?.uid ?? null,
        draftToProfile(draft) as Omit<StudioLegalProfile, 'updated_at' | 'updated_by'>
      )
      invalidate()
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <Skeleton className="h-16 rounded" />
      </div>
    )
  }

  const readOnly = !isOwner

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-start gap-2.5">
        <Landmark className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div>
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('subtitle')}</p>
        </div>
      </div>

      {readOnly && <p className="text-xs text-muted-foreground">{t('ownerOnlyNote')}</p>}

      {primaryPlace?.address && (
        <p className="text-xs text-muted-foreground">
          {t('placeAddressHint', { address: primaryPlace.address })}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lp-legal-name">{t('legalName')}</Label>
          <Input
            id="lp-legal-name"
            value={draft.legal_name}
            onChange={(e) => set('legal_name', e.target.value)}
            onBlur={() => blur('legal_name')}
            disabled={readOnly}
            maxLength={35}
          />
          {shouldShow('legal_name') && errorMessage('legal_name') && (
            <p className="text-xs text-destructive">{errorMessage('legal_name')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-street">{t('streetName')}</Label>
          <Input
            id="lp-street"
            value={draft.street_name}
            onChange={(e) => set('street_name', e.target.value)}
            onBlur={() => blur('street_name')}
            disabled={readOnly}
          />
          {shouldShow('street_name') && errorMessage('postal.street_name') && (
            <p className="text-xs text-destructive">{errorMessage('postal.street_name')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-house-no">{t('houseNo')}</Label>
          <Input
            id="lp-house-no"
            value={draft.house_no}
            onChange={(e) => set('house_no', e.target.value)}
            onBlur={() => blur('house_no')}
            disabled={readOnly}
          />
          {shouldShow('house_no') && errorMessage('postal.house_no') && (
            <p className="text-xs text-destructive">{errorMessage('postal.house_no')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-zip">{t('zip')}</Label>
          <Input
            id="lp-zip"
            value={draft.zip}
            onChange={(e) => set('zip', e.target.value)}
            onBlur={() => blur('zip')}
            disabled={readOnly}
          />
          {shouldShow('zip') && errorMessage('postal.zip') && (
            <p className="text-xs text-destructive">{errorMessage('postal.zip')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-city">{t('city')}</Label>
          <Input
            id="lp-city"
            value={draft.city}
            onChange={(e) => set('city', e.target.value)}
            onBlur={() => blur('city')}
            disabled={readOnly}
            maxLength={35}
          />
          {shouldShow('city') && errorMessage('postal.city') && (
            <p className="text-xs text-destructive">{errorMessage('postal.city')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-canton">{t('canton')}</Label>
          <Select
            value={draft.canton || undefined}
            onValueChange={(v) => {
              set('canton', (v as SwissCanton) ?? '')
              blur('canton')
            }}
            disabled={readOnly}
          >
            <SelectTrigger id="lp-canton">
              <SelectValue placeholder={t('cantonPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {SWISS_CANTONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {shouldShow('canton') && errorMessage('canton') && (
            <p className="text-xs text-destructive">{errorMessage('canton')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-iban">{t('iban')}</Label>
          <Input
            id="lp-iban"
            value={draft.iban}
            onChange={(e) => set('iban', e.target.value)}
            onBlur={() => {
              blur('iban')
              if (draft.iban.trim()) set('iban', formatIban(draft.iban))
            }}
            disabled={readOnly}
            placeholder="CH93 0076 2011 6238 5295 7"
          />
          {shouldShow('iban') && errorMessage('iban') && (
            <p className="text-xs text-destructive">{errorMessage('iban')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-qr-iban">{t('qrIban')}</Label>
          <Input
            id="lp-qr-iban"
            value={draft.qr_iban}
            onChange={(e) => set('qr_iban', e.target.value)}
            onBlur={() => {
              blur('qr_iban')
              if (draft.qr_iban.trim()) set('qr_iban', formatIban(draft.qr_iban))
            }}
            disabled={readOnly}
          />
          <p className="text-xs text-muted-foreground">{t('qrIbanHelp')}</p>
          {shouldShow('qr_iban') && errorMessage('qr_iban') && (
            <p className="text-xs text-destructive">{errorMessage('qr_iban')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-vat-number">{t('vatNumber')}</Label>
          <Input
            id="lp-vat-number"
            value={draft.vat_number}
            onChange={(e) => set('vat_number', e.target.value)}
            onBlur={() => blur('vat_number')}
            disabled={readOnly}
            placeholder="CHE-123.456.789 MWST"
          />
          {shouldShow('vat_number') && errorMessage('vat_number') && (
            <p className="text-xs text-destructive">{errorMessage('vat_number')}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-vat-rate">{t('vatRate')}</Label>
          <Input
            id="lp-vat-rate"
            type="number"
            step="0.1"
            min={0}
            value={draft.vat_rate}
            onChange={(e) => set('vat_rate', e.target.value)}
            onBlur={() => blur('vat_rate')}
            disabled={readOnly}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-phone">{t('phone')}</Label>
          <Input
            id="lp-phone"
            value={draft.phone}
            onChange={(e) => set('phone', e.target.value)}
            onBlur={() => blur('phone')}
            disabled={readOnly}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lp-email">{t('email')}</Label>
          <Input
            id="lp-email"
            type="email"
            value={draft.email}
            onChange={(e) => set('email', e.target.value)}
            onBlur={() => blur('email')}
            disabled={readOnly}
          />
          {shouldShow('email') && errorMessage('email') && (
            <p className="text-xs text-destructive">{errorMessage('email')}</p>
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="flex items-center justify-end gap-2">
          {saved && !dirty && <span className="text-xs text-muted-foreground">{t('saved')}</span>}
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      )}
    </div>
  )
}
