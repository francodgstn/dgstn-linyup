'use client'

// THE "RECEIPTS" SEGMENT — a contact's Tarif 595 corner. Insurer data lives
// here (manager-only, never on the Contact doc — see tarif595.ts's module
// header), a receipt is always ISSUED from here (never from the plugin's own
// page, which only lists and manages what already exists), and this contact's
// own receipt history closes the loop.
//
// PREVIEW BEFORE ISSUE, ALWAYS: `previewTarif595Receipt` renders the exact
// lines `issueTarif595Receipt` would freeze, so nothing here computes a line
// itself — a blank line list would be a second, divergent implementation of
// the server's own math. The Issue button stays disabled until the preview
// says `ok`.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { collectionGroup, getDocs, limit, query, where } from 'firebase/firestore'
import { toast } from 'sonner'
import type { Route } from 'next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Contact } from '@linyup/shared'
import {
  COURSE_PURCHASES_SUBCOLLECTION,
  formatAhv,
  isValidAhv,
  type Tarif595BlockingCode,
  type Tarif595PreviewResult,
  type Tarif595Source,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useActivities } from '@/hooks/useActivities'
import { useSubscriptionHistory } from '@/hooks/useSubscriptionHistory'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useCourses } from '@/plugins/online-courses/hooks'
import {
  callIssueTarif595Receipt,
  callPreviewTarif595Receipt,
  downloadTarif595Receipt,
  saveTarif595ContactData,
  useContactTarif595Receipts,
  useInvalidateTarif595,
  useTarif595ContactData,
  type Tarif595ReceiptRow,
} from '@/plugins/tarif-595/hooks'
import { ReceiptActions, ReceiptStatusBadge } from '@/plugins/tarif-595/ReceiptActions'
import { formatMoneyMinor } from '@/lib/payments'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// ─── date helpers ───────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function tsToIsoDate(ts: unknown): string | null {
  const v = ts as { toDate?: () => Date } | null
  if (v?.toDate) return isoDate(v.toDate())
  return null
}

function currentYearRange(): { from: string; to: string } {
  const y = new Date().getFullYear()
  return { from: `${y}-01-01`, to: `${y}-12-31` }
}

// ─── this contact's course purchases (lifetime entitlements) ────────────────
// No shared hook lists a CONTACT's purchases from the (auth) side — only the
// public Space/Shop do, scoped to the signed-in visitor. Same collection-group
// shape (`contactId` + `teamId`), read here for the studio's own contact page.

// A person buys a handful of courses in a lifetime; the bound is a tripwire, not a page.
const COURSE_PURCHASES_SCAN = 100

function useContactCoursePurchases(teamId: string | null, contactId: string) {
  return useQuery<string[]>({
    queryKey: ['tarif595-course-purchases', teamId, contactId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, COURSE_PURCHASES_SUBCOLLECTION),
          where('contactId', '==', contactId),
          where('teamId', '==', teamId),
          limit(COURSE_PURCHASES_SCAN)
        )
      )
      return snap.docs.map((d) => (d.data().courseId as string | undefined) ?? d.id)
    },
  })
}

// ─── source picker ────────────────────────────────────────────────────────

interface SourceOption {
  key: string
  label: string
  source: Tarif595Source
  defaultFrom: string | null
  defaultTo: string | null
}

// ─── blocking-code → "go fix it" link ────────────────────────────────────
// contact_* codes are asked for right here (AHV, sex) or on the Profile tab
// (birthdate, address) — the profile is the one link that covers both.
// Everything else that can block a preview is plugin/legal-profile SETUP,
// answered on the plugin's own settings page or the shared legal profile.

function blockingLink(
  code: Tarif595BlockingCode,
  contactId: string
): { href: Route; labelKey: 'completeProfile' | 'openSettings' } | null {
  if (code.startsWith('contact_')) {
    return { href: `/contacts/${contactId}?tab=profile` as Route, labelKey: 'completeProfile' }
  }
  if (code === 'legal_profile_incomplete') {
    return { href: '/settings/team?tab=payments' as Route, labelKey: 'openSettings' }
  }
  if (code === 'plugin_config_incomplete' || code === 'offering_unmapped' || code === 'position_invalid_on_date') {
    return { href: '/plugins/tarif-595/settings' as Route, labelKey: 'openSettings' }
  }
  return null
}

