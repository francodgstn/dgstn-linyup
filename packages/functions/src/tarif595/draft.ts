// Tarif 595 — THE ONE composition behind preview and issue. Loads the setup,
// the contact, the plugin's insurer data and the source records, runs the pure
// line builder, and answers with the receipt exactly as it would be issued —
// or with the list of reasons it cannot be. `previewTarif595Receipt` returns
// this; `issueTarif595Receipt` freezes it. There is no second line computation
// anywhere (not on the client either — the UI renders what preview returns).
//
// Refusals vs advisories: a BLOCKING issue is the server's refusal (the issue
// path throws on any of them); a WARNING is shown and never refused on. The
// AHV number is blocking by decision (docs/tarif-595.md → "Decisions").

import * as admin from 'firebase-admin'
import {
  CONTACTS_COLLECTION,
  TARIF595_RECEIPTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  isValidAhv,
  normalizeAhv,
  tarif595GenderSex,
  tarif595LangOf,
  tarif595OfferingKey,
  tarif595ReceiptId,
  tarif595SourceKey,
  type Contact,
  type StructuredPostal,
  type Tarif595ContactData,
  type Tarif595Line,
  type Tarif595OfferingMapping,
  type Tarif595PreviewIssue,
  type Tarif595PreviewResult,
  type Tarif595PreviewWarning,
  type Tarif595ReceiptDoc,
  type Tarif595ReceiptRequest,
  type Tarif595ReceiptStatus,
} from '@linyup/shared'
import { tarif595PositionOn } from '@linyup/shared/tarif595-positions'
import { sha256Hex } from '../utils/crypto'
import { getTeam } from '../utils/teams'
import { loadSetup, loadTarif595ContactData, type Tarif595Setup } from './config'
import { buildTarif595Lines } from './lines'
import { listAttendedDays, loadCoursePurchase, loadSubscriptionPeriod, unitPriceMinorFor, zurichDay } from './sources'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const CONTACT_RECEIPTS_SCAN = 200

/** Everything the frozen receipt needs except what the transaction allocates
 *  (number, guid, request_timestamp, request_date, created_*). */
export type FrozenParts = Omit<
  Tarif595ReceiptDoc,
  'id' | 'number' | 'guid' | 'request_timestamp' | 'request_date' | 'created_at' | 'created_by' | 'status' | 'files' | 'delivery'
> & { id: string }

export interface DraftOutcome {
  result: Tarif595PreviewResult
  frozen: FrozenParts | null
  setup: Tarif595Setup | null
  contact: (Contact & { id: string }) | null
}

interface ExistingReceipt {
  id: string
  number: string
  status: Tarif595ReceiptStatus
  revision: number
  source_key: string
  period: { from: string; to: string }
}

async function listContactReceipts(teamId: string, contactId: string): Promise<ExistingReceipt[]> {
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TARIF595_RECEIPTS_SUBCOLLECTION)
    .where('contact_id', '==', contactId)
    .limit(CONTACT_RECEIPTS_SCAN)
    .get()
  return snap.docs.map((d) => {
    const r = d.data() as Tarif595ReceiptDoc
    return { id: d.id, number: r.number, status: r.status, revision: r.revision, source_key: r.source_key, period: r.period }
  })
}

function contactPostal(c: Contact): StructuredPostal | null {
  const a = c.address
  if (!a?.postal_code || !a?.locality) return null
  return {
    street_name: a.route ?? '',
    house_no: a.street_number ?? '',
    zip: a.postal_code,
    city: a.locality,
    country: 'CH',
  }
}

function salutationFor(gender: 'male' | 'female' | 'diverse', lang: 'de' | 'fr' | 'it'): string | null {
  if (gender === 'diverse') return null
  const table = { de: ['Herr', 'Frau'], fr: ['Monsieur', 'Madame'], it: ['Signor', 'Signora'] } as const
  return gender === 'male' ? table[lang][0] : table[lang][1]
}

