'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations, useLocale } from 'next-intl'
import { toast } from 'sonner'
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { checkTeamSlug } from '@/lib/teamSlug'
import { useAuth } from '@/contexts/AuthContext'
import { RankLevelFields } from '@/components/ranking/RankLevelFields'
import { RankBadge } from '@/components/ranking/RankBadge'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { CustomFieldsTab } from '@/plugins/custom-fields/CustomFieldsTab'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useOpenTabs } from '@/contexts/OpenTabsContext'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  TEAMS_COLLECTION,
  ALERT_PRESETS_SUBCOLLECTION,
  isReservedSlug,
  DEFAULT_ENGAGEMENT_THRESHOLDS,
} from '@linyup/shared'
import type {
  Team,
  AlertScheduleType,
  RankingSystem,
  RankLevel,
  TeamIntegration,
  PaymentGatewayType,
  RegionalSettings,
  DateFormatStyle,
  TimeFormatStyle,
  WeekStart,
} from '@linyup/shared'
import {
  createRegionalFormatter,
  resolveRegional,
  deviceTimeZone,
  DATE_FORMAT_SAMPLE,
  DATE_FORMAT_STYLES,
} from '@/lib/format'
import {
  AlertTriangle,
  CalendarDays,
  Timer,
  Plus,
  Pencil,
  Trash2,
  Star,
  Building2,
  Mail,
  Copy,
  CheckCircle2,
  Clock,
  XCircle,
  Zap,
} from 'lucide-react'
import { QueryErrorState } from '@/components/ui/query-error'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import { ConnectPaymentsCard } from '@/components/connect/ConnectPaymentsCard'
import { PaymentModesCard } from '@/components/payments/PaymentModesCard'
import { BillingCurrencyCard, useGatewayCurrency } from '@/components/connect/BillingCurrencyCard'
import { RANK_PRESETS } from '@/lib/rank-presets'
import { useRankHolderCount } from '@/lib/rank-utils'
import { useRankingSystems } from '@/hooks/useRankingSystems'
import { useEmailSenderSettings } from '@/hooks/useEmailSenderSettings'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useByoStripeDoubleRecording } from '@/hooks/useConnect'
import { Link, useRouter } from '@/i18n/navigation'
import type { Route } from 'next'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { DeleteAccountCard } from '@/components/settings/DeleteAccountCard'

// ─── constants ────────────────────────────────────────────────────────────────

const SPORT_TYPES = [
  'Martial arts',
  'Football / Soccer',
  'Basketball',
  'Volleyball',
  'Tennis',
  'Swimming',
  'Gymnastics',
  'CrossFit / Fitness',
  'Yoga / Pilates',
  'Dance',
  'Rugby',
  'Cycling',
  'Athletics',
  'Other',
]

const SLUG_REGEX = /^[a-z0-9-]+$/

// ─── types ────────────────────────────────────────────────────────────────────

interface AlertPreset {
  id: string
  name: string
  description?: string
  schedule_type: AlertScheduleType
  schedule_value?: number
  message: string
  show_in_app?: boolean
}

// ─── schemas ──────────────────────────────────────────────────────────────────

/** The four languages the product speaks — same set as the i18n routing, named
 *  here because this control is about OUTBOUND MAIL, not about the URL. */
const TEAM_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
] as const

const generalSchema = z.object({
  name: z.string().min(2, 'At least 2 characters').max(60, 'Max 60 characters'),
  description: z.string().max(500, 'Max 500 characters').optional(),
  sport_type: z.string().optional(),
  // The language this studio writes to its MEMBERS in. It had no editor
  // anywhere in the app until 2026-08-23 — declared on the type, read by ~15
  // call sites in the functions to pick the language of every outbound mail,
  // and writable only by a seed. A German studio created through signup mailed
  // its members in English with no way to change it.
  language: z.enum(['en', 'de', 'fr', 'it']),
  slug: z
    .string()
    .min(3, 'At least 3 characters')
    .max(50, 'Max 50 characters')
    .regex(SLUG_REGEX, 'Only lowercase letters, numbers and hyphens'),
})
type GeneralData = z.infer<typeof generalSchema>

const presetSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  schedule_type: z.enum(['sessions_countdown', 'datetime', 'always']),
  schedule_value: z.coerce.number().min(1).optional(),
  message: z.string().min(1).max(500),
  show_in_app: z.boolean().optional(),
})
type PresetData = z.infer<typeof presetSchema>

const gatewaySchema = z.object({
  gatewayType: z.enum(['stripe', 'payrexx']),
  identifier: z.string().min(1, 'Required'),
  currency: z.string().min(3).max(3).toUpperCase(),
  // Payrexx-specific (optional — only submitted when gatewayType === 'payrexx')
  webhookSigningSecret: z.string().optional(),
  defaultSubscriptionTypeId: z.string().optional(),
})
type GatewayFormData = z.infer<typeof gatewaySchema>

// ─── owner-only note ──────────────────────────────────────────────────────────
// Everything on this page writes the team doc or one of its owner-only
// subcollections (alert_presets, integrations — firestore.rules), so a
// manager-role member can read it all and change none of it. `canEdit` is
// derived ONCE on the page (useCapabilities().can('team.settings'), the
// capability that is owner-only by definition) and threaded into each form,
// which disables its inputs and its Save and renders this line — the same
// one-line treatment CancellationPolicyCard and SystemEmailsCard already use.
// The rail also hides the sections a non-owner can only look at; see
// lib/settings-nav.ts.

function OwnerOnlyNote() {
  const t = useTranslations('TeamSettings')
  return <p className="text-xs text-muted-foreground">{t('ownerOnly')}</p>
}

// ─── data helpers ─────────────────────────────────────────────────────────────

// Asked of the server (`lib/teamSlug.ts`), which owns this question and is the
// only place that can answer it. This used to be a client `where('slug','==',…)`
// over `teams`, which the rules refuse the moment a matching document belongs to
// a studio the caller is not in — i.e. it threw for exactly the case it exists
// to detect, and `onSlugBlur` had no catch, so the spinner stuck and the form
// saved a slug that was already taken.
async function isSlugAvailable(slug: string, teamId: string): Promise<boolean> {
  if (isReservedSlug(slug)) return false
  const check = await checkTeamSlug(slug, teamId)
  return check.available
}

function useTeam(teamId: string | null) {
  return useQuery<Team | null>({
    queryKey: ['team', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return snap.exists() ? ({ id: snap.id, ...snap.data() } as Team) : null
    },
  })
}

function useAlertPresets(teamId: string | null) {
  return useQuery<AlertPreset[]>({
    queryKey: ['alert-presets', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId, ALERT_PRESETS_SUBCOLLECTION)
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as AlertPreset)
    },
  })
}

// teams/{id}/integrations is owner-only for READ as well as write
// (firestore.rules), so for a manager this query REJECTS. Its consumer must
// therefore branch on the capability before it branches on emptiness — "no
// gateway configured" and "you are not allowed to see this" are different
// facts, and only one of them is ever true for a non-owner.
function useGatewayIntegrations(teamId: string | null, enabled: boolean) {
  return useQuery<TeamIntegration[]>({
    queryKey: ['gateway-integrations', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId, 'integrations'),
          where('type', '==', 'payment_gateway')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as TeamIntegration)
    },
  })
}

// ─── engagement thresholds ────────────────────────────────────────────────────
// Day windows that drive the read-only engagement band shown on each contact.
// The band itself is derived on render (never stored).