function PreviewResultView({
  preview,
  teamId,
  contactId,
}: {
  preview: Tarif595PreviewResult
  teamId: string
  contactId: string
}) {
  const t = useTranslations('Tarif595')
  const [downloading, setDownloading] = useState(false)

  async function handleDownloadExisting() {
    if (!preview.existing) return
    setDownloading(true)
    try {
      await downloadTarif595Receipt(teamId, preview.existing.receiptId, 'pdf')
    } catch (err) {
      console.error('[tarif-595] existing download failed:', err)
      toast.error(t('actions.downloadError'))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {preview.existing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span>
            {t('issue.existingNote', {
              number: preview.existing.number,
              status: t(`status.${preview.existing.status}`),
            })}
          </span>
          <Button size="sm" variant="outline" onClick={() => void handleDownloadExisting()} disabled={downloading}>
            {downloading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t('actions.downloadPdf')}
          </Button>
        </div>
      )}

      {preview.blocking.length > 0 && (
        <ul className="space-y-1">
          {preview.blocking.map((issue, i) => {
            const link = blockingLink(issue.code, contactId)
            return (
              <li key={`${issue.code}:${i}`} className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t(`blocking.${issue.code}`)}
                  {link && (
                    <>
                      {' — '}
                      <Link href={link.href} className="underline underline-offset-2">
                        {t(`issue.${link.labelKey}`)}
                      </Link>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {preview.warnings.length > 0 && (
        <ul className="space-y-1">
          {preview.warnings.map((w, i) => (
            <li
              key={`${w.code}:${i}`}
              className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t(`warning.${w.code}`)}</span>
            </li>
          ))}
        </ul>
      )}

      {preview.draft && (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('issue.colDate')}</TableHead>
                  <TableHead>{t('issue.colCode')}</TableHead>
                  <TableHead>{t('issue.colName')}</TableHead>
                  <TableHead className="text-right">{t('issue.colQuantity')}</TableHead>
                  <TableHead className="text-right">{t('issue.colUnit')}</TableHead>
                  <TableHead className="text-right">{t('issue.colAmount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.draft.lines.map((line) => (
                  <TableRow key={line.record_id}>
                    <TableCell>{line.date_begin}</TableCell>
                    <TableCell>{line.code}</TableCell>
                    <TableCell>{line.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyMinor(line.unit_minor, 'CHF')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyMinor(line.amount_minor, 'CHF')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              {t('issue.totalVat')}: {formatMoneyMinor(preview.draft.totals.vat_minor, 'CHF')}
            </span>
            <span className="font-medium">
              {t('issue.totalAmount')}: {formatMoneyMinor(preview.draft.totals.amount_minor, 'CHF')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── this contact's receipt history ──────────────────────────────────────

function ContactReceiptsList({
  teamId,
  receipts,
  loading,
  canManage,
}: {
  teamId: string | null
  receipts: Tarif595ReceiptRow[]
  loading: boolean
  canManage: boolean
}) {
  const t = useTranslations('Tarif595')
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    )
  }
  if (receipts.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{t('history.empty')}</p>
  }
  if (!teamId) return null
  return (
    <ul className="divide-y">
      {receipts.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{r.number}</span>
              <ReceiptStatusBadge status={r.status} />
            </div>
            <div className="text-xs text-muted-foreground">
              {r.period.from} – {r.period.to}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm font-medium tabular-nums">{formatMoneyMinor(r.totals.amount_minor, 'CHF')}</span>
            <ReceiptActions teamId={teamId} receipt={r} canManage={canManage} />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── the segment ──────────────────────────────────────────────────────────

export function ReceiptsSegment({
  contact,
  teamId,
}: {
  contact: Contact & { id: string }
  teamId: string | null
}) {
  const t = useTranslations('Tarif595')
  const { user, teamRole } = useAuth()
  const canManage = teamRole === 'owner' || teamRole === 'manager'
  const invalidate = useInvalidateTarif595(teamId)

  // ── (a) insurer data ──────────────────────────────────────────────────
  const { data: contactData, isLoading: contactDataLoading } = useTarif595ContactData(teamId, contact.id)
  const [ahv, setAhv] = useState('')
  const [insurerName, setInsurerName] = useState('')
  const [insurerGln, setInsurerGln] = useState('')
  const [insuredNumber, setInsuredNumber] = useState('')
  const [sexOverride, setSexOverride] = useState<'male' | 'female' | ''>('')
  const [guardianGivenname, setGuardianGivenname] = useState('')
  const [guardianFamilyname, setGuardianFamilyname] = useState('')
  const [savingContactData, setSavingContactData] = useState(false)

  useEffect(() => {
    setAhv(contactData?.ahv_number ?? '')
    setInsurerName(contactData?.insurer_name ?? '')
    setInsurerGln(contactData?.insurer_gln ?? '')
    setInsuredNumber(contactData?.insured_number ?? '')
    setSexOverride(contactData?.sex_override ?? '')
    setGuardianGivenname(contactData?.guardian?.givenname ?? '')
    setGuardianFamilyname(contactData?.guardian?.familyname ?? '')
  }, [contactData])

  // A contact whose gender is recorded M/F needs no override — the receipt's
  // `patient.sex` derives from it directly (tarif595GenderSex). Anyone else
  // (unset or `other`) has no derivable sex, and `issue` refuses without one.
  const needsSexOverride = contact.gender !== 'M' && contact.gender !== 'F'
  const ahvTrimmed = ahv.trim()
  const ahvInvalid = ahvTrimmed !== '' && !isValidAhv(ahvTrimmed)

  async function handleSaveContactData() {
    if (!teamId) return
    setSavingContactData(true)
    try {
      await saveTarif595ContactData(teamId, contact.id, user?.uid ?? null, {
        ahv_number: ahvTrimmed || null,
        insurer_name: insurerName.trim() || null,
        insurer_gln: insurerGln.trim() || null,
        insured_number: insuredNumber.trim() || null,
        sex_override: sexOverride || null,
        guardian:
          guardianGivenname.trim() || guardianFamilyname.trim()
            ? { familyname: guardianFamilyname.trim(), givenname: guardianGivenname.trim() }
            : null,
      })
      toast.success(t('insurer.saveSuccess'))
      invalidate(contact.id)
    } catch (err) {
      console.error('[tarif-595] save contact data failed:', err)
      toast.error(t('insurer.saveError'))
    } finally {
      setSavingContactData(false)
    }
  }

  // ── (b) issue a receipt ───────────────────────────────────────────────
  const { data: history = [] } = useSubscriptionHistory(contact.id)
  const { data: subTypes = [] } = useSubscriptionTypes(teamId)
  const { data: activities = [] } = useActivities(teamId)
  const { data: courses = [] } = useCourses(teamId)
  const { data: purchasedCourseIds = [] } = useContactCoursePurchases(teamId, contact.id)

  const typeName = useMemo(() => {
    const byId = new Map(subTypes.map((s) => [s.id, s.name]))
    return (id: string | null | undefined, fallback: string | null | undefined) =>
      (id && byId.get(id)) || fallback || t('issue.unknownPlan')
  }, [subTypes, t])

  const classActivities = useMemo(
    () => activities.filter((a) => (a.type ?? 'class') === 'class'),
    [activities]
  )
  const purchasedIdSet = useMemo(() => new Set(purchasedCourseIds), [purchasedCourseIds])
  const purchasedCourses = useMemo(
    () => courses.filter((c) => purchasedIdSet.has(c.id)),
    [courses, purchasedIdSet]
  )

  const subscriptionOptions: SourceOption[] = useMemo(
    () =>
      history.map((h) => {
        const startIso = tsToIsoDate(h.start_date)
        const endIso = tsToIsoDate(h.end_date)
        return {
          key: `subscription:${h.id}`,
          label: `${typeName(h.subscription_type_id, h.subscription_type_name)} · ${startIso ?? '—'} – ${
            endIso ?? t('issue.ongoing')
          }`,
          source: { kind: 'subscription', historyId: h.id },
          defaultFrom: startIso,
          defaultTo: endIso ?? isoDate(new Date()),
        }
      }),
    [history, typeName, t]
  )

  const attendanceOptions: SourceOption[] = useMemo(
    () =>
      classActivities.map((a) => ({
        key: `attendance:${a.id}`,
        label: a.name,
        source: { kind: 'attendance', activityId: a.id },
        defaultFrom: null,
        defaultTo: null,
      })),
    [classActivities]
  )

  const courseOptions: SourceOption[] = useMemo(
    () =>
      purchasedCourses.map((c) => ({
        key: `course:${c.id}`,
        label: c.title,
        source: { kind: 'course', courseId: c.id },
        defaultFrom: null,
        defaultTo: null,
      })),
    [purchasedCourses]
  )

  const allOptions = useMemo(
    () => [...subscriptionOptions, ...attendanceOptions, ...courseOptions],
    [subscriptionOptions, attendanceOptions, courseOptions]
  )

  const [pickKey, setPickKey] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<Tarif595PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [alsoEmail, setAlsoEmail] = useState(false)
  // Price per unit in CHF — the server derives it from a subscription's history
  // row or a course's purchase; an attendance receipt has no record to read it
  // from, so the manager types it. Left blank = let the server derive.
  const [unitPrice, setUnitPrice] = useState('')
  const unitPriceMinor = unitPrice.trim() === '' ? null : Math.round(Number(unitPrice.replace(',', '.')) * 100)
  const unitPriceValid = unitPriceMinor === null || (Number.isFinite(unitPriceMinor) && unitPriceMinor >= 0)

  const selected = allOptions.find((o) => o.key === pickKey) ?? null

  function handlePick(key: string) {
    setPickKey(key)
    setPreview(null)
    const opt = allOptions.find((o) => o.key === key)
    if (opt?.defaultFrom && opt.defaultTo) {
      setFrom(opt.defaultFrom)
      setTo(opt.defaultTo)
    } else {
      const range = currentYearRange()
      setFrom(range.from)
      setTo(range.to)
    }
  }

  async function handlePreview() {
    if (!teamId || !selected || !from || !to) return
    setPreviewing(true)
    setPreview(null)
    try {
      const { data } = await callPreviewTarif595Receipt({
        teamId,
        contactId: contact.id,
        source: selected.source,
        from,
        to,
        unitPriceMinor: unitPriceValid ? unitPriceMinor : null,
      })
      setPreview(data)
    } catch (err) {
      console.error('[tarif-595] preview failed:', err)
      toast.error(t('issue.previewError'))
    } finally {
      setPreviewing(false)
    }
  }

  async function handleIssue() {
    if (!teamId || !selected || !preview?.ok) return
    setIssuing(true)
    try {
      const { data } = await callIssueTarif595Receipt({
        teamId,
        contactId: contact.id,
        source: selected.source,
        from,
        to,
        unitPriceMinor: unitPriceValid ? unitPriceMinor : null,
        email: alsoEmail,
      })
      toast.success(
        data.resumed ? t('issue.resumedSuccess', { number: data.number }) : t('issue.issueSuccess', { number: data.number })
      )
      invalidate(contact.id)
      setPreview(null)
      setPickKey('')
    } catch (err) {
      console.error('[tarif-595] issue failed:', err)
      toast.error(t('issue.issueError'))
    } finally {
      setIssuing(false)
    }
  }

  // ── (c) this contact's receipts ───────────────────────────────────────
  const { data: receipts = [], isLoading: receiptsLoading } = useContactTarif595Receipts(teamId, contact.id)

  if (!canManage) {
    // Insurer data + issuing are manager/owner actions; everyone else still
    // sees what has already been produced, same as every other money surface.
    return (
      <div className="space-y-4 p-4 sm:p-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('history.title')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ContactReceiptsList teamId={teamId} receipts={receipts} loading={receiptsLoading} canManage={false} />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4 sm:p-5">
      {/* (a) insurer data */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('insurer.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {contactDataLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-ahv">{t('insurer.ahvLabel')}</Label>
                  <Input
                    id="tarif595-ahv"
                    value={ahv}
                    onChange={(e) => setAhv(e.target.value)}
                    placeholder="756.1234.5678.97"
                    aria-invalid={ahvInvalid}
                  />
                  {ahvTrimmed && !ahvInvalid && <p className="text-xs text-muted-foreground">{formatAhv(ahvTrimmed)}</p>}
                  {ahvInvalid && <p className="text-xs text-destructive">{t('insurer.ahvInvalid')}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-insured-number">{t('insurer.insuredNumberLabel')}</Label>
                  <Input
                    id="tarif595-insured-number"
                    value={insuredNumber}
                    onChange={(e) => setInsuredNumber(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-insurer-name">{t('insurer.insurerNameLabel')}</Label>
                  <Input id="tarif595-insurer-name" value={insurerName} onChange={(e) => setInsurerName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-insurer-gln">{t('insurer.insurerGlnLabel')}</Label>
                  <Input id="tarif595-insurer-gln" value={insurerGln} onChange={(e) => setInsurerGln(e.target.value)} />
                </div>
                {needsSexOverride && (
                  <div className="space-y-1.5">
                    <Label htmlFor="tarif595-sex">{t('insurer.sexLabel')}</Label>
                    <Select
                      value={sexOverride || undefined}
                      onValueChange={(v) => setSexOverride((v as 'male' | 'female') ?? '')}
                    >
                      <SelectTrigger id="tarif595-sex" className="w-full">
                        <SelectValue placeholder={t('insurer.sexPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="male">{t('insurer.sexMale')}</SelectItem>
                        <SelectItem value="female">{t('insurer.sexFemale')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t('insurer.guardianTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('insurer.guardianHint')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    value={guardianGivenname}
                    onChange={(e) => setGuardianGivenname(e.target.value)}
                    placeholder={t('insurer.guardianGivenname')}
                  />
                  <Input
                    value={guardianFamilyname}
                    onChange={(e) => setGuardianFamilyname(e.target.value)}
                    placeholder={t('insurer.guardianFamilyname')}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void handleSaveContactData()} disabled={savingContactData || ahvInvalid}>
                  {savingContactData && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                  {t('insurer.save')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* (b) issue a receipt */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('issue.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {allOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('issue.noSources')}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>{t('issue.sourceLabel')}</Label>
                  <Select value={pickKey || undefined} onValueChange={(v) => v && handlePick(String(v))}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('issue.sourcePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {subscriptionOptions.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>{t('issue.groupSubscriptions')}</SelectLabel>
                          {subscriptionOptions.map((o) => (
                            <SelectItem key={o.key} value={o.key}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {attendanceOptions.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>{t('issue.groupClasses')}</SelectLabel>
                          {attendanceOptions.map((o) => (
                            <SelectItem key={o.key} value={o.key}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {courseOptions.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>{t('issue.groupCourses')}</SelectLabel>
                          {courseOptions.map((o) => (
                            <SelectItem key={o.key} value={o.key}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-from">{t('issue.fromLabel')}</Label>
                  <Input
                    id="tarif595-from"
                    type="date"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value)
                      setPreview(null)
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-to">{t('issue.toLabel')}</Label>
                  <Input
                    id="tarif595-to"
                    type="date"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value)
                      setPreview(null)
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarif595-unit-price">{t('issue.unitPriceLabel')}</Label>
                  <Input
                    id="tarif595-unit-price"
                    type="text"
                    inputMode="decimal"
                    placeholder={selected?.source.kind === 'attendance' ? '25.00' : ''}
                    value={unitPrice}
                    aria-invalid={!unitPriceValid}
                    onChange={(e) => {
                      setUnitPrice(e.target.value)
                      setPreview(null)
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t('issue.unitPriceHint')}</p>
                </div>
              </div>

              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePreview()}
                  disabled={!selected || !from || !to || previewing}
                >
                  {previewing && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                  {t('issue.previewButton')}
                </Button>
              </div>

              {preview && teamId && <PreviewResultView preview={preview} teamId={teamId} contactId={contact.id} />}

              {preview?.ok && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Switch checked={alsoEmail} onCheckedChange={setAlsoEmail} />
                    {t('issue.alsoEmailLabel')}
                  </label>
                  <Button size="sm" onClick={() => void handleIssue()} disabled={issuing}>
                    {issuing && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                    {t('issue.issueButton')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* (c) this contact's receipts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('history.title')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ContactReceiptsList teamId={teamId} receipts={receipts} loading={receiptsLoading} canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  )
}