export async function buildReceiptDraft(req: Tarif595ReceiptRequest): Promise<DraftOutcome> {
  const blocking: Tarif595PreviewIssue[] = []
  const warnings: Tarif595PreviewWarning[] = []
  const refuse = (): DraftOutcome => ({
    result: { ok: false, blocking, warnings, draft: null, existing: null },
    frozen: null,
    setup: null,
    contact: null,
  })

  if (!ISO_RE.test(req.from) || !ISO_RE.test(req.to) || req.to < req.from) {
    blocking.push({ code: 'period_invalid' })
    return refuse()
  }

  const [{ setup, issues: setupIssues }, team, contactSnap, contactData, existingReceipts] = await Promise.all([
    loadSetup(req.teamId),
    getTeam(req.teamId),
    admin.firestore().collection(CONTACTS_COLLECTION).doc(req.contactId).get(),
    loadTarif595ContactData(req.teamId, req.contactId),
    listContactReceipts(req.teamId, req.contactId),
  ])
  for (const i of setupIssues) blocking.push({ code: i.code, detail: i.detail })

  const contact = contactSnap.exists ? ({ ...(contactSnap.data() as Contact), id: contactSnap.id } as Contact & { id: string }) : null
  if (!contact || contact.teamId !== req.teamId || contact.deleted_at) {
    blocking.push({ code: 'contact_not_found' })
    return refuse()
  }
  if (!setup) return { ...refuse(), contact }

  const language = setup.config.language ?? tarif595LangOf(team?.language)
  const sourceKey = tarif595SourceKey(req.source, req.from, req.to)

  // Already issued (or mid-issue) for this very source/period → offer that one.
  const same = existingReceipts.filter((r) => r.source_key === sourceKey)
  const live = same.find((r) => r.status === 'issued' || r.status === 'pending')
  if (live) {
    blocking.push({ code: 'already_issued', detail: live.number })
    return {
      result: {
        ok: false,
        blocking,
        warnings,
        draft: null,
        existing: { receiptId: live.id, number: live.number, status: live.status },
      },
      frozen: null,
      setup,
      contact,
    }
  }
  const voided = same.filter((r) => r.status === 'voided').sort((a, b) => b.revision - a.revision)
  const revision = (voided[0]?.revision ?? 0) + 1
  const replaces = voided[0]?.id ?? null
  for (const r of existingReceipts) {
    if (r.source_key === sourceKey || r.status !== 'issued') continue
    if (r.period.from <= req.to && r.period.to >= req.from) {
      warnings.push({ code: 'overlapping_receipt', detail: r.number })
    }
  }

  // ── The source → mapping, dates, unit price ────────────────────────────────
  let mapping: Tarif595OfferingMapping | undefined
  let offeringKey = ''
  let attendanceDates: string[] | undefined
  let unitPriceMinor = typeof req.unitPriceMinor === 'number' && req.unitPriceMinor >= 0 ? Math.round(req.unitPriceMinor) : null

  if (req.source.kind === 'subscription') {
    const period = await loadSubscriptionPeriod(req.contactId, req.source.historyId)
    if (!period || !period.subscriptionTypeId) {
      blocking.push({ code: 'source_not_found', detail: req.source.historyId })
      return { ...refuse(), setup, contact }
    }
    offeringKey = tarif595OfferingKey('subscription', period.subscriptionTypeId)
    mapping = setup.config.offerings[offeringKey]
    if (mapping && unitPriceMinor === null) {
      unitPriceMinor = unitPriceMinorFor(mapping.unit, period.recurrence, period.amountMajor)
    }
  } else if (req.source.kind === 'attendance') {
    offeringKey = tarif595OfferingKey('activity', req.source.activityId)
    mapping = setup.config.offerings[offeringKey]
    if (mapping) {
      const scan = await listAttendedDays({
        teamId: req.teamId,
        contactId: req.contactId,
        activityId: req.source.activityId,
        fromIso: req.from,
        toIso: req.to,
      })
      attendanceDates = scan.days
      if (scan.truncated) warnings.push({ code: 'attendance_truncated' })
    }
  } else {
    const purchase = await loadCoursePurchase(req.source.courseId, req.contactId)
    if (!purchase) {
      blocking.push({ code: 'source_not_found', detail: req.source.courseId })
      return { ...refuse(), setup, contact }
    }
    offeringKey = tarif595OfferingKey('course', req.source.courseId)
    mapping = setup.config.offerings[offeringKey]
    if (unitPriceMinor === null && purchase.amountMinor !== null) unitPriceMinor = purchase.amountMinor
  }

  if (!mapping) {
    blocking.push({ code: 'offering_unmapped', detail: offeringKey })
    return { ...refuse(), setup, contact }
  }
  if (unitPriceMinor === null) unitPriceMinor = 0
  if (unitPriceMinor === 0) warnings.push({ code: 'unit_price_zero' })

  // ── The lines ──────────────────────────────────────────────────────────────
  const built = buildTarif595Lines({
    mapping,
    period: { from: req.from, to: req.to },
    attendanceDates,
    unitPriceMinor,
    vatRate: setup.legalProfile.vat_number ? setup.legalProfile.vat_rate ?? 0 : 0,
    language,
    positionOn: (code, date) => tarif595PositionOn(code, date),
  })
  for (const i of built.issues) blocking.push(i)

  // ── The patient ────────────────────────────────────────────────────────────
  const birthdate = zurichDay(contact.birthdate)
  if (!birthdate) blocking.push({ code: 'contact_birthdate_missing' })
  const genderSex = tarif595GenderSex(contact.gender, contactData?.sex_override ?? null)
  if (!genderSex) blocking.push({ code: 'contact_sex_unknown' })
  const postal = contactPostal(contact)
  if (!postal) blocking.push({ code: 'contact_address_incomplete' })
  const ahv = normalizeAhv(contactData?.ahv_number ?? '')
  if (!ahv) blocking.push({ code: 'contact_ahv_missing' })
  else if (!isValidAhv(ahv)) blocking.push({ code: 'contact_ahv_invalid' })
  if (!contactData?.insured_number) warnings.push({ code: 'insured_number_missing' })
  if (!contactData?.insurer_gln) warnings.push({ code: 'insurer_unknown' })

  const receiptId = tarif595ReceiptId(sha256Hex, req.teamId, req.contactId, sourceKey, revision)
  const lines: Tarif595Line[] = built.lines

  if (blocking.length > 0) {
    return {
      result: {
        ok: false,
        blocking,
        warnings,
        draft: { period: { from: req.from, to: req.to }, lines, totals: built.totals, language, receiptId, revision, replaces },
        existing: null,
      },
      frozen: null,
      setup,
      contact,
    }
  }

  const lp = setup.legalProfile
  const party = {
    companyname: lp.legal_name,
    postal: lp.postal,
    phone: lp.phone ?? null,
    email: lp.email ?? null,
  }
  const person = {
    familyname: contact.lastname,
    givenname: contact.firstname,
    postal: postal!,
    email: contact.email ?? null,
  }
  const guardian = contactData?.guardian
    ? { familyname: contactData.guardian.familyname, givenname: contactData.guardian.givenname, postal: contactData.guardian.postal ?? postal!, email: null }
    : person

  const frozen: FrozenParts = {
    id: receiptId,
    teamId: req.teamId,
    contact_id: req.contactId,
    revision,
    replaces,
    source: req.source,
    source_key: sourceKey,
    period: { from: req.from, to: req.to },
    lines,
    totals: built.totals,
    language,
    modus: setup.config.modus ?? 'production',
    canton: lp.canton,
    biller: { ...party, gln: setup.config.biller.gln, zsr: setup.config.biller.zsr },
    provider: {
      ...party,
      gln: setup.config.provider.gln,
      gln_location: setup.config.provider.gln_location || setup.config.provider.gln,
      zsr: setup.config.provider.zsr ?? setup.config.biller.zsr,
      uid: setup.config.provider.uid ?? null,
    },
    iban: lp.iban,
    vat_number: lp.vat_number ?? null,
    patient: {
      ...person,
      gender: genderSex!.gender,
      sex: genderSex!.sex,
      birthdate: birthdate!,
      ssn: ahv,
      salutation: salutationFor(genderSex!.gender, language),
    },
    guarantor: guardian,
    insurer: contactData?.insurer_gln ? { gln: contactData.insurer_gln, name: contactData.insurer_name ?? null } : null,
    insured_number: contactData?.insured_number ?? null,
  }

  return {
    result: {
      ok: true,
      blocking: [],
      warnings,
      draft: { period: frozen.period, lines, totals: built.totals, language, receiptId, revision, replaces },
      existing: null,
    },
    frozen,
    setup,
    contact,
  }
}
