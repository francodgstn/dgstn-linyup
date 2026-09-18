// suggestTarif595Mappings — a PROPOSAL of positions for the studio's offerings,
// reviewed before it is saved. Writes nothing.
//
// Mapping every plan and class to a Tarif 595 position is the most tedious
// step of the setup: a few hundred rows in insurer German, and a studio with
// twenty offerings scrolls the list twenty times. The unit half of a mapping
// is derived from the offering's own data (`suggestTarif595Unit`, shared) and
// needs no model. The position half is a method judgement — "Yoga Flow" is
// body-and-mind, "Open Gym" is the training floor — that a model reads off
// names and descriptions well and a studio confirms in a glance. So the model
// proposes, the row says "suggested" with the reason, and the manager who
// knows which methods the label body certified decides. The parser is the
// boundary: a code the table does not know, or one not valid today, is
// dropped to null — never passed through because the model said so.
//
// Gated like creation (manager + plugin installed): it spends the studio's
// model budget on the studio's behalf, and a rate limit bounds that. The
// vertex client is the shared one (utils/vertexClient.ts, ADC, no key).

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { Type } from '@google/genai'
import {
  ACTIVITIES_COLLECTION,
  COURSES_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TARIF595_FREE_TEXT_CODE,
  TARIF595_PLUGIN_ID,
  TARIF595_SUGGEST_AS_OF_MAX_DAYS,
  TEAMS_COLLECTION,
  suggestTarif595Unit,
  tarif595LangOf,
  tarif595OfferingKey,
  type Activity,
  type Course,
  type SubscriptionType,
  type Tarif595Lang,
  type Tarif595OfferingFacts,
  type Tarif595SuggestRequest,
  type Tarif595SuggestResult,
  type Tarif595Suggestion,
  type Tarif595SuggestionConfidence,
  type Tarif595Unit,
} from '@linyup/shared'
import { TARIF595_LIST_VERSION, tarif595PositionOn, tarif595PositionsOn } from '@linyup/shared/tarif595-positions'
import { assertManager } from '../connect/access'
import { assertUnderRateLimit } from '../offer/draftOfferings'
import { assertPluginInstalled } from '../utils/plugins'
import { getTeam } from '../utils/teams'
import { ASSISTANT_MODEL, getGenAI, replyWasStopped } from '../utils/vertexClient'
import { loadTarif595Config } from './config'
import { zurichDay } from './sources'

/** Suggestion runs per user + team + hour. A studio re-runs after renaming a
 *  plan or two, not in a loop. */
const RATE_LIMIT_MAX = 6
const MAX_OFFERINGS = 120
/** A lookup, not a plan: a small thinking budget, and a cap with room for
 *  MAX_OFFERINGS rows of key + code + unit + confidence + one line (~60
 *  tokens each) well above it. */
const SUGGEST_THINKING_BUDGET = 1024
const SUGGEST_MAX_OUTPUT_TOKENS = 12288
const UNITS: readonly Tarif595Unit[] = ['month', 'year', 'lesson', 'entry', 'flat']
const CONFIDENCES: readonly Tarif595SuggestionConfidence[] = ['high', 'medium', 'low']

interface OfferingForModel {
  key: string
  kind: 'plan' | 'class' | 'course'
  name: string
  description: string
  /** The derived unit, as the word the position texts use. */
  unitHint: Tarif595Unit | null
  facts: Tarif595OfferingFacts
}

const UNIT_WORDS: Record<Tarif595Lang, Record<Tarif595Unit, string>> = {
  de: { month: 'pro 1 Monat', year: 'pro 1 Jahr', lesson: 'pro 1 Lektion', entry: 'Einzeleintritt', flat: 'pauschal' },
  fr: { month: 'par mois', year: 'par an', lesson: 'par leçon', entry: 'entrée individuelle', flat: 'forfait' },
  it: { month: 'al mese', year: "all'anno", lesson: 'per lezione', entry: 'entrata singola', flat: 'forfettario' },
}