function EngagementThresholdsForm({
  team,
  teamId,
  canEdit,
}: {
  team: Team
  teamId: string
  canEdit: boolean
}) {
  const t = useTranslations('TeamSettings')
  const qc = useQueryClient()
  const current = team.engagement_thresholds ?? DEFAULT_ENGAGEMENT_THRESHOLDS
  const [active, setActive] = useState(String(current.active_within_days))
  const [low, setLow] = useState(String(current.low_within_days))
  const [atRisk, setAtRisk] = useState(String(current.at_risk_within_days))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const a = Number(active)
  const l = Number(low)
  const r = Number(atRisk)
  const valid = [a, l, r].every((n) => Number.isInteger(n) && n > 0) && a < l && l < r

  async function onSave() {
    if (!valid || !canEdit) return
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), {
        engagement_thresholds: {
          active_within_days: a,
          low_within_days: l,
          at_risk_within_days: r,
        },
      })
      await qc.invalidateQueries({ queryKey: ['team', teamId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      toast.error(t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  const fields: { value: string; set: (v: string) => void; label: string; dot: string }[] = [
    { value: active, set: setActive, label: t('engagementActiveWithin'), dot: 'bg-emerald-500' },
    { value: low, set: setLow, label: t('engagementLowWithin'), dot: 'bg-amber-500' },
    { value: atRisk, set: setAtRisk, label: t('engagementAtRiskWithin'), dot: 'bg-red-500' },
  ]

  return (
    // No own top divider any more — it is now the first section inside the
    // "Other" Card (UI polish, Settings → General 3-card split).
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{t('engagementTitle')}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{t('engagementHelp')}</p>
        {!canEdit && <OwnerOnlyNote />}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {fields.map((f) => (
          <div key={f.label} className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <span className={`h-2 w-2 rounded-full ${f.dot}`} />
              {f.label}
            </Label>
            <Input
              type="number"
              min={1}
              value={f.value}
              disabled={!canEdit}
              onChange={(e) => f.set(e.target.value)}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('engagementDaysHint')}</p>
      {!valid && <p className="text-xs text-destructive">{t('engagementInvalid')}</p>}
      <SettingsSaveBar onSave={onSave} saving={saving} saved={saved} disabled={!canEdit || !valid} />
    </div>
  )
}

// Per-device interface preference: show/hide the navigational tab strip. Stored
// per-browser (localStorage via OpenTabsContext), not on the team — so it sits
// apart from the team fields, labelled as a this-device setting.
function TabBarPreference() {
  const t = useTranslations('TeamSettings')
  const { enabled, setEnabled } = useOpenTabs()
  return (
    // `pt-6`, not `pt-4` — this divider sits right below
    // EngagementThresholdsForm's own SettingsSaveBar (same "Other" Card), and
    // `pt-4` alone read as the save button touching the divider (UI polish,
    // Settings → General). SettingsSaveBar already adds `pt-2` above itself;
    // this is the gap BELOW it, which nothing previously supplied.
    <div className="space-y-3 pt-6 border-t">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t('tabBarTitle')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('tabBarHelp')}</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t('tabBarTitle')} />
      </div>
    </div>
  )
}

// ─── general form ─────────────────────────────────────────────────────────────

function GeneralForm({
  team,
  teamId,
  canEdit,
}: {
  team: Team
  teamId: string
  canEdit: boolean
}) {
  const t = useTranslations('TeamSettings')
  const qc = useQueryClient()
  const [slugError, setSlugError] = useState<string | null>(null)
  const [slugChecking, setSlugChecking] = useState(false)
  const [saved, setSaved] = useState(false)

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<GeneralData>({
    resolver: zodResolver(generalSchema),
    defaultValues: {
      name: team.name,
      description: team.description ?? '',
      sport_type: team.sport_type ?? '',
      // 'en' is what the server already falls back to for a team with no value
      // (`isLang(team.language) ? … : 'en'`), so the control shows the truth
      // rather than an empty box that implies nothing has been decided.
      language: (team.language ?? 'en') as 'en' | 'de' | 'fr' | 'it',
      slug: team.slug,
    },
  })

  async function onSlugBlur(slug: string) {
    if (!SLUG_REGEX.test(slug) || slug.length < 3) return
    setSlugChecking(true)
    setSlugError(null)
    try {
      const available = await isSlugAvailable(slug, teamId)
      if (!available) setSlugError(isReservedSlug(slug) ? t('slugReserved') : t('slugTaken'))
    } catch {
      // FAILS CLOSED, and deliberately: `onSubmit` refuses while `slugError` is
      // set, so a check that could not run blocks Save. Two studios sharing a
      // slug send one studio's members to the other's public page and there is
      // no error anywhere to notice it; being asked to retry a blurred field is
      // the cheaper failure. Editing the slug again clears this and re-checks.
      setSlugError(t('slugCheckFailed'))
    } finally {
      setSlugChecking(false)
    }
  }

  async function onSubmit(data: GeneralData) {
    if (slugError || !canEdit) return
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), {
        name: data.name,
        description: data.description ?? '',
        sport_type: data.sport_type ?? '',
        language: data.language,
        slug: data.slug,
      })
      await qc.invalidateQueries({ queryKey: ['team', teamId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      toast.error(t('saveError'))
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {!canEdit && <OwnerOnlyNote />}

      <div className="space-y-1.5">
        <Label htmlFor="name">{t('teamName')}</Label>
        <Input id="name" {...register('name')} disabled={!canEdit} />
        {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">{t('description')}</Label>
        <textarea
          id="description"
          {...register('description')}
          rows={3}
          disabled={!canEdit}
          placeholder={t('descriptionPlaceholder')}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none disabled:opacity-60"
        />
        {errors.description && (
          <p className="text-destructive text-xs">{errors.description.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sport_type">{t('sportType')}</Label>
        <Controller
          name="sport_type"
          control={control}
          render={({ field }) => (
            <Select
              value={field.value || '__none__'}
              disabled={!canEdit}
              onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('sportTypeNone')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('sportTypeNone')}</SelectItem>
                {SPORT_TYPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="language">{t('language')}</Label>
        <Controller
          name="language"
          control={control}
          render={({ field }) => (
            <Select value={field.value} disabled={!canEdit} onValueChange={field.onChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEAM_LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {/* Said plainly, because the obvious reading is the wrong one: this is
            not the language of the dashboard (that follows the URL), it is the
            language your members are written to in. */}
        <p className="text-xs text-muted-foreground">{t('languageHint')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="slug">{t('slug')}</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0 select-none">
            /public/
          </span>
          <Input
            id="slug"
            {...register('slug')}
            disabled={!canEdit}
            onBlur={(e) => onSlugBlur(e.target.value)}
            placeholder="my-club"
            className="font-mono"
          />
        </div>
        {slugChecking && <p className="text-muted-foreground text-xs">{t('slugChecking')}</p>}
        {slugError && <p className="text-destructive text-xs">{slugError}</p>}
        {errors.slug && !slugError && (
          <p className="text-destructive text-xs">{errors.slug.message}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('slugHelp')}</p>
      </div>

      <SettingsSaveBar
        type="submit"
        saving={isSubmitting}
        saved={saved}
        disabled={!canEdit || !isDirty || !!slugError || slugChecking}
      />
    </form>
  )
}

// ─── region & formats ─────────────────────────────────────────────────────────
// How this studio RENDERS dates and times. All four settings are team-wide on
// purpose — one studio, one clock, one printed roster — while the reader's UI
// language stays per-user and layers on top: it picks the words, this picks the
// shape. Absent means the Swiss defaults, so nothing here needs a migration.
//
// DISPLAY ONLY. This zone is not the one the scheduling or accounting math runs
// in; see the header of shared/utils/regional.ts for that boundary.

/** A fixed instant, not `now` — the 31st tells DD/MM from MM/DD at a glance,
 *  and a constant cannot drift between the server render and the browser's. */
const REGION_PREVIEW_INSTANT = new Date(Date.UTC(2026, 0, 31, 17, 30))

function RegionalForm({
  team,
  teamId,
  canEdit,
}: {
  team: Team
  teamId: string
  canEdit: boolean
}) {
  const t = useTranslations('TeamSettings')
  const locale = useLocale()
  const qc = useQueryClient()
  const stored = resolveRegional(team.regional)
  // Seeded at MOUNT and intentionally not resynced — a form that rewrites the
  // field somebody is typing in is worse than a stale one. The call site keys
  // this component on the team id so a team switch remounts it; see there.
  const [draft, setDraft] = useState<RegionalSettings>(stored)
  const [zones, setZones] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Client-only: ~400 <option>s have no business in the server-rendered HTML,
  // and populating them after mount keeps the datalist out of hydration.
  useEffect(() => {
    try {
      const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
      setZones(supported ? supported('timeZone') : [])
    } catch {
      setZones([])
    }
  }, [])

  const zoneValid = draft.timezone === resolveRegional(draft).timezone
  const dirty =
    draft.timezone !== stored.timezone ||
    draft.weekStartsOn !== stored.weekStartsOn ||
    draft.dateFormat !== stored.dateFormat ||
    draft.timeFormat !== stored.timeFormat

  const previewSettings = zoneValid ? draft : stored
  const preview = useMemo(
    () => createRegionalFormatter(locale, previewSettings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, previewSettings.timezone, previewSettings.dateFormat, previewSettings.timeFormat]
  )

  function set<K extends keyof RegionalSettings>(key: K, value: RegionalSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function onSave() {
    if (!canEdit || !zoneValid) return
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { regional: draft })
      await qc.invalidateQueries({ queryKey: ['team', teamId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      toast.error(t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    // No own heading/divider here any more — this now lives inside its own
    // "Region & format" Card, whose CardHeader carries the title and the hint
    // (`regionTitle`/`regionHint`) that used to be repeated in-line right below
    // it (UI polish, Settings → General 3-card split).
    <div className="space-y-4">
      {!canEdit && <OwnerOnlyNote />}

      <div className="space-y-1.5">
        <Label htmlFor="regional-timezone">{t('regionTimezone')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="regional-timezone"
            list="regional-timezone-options"
            value={draft.timezone}
            disabled={!canEdit}
            onChange={(e) => set('timezone', e.target.value.trim())}
            placeholder="Europe/Zurich"
            className="font-mono"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => set('timezone', deviceTimeZone())}
          >
            {t('regionUseDeviceTimezone')}
          </Button>
        </div>
        <datalist id="regional-timezone-options">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        {!zoneValid && <p className="text-destructive text-xs">{t('regionTimezoneInvalid')}</p>}
        <p className="text-xs text-muted-foreground">{t('regionTimezoneHint')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>{t('regionWeekStart')}</Label>
          <Select
            value={String(draft.weekStartsOn)}
            disabled={!canEdit}
            onValueChange={(v) => set('weekStartsOn', (v === '0' ? 0 : 1) as WeekStart)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t('regionWeekStartMonday')}</SelectItem>
              <SelectItem value="0">{t('regionWeekStartSunday')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>{t('regionDateFormat')}</Label>
          <Select
            value={draft.dateFormat}
            disabled={!canEdit}
            onValueChange={(v) => set('dateFormat', v as DateFormatStyle)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMAT_STYLES.map((s) => (
                <SelectItem key={s} value={s}>
                  {DATE_FORMAT_SAMPLE[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>{t('regionTimeFormat')}</Label>
          <Select
            value={draft.timeFormat}
            disabled={!canEdit}
            onValueChange={(v) => set('timeFormat', v as TimeFormatStyle)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">{t('regionTime24h')}</SelectItem>
              <SelectItem value="12h">{t('regionTime12h')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">{t('regionPreview')}</p>
        <p className="text-sm mt-0.5 tabular-nums">
          {preview.dateMedium(REGION_PREVIEW_INSTANT)} · {preview.date(REGION_PREVIEW_INSTANT)} ·{' '}
          {preview.time(REGION_PREVIEW_INSTANT)}
        </p>
      </div>

      <SettingsSaveBar
        onSave={onSave}
        saving={saving}
        saved={saved}
        disabled={!canEdit || !dirty || !zoneValid}
      />
    </div>
  )
}

// ─── alert presets tab ────────────────────────────────────────────────────────

/** Icon + i18n key for a schedule type — mirrors the contact detail page's
 *  `alertTypeIcon` / `alertTypeLabelKey` (a preset's schedule type is the same
 *  union, rendered the same way, one file over). */
function alertTypeIcon(type: AlertScheduleType, className = 'h-4 w-4') {
  switch (type) {
    case 'sessions_countdown':
      return <Timer className={className} />
    case 'datetime':
      return <CalendarDays className={className} />
    case 'always':
      return <Zap className={className} />
  }
}

function alertTypeLabelKey(
  type: AlertScheduleType
): 'alertTypeSessionsCountdown' | 'alertTypeDatetime' | 'alertTypeAlways' {
  switch (type) {
    case 'sessions_countdown':
      return 'alertTypeSessionsCountdown'
    case 'datetime':
      return 'alertTypeDatetime'
    case 'always':
      return 'alertTypeAlways'
  }
}

function PresetDialog({
  open,
  onOpenChange,
  teamId,
  editing,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  editing: AlertPreset | null
  onSaved: () => void
}) {
  const t = useTranslations('TeamSettings')

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { isSubmitting },
  } = useForm<PresetData>({
    resolver: zodResolver(presetSchema),
    defaultValues: {
      name: editing?.name ?? '',
      description: editing?.description ?? '',
      schedule_type: editing?.schedule_type ?? 'sessions_countdown',
      schedule_value: editing?.schedule_value ?? 10,
      message: editing?.message ?? '',
      show_in_app: editing?.show_in_app ?? false,
    },
  })

  const scheduleType = watch('schedule_type')

  async function onSubmit(data: PresetData) {
    const payload = {
      name: data.name,
      description: data.description || null,
      schedule_type: data.schedule_type,
      schedule_value:
        data.schedule_type === 'sessions_countdown' ? Number(data.schedule_value) : null,
      message: data.message,
      show_in_app: data.show_in_app ?? false,
    }
    try {
      if (editing) {
        await updateDoc(
          doc(db, TEAMS_COLLECTION, teamId, ALERT_PRESETS_SUBCOLLECTION, editing.id),
          payload
        )
      } else {
        await addDoc(collection(db, TEAMS_COLLECTION, teamId, ALERT_PRESETS_SUBCOLLECTION), {
          ...payload,
          created_at: serverTimestamp(),
        })
      }
      onSaved()
      reset()
      onOpenChange(false)
    } catch {
      toast.error(t('saveError'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? t('editAlertPreset') : t('addAlertPreset')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 py-1">
          <div className="space-y-1">
            <Label>{t('alertPresetName')}</Label>
            <Input {...register('name')} placeholder="e.g. 10th session gift" />
          </div>
          <div className="space-y-1">
            <Label>{t('alertPresetDesc')}</Label>
            <Input {...register('description')} />
          </div>

          {/* Schedule type */}
          <div className="space-y-1.5">
            <Label>{t('alertPresetScheduleType')}</Label>
            <div className="flex gap-2">
              {(['sessions_countdown', 'datetime', 'always'] as AlertScheduleType[]).map((type) => (
                <label key={type} className="flex-1 cursor-pointer">
                  <input
                    type="radio"
                    value={type}
                    {...register('schedule_type')}
                    className="sr-only"
                  />
                  <div
                    className={`flex items-center gap-1.5 justify-center py-1.5 px-3 rounded-lg border text-sm font-medium transition-colors ${
                      scheduleType === type
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {alertTypeIcon(type, 'h-3.5 w-3.5')}
                    {t(alertTypeLabelKey(type))}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {scheduleType === 'sessions_countdown' ? (
            <div className="space-y-1">
              <Label>{t('alertPresetSessionCount')}</Label>
              <Input type="number" min="1" {...register('schedule_value')} />
            </div>
          ) : scheduleType === 'datetime' ? (
            <p className="text-xs text-muted-foreground rounded-lg bg-muted px-3 py-2">
              {t('alertPresetDateInfo')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground rounded-lg bg-muted px-3 py-2">
              {t('alertPresetAlwaysInfo')}
            </p>
          )}

          <div className="space-y-1">
            <Label>{t('alertPresetMessage')}</Label>
            <textarea
              {...register('message')}
              rows={3}
              placeholder="e.g. Time for the welcome gift!"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" {...register('show_in_app')} className="rounded border-input" />
            {t('alertPresetShowInApp')}
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AlertPresetsTab({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const t = useTranslations('TeamSettings')
  const qc = useQueryClient()
  const { data: presets = [], isLoading } = useAlertPresets(teamId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AlertPreset | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['alert-presets', teamId] })

  const openAdd = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (p: AlertPreset) => {
    setEditing(p)
    setDialogOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (!canEdit) return
    try {
      await deleteDoc(doc(db, TEAMS_COLLECTION, teamId, ALERT_PRESETS_SUBCOLLECTION, id))
      invalidate()
    } catch {
      toast.error(t('saveError'))
    } finally {
      setDeleting(null)
    }
  }

  if (isLoading)
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    )

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('presetsInfo')}</p>
      {!canEdit && <OwnerOnlyNote />}

      <div className="flex justify-end">
        <Button size="sm" onClick={openAdd} disabled={!canEdit}>
          <Plus className="h-4 w-4 mr-1.5" />
          {t('addAlertPreset')}
        </Button>
      </div>

      {presets.length === 0 ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {t('noAlertPresets')}
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((p) => (
            <div key={p.id} className="flex items-start gap-3 p-3 rounded-lg border">
              <div className="mt-0.5 shrink-0 text-muted-foreground">
                {alertTypeIcon(p.schedule_type)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{p.name}</p>
                  <Badge variant="outline" className="text-xs">
                    {p.schedule_type === 'sessions_countdown'
                      ? t('presetSessionsCount', { count: p.schedule_value ?? 0 })
                      : t(alertTypeLabelKey(p.schedule_type))}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{p.message}</p>
              </div>
              {canEdit && (
                <>
                  <button
                    onClick={() => openEdit(p)}
                    className="p-1.5 rounded hover:bg-muted transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                  <button
                    onClick={() => setDeleting(p.id)}
                    className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <PresetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        teamId={teamId}
        editing={editing}
        onSaved={invalidate}
      />

      <Dialog open={!!deleting} onOpenChange={() => setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deletePreset')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            {t('deletePresetConfirm', { name: presets.find((p) => p.id === deleting)?.name ?? '' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleting && handleDelete(deleting)}>
              {t('deletePreset')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── ranking tab ──────────────────────────────────────────────────────────────

const SLUG_REGEX_RANK = /^[a-z0-9-]+$/

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
}

interface RankSystemFormState {
  id: string
  name: string
  levels: RankLevel[]
  is_primary: boolean
}

function emptySystem(): RankSystemFormState {
  return { id: '', name: '', levels: [], is_primary: false }
}

function RankSystemDialog({
  open,
  onOpenChange,
  initial,
  existingIds,
  onSave,
  storagePath,
  holderTeamIds,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: RankSystemFormState | null
  existingIds: string[]
  onSave: (s: RankSystemFormState) => void
  /** Where uploaded badge artwork goes — see the Storage rule for
   *  `teams/{teamId}/ranking`. */
  storagePath: string
  /** Whose contacts a removed level would orphan — this studio. `null` when
   *  that is not known, which is not the same as nobody. */
  holderTeamIds: string[] | null
}) {
  const t = useTranslations('TeamSettings')
  const [form, setForm] = useState<RankSystemFormState>(initial ?? emptySystem())
  const [presetOpen, setPresetOpen] = useState(false)
  const [idTouched, setIdTouched] = useState(false)
  const [idError, setIdError] = useState('')
  const [pendingRemove, setPendingRemove] = useState<number | null>(null)
  const levelHolders = useRankHolderCount()

  const isEdit = !!initial

  useEffect(() => {
    if (open) {
      setForm(initial ?? emptySystem())
      setIdTouched(false)
      setIdError('')
      setPresetOpen(false)
      setPendingRemove(null)
    }
  }, [open, initial])

  const setName = (name: string) => {
    setForm((f) => ({
      ...f,
      name,
      id: idTouched ? f.id : generateId(name),
    }))
  }

  const setId = (id: string) => {
    setIdTouched(true)
    setForm((f) => ({ ...f, id }))
    if (!SLUG_REGEX_RANK.test(id)) {
      setIdError(t('rankingSystemIdHelp'))
    } else if (!isEdit && existingIds.includes(id)) {
      setIdError('ID already in use.')
    } else {
      setIdError('')
    }
  }

  const addLevel = () => {
    const nextVal = form.levels.length > 0 ? Math.max(...form.levels.map((l) => l.value)) + 1 : 0
    setForm((f) => ({
      ...f,
      levels: [...f.levels, { value: nextVal, label: '', color: '#9CA3AF' }],
    }))
  }

  const updateLevel = (idx: number, patch: Partial<RankLevel>) => {
    setForm((f) => {
      const levels = f.levels.map((l, i) => {
        if (i !== idx) return l
        const next = { ...l, ...patch } as RankLevel
        // An `undefined` in the patch CLEARS the field — turning a split belt
        // solid, or removing an emoji. Spreading it in leaves the key present
        // with an undefined value, which Firestore refuses outright when the
        // levels array is written back.
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete (next as unknown as Record<string, unknown>)[k]
        }
        return next
      })
      return { ...f, levels }
    })
  }

  const removeLevel = (idx: number) => {
    setForm((f) => ({ ...f, levels: f.levels.filter((_, i) => i !== idx) }))
  }

  // Removing a level is destructive to CONTACTS, not just to this form: every
  // `Contact.ranks[systemId]` sitting on that value is orphaned and thereafter
  // renders as the nearest level below it (see `primaryRank` in @linyup/shared). So ask — but
  // only where somebody can actually be holding it.
  const requestRemoveLevel = (idx: number) => {
    const value = form.levels[idx]?.value
    const wasSaved = isEdit && initial?.levels.some((l) => l.value === value)
    // A level added in this dialog has never been written, so no contact can
    // hold it. Confirming that would be pure noise plus a wasted round trip.
    if (value === undefined || !wasSaved) {
      removeLevel(idx)
      return
    }
    setPendingRemove(idx)
    levelHolders.start(holderTeamIds, form.id, [value])
  }

  const closeRemoveConfirm = () => {
    setPendingRemove(null)
    levelHolders.reset()
  }

  const applyPreset = (preset: (typeof RANK_PRESETS)[number]) => {
    setForm((f) => ({
      ...f,
      name: f.name || preset.name,
      id: f.id || (!idTouched ? generateId(preset.name) : f.id),
      levels: preset.levels.map((l) => ({ ...l })),
    }))
    setPresetOpen(false)
  }

  const canSave =
    form.name.trim().length > 0 &&
    form.id.length > 0 &&
    SLUG_REGEX_RANK.test(form.id) &&
    !idError &&
    form.levels.length > 0 &&
    form.levels.every((l) => l.label.trim().length > 0)

  return (
    <>
      <Dialog open={open && !presetOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? t('editRankingSystem') : t('addRankingSystem')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4 py-1">
            {/* Preset picker button */}
            {!isEdit && (
              <button
                type="button"
                onClick={() => setPresetOpen(true)}
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-dashed text-sm text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
              >
                <Star className="h-3.5 w-3.5" />
                {t('rankingPresetsTitle')}
              </button>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('rankingSystemName')}</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('rankingSystemNamePlaceholder')}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('rankingSystemId')}</Label>
                <Input
                  value={form.id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="bjj-belts"
                  disabled={isEdit}
                  className="font-mono text-sm"
                />
                {idError && <p className="text-xs text-destructive">{idError}</p>}
                {!idError && (
                  <p className="text-xs text-muted-foreground">{t('rankingSystemIdHelp')}</p>
                )}
              </div>
            </div>

            {/* Levels */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('rankingSystemLevels', { count: form.levels.length })}</Label>
                <button
                  type="button"
                  onClick={addLevel}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  {t('addLevel')}
                </button>
              </div>
              {form.levels.length === 0 && (
                <p className="text-xs text-muted-foreground py-2 text-center">
                  {t('rankingNoSystems')}
                </p>
              )}
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {form.levels.map((level, idx) => (
                  <RankLevelFields
                    key={idx}
                    level={level}
                    index={idx}
                    storagePath={storagePath}
                    canRemove
                    onChange={(field, value) => updateLevel(idx, { [field]: value } as Partial<RankLevel>)}
                    onRemove={() => requestRemoveLevel(idx)}
                  />
                ))}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canSave}
              onClick={() => {
                onSave(form)
                onOpenChange(false)
              }}
            >
              {t('save')}
            </Button>
          </DialogFooter>

          {/* Rendered inside the popup so base-ui treats it as a nested
              dialog rather than a second competing top layer. */}
          <AlertDialog
            open={pendingRemove !== null}
            onOpenChange={(v) => {
              if (!v) closeRemoveConfirm()
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('removeRankLevelTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {levelHolders.count === undefined
                    ? t('rankHoldersChecking')
                    : levelHolders.count === null
                      ? t('rankHoldersUnknown')
                      : levelHolders.count === 0
                        ? t('rankHoldersNoneLevel')
                        : `${t('rankHoldersLevelCount', { count: levelHolders.count })} ${t('rankHoldersLevelWarning')}`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    if (pendingRemove !== null) removeLevel(pendingRemove)
                    closeRemoveConfirm()
                  }}
                >
                  {t('removeRankLevelConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>

      {/* Preset picker */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('rankingPresetsTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            {RANK_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => applyPreset(preset)}
                className="w-full flex items-start gap-3 p-3 rounded-lg border text-left hover:bg-muted transition-colors"
              >
                <div className="flex gap-0.5 shrink-0 mt-0.5">
                  {preset.levels.slice(0, 5).map((l, i) => (
                    <RankBadge key={i} level={l} size="sm" />
                  ))}
                  {preset.levels.length > 5 && (
                    <span className="text-xs text-muted-foreground ml-0.5">
                      +{preset.levels.length - 5}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{preset.name}</p>
                  <p className="text-xs text-muted-foreground">{preset.levels.length} levels</p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RankingTab({
  teamId,
  team,
  canEdit,
}: {
  teamId: string
  team: Team
  canEdit: boolean
}) {
  const t = useTranslations('TeamSettings')
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RankSystemFormState | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const systemHolders = useRankHolderCount()

  const {
    rankingSystems: effectiveSystems,
    managedByOrg,
    orgId,
    loading: rankLoading,
  } = useRankingSystems()
  const systems: RankingSystem[] = managedByOrg ? effectiveSystems : (team.ranking_systems ?? [])

  const saveToFirestore = async (next: RankingSystem[]) => {
    if (!canEdit) return
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { ranking_systems: next })
      qc.invalidateQueries({ queryKey: ['team', teamId] })
    } catch {
      toast.error(t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async (form: RankSystemFormState) => {
    const system: RankingSystem = {
      id: form.id,
      name: form.name,
      levels: form.levels,
      is_primary: form.is_primary,
    }
    const next = editing
      ? systems.map((s) => (s.id === editing.id ? system : s))
      : [...systems, system]
    await saveToFirestore(next)
    setEditing(null)
  }

  const handleSetPrimary = async (id: string) => {
    const next = systems.map((s) => ({ ...s, is_primary: s.id === id }))
    await saveToFirestore(next)
  }

  const handleClearPrimary = async () => {
    const next = systems.map((s) => ({ ...s, is_primary: false }))
    await saveToFirestore(next)
  }

  const handleDelete = async (id: string) => {
    const next = systems.filter((s) => s.id !== id)
    await saveToFirestore(next)
    closeDelete()
  }

  const openDelete = (s: RankingSystem) => {
    setDeleting(s.id)
    // Counted per level and summed. Firestore cannot ask "does this field
    // exist", so a contact orphaned at a value this system no longer carries
    // falls outside the count — which is why the copy says "holding one of its
    // levels" rather than "in this system".
    systemHolders.start(
      [teamId],
      s.id,
      s.levels.map((l) => l.value),
    )
  }
  const closeDelete = () => {
    setDeleting(null)
    systemHolders.reset()
  }

  const openAdd = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (s: RankingSystem) => {
    setEditing({
      id: s.id,
      name: s.name,
      levels: s.levels.map((l) => ({ ...l })),
      is_primary: s.is_primary ?? false,
    })
    setDialogOpen(true)
  }

  // Two independent reasons this list is read-only: the organization owns the
  // systems, or the member is not the studio owner (the systems live on the team
  // doc, which firestore.rules keeps owner-only). Each says so in its own words.
  const canManage = !managedByOrg && canEdit

  return (
    <div className="space-y-4">
      {managedByOrg && orgId && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-muted/50 border text-sm">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <span className="text-muted-foreground">
            {t('rankingManagedByOrg')}{' '}
            {/* The editor is its own page. This used to point at
                `/org/{orgId}/settings`, which has no ranking UI at all, so the
                one link out of a read-only tab led nowhere useful. */}
            <Link href={`/org/${orgId}/ranking` as Route} className="text-primary hover:underline">
              {t('rankingManagedByOrgLink')}
            </Link>
          </span>
        </div>
      )}
      {!managedByOrg && !canEdit && <OwnerOnlyNote />}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('rankingSystems')}</p>
        {canManage && (
          <Button size="sm" onClick={openAdd} disabled={saving || rankLoading}>
            <Plus className="h-4 w-4 mr-1.5" />
            {t('addRankingSystem')}
          </Button>
        )}
      </div>

      {rankLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 rounded-lg border bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : systems.length === 0 ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {t('rankingNoSystems')}
        </div>
      ) : (
        <div className="space-y-2">
          {systems.map((s) => (
            <div key={s.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{s.name}</p>
                    {s.is_primary && (
                      <Badge variant="default" className="text-xs">
                        {t('rankingSystemPrimary')}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground font-mono">{s.id}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('rankingSystemLevels', { count: s.levels.length })}
                  </p>
                </div>
                {canManage &&
                  (s.is_primary ? (
                    <button
                      onClick={handleClearPrimary}
                      disabled={saving}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted disabled:opacity-50"
                    >
                      {t('primaryModeAuto')}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSetPrimary(s.id)}
                      disabled={saving}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted disabled:opacity-50"
                    >
                      {t('rankingSystemSetPrimary')}
                    </button>
                  ))}
                {canManage && (
                  <button
                    onClick={() => openEdit(s)}
                    className="p-1.5 rounded hover:bg-muted transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
                {canManage && (
                  <button
                    onClick={() => openDelete(s)}
                    className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Level strip, sorted by VALUE — the scale's own order. Array
                  order made this disagree with the other surfaces whenever the
                  two differed. */}
              <div className="flex gap-1 flex-wrap">
                {[...s.levels].sort((a, b) => a.value - b.value).map((l) => (
                  <div key={l.value} className="flex items-center gap-1">
                    <RankBadge level={l} size="sm" />
                    <span className="text-xs text-muted-foreground">{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!systems.some((s) => s.is_primary) && systems.length > 1 && (
            <p className="text-xs text-muted-foreground px-1">{t('primaryModeAuto')}</p>
          )}
        </div>
      )}

      <RankSystemDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v)
          if (!v) setEditing(null)
        }}
        initial={editing}
        existingIds={systems.filter((s) => !editing || s.id !== editing.id).map((s) => s.id)}
        onSave={handleSave}
        storagePath={`teams/${teamId}/ranking`}
        holderTeamIds={[teamId]}
      />

      <Dialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) closeDelete()
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteRankingSystem')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            {t('deleteRankingSystemConfirm', {
              name: systems.find((s) => s.id === deleting)?.name ?? '',
            })}
          </p>
          <p className="text-sm text-muted-foreground py-1">
            {systemHolders.count === undefined
              ? t('rankHoldersChecking')
              : systemHolders.count === null
                ? t('rankHoldersUnknown')
                : systemHolders.count === 0
                  ? t('rankHoldersNoneSystem')
                  : `${t('rankHoldersSystemCount', { count: systemHolders.count })} ${t('rankHoldersSystemWarning')}`}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={closeDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => deleting && handleDelete(deleting)}
            >
              {t('deleteRankingSystem')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── payments tab ─────────────────────────────────────────────────────────────

function PaymentsTab({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const t = useTranslations('TeamSettings')
  const qc = useQueryClient()
  const { user, team } = useAuth()
  const {
    data: integrations = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useGatewayIntegrations(teamId, canEdit)
  const { data: subscriptionTypes = [] } = useSubscriptionTypes(teamId)
  const { data: gatewayCurrency } = useGatewayCurrency(teamId)

  // WHAT THE ENDPOINT ACTUALLY SENT (docs/open-defects.md → "A BYO studio can
  // double-count its own recurring revenue"). The guidance below the signing
  // secret is the primary defence; this is the second half — when a studio
  // subscribed to both Stripe event families anyway, the rail can SEE it in the
  // rows it wrote, and the owner is the only person who can go and fix it.
  //
  // Read only when there IS a Stripe integration to accuse, and only for
  // somebody who can act on it (a manager cannot even see this list).
  const hasStripeGateway = integrations.some((i) => i.config.type === 'stripe')
  const { data: doubleRecording } = useByoStripeDoubleRecording(teamId, canEdit && hasStripeGateway)

  const [showDialog, setShowDialog] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<GatewayFormData>({
    resolver: zodResolver(gatewaySchema),
    defaultValues: { gatewayType: 'stripe', identifier: '', currency: 'CHF' },
  })

  const selectedType = watch('gatewayType') as PaymentGatewayType

  function openAdd() {
    reset({ gatewayType: 'stripe', identifier: '', currency: 'CHF' })
    setEditingId(null)
    setShowDialog(true)
  }

  function openEdit(item: TeamIntegration) {
    const cfg = item.config
    reset({
      gatewayType: cfg.type,
      identifier: cfg.type === 'stripe' ? cfg.publishable_key : cfg.instance_name,
      currency: cfg.currency,
      // Both Stripe (BYO) and Payrexx now carry a webhook signing secret + default.
      webhookSigningSecret: cfg.webhook_signing_secret ?? '',
      defaultSubscriptionTypeId: cfg.default_subscription_type_id ?? '',
    })
    setEditingId(item.id)
    setShowDialog(true)
  }

  async function onSubmit(values: GatewayFormData) {
    if (!canEdit) return
    setSaving(true)
    try {
      const config =
        values.gatewayType === 'stripe'
          ? {
              type: 'stripe' as const,
              publishable_key: values.identifier,
              currency: values.currency,
              ...(values.webhookSigningSecret?.trim()
                ? { webhook_signing_secret: values.webhookSigningSecret.trim() }
                : {}),
              ...(values.defaultSubscriptionTypeId?.trim()
                ? { default_subscription_type_id: values.defaultSubscriptionTypeId.trim() }
                : {}),
            }
          : {
              type: 'payrexx' as const,
              instance_name: values.identifier,
              currency: values.currency,
              ...(values.webhookSigningSecret?.trim()
                ? { webhook_signing_secret: values.webhookSigningSecret.trim() }
                : {}),
              ...(values.defaultSubscriptionTypeId?.trim()
                ? { default_subscription_type_id: values.defaultSubscriptionTypeId.trim() }
                : {}),
            }

      if (editingId) {
        await updateDoc(doc(db, TEAMS_COLLECTION, teamId, 'integrations', editingId), {
          config,
          updated_at: serverTimestamp(),
        })
      } else {
        await addDoc(collection(db, TEAMS_COLLECTION, teamId, 'integrations'), {
          teamId,
          type: 'payment_gateway',
          enabled: true,
          config,
          created: serverTimestamp(),
          createdBy: user?.uid ?? '',
        })
      }
      await qc.invalidateQueries({ queryKey: ['gateway-integrations', teamId] })
      setShowDialog(false)
    } catch {
      toast.error(t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleEnabled(item: TeamIntegration) {
    if (!canEdit) return
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId, 'integrations', item.id), {
        enabled: !item.enabled,
        updated_at: serverTimestamp(),
      })
      await qc.invalidateQueries({ queryKey: ['gateway-integrations', teamId] })
    } catch {
      toast.error(t('saveError'))
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !canEdit) return
    try {
      await deleteDoc(doc(db, TEAMS_COLLECTION, teamId, 'integrations', deleteTarget))
      await qc.invalidateQueries({ queryKey: ['gateway-integrations', teamId] })
    } catch {
      toast.error(t('saveError'))
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading)
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 rounded" />
      </div>
    )

  return (
    <div className="space-y-6">
      {/* ── TWO THINGS CALLED STRIPE, AND ONLY ONE OF THEM TAKES MONEY ───────
          This tab shows the Stripe Connect rail (members are charged inside
          Linyup, money lands in the studio's own Stripe account) directly above
          a BYO integration whose entire job is to RECORD payments the studio
          collected somewhere else — and whose provider dropdown also says
          "Stripe", defaults to it, and used to badge itself "Enabled" (UX-17).

          The distinction is now structural, not just worded: everything that
          takes money is above the record-only heading, everything that merely
          writes down money already taken is below it. Keep it that way — a card
          moved across that line silently reverses what its heading claims. */}
      {/* Accept payments with Linyup (Stripe Connect) — own card; renders only when enabled. */}
      <ConnectPaymentsCard teamId={teamId} />

      {/* The currency the rail above charges in — money-side, so it stays above
          the record-only heading. */}
      <BillingCurrencyCard
        teamId={teamId}
        current={team?.default_currency}
        gatewayCurrency={gatewayCurrency}
        canEdit={canEdit}
      />

      <div className="space-y-4 pt-2">
        {/* The heading alone. The paragraph that used to sit here restated
            what both blocks below already say in their own words — and said it
            first, so a reader met the caveat before the thing it was about. */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold">{t('paymentsRecordOnlyTitle')}</p>
        </div>

      {/* ── TWO CARDS, CHEAPEST FIRST ─────────────────────────────────────────
          Manual on top and the external provider below it: taking cash is what
          most studios here actually do, needs no setup, and is the thing a
          reader is most likely to be looking for. They are SEPARATE cards, not
          one stacked card divided by a rule — they share only the heading above
          them, and a studio setting up cash has no business scrolling past a
          beta integration's caveats to find the input.

          The provider card keeps the default surface rather than a tinted one:
          a tint reads as a warning, and the caveats it carries are stated in
          words already. */}
      <Card>
        <CardContent className="pt-6">
          <PaymentModesCard teamId={teamId} current={team?.payment_modes} canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-3">
      <div>
        {/* Superseded keys `paymentsGateway` / `paymentsGatewayDescription`
            still exist in the locale files; they said "Payment gateway" and
            "…to collect member payments", which is the claim this rail cannot
            honour — it holds no credentials and makes no API call. */}
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{t('paymentsExternalTitle')}</p>
          {/* BETA, said out loud. This rail has never been exercised end to end
              on production (Franco, 2026-08-24), and a studio deciding where to
              take money is entitled to know that before it does. */}
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
            {t('paymentsExternalBeta')}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{t('paymentsExternalDescription')}</p>
        {/* WHAT IT DOES NOT DO, before the setup button rather than after it.
            Each line is a real limit of the rail, not a hedge: it receives a
            notification and files it, so it knows roughly who paid and nothing
            else. Order is what it CAN do, then the two things it cannot —
            leading with a limitation reads as a warning about the whole idea.
            Refunds share a line with pause and cancellation because they are
            one habit, not three: whatever you do in the provider, do here. */}
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {(['paymentsExternalLimitMatch', 'paymentsExternalLimitLink', 'paymentsExternalLimitRefund'] as const).map(
            (key) => (
              <li key={key} className="flex gap-2">
                <span aria-hidden className="select-none">•</span>
                <span>{t(key)}</span>
              </li>
            )
          )}
        </ul>
        {/* No owner-only note here: the body below says the stronger thing —
            a non-owner cannot even SEE this list — and saying both would be
            two lines of the same sentence. */}
      </div>

      {/* ABSENT-BECAUSE-FORBIDDEN is not absent-because-none. A manager cannot
          read teams/{id}/integrations at all, so she used to be told "No payment
          gateway configured" about a studio that may well have one — a false
          statement, and one that invites her to go and configure a second
          (UX-6). She is told what is actually true instead: the list is the
          owner's to see. An owner whose read genuinely FAILS gets the error
          block with a retry, for the same reason. */}
      {!canEdit ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {t('paymentsExternalHiddenOwnerOnly')}
        </p>
      ) : isError ? (
        <QueryErrorState
          onRetry={() => void refetch()}
          detail={error instanceof Error ? error.message : null}
        />
      ) : integrations.length === 0 ? (
        // Left, small, no vertical padding: with the action moved to the bottom
        // of the block, a centred line floated between the limits above it and
        // the button below and belonged to neither.
        <p className="text-xs text-muted-foreground">{t('paymentsNoExternal')}</p>
      ) : (
        <div className="divide-y border rounded-lg">
          {integrations.map((item) => {
            const cfg = item.config
            const label = cfg.type === 'stripe' ? 'Stripe' : 'Payrexx'
            const identifier = cfg.type === 'stripe' ? cfg.publishable_key : cfg.instance_name
            // A BYO Stripe row with no signing secret records NOTHING:
            // handleTeamStripeWebhook answers `no_signing_secret` and returns 400
            // before it looks at the body. Payrexx is not the same case — a blank
            // secret there skips signature verification but still records — so the
            // stalled state is deliberately Stripe-only rather than symmetrical.
            const stalled = item.enabled && cfg.type === 'stripe' && !cfg.webhook_signing_secret
            return (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {identifier} · {cfg.currency}
                  </p>
                </div>
                {stalled ? (
                  <Badge
                    variant="secondary"
                    className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                  >
                    {t('paymentsRecordingStalled')}
                  </Badge>
                ) : (
                  <Badge variant={item.enabled ? 'default' : 'outline'} className="text-xs">
                    {item.enabled ? t('paymentsRecordingOn') : t('paymentsRecordingOff')}
                  </Badge>
                )}
                <Switch checked={item.enabled} onCheckedChange={() => handleToggleEnabled(item)} />
                <button
                  onClick={() => openEdit(item)}
                  className="text-muted-foreground hover:text-foreground p-1"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setDeleteTarget(item.id)}
                  className="text-muted-foreground hover:text-destructive p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* THIS ENDPOINT IS RECORDING EVERY RECURRING PAYMENT TWICE.
          Stated, never repaired. The two rows cannot be merged from here (an
          `invoice.*` payload can no longer name its PaymentIntent, and BYO holds
          no credentials to bridge them), and matching them by amount and time
          would be a guess that deletes real money when it is wrong — so this
          surface tells the one person who can change the endpoint, and touches
          nothing. `bothFamilies` is a reading of `raw_status`, i.e. of what the
          endpoint literally delivered, not an inference from the totals. */}
      {doubleRecording?.bothFamilies && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t('paymentsDoubleRecordingTitle')}
              </p>
              <p className="text-xs text-amber-900/90 dark:text-amber-200/90">
                {t('paymentsDoubleRecordingBody', {
                  days: doubleRecording.windowDays,
                  invoiceCount: doubleRecording.invoiceRows,
                  paymentCount: doubleRecording.paymentRows,
                })}
              </p>
              <p className="text-xs text-amber-900/90 dark:text-amber-200/90">
                {t.rich('paymentsDoubleRecordingFix', {
                  code: (chunks) => (
                    <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">{chunks}</code>
                  ),
                })}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* The action AFTER what it commits you to, and left-aligned under it —
          a top-right button asked for a decision above the three lines that
          inform it. */}
      {canEdit && (
        <div>
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="h-4 w-4 mr-1" />
            {t('paymentsAddExternal')}
          </Button>
        </div>
      )}
        </CardContent>
      </Card>
      </div>

      {/* Add/edit dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('paymentsEditExternal') : t('paymentsAddExternal')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>{t('paymentsGatewayType')}</Label>
              <Controller
                name="gatewayType"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <span className="flex flex-1 text-left text-sm truncate">
                        {field.value === 'stripe' ? (
                          'Stripe'
                        ) : field.value === 'payrexx' ? (
                          'Payrexx'
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stripe">Stripe</SelectItem>
                      <SelectItem value="payrexx">Payrexx</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                {selectedType === 'stripe' ? t('paymentsPublishableKey') : t('paymentsInstanceName')}
              </Label>
              <Input
                {...register('identifier')}
                placeholder={selectedType === 'stripe' ? 'pk_live_…' : 'my-instance'}
              />
              {errors.identifier && (
                <p className="text-xs text-destructive">{errors.identifier.message}</p>
              )}
              {/* The publishable key is a NAMEPLATE here — it is written to the
                  integration doc and rendered back in the row above, and nothing
                  in functions/ ever reads it (BYO holds no credentials and makes
                  no Stripe API call). Saying so beats leaving an owner to infer
                  that pasting it turns card payments on. */}
              {selectedType === 'stripe' && (
                <p className="text-[11px] text-muted-foreground">
                  {t('paymentsPublishableKeyHelp')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('paymentsCurrency')}</Label>
              <Input
                {...register('currency')}
                placeholder="CHF"
                maxLength={3}
                className="uppercase w-24"
              />
            </div>

            {/* BYO record-only wiring (Stripe + Payrexx): verify the webhook
                signature + a default subscription type for unlabelled payments. */}
            <div className="space-y-1.5">
              <Label>{t('paymentsWebhookSecretLabel')}</Label>
              <Input
                {...register('webhookSigningSecret')}
                type="password"
                placeholder={
                  selectedType === 'stripe' ? 'whsec_…' : t('paymentsWebhookSecretPlaceholderPayrexx')
                }
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">
                {selectedType === 'stripe' ? (
                  t.rich('paymentsWebhookSecretHelpStripe', {
                    teamId,
                    code: (chunks) => <code className="bg-muted px-1 rounded">{chunks}</code>,
                  })
                ) : (
                  t.rich('paymentsWebhookSecretHelpPayrexx', {
                    code: (chunks) => <code className="bg-muted px-1 rounded">{chunks}</code>,
                  })
                )}
              </p>
              {/* WHICH EVENTS — the half of the wiring that decides whether the
                  studio's revenue is counted once or twice, and until now it was
                  written down only in the header of handleTeamStripeWebhook,
                  where a studio will never see it.

                  It is a real constraint, not a preference: an `invoice.*`
                  payload can no longer name its PaymentIntent and a
                  `payment_intent.*` payload can no longer name its invoice, and
                  this rail holds no Stripe credentials with which to bridge
                  them. So a subscription to BOTH records every recurring payment
                  twice, and nothing on our side can merge the two rows. The rows
                  it does produce are flagged in the payments table
                  ("may be a duplicate"), and an endpoint caught sending both
                  families is called out on the card behind this dialog — but
                  both of those are after the fact. This is the PRIMARY defence
                  (Franco, 2026-08-18: guidance + detection is the close for that
                  defect; dedupe-by-heuristic was rejected), which is why it is a
                  callout and not a footnote. */}
              {selectedType === 'stripe' && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/40">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                        {t('paymentsWebhookEventsTitle')}
                      </p>
                      <p className="text-[11px] text-amber-900/90 dark:text-amber-200/90">
                        {t.rich('paymentsWebhookEventsHelp', {
                          code: (chunks) => (
                            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">
                              {chunks}
                            </code>
                          ),
                        })}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('paymentsDefaultSubscriptionType')}</Label>
              <Controller
                name="defaultSubscriptionTypeId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value ?? ''} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <span className="flex flex-1 text-left text-sm truncate">
                        {subscriptionTypes.find((s) => s.id === field.value)?.name ?? (
                          <span className="text-muted-foreground">{t('paymentsNoneOption')}</span>
                        )}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{t('paymentsNoneOption')}</SelectItem>
                      {subscriptionTypes.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-[11px] text-muted-foreground">
                {selectedType === 'stripe' ? (
                  t.rich('paymentsDefaultSubscriptionTypeHelpStripe', {
                    code: (chunks) => <code className="bg-muted px-1 rounded">{chunks}</code>,
                  })
                ) : (
                  t.rich('paymentsDefaultSubscriptionTypeHelpPayrexx', {
                    code: (chunks) => <code className="bg-muted px-1 rounded">{chunks}</code>,
                  })
                )}
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('paymentsDeleteGateway')}</AlertDialogTitle>
            <AlertDialogDescription>{t('paymentsDeleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t('paymentsDeleteGateway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Which terms this studio agreed to, and when.
 *
 * `provisionTeam` has recorded this since 2026-08-25 and NOTHING showed it —
 * evidence nobody can see is worth less than it cost to collect, and the studio
 * has at least as much right to it as we do.
 *
 * ABSENT MEANS NEVER ASKED, not refused: every studio created before that date
 * carries no value at all, so the block renders nothing rather than implying
 * the studio declined something. The links stay reachable from the account menu
 * either way.
 */
function TermsAcceptedNote({ team }: { team: Team }) {
  const t = useTranslations('TeamSettings')
  const fmt = useTeamFormat()
  const accepted = team.terms_accepted
  if (!accepted) return null

  const atMs =
    (accepted.accepted_at as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null

  return (
    <div className="space-y-1 pt-4 border-t">
      <p className="text-sm font-medium">{t('termsAcceptedTitle')}</p>
      <p className="text-xs text-muted-foreground">
        {t('termsAcceptedBody', {
          version: accepted.version,
          date: atMs ? fmt.date(new Date(atMs)) : '—',
          email: accepted.accepted_by_email || '—',
        })}
      </p>
      <p className="flex flex-wrap gap-x-3 text-xs">
        <a
          href="https://linyup.com/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {t('termsLink')}
        </a>
        <a
          href="https://linyup.com/dpa"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {t('dpaLink')}
        </a>
      </p>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

type SettingsTab = 'general' | 'alerts' | 'ranking' | 'payments' | 'custom-fields'

export default function TeamSettingsPage() {
  const { currentTeamId } = useAuth()
  const { data: team, isLoading } = useTeam(currentTeamId)
  const { isInstalled } = useInstalledPlugins()
  // ONE derivation for the whole page — every section below writes the team doc
  // or an owner-only subcollection of it, and `team.settings` is the capability
  // that is owner-only by construction (OWNER_ONLY in shared/types/capabilities).
  const { can } = useCapabilities()
  const canEdit = can('team.settings')
  const t = useTranslations('TeamSettings')
  // The active section is driven entirely by ?tab= — the settings rail is the tab
  // bar now (each team sub-section is its own rail item). Deep-links like the contact
  // card's "set up custom fields" (?tab=custom-fields) still land on the right one.
  const searchParams = useSearchParams()
  const router = useRouter()
  const rawTab = searchParams.get('tab')

  // Outreach moved to /settings/emails (2026-08-25). Redirect rather than fall
  // through to 'general': a pinned or bookmarked ?tab=outreach would otherwise
  // land on the wrong section and read as "the settings I had are gone".
  //
  // Declared HERE, above the loading and no-team early returns, because both of
  // those return before the tab is resolved — a hook below them runs in a
  // different order on the first render than on the second.
  useEffect(() => {
    if (rawTab === 'outreach') router.replace('/settings/emails')
  }, [rawTab, router])

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    )
  }

  if (!team || !currentTeamId) {
    return <p className="text-muted-foreground">{t('noTeam')}</p>
  }

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: t('tabGeneral') },
    { id: 'alerts', label: t('tabAlerts') },
    { id: 'ranking', label: t('tabRanking') },
    { id: 'payments', label: t('tabPayments') },
    // Affiliations moved out of Settings into the main nav's "Offer" section
    // (/offer/affiliations).
    // Custom Fields plugin — tab appears only when the plugin is installed
    ...(isInstalled('custom-fields')
      ? [{ id: 'custom-fields' as SettingsTab, label: t('tabCustomFields') }]
      : []),
  ]

  // ?tab= selects the section; fall back to General when absent or gated away.
  const requestedTab = (rawTab as SettingsTab) || 'general'
  const tab: SettingsTab = TABS.some((tb) => tb.id === requestedTab) ? requestedTab : 'general'
  const activeLabel = TABS.find((tb) => tb.id === tab)?.label ?? t('title')

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{activeLabel}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('title')} · {team.name}
        </p>
      </div>

      {/* Payments + Outreach manage their own stacked cards; General is now its
          own 3-card split (see below); the remaining tabs share one wrapper. */}
      {tab === 'payments' ? (
        <PaymentsTab teamId={currentTeamId} canEdit={canEdit} />
      ) : tab === 'general' ? (
        // THREE CARDS, ONE PER TOPIC — this used to be one long Card holding
        // four stacked sub-forms with hairline dividers between them (UI polish,
        // 2026-08). Every field, its validation and its own save action are
        // UNCHANGED; only the wrapper each section sits in moved.
        //   Team            -> identity: name, description, sport, slug
        //   Region & format -> RegionalForm: timezone, week start, date/time format
        //   Other           -> engagement bands + the per-device tab-bar toggle
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('sectionTeam')}</CardTitle>
            </CardHeader>
            <CardContent>
              <GeneralForm team={team} teamId={currentTeamId} canEdit={canEdit} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('sectionRegionFormat')}</CardTitle>
              <CardDescription>{t('regionHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Keyed on the team: the draft below is seeded from
                  `team.regional` at mount only, and the TeamSwitcher can change
                  `currentTeamId` under a mounted settings page. Without the
                  remount the form would keep team A's zone and formats and save
                  them onto team B's document. */}
              <RegionalForm
                key={currentTeamId}
                team={team}
                teamId={currentTeamId}
                canEdit={canEdit}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('sectionOther')}</CardTitle>
            </CardHeader>
            <CardContent>
              <EngagementThresholdsForm team={team} teamId={currentTeamId} canEdit={canEdit} />
              <TabBarPreference />
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="pt-6">
            {tab === 'alerts' && <AlertPresetsTab teamId={currentTeamId} canEdit={canEdit} />}
            {tab === 'ranking' && (
              <RankingTab teamId={currentTeamId} team={team} canEdit={canEdit} />
            )}
            {tab === 'custom-fields' && isInstalled('custom-fields') && (
              <CustomFieldsTab teamId={currentTeamId} team={team} />
            )}
          </CardContent>
        </Card>
      )}

      {/* THE DANGER ZONE, OUTSIDE the settings card and last on the tab. Its own
          card, with its own border, because everything above it is reversible
          and this is not. Owner-only — it renders nothing for anybody else
          rather than rendering disabled, which would only raise the question of
          who can. */}
      {tab === 'general' && <TermsAcceptedNote team={team} />}
      {tab === 'general' && (
        <DeleteAccountCard teamId={currentTeamId} team={team} canEdit={canEdit} />
      )}
    </div>
  )
}
