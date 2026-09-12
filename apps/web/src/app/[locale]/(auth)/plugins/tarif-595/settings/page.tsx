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
import { ArrowLeft, CheckCircle2, HeartPulse, Loader2, XCircle } from 'lucide-react'
import {
  TARIF595_FREE_TEXT_CODE,
  legalProfileIsComplete,
  tarif595LangOf,
  tarif595OfferingKey,
  validateTarif595Config,
  type Tarif595Config,
  type Tarif595ConfigIssueCode,
  type Tarif595Lang,
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
import { useTarif595Config, saveTarif595Config, useInvalidateTarif595 } from '@/plugins/tarif-595/hooks'
import { PositionPicker, useTarif595PositionsTable } from '@/plugins/tarif-595/PositionPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { FormSection } from '@/components/ui/form-section'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

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

interface OfferingRow {
  key: string
  kind: Tarif595OfferingKind
  id: string
  name: string
  position: string | null
  unit: Tarif595Unit | ''
  entries: string
  ptPosition: string | null
  customName: string
}

function rowFrom(
  kind: Tarif595OfferingKind,
  id: string,
  name: string,
  offerings: Record<string, Tarif595OfferingMapping>
): OfferingRow {
  const key = tarif595OfferingKey(kind, id)
  const m = offerings[key]
  return {
    key,
    kind,
    id,
    name,
    position: m?.position ?? null,
    unit: m?.unit ?? '',
    entries: m?.entries != null ? String(m.entries) : '',
    ptPosition: m?.ptPosition ?? null,
    customName: m?.customName ?? '',
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
    out[r.key] = mapping
  }
  return out
}

const UNITS: Tarif595Unit[] = ['month', 'year', 'lesson', 'entry', 'flat']

// Literal `t('key')` calls only — no template-literal keys — so every label
// below is spelled out rather than built from `kind`/`unit`.
function kindLabel(t: ReturnType<typeof useTranslations>, kind: Tarif595OfferingKind): string {
  if (kind === 'subscription') return t('kind.subscription')
  if (kind === 'activity') return t('kind.activity')
  return t('kind.course')
}

function unitLabel(t: ReturnType<typeof useTranslations>, unit: Tarif595Unit): string {
  if (unit === 'month') return t('unit.month')
  if (unit === 'year') return t('unit.year')
  if (unit === 'lesson') return t('unit.lesson')
  if (unit === 'entry') return t('unit.entry')
  return t('unit.flat')
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
    const nextRows: OfferingRow[] = [
      ...subscriptionTypes.map((s) => rowFrom('subscription', s.id, s.name, config?.offerings ?? {})),
      ...activities
        .filter((a) => (a.type ?? 'class') === 'class')
        .map((a) => rowFrom('activity', a.id, a.name, config?.offerings ?? {})),
      ...courses.map((c) => rowFrom('course', c.id, c.title, config?.offerings ?? {})),
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

  const language = watch('language')
  const providerSameAsBiller = watch('providerSameAsBiller')

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

  return (
    <div className="max-w-3xl space-y-6 p-4 sm:p-6">
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
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 rounded-xl border bg-card p-4 sm:p-6">
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

          {/* (d) Offerings */}
          <FormSection title={t('offeringsSectionTitle')} description={t('offeringsSectionDescription')}>
            {offeringsRootError && <p className="text-xs text-destructive">{offeringsRootError}</p>}
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('offeringsNone')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('offeringName')}</TableHead>
                    <TableHead>{t('offeringPosition')}</TableHead>
                    <TableHead>{t('offeringUnit')}</TableHead>
                    <TableHead>{t('offeringEntries')}</TableHead>
                    <TableHead>{t('offeringPtPosition')}</TableHead>
                    <TableHead>{t('offeringCustomText')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const rowErrors = offeringsErrorsByKey[row.key]
                    return (
                      <TableRow key={row.key}>
                        <TableCell className="whitespace-normal">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[10px] uppercase">
                              {kindLabel(t, row.kind)}
                            </Badge>
                            <span className="text-sm">{row.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-52">
                          <PositionPicker
                            value={row.position}
                            onChange={(code) => updateRow(row.key, { position: code })}
                            language={language}
                            allowExpired
                          />
                          {rowErrors?.position?.message && (
                            <p className="text-xs text-destructive mt-1">{rowErrors.position.message}</p>
                          )}
                        </TableCell>
                        <TableCell className="min-w-36">
                          <Select
                            value={row.unit || undefined}
                            onValueChange={(v) => updateRow(row.key, { unit: v as Tarif595Unit })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('offeringUnitPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {UNITS.map((u) => (
                                <SelectItem key={u} value={u}>
                                  {unitLabel(t, u)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {rowErrors?.unit?.message && (
                            <p className="text-xs text-destructive mt-1">{rowErrors.unit.message}</p>
                          )}
                        </TableCell>
                        <TableCell className="min-w-24">
                          {row.unit === 'entry' && (
                            <>
                              <Input
                                type="number"
                                min={1}
                                value={row.entries}
                                onChange={(e) => updateRow(row.key, { entries: e.target.value })}
                                className="w-20"
                              />
                              {rowErrors?.entries?.message && (
                                <p className="text-xs text-destructive mt-1">{rowErrors.entries.message}</p>
                              )}
                            </>
                          )}
                        </TableCell>
                        <TableCell className="min-w-52">
                          <PositionPicker
                            value={row.ptPosition}
                            onChange={(code) => updateRow(row.key, { ptPosition: code })}
                            language={language}
                            allowExpired
                          />
                          {rowErrors?.ptPosition?.message && (
                            <p className="text-xs text-destructive mt-1">{rowErrors.ptPosition.message}</p>
                          )}
                        </TableCell>
                        <TableCell className="min-w-48">
                          {row.position === TARIF595_FREE_TEXT_CODE && (
                            <>
                              <Input
                                value={row.customName}
                                onChange={(e) => updateRow(row.key, { customName: e.target.value })}
                                placeholder={t('offeringCustomTextPlaceholder')}
                              />
                              {rowErrors?.customName?.message && (
                                <p className="text-xs text-destructive mt-1">{rowErrors.customName.message}</p>
                              )}
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
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
