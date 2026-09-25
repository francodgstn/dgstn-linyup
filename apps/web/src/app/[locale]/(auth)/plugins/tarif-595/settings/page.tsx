'use client'

// Tarif 595 — plugin settings. Manager/owner. The plugin's OWN identifiers
// (GLN/ZSR, numbering, offering → position map); the studio's creditor
// identity (name, address, IBAN, VAT) lives on the SHARED legal profile at
// Settings → Payments — see components/payments/LegalProfileCard.tsx.

import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import type { FieldErrors, Resolver } from 'react-hook-form'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, CheckCircle2, HeartPulse, Loader2, Sparkles, XCircle } from 'lucide-react'
import {
  TARIF595_FREE_TEXT_CODE,
  legalProfileIsComplete,
  suggestTarif595Unit,
  tarif595LangOf,
  tarif595OfferingKey,
  validateTarif595Config,
  type Tarif595Config,
  type Tarif595ConfigIssueCode,
  type Tarif595Lang,
  type Tarif595OfferingFacts,
  type Tarif595OfferingKind,
  type Tarif595OfferingMapping,
  type Tarif595Unit,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useLegalProfile } from '@/hooks/useLegalProfile'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useActivities } from '@/hooks/useActivities'
import { useCourses } from '@/plugins/online-courses/hooks'
import { useTarif595Config, saveTarif595Config, useInvalidateTarif595, callSuggestTarif595Mappings } from '@/plugins/tarif-595/hooks'
import { useTarif595PositionsTable } from '@/plugins/tarif-595/PositionPicker'
import {
  OfferingsTable,
  type ExpiryOf,
  type OfferingReplacement,
  type OfferingRow,
  type OfferingRowErrors,
} from '@/plugins/tarif-595/OfferingsTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { FormSection } from '@/components/ui/form-section'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// ─── Form shape ─────────────────────────────────────────────────────────────
// Offerings are kept as ONE plain object field (no useFieldArray) — the rows
// themselves live in local component state (`OfferingRow[]`) and are mirrored
// into this field on every row edit, so the resolver validates the whole
// config, identifiers and offerings together, in one place.

interface Tarif595FormValues {
  language: Tarif595Lang
  modus: 'production' | 'test'
  billerGln: string
  billerZsr: string
  providerSameAsBiller: boolean
  providerGln: string
  providerGlnLocation: string
  providerZsr: string
  providerUid: string
  numberingPrefix: string
  offerings: Record<string, Tarif595OfferingMapping>
}

function valuesToConfig(values: Tarif595FormValues): Partial<Tarif595Config> {
  const billerGln = values.billerGln.trim()
  const provider = values.providerSameAsBiller
    ? { gln: billerGln, gln_location: billerGln, zsr: values.billerZsr.trim() || null, uid: null }
    : {
        gln: values.providerGln.trim(),
        gln_location: values.providerGlnLocation.trim() || values.providerGln.trim(),
        zsr: values.providerZsr.trim() || null,
        uid: values.providerUid.trim() || null,
      }
  return {
    language: values.language,
    modus: values.modus,
    biller: { gln: billerGln, zsr: values.billerZsr.trim() },
    provider,
    numbering: { prefix: values.numberingPrefix.trim().toUpperCase() },
    offerings: values.offerings,
  }
}

function defaultFormValues(config: Tarif595Config | null | undefined, defaultLang: Tarif595Lang): Tarif595FormValues {
  const providerSameAsBiller = !config || config.provider.gln === config.biller.gln
  return {
    language: config?.language ?? defaultLang,
    modus: config?.modus ?? 'test',
    billerGln: config?.biller.gln ?? '',
    billerZsr: config?.biller.zsr ?? '',
    providerSameAsBiller,
    providerGln: config?.provider.gln ?? '',
    providerGlnLocation: config?.provider.gln_location ?? '',
    providerZsr: config?.provider.zsr ?? '',
    providerUid: config?.provider.uid ?? '',
    numberingPrefix: config?.numbering.prefix ?? '595',
    offerings: config?.offerings ?? {},
  }
}