const SYSTEM_PROMPT = `You map the offerings of a Swiss sports, fitness or wellness studio to positions of "Tarif 595" — the Swiss health-insurance tariff for health-promotion services (Forum Datenaustausch), whose position list you are given.

Each position is one METHOD billed in one UNIT: chapter 2 is flat-rate access to a training centre or group-fitness studio (per month, per year, single entry); chapter 3 is courses and personal training by method (endurance/strength, body-and-mind such as yoga and pilates, diverse courses, specific training), per lesson or per month, with "Personal Training" and "Einzelsetting" variants for 1:1; chapters 4–6 are nutrition, lifestyle and maternity. Position 9999 is free text for what no other position covers.

For EVERY offering return the best position:
- pick the method from the name and description; when the name is generic ("Unlimited", "Membership", "Open Gym") and the studio is a training centre, the training-floor positions of chapter 2 apply;
- pick the row whose unit matches the unit hint ("pro 1 Monat", "pro 1 Lektion", …) — the hint is derived from the offering's prices and is reliable;
- for a 1:1 offering ("Personal Training", "PT", "1:1", "Einzel", "privé", "individuale") also return the Personal Training companion position of the same method in ptPosition;
- an online-live offering takes the "online live" variant; a recorded-video course takes 1105;
- never invent a code: use codes from the list only; use 9999 only when nothing else fits and say so in the reason;
- confidence: "high" when method and unit are both clear, "medium" when the method is inferred, "low" when you are guessing;
- reason: one short sentence in the requested language, naming the method you recognised.
Return JSON only.`

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING, description: 'the offering key exactly as given' },
          position: { type: Type.STRING, description: 'a 4-digit code from the list' },
          unit: { type: Type.STRING, enum: [...UNITS] },
          ptPosition: { type: Type.STRING, description: '4-digit code, 1:1 offerings only' },
          confidence: { type: Type.STRING, enum: [...CONFIDENCES] },
          reason: { type: Type.STRING },
        },
        required: ['key', 'position', 'confidence', 'reason'],
      },
    },
  },
  required: ['suggestions'],
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/** `asOf` within [today, today + TARIF595_SUGGEST_AS_OF_MAX_DAYS]; anything
 *  else (absent, malformed, the past, too far) is today. */
export function clampAsOf(asOf: unknown, todayIso: string): string {
  if (typeof asOf !== 'string' || !ISO_RE.test(asOf) || asOf < todayIso) return todayIso
  const [y, m, d] = todayIso.split('-').map(Number)
  const max = new Date(Date.UTC(y, m - 1, d + TARIF595_SUGGEST_AS_OF_MAX_DAYS)).toISOString().slice(0, 10)
  return asOf > max ? todayIso : asOf
}

function unfence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return (m ? m[1] : text).trim()
}

async function loadOfferings(teamId: string): Promise<OfferingForModel[]> {
  const db = admin.firestore()
  const [plans, activities, courses] = await Promise.all([
    db.collection(TEAMS_COLLECTION).doc(teamId).collection(SUBSCRIPTION_TYPES_SUBCOLLECTION).limit(MAX_OFFERINGS).get(),
    db.collection(ACTIVITIES_COLLECTION).where('teamId', '==', teamId).limit(MAX_OFFERINGS).get(),
    db.collection(COURSES_COLLECTION).where('teamId', '==', teamId).limit(MAX_OFFERINGS).get(),
  ])
  const out: OfferingForModel[] = []
  for (const d of plans.docs) {
    const p = d.data() as SubscriptionType
    const facts: Tarif595OfferingFacts = {
      kind: 'subscription',
      recurrences: (p.prices ?? []).map((x) => x.recurrence),
      credits: Math.max(0, ...(p.prices ?? []).map((x) => x.credits ?? 0)) || null,
    }
    const limit = p.limits?.[0]
    out.push({
      key: tarif595OfferingKey('subscription', d.id),
      kind: 'plan',
      name: p.name ?? '',
      description: [p.description ?? '', limit ? `${limit.count} per ${limit.per}` : ''].filter(Boolean).join(' — '),
      unitHint: suggestTarif595Unit(facts)?.unit ?? null,
      facts,
    })
  }
  for (const d of activities.docs) {
    const a = d.data() as Activity
    // The settings page lists class activities only; an appointment is billed
    // through its plan or as a lesson from the detail page.
    if ((a.type ?? 'class') !== 'class') continue
    const facts: Tarif595OfferingFacts = { kind: 'activity', activityType: 'class' }
    out.push({
      key: tarif595OfferingKey('activity', d.id),
      kind: 'class',
      name: a.name ?? '',
      description: [a.description ?? '', ...(a.tags ?? [])].filter(Boolean).join(' — '),
      unitHint: 'lesson',
      facts,
    })
  }
  for (const d of courses.docs) {
    const c = d.data() as Course
    const facts: Tarif595OfferingFacts = { kind: 'course' }
    out.push({ key: tarif595OfferingKey('course', d.id), kind: 'course', name: c.title ?? '', description: c.summary ?? '', unitHint: 'flat', facts })
  }
  return out.slice(0, MAX_OFFERINGS)
}

export const suggestTarif595Mappings = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request): Promise<Tarif595SuggestResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = (request.data ?? {}) as Partial<Tarif595SuggestRequest>
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const uid = request.auth.uid
  await assertManager(uid, teamId)
  await assertPluginInstalled(teamId, TARIF595_PLUGIN_ID)
  await assertUnderRateLimit(uid, teamId, 'tarif595_suggest', RATE_LIMIT_MAX)

  const [team, config, allOfferings] = await Promise.all([getTeam(teamId), loadTarif595Config(teamId), loadOfferings(teamId)])
  // `keys` narrows the proposal to the rows the page asks about (the ones whose
  // position is about to expire); an unknown key is simply not in the set.
  const onlyKeys = Array.isArray(data.keys) ? new Set(data.keys.filter((k): k is string => typeof k === 'string')) : null
  const offerings = onlyKeys ? allOfferings.filter((o) => onlyKeys.has(o.key)) : allOfferings
  if (offerings.length === 0) return { suggestions: [], listVersion: TARIF595_LIST_VERSION, model: ASSISTANT_MODEL }
  const language = config?.language ?? tarif595LangOf(team?.language)
  const nowIso = zurichDay(new Date()) ?? new Date().toISOString().slice(0, 10)
  // THE DAY THE PROPOSAL IS VALID FOR. Today by default; a later day when the
  // page asks for a REPLACEMENT of a position that expires — as of the day
  // after its last valid day, so the catalogue is next year's edition and the
  // parser below refuses this year's codes. Clamped: never the past (a
  // mapping for a list that no longer applies), never further than the next
  // edition.
  const today = clampAsOf(data.asOf, nowIso)

  const catalogue = tarif595PositionsOn(today)
    .map((p) => `${p.code} | ${p.chapter} | ${p.text[language]}`)
    .join('\n')
  const rows = offerings
    .map((o) => {
      const hint = o.unitHint ? `${o.unitHint} ("${UNIT_WORDS[language][o.unitHint]}")` : 'unknown'
      return `- key=${o.key} | ${o.kind} | name="${o.name}" | description="${o.description.slice(0, 200)}" | unit hint: ${hint}`
    })
    .join('\n')
  const userText = `Studio: ${team?.name ?? ''}. Reason language: ${language}.\n\nOFFERINGS:\n${rows}\n\nPOSITIONS (code | chapter | text):\n${catalogue}`

  let raw = ''
  let stopped = false
  try {
    const response = await getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // Thinking counts against the cap (utils/vertexClient.ts): a bounded
        // budget for a lookup task, and room for MAX_OFFERINGS rows of
        // {key, code, unit, confidence, one line} under it.
        maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: SUGGEST_THINKING_BUDGET },
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseJsonSchema: RESPONSE_SCHEMA,
      },
    })
    raw = response.text ?? ''
    stopped = replyWasStopped(response)
  } catch (err) {
    console.error('[tarif595:suggest] Vertex error:', (err as Error).message)
    throw new HttpsError('unavailable', 'Suggestions are not available right now', { reason: 'ai_unavailable' })
  }
  if (stopped) {
    // A cut JSON array may parse and still be missing rows — treat as no answer
    // rather than hand back half the offerings as if that were the proposal.
    console.warn(`[tarif595:suggest] reply hit the output cap (team=${teamId}, chars=${raw.length})`)
    throw new HttpsError('internal', 'The suggestions were too long to finish', { reason: 'ai_incomplete' })
  }

  let parsed: { suggestions?: unknown } = {}
  try {
    parsed = JSON.parse(unfence(raw)) as { suggestions?: unknown }
  } catch {
    throw new HttpsError('internal', 'The suggestions came back in a shape we could not read', { reason: 'ai_unreadable' })
  }

  // THE PARSER IS THE BOUNDARY. Every value is checked against the table and
  // the offering set; what does not pass becomes null, never an error.
  const byKey = new Map(offerings.map((o) => [o.key, o]))
  const validCode = (v: unknown): string | null => (typeof v === 'string' && tarif595PositionOn(v.trim(), today) ? v.trim() : null)
  const proposed = new Map<string, Tarif595Suggestion>()
  for (const item of Array.isArray(parsed.suggestions) ? parsed.suggestions : []) {
    const s = item as Record<string, unknown>
    const key = typeof s.key === 'string' ? s.key : ''
    const offering = byKey.get(key)
    if (!offering || proposed.has(key)) continue
    const position = validCode(s.position)
    const unit = UNITS.includes(s.unit as Tarif595Unit) ? (s.unit as Tarif595Unit) : (offering.unitHint ?? null)
    const derived = suggestTarif595Unit(offering.facts)
    proposed.set(key, {
      key,
      position,
      unit: position ? unit : null,
      entries: unit === 'entry' ? derived?.entries ?? null : null,
      ptPosition: validCode(s.ptPosition),
      confidence:
        position === null ? 'low' : position === TARIF595_FREE_TEXT_CODE ? 'low' : CONFIDENCES.includes(s.confidence as Tarif595SuggestionConfidence) ? (s.confidence as Tarif595SuggestionConfidence) : 'medium',
      reason: typeof s.reason === 'string' ? s.reason.trim().slice(0, 200) : '',
    })
  }
  const suggestions = offerings.map(
    (o) => proposed.get(o.key) ?? { key: o.key, position: null, unit: o.unitHint, entries: null, ptPosition: null, confidence: 'low' as const, reason: '' }
  )
  console.log(`[tarif595:suggest] team=${teamId} offerings=${offerings.length} placed=${suggestions.filter((s) => s.position).length} by=${uid}`)
  return { suggestions, listVersion: TARIF595_LIST_VERSION, model: ASSISTANT_MODEL }
})