// The validator's paths are dot-joined against the NESTED Tarif595Config
// shape (`biller.gln`, `offerings.<key>.position`); this form is flat on the
// identifier fields, so those few need remapping. Everything else (offerings,
// language) already lands on a form field of the same name.
const ISSUE_PATH_TO_FIELD: Record<string, string> = {
  'biller.gln': 'billerGln',
  'biller.zsr': 'billerZsr',
  'provider.gln': 'providerGln',
  'provider.gln_location': 'providerGlnLocation',
  'provider.zsr': 'providerZsr',
  'numbering.prefix': 'numberingPrefix',
}

function issueMessageKey(code: Tarif595ConfigIssueCode): string {
  switch (code) {
    case 'required':
      return 'errorRequired'
    case 'pattern':
      return 'errorPattern'
    case 'checksum':
      return 'errorChecksum'
    case 'length':
      return 'errorLength'
    case 'unknown_position':
      return 'errorUnknownPosition'
    case 'no_offerings':
      return 'errorNoOfferings'
    default:
      return 'errorRequired'
  }
}

// Building the FieldErrors tree from dynamic dot-paths (offering keys carry a
// ':' but never a '.', so splitting on '.' is safe) has no clean generic
// typing in react-hook-form — the object is assembled loosely and cast once,
// at the resolver's return, rather than at every write below.
function setErrorAtPath(target: Record<string, unknown>, path: string, error: { type: string; message: string }) {
  const parts = path.split('.')
  let node = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    const existing = node[key]
    if (typeof existing !== 'object' || existing === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  const last = parts[parts.length - 1]
  const existing = node[last]
  node[last] = typeof existing === 'object' && existing !== null ? { ...existing, ...error } : { ...error }
}

// ─── Offering rows (page state, merged into the `offerings` field on submit) ─

// `OfferingRow` lives with the table (plugins/tarif-595/OfferingsTable.tsx).
//
// An UNMAPPED row starts with its unit already derived from the offering's
// own facts (`suggestTarif595Unit`: a monthly price bills per month, a credit
// pack per entry, a class per lesson) — the half of a mapping that needs no
// judgment. The position stays empty until the manager picks one or accepts
// a suggestion; `rowsToOfferings` skips a row without a position, so a
// derived unit alone never reaches the saved config.
function rowFrom(
  kind: Tarif595OfferingKind,
  id: string,
  name: string,
  facts: Tarif595OfferingFacts,
  offerings: Record<string, Tarif595OfferingMapping>
): OfferingRow {
  const key = tarif595OfferingKey(kind, id)
  const m = offerings[key]
  const derived = m ? null : suggestTarif595Unit(facts)
  return {
    key,
    kind,
    id,
    name,
    position: m?.position ?? null,
    unit: m?.unit ?? derived?.unit ?? '',
    entries: m?.entries != null ? String(m.entries) : derived?.entries != null ? String(derived.entries) : '',
    ptPosition: m?.ptPosition ?? null,
    customName: m?.customName ?? '',
    suggestion: null,
    successor: m?.successor ?? null,
  }
}

function rowsToOfferings(rows: OfferingRow[]): Record<string, Tarif595OfferingMapping> {
  const out: Record<string, Tarif595OfferingMapping> = {}
  for (const r of rows) {
    // Unmapped rows (nothing ever selected) are simply absent.
    if (!r.position) continue
    const mapping: Tarif595OfferingMapping = { position: r.position, unit: r.unit as Tarif595Unit }
    if (r.unit === 'entry' && r.entries.trim()) mapping.entries = Number(r.entries)
    if (r.ptPosition) mapping.ptPosition = r.ptPosition
    if (r.position === TARIF595_FREE_TEXT_CODE && r.customName.trim()) mapping.customName = r.customName.trim()
    if (r.successor?.position) mapping.successor = r.successor
    out[r.key] = mapping
  }
  return out
}

export default function Tarif595SettingsPage() {
  const t = useTranslations('Tarif595Settings')
  const { currentTeamId, team, teamRole, user } = useAuth()
  const teamId = currentTeamId ?? null
  const canEdit = teamRole === 'owner' || teamRole === 'manager'
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()

  const { data: legalProfile, isLoading: legalLoading } = useLegalProfile(teamId)
  const { data: config, isLoading: configLoading } = useTarif595Config(teamId)
  const { data: subscriptionTypes = [], isLoading: subsLoading } = useSubscriptionTypes(teamId)
  const { data: activities = [], isLoading: activitiesLoading } = useActivities(teamId)
  const { data: courses = [], isLoading: coursesLoading } = useCourses(teamId)
  const { data: positionsTable } = useTarif595PositionsTable()
  const invalidate = useInvalidateTarif595(teamId)

  const positionExists = useMemo(() => {
    const table = positionsTable
    return (code: string) => (table ? table.positions.some((p) => p.code === code) : true)
  }, [positionsTable])

  const resolver: Resolver<Tarif595FormValues> = useMemo(
    () => async (values) => {
      const cfg = valuesToConfig(values)
      const issues = validateTarif595Config(cfg, { positionExists })
      if (issues.length === 0) return { values, errors: {} }
      const errors: Record<string, unknown> = {}
      for (const issue of issues) {
        const field = ISSUE_PATH_TO_FIELD[issue.path] ?? issue.path
        setErrorAtPath(errors, field, { type: issue.code, message: t(issueMessageKey(issue.code)) })
      }
      return { values: {}, errors: errors as FieldErrors<Tarif595FormValues> }
    },
    [positionExists, t]
  )

  const defaultLang = tarif595LangOf(team?.language)

  const form = useForm<Tarif595FormValues>({
    resolver,
    defaultValues: defaultFormValues(config, defaultLang),
  })
  const { register, handleSubmit, watch, setValue, reset, formState } = form
  const { errors, isSubmitting } = formState

  // `errors.offerings` has no clean generic shape in react-hook-form for a
  // Record-typed field with dynamically-built dot-paths — routed through
  // `unknown` once, here, rather than cast at every read site below.
  const offeringsErrors = errors.offerings as unknown as
    | ({ message?: string } & Record<string, Record<string, { message?: string } | undefined>>)
    | undefined
  const offeringsRootError = offeringsErrors?.message
  const offeringsErrorsByKey: Record<string, Record<string, { message?: string } | undefined>> = offeringsErrors
    ? (Object.fromEntries(
        Object.entries(offeringsErrors).filter(([k]) => k !== 'message' && k !== 'type' && k !== 'ref')
      ) as Record<string, Record<string, { message?: string } | undefined>>)
    : {}

  const [rows, setRows] = useState<OfferingRow[]>([])
  const [initialized, setInitialized] = useState(false)

  const dataLoading =
    pluginsLoading || legalLoading || configLoading || subsLoading || activitiesLoading || coursesLoading

  useEffect(() => {
    if (dataLoading || initialized) return
    reset(defaultFormValues(config, defaultLang))
    const offerings = config?.offerings ?? {}
    const nextRows: OfferingRow[] = [
      ...subscriptionTypes.map((s) =>
        rowFrom(
          'subscription',
          s.id,
          s.name,
          {
            kind: 'subscription',
            recurrences: (s.prices ?? []).map((p) => p.recurrence),
            credits: Math.max(0, ...(s.prices ?? []).map((p) => p.credits ?? 0)) || null,
          },
          offerings
        )
      ),
      ...activities
        .filter((a) => (a.type ?? 'class') === 'class')
        .map((a) => rowFrom('activity', a.id, a.name, { kind: 'activity', activityType: 'class' }, offerings)),
      ...courses.map((c) => rowFrom('course', c.id, c.title, { kind: 'course' }, offerings)),
    ]
    setRows(nextRows)
    setInitialized(true)
    // Only ever runs the FIRST time every source has loaded — after that, row
    // edits are local state, merged into the `offerings` field below, and a
    // later config refetch (after Save) must not stomp an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoading, initialized])

  useEffect(() => {
    setValue('offerings', rowsToOfferings(rows), { shouldDirty: initialized })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  function updateRow(key: string, patch: Partial<OfferingRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  // ── Suggestions: fill the EMPTY rows from the model, mark them, save nothing ─
  // A row the manager already mapped is never overwritten — the model proposes
  // into blanks. Each filled row carries the reason and stays tinted until its
  // position is touched; the notice above the table says what that means.
  const [suggesting, setSuggesting] = useState(false)
  async function suggestPositions() {
    if (!teamId) return
    if (!rows.some((r) => !r.position)) {
      toast.info(t('suggest.nothingToFill'))
      return
    }
    setSuggesting(true)
    try {
      const { data } = await callSuggestTarif595Mappings({ teamId })
      const byKey = new Map(data.suggestions.map((s) => [s.key, s]))
      let filled = 0
      setRows((prev) =>
        prev.map((r) => {
          if (r.position) return r
          const s = byKey.get(r.key)
          if (!s?.position) return r
          filled += 1
          return {
            ...r,
            position: s.position,
            unit: s.unit ?? r.unit,
            entries: s.entries != null ? String(s.entries) : r.entries,
            ptPosition: s.ptPosition ?? r.ptPosition,
            suggestion: { confidence: s.confidence, reason: s.reason },
          }
        })
      )
      // `filled` is counted inside the updater, which React runs synchronously
      // for a state set outside a render — but say it after the set regardless.
      setTimeout(() => {
        if (filled > 0) toast.success(t('suggest.applied', { count: filled }))
        else toast.info(t('suggest.noneFound'))
      }, 0)
    } catch (err) {
      const code = (err as { code?: string })?.code ?? ''
      if (code.endsWith('resource-exhausted')) toast.error(t('suggest.rateLimited'))
      else toast.error(t('suggest.unavailable'))
      console.error('[tarif-595] suggest failed:', err)
    } finally {
      setSuggesting(false)
    }
  }

  const language = watch('language')
  const providerSameAsBiller = watch('providerSameAsBiller')

  // ── Expiring positions: warn ahead of 1 January, propose a replacement ─────
  // The position list retires rows every year, and a line dated after a
  // position's last valid day is refused by the preview. The date rule is the
  // positions module's own (`expiry`, handed out with the lazily loaded
  // table); there is no successor map, so a replacement is PROPOSED by the
  // same model path as of the day after expiry and applied only by a click —
  // unlike a fill-in suggestion, it would overwrite a mapping the manager made.
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const expiryOf = useMemo<ExpiryOf>(
    () => (code) => (code && positionsTable ? positionsTable.expiry(code, todayIso) : null),
    [positionsTable, todayIso]
  )
  const positionLabel = useMemo(
    () => (code: string) => {
      const p = positionsTable?.positions.find((x) => x.code === code)
      return p ? `${p.code} — ${p.text[language]}` : code
    },
    [positionsTable, language]
  )
  const [replacements, setReplacements] = useState<Record<string, OfferingReplacement>>({})
  const [suggestingReplacements, setSuggestingReplacements] = useState(false)

  async function suggestReplacements() {
    if (!teamId || !positionsTable) return
    const expiring = rows
      .map((r) => ({ r, until: expiryOf(r.position)?.status !== 'ok' ? expiryOf(r.position)?.validUntil ?? null : null }))
      .filter((x): x is { r: OfferingRow; until: string } => !!x.until)
    if (expiring.length === 0) return
    // As of the day after the LATEST last valid day among them, so every
    // proposal is valid once all of them have expired.
    const asOf = positionsTable.dayAfter(expiring.map((x) => x.until).sort().slice(-1)[0])
    setSuggestingReplacements(true)
    try {
      const { data } = await callSuggestTarif595Mappings({ teamId, asOf, keys: expiring.map((x) => x.r.key) })
      const next: Record<string, OfferingReplacement> = {}
      for (const s of data.suggestions) if (s.position) next[s.key] = { position: s.position, ptPosition: s.ptPosition, reason: s.reason }
      setReplacements(next)
      if (Object.keys(next).length > 0) toast.success(t('expiry.replacementsFound', { count: Object.keys(next).length }))
      else toast.info(t('expiry.replacementsNone'))
    } catch (err) {
      const code = (err as { code?: string })?.code ?? ''
      if (code.endsWith('resource-exhausted')) toast.error(t('suggest.rateLimited'))
      else toast.error(t('suggest.unavailable'))
      console.error('[tarif-595] replacement suggest failed:', err)
    } finally {
      setSuggestingReplacements(false)
    }
  }

  // "Use" writes a SUCCESSOR, never an overwrite: in January the studio still
  // issues last year's receipts, whose lines need the old position, beside
  // the new year's. The successor starts the day after the old position's last
  // valid day; a PT companion that survives the change is carried over, one
  // that expires too is replaced by the proposal's (or dropped).
  function applyReplacement(key: string) {
    const rep = replacements[key]
    const row = rows.find((r) => r.key === key)
    if (!rep || !row || !positionsTable) return
    const until = [expiryOf(row.position), expiryOf(row.ptPosition)]
      .map((e) => (e && e.status !== 'ok' ? e.validUntil : null))
      .filter((d): d is string => !!d)
      .sort()[0]
    if (!until) return
    const from = positionsTable.dayAfter(until)
    const ptSurvives = !!row.ptPosition && expiryOf(row.ptPosition)?.status === 'ok'
    updateRow(key, { successor: { from, position: rep.position, ptPosition: rep.ptPosition ?? (ptSurvives ? row.ptPosition : null) } })
    setReplacements((prev) => {
      const { [key]: _used, ...rest } = prev
      return rest
    })
  }

  async function onSubmit(values: Tarif595FormValues) {
    if (!teamId || !canEdit) return
    try {
      await saveTarif595Config(
        teamId,
        user?.uid ?? null,
        valuesToConfig(values) as Omit<Tarif595Config, 'updated_at' | 'updated_by'>
      )
      invalidate()
      toast.success(t('saved'))
    } catch (err) {
      console.error('[tarif-595] settings save failed:', err)
      toast.error(t('saveError'))
    }
  }

  if (pluginsLoading) return <Skeleton className="m-6 h-40" />
  if (!teamId || !isInstalled('tarif-595')) {
    return (
      <div className="p-6 space-y-2">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t('title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('notInstalled')}</p>
      </div>
    )
  }

  if (!canEdit) {
    return (
      <div className="p-6 space-y-2">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t('title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('managerOnly')}</p>
      </div>
    )
  }

  const legalComplete = legalProfileIsComplete(legalProfile)

  // FULL WIDTH, and no card around the form. The offerings table carries two
  // position pickers, a unit, a count and a text per row: capped at 6xl it
  // still overflowed, and the only way to reach its horizontal scrollbar was
  // to scroll to the bottom of a long page first. A card's padding and border
  // only narrowed it further, so the page IS the container — the identifier
  // sections above set their own widths.
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Link
          href={'/plugins/tarif-595' as Route}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t('back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <HeartPulse className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('title')}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>

      {dataLoading ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
          {/* (a) Legal profile status */}
          <FormSection title={t('legalProfileSectionTitle')}>
            <div className="flex items-center gap-2">
              {legalComplete ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span className="text-sm">{t('legalProfileComplete')}</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-amber-600" />
                  <span className="text-sm">{t('legalProfileIncomplete')}</span>
                </>
              )}
              <Link href={'/settings/team?tab=payments' as Route} className="text-sm text-primary hover:underline">
                {t('legalProfileLink')}
              </Link>
            </div>
          </FormSection>

          {/* (b) Identifiers */}
          <FormSection title={t('identifiersSectionTitle')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="t595-biller-gln">{t('billerGln')}</Label>
                <Input id="t595-biller-gln" {...register('billerGln')} />
                {errors.billerGln?.message && (
                  <p className="text-xs text-destructive">{errors.billerGln.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t595-biller-zsr">{t('billerZsr')}</Label>
                <Input id="t595-biller-zsr" {...register('billerZsr')} placeholder="A123456" />
                {errors.billerZsr?.message && (
                  <p className="text-xs text-destructive">{errors.billerZsr.message}</p>
                )}
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch
                checked={providerSameAsBiller}
                onCheckedChange={(v: boolean) => setValue('providerSameAsBiller', v, { shouldDirty: true })}
              />
              {t('providerSameAsBiller')}
            </label>

            {!providerSameAsBiller && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="t595-provider-gln">{t('providerGln')}</Label>
                  <Input id="t595-provider-gln" {...register('providerGln')} />
                  {errors.providerGln?.message && (
                    <p className="text-xs text-destructive">{errors.providerGln.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t595-provider-gln-location">{t('providerGlnLocation')}</Label>
                  <Input id="t595-provider-gln-location" {...register('providerGlnLocation')} />
                  {errors.providerGlnLocation?.message && (
                    <p className="text-xs text-destructive">{errors.providerGlnLocation.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t595-provider-zsr">{t('providerZsr')}</Label>
                  <Input id="t595-provider-zsr" {...register('providerZsr')} placeholder="A123456" />
                  {errors.providerZsr?.message && (
                    <p className="text-xs text-destructive">{errors.providerZsr.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t595-provider-uid">{t('providerUid')}</Label>
                  <Input id="t595-provider-uid" {...register('providerUid')} />
                </div>
              </div>
            )}
          </FormSection>

          {/* (c) Document */}
          <FormSection title={t('documentSectionTitle')}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="t595-language">{t('language')}</Label>
                <Select
                  value={watch('language')}
                  onValueChange={(v) => setValue('language', v as Tarif595Lang, { shouldDirty: true })}
                >
                  <SelectTrigger id="t595-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="de">Deutsch</SelectItem>
                    <SelectItem value="fr">Français</SelectItem>
                    <SelectItem value="it">Italiano</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t595-modus">{t('modus')}</Label>
                <Select
                  value={watch('modus')}
                  onValueChange={(v) => setValue('modus', v as 'production' | 'test', { shouldDirty: true })}
                >
                  <SelectTrigger id="t595-modus">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="test">{t('modusTest')}</SelectItem>
                    <SelectItem value="production">{t('modusProduction')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {watch('modus') === 'test' ? t('modusTestHelp') : t('modusProductionHelp')}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t595-prefix">{t('numberingPrefix')}</Label>
                <Input
                  id="t595-prefix"
                  value={watch('numberingPrefix')}
                  onChange={(e) =>
                    setValue(
                      'numberingPrefix',
                      e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
                      { shouldDirty: true }
                    )
                  }
                  maxLength={10}
                />
                {errors.numberingPrefix?.message && (
                  <p className="text-xs text-destructive">{errors.numberingPrefix.message}</p>
                )}
              </div>
            </div>
          </FormSection>

          {/* (d) Offerings — a data table; the row model and the cells live in
              plugins/tarif-595/OfferingsTable.tsx. "Suggest positions" fills
              the EMPTY rows from the model and marks them; nothing is saved
              until the manager presses Save. */}
          <FormSection
            title={t('offeringsSectionTitle')}
            description={t('offeringsSectionDescription')}
            action={
              rows.length > 0 && canEdit ? (
                <Button type="button" size="sm" variant="outline" onClick={suggestPositions} disabled={suggesting}>
                  {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {suggesting ? t('suggest.running') : t('suggest.button')}
                </Button>
              ) : undefined
            }
          >
            {offeringsRootError && <p className="text-xs text-destructive">{offeringsRootError}</p>}
            {rows.some((r) => r.suggestion) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{t('suggest.notice')}</p>
              </div>
            )}
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('offeringsNone')}</p>
            ) : (
              <OfferingsTable
                rows={rows}
                language={language}
                errorsByKey={offeringsErrorsByKey}
                onUpdate={updateRow}
                expiryOf={expiryOf}
                positionLabel={positionLabel}
                replacements={replacements}
                onUseReplacement={applyReplacement}
                onSuggestReplacements={suggestReplacements}
                suggestingReplacements={suggestingReplacements}
              />
            )}
          </FormSection>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSubmitting ? t('saving') : t('save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
