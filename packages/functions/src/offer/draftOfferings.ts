// ─── AI offer drafting: propose, then apply ──────────────────────────────────
//
// TWO CALLABLES, AND THE SPLIT IS THE SECURITY MODEL.
//
// `draftOfferings` runs the model and WRITES NOTHING. It returns an
// `OfferingDraft` — a type with no ids, no tenant and no reference to anything
// that already exists (see `packages/shared/src/types/offeringDraft.ts`, which
// carries the full argument). A studio reads what it proposes and decides.
//
// `applyOfferingDraft` takes a draft back and writes it, in ONE batch, through
// the same shapes the activity and plan forms produce. It re-parses whatever it
// is handed rather than trusting the client: the review step is a UX
// affordance, not a boundary — the boundary is that both ends of the round trip
// go through `parseOfferingDraft` (Franco, 2026-09-02).
//
// The applier therefore CANNOT update. Every draft creates; nothing it can
// express addresses an existing record. A studio that dislikes the result
// deletes five new rows, which is a recoverable afternoon rather than a
// restore-from-backup.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  TEAMS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  OFFERING_DRAFT_LIMITS,
  AI_MODULES,
  parseOfferingDraft,
  planKeysForActivity,
  type OfferingDraft,
} from '@linyup/shared'
import { to } from '../utils/async'
import { hasTeamRole, isTeamMember } from '../utils/teams'
import { pluginIsActive } from '../utils/plugins'
import { newAppointmentDocument, newClassDocument, planDocument } from './offeringWriter'
import { Type } from '@google/genai'
import { getGenAI, ASSISTANT_MODEL, replyWasStopped } from '../utils/vertexClient'

const RATE_LIMIT_MAX = 12 // drafts per user + team per hour
const RATE_WINDOW_MS = 60 * 60 * 1000

/**
 * THE OUTPUT BUDGET, SPLIT. A draft is a small planning task — activities and
 * plans that name each other by key, access tiers that need a plan behind them
 * — so thinking stays on, but BOUNDED, and the cap sits well above it. Thinking
 * tokens count against `maxOutputTokens` (see vertexClient); with the old cap
 * of 2048 and unbounded thinking, a draft could be stopped mid-JSON.
 *
 * The room left for the answer covers the largest draft `parseOfferingDraft`
 * accepts (OFFERING_DRAFT_LIMITS: 8 activities and 6 plans, each description
 * at its full 600 characters), which is under 4000 tokens.
 */
export const DRAFT_THINKING_BUDGET = 1024
export const DRAFT_MAX_OUTPUT_TOKENS = 6144

/**
 * The model is asked for JSON and given the shape by name.
 *
 * It is NOT asked to be careful — care is not enforceable in a prompt. It is
 * asked to be useful, and `parseOfferingDraft` is what makes the result safe.
 * Everything here is about output QUALITY; nothing here is a security control.
 */
const SYSTEM_PROMPT = `You design the offer of a sports, fitness or wellness studio.

Given a short description of a studio, return the ACTIVITIES it should run and
the PLANS (subscriptions) it should sell. Return JSON only — no prose, no code
fences.

Shape:
{
  "activities": [{
    "key": "kebab-case-handle",         // unique within this response
    "name": "Yoga Basics",
    "description": "one or two sentences, optional",
    "type": "class" | "appointment",    // default class; appointment = 1:1 time
    "durations": [{"minutes": 60, "priceAmount": 90}],  // APPOINTMENTS ONLY
    "accessTier": "open" | "members" | "subscription",
    "planKeys": ["unlimited"],          // plans in THIS response that open it
    "dropInPriceAmount": 25             // CLASSES ONLY, price for a single visit
  }],
  "plans": [{
    "key": "unlimited",
    "name": "Unlimited",
    "description": "optional",
    "prices": [{"amount": 89, "recurrence": "monthly", "credits": 10}],
    "limit": {"count": 8, "per": "month"},
    "activityKeys": ["yoga-basics"]     // activities in THIS response it includes
  }],
  "note": "one line on anything you assumed, optional"
}

recurrence is one of: one_time, weekly, biweekly, monthly, quarterly, annual.
A class pack is one_time with credits (the number of classes).
limit.per is one of: day, week, month.

Rules:
- Only these fields. Never invent an "id" — you are proposing new records.
- Link activities and plans using the keys in THIS response and no other value.
- "accessTier": "subscription" only makes sense with planKeys; "open" means
  anyone may book, "members" means any signed-in member.
- Prices are in the studio's own currency, as plain numbers. If the description
  gives no price, LEAVE PRICES OUT rather than guessing a number the studio
  might not notice.
- Descriptions are plain text shown to members on public pages: no Markdown,
  no bullets, no bold. The "note" may use Markdown.
- Do not duplicate anything in "Already set up" below; complement it.
- Keep it small and realistic: a handful of activities, two or three plans.`

/**
 * THE SHAPE, GIVEN TO THE MODEL RATHER THAN DESCRIBED TO IT.
 *
 * This is NOT the security boundary — `parseOfferingDraft` is, and it still
 * refuses everything it refused when the shape lived only in the prompt. What
 * this buys is a better FIRST draft: a constrained model does not invent a
 * field name, so fewer usable proposals get thrown away over a spelling.
 *
 * It mirrors the prompt rather than replacing it: the prompt says what a GOOD
 * answer looks like, this says what an answer IS. Only `key` and `name` are
 * required, because a proposal with nothing but names is still worth reviewing
 * — and a schema that demands prices would push the model into inventing the
 * numbers the prompt tells it to leave out.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    activities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING, description: 'kebab-case handle, unique in this response' },
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          type: { type: Type.STRING, enum: ['class', 'appointment'] },
          accessTier: { type: Type.STRING, enum: ['open', 'members', 'subscription'] },
          planKeys: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'keys of plans in THIS response',
          },
          dropInPriceAmount: { type: Type.NUMBER, description: 'classes only' },
          durations: {
            type: Type.ARRAY,
            description: 'appointments only',
            items: {
              type: Type.OBJECT,
              properties: {
                minutes: { type: Type.INTEGER },
                priceAmount: { type: Type.NUMBER },
              },
              required: ['minutes'],
            },
          },
        },
        required: ['key', 'name'],
      },
    },
    plans: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING },
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          activityKeys: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'keys of activities in THIS response',
          },
          prices: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                amount: { type: Type.NUMBER },
                recurrence: {
                  type: Type.STRING,
                  enum: [
                    'one_time',
                    'weekly',
                    'biweekly',
                    'monthly',
                    'quarterly',
                    'annual',
                  ],
                },
                label: { type: Type.STRING },
                credits: { type: Type.INTEGER },
              },
              required: ['amount', 'recurrence'],
            },
          },
          limit: {
            type: Type.OBJECT,
            properties: {
              count: { type: Type.INTEGER },
              per: { type: Type.STRING, enum: ['day', 'week', 'month'] },
            },
            required: ['count', 'per'],
          },
        },
        required: ['key', 'name'],
      },
    },
    note: { type: Type.STRING },
  },
  required: ['activities', 'plans'],
}

type DraftRequest = { teamId?: string; prompt?: string }
type ApplyRequest = { teamId?: string; draft?: unknown }

function assertShortEnough(prompt: string) {
  if (prompt.length > OFFERING_DRAFT_LIMITS.promptChars) {
    throw new HttpsError('invalid-argument', 'That description is too long.')
  }
}

/** Member, owner, and the module installed — checked in that order so the
 *  message a caller gets names the first thing actually wrong. */
async function assertAllowed(uid: string, teamId: string) {
  const [memberErr, isMember] = await to(isTeamMember(uid, teamId))
  if (memberErr || !isMember) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }
  // OWNER-ONLY, matching where the switch lives. It was the `offer-drafting`
  // experiment on the team document until 2026-09-17 and is now the
  // `ai-offer-drafting` module of the AI insights plugin — and both are
  // owner-written. A manager who could run this but not turn it off would be
  // able to create priced records from a switch they cannot reach.
  const [roleErr, isOwner] = await to(hasTeamRole(uid, teamId, 'owner'))
  if (roleErr || !isOwner) {
    throw new HttpsError('permission-denied', 'Only the studio owner can draft offerings.')
  }
  // `pluginIsActive` also sees the module installed at the ORGANIZATION.
  if (!(await pluginIsActive(teamId, AI_MODULES.offerDrafting))) {
    throw new HttpsError('failed-precondition', 'Offer drafting is not switched on for this team.')
  }
}

/** Per user + team + hour, in `bucket`. Exported for the other model-backed
 *  callables (tarif595/suggest.ts) so there is ONE limiter, not a copy. */
export async function assertUnderRateLimit(uid: string, teamId: string, bucket: string, max = RATE_LIMIT_MAX) {
  const db = admin.firestore()
  const windowKey = Math.floor(Date.now() / RATE_WINDOW_MS).toString()
  const ref = db.collection('rate_limits').doc(uid).collection(bucket).doc(`${teamId}_${windowKey}`)
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const count = snap.exists ? ((snap.data()!.count as number) ?? 0) : 0
    if (count >= max) return false
    tx.set(ref, { count: count + 1, updated_at: FieldValue.serverTimestamp() }, { merge: true })
    return true
  })
  if (!allowed) {
    throw new HttpsError('resource-exhausted', 'You have reached the hourly limit. Try again later.')
  }
}

/** Names only. The model is given what EXISTS so it does not propose a second
 *  "Yoga Basics" — never ids, prices or access rules, which it has no use for
 *  and could otherwise echo back as if they were its own proposal. */
async function existingNames(teamId: string): Promise<string> {
  const db = admin.firestore()
  const [acts, plans] = await Promise.all([
    db.collection(ACTIVITIES_COLLECTION).where('teamId', '==', teamId).limit(60).get(),
    db.collection(TEAMS_COLLECTION).doc(teamId).collection(SUBSCRIPTION_TYPES_SUBCOLLECTION).limit(40).get(),
  ])
  const a = acts.docs.map((d) => String(d.data().name ?? '')).filter(Boolean)
  const p = plans.docs.map((d) => String(d.data().name ?? '')).filter(Boolean)
  if (!a.length && !p.length) return 'Already set up: nothing yet.'
  return `Already set up — do not duplicate these:\nActivities: ${a.join(', ') || '(none)'}\nPlans: ${p.join(', ') || '(none)'}`
}

/** Strip a ```json fence if the model wrapped its answer in one. Asked not to,
 *  does anyway often enough to be worth three lines. */
function unfence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return (m ? m[1] : text).trim()
}

export type DraftReply = { ok: true; json: unknown } | { ok: false; reason: 'stopped' | 'unreadable' }

/**
 * The model's reply → JSON, or why not. A STOPPED reply is refused before it is
 * parsed: it is incomplete by definition, and a cut that happens to leave valid
 * JSON would still be a draft missing whatever came after the cut.
 */
export function readDraftReply(raw: string, stopped: boolean): DraftReply {
  if (stopped) return { ok: false, reason: 'stopped' }
  try {
    return { ok: true, json: JSON.parse(unfence(raw)) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

export const draftOfferings = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, prompt } = (request.data ?? {}) as DraftRequest
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')
  if (!prompt || !prompt.trim()) throw new HttpsError('invalid-argument', 'Describe the studio first.')
  assertShortEnough(prompt)

  await assertAllowed(uid, teamId)
  await assertUnderRateLimit(uid, teamId, 'draft_offerings')

  const context = await existingNames(teamId)

  let raw = ''
  let stopped = false
  try {
    const response = await getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [{ role: 'user', parts: [{ text: `${context}\n\nStudio: ${prompt.trim()}` }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // Split between bounded thinking and the answer — see DRAFT_THINKING_BUDGET.
        maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: DRAFT_THINKING_BUDGET },
        // Low temperature: this is a structured proposal, not a brainstorm, and
        // a creative model here mostly invents field names.
        temperature: 0.2,
        // THE SHAPE IS GIVEN, not just described — see RESPONSE_SCHEMA. The
        // parser still refuses everything it refused before; this only makes
        // the first draft likelier to survive it.
        responseMimeType: 'application/json',
        responseJsonSchema: RESPONSE_SCHEMA,
      },
    })
    // `response.text`, not a walk down candidates[0].content.parts — four
    // optional steps that each return undefined silently. See vertexClient.
    raw = response.text ?? ''
    stopped = replyWasStopped(response)
  } catch (err) {
    console.error('[draftOfferings] Vertex error:', (err as Error).message)
    throw new HttpsError('internal', 'The drafting service is unavailable right now.')
  }

  const reply = readDraftReply(raw, stopped)
  if (!reply.ok) {
    if (reply.reason === 'stopped') {
      console.warn(`[draftOfferings] reply hit the output cap (team=${teamId}, chars=${raw.length})`)
      throw new HttpsError('internal', 'The draft was too long to finish. Try describing a smaller offer.')
    }
    throw new HttpsError('internal', 'The draft came back in a shape we could not read.')
  }

  const { draft, problems } = parseOfferingDraft(reply.json)
  if (!draft) {
    console.warn('[draftOfferings] rejected draft:', JSON.stringify(problems).slice(0, 400))
    throw new HttpsError('internal', 'The draft came back in a shape we could not read.')
  }
  // Problems are returned, not thrown: a draft with one dropped color is still
  // worth showing, and the studio is the one who decides whether it is useful.
  return { draft, problems }
})

export const applyOfferingDraft = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, draft: incoming } = (request.data ?? {}) as ApplyRequest
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')

  await assertAllowed(uid, teamId)

  // RE-PARSED, NOT TRUSTED. The client edited this between the two calls, which
  // is the point of the review — so what arrives here is user input like any
  // other, and it goes through the same gate the model's output did.
  const { draft } = parseOfferingDraft(incoming)
  if (!draft) throw new HttpsError('invalid-argument', 'There is nothing valid to apply.')

  const db = admin.firestore()
  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)

  // Order the new rows after whatever is already there. Read before the batch:
  // a batch cannot read, and an approximate starting point is fine — `order` is
  // a display sort a studio drags to fix, not an invariant.
  const [actCount, planCount] = await Promise.all([
    db.collection(ACTIVITIES_COLLECTION).where('teamId', '==', teamId).count().get(),
    teamRef.collection(SUBSCRIPTION_TYPES_SUBCOLLECTION).count().get(),
  ])

  const batch = db.batch()

  // PLANS FIRST, so an activity's access rule can name the id of a plan created
  // in the same batch. This is the only place a draft key becomes an id, and it
  // is why the draft could never spell one itself.
  const planIds = new Map<string, string>()
  draft.plans.forEach((plan, i) => {
    const ref = teamRef.collection(SUBSCRIPTION_TYPES_SUBCOLLECTION).doc()
    planIds.set(plan.key, ref.id)
    // THE SHARED WRITER (offer/offeringWriter.ts), the same one the setup
    // wizard uses. NOT PUBLIC: a drafted plan is visible to the studio and to
    // nobody else until they say so, and an AI proposal is not that decision.
    batch.set(
      ref,
      planDocument(
        {
          name: plan.name,
          ...(plan.description ? { description: plan.description } : {}),
          source: 'internal',
          public: false,
          prices: (plan.prices ?? []).map((p) => ({
            amount: p.amount,
            recurrence: p.recurrence,
            ...(p.label ? { label: p.label } : {}),
            ...(p.credits ? { credits: p.credits } : {}),
          })),
          ...(plan.limit ? { limits: [plan.limit] } : {}),
        },
        { teamId, uid, order: planCount.data().count + i, createdVia: 'ai-draft' },
        (j) => `${ref.id}-${j}`
      )
    )
  })

  draft.activities.forEach((activity, i) => {
    const ref = db.collection(ACTIVITIES_COLLECTION).doc()
    const gatePlanIds = planKeysForActivity(draft, activity.key)
      .map((k) => planIds.get(k))
      .filter((id): id is string => !!id)
    const isAppointment = activity.type === 'appointment'
    // A gate with nothing behind it would deny everyone, so an activity the
    // model marked `subscription` but linked to no plan falls back to `open` —
    // the same direction the activity form's own resolver takes.
    const tier =
      activity.accessTier === 'subscription' && !gatePlanIds.length ? 'open' : (activity.accessTier ?? 'open')

    const stamp = { teamId, uid, order: actCount.data().count + i, createdVia: 'ai-draft' as const }
    const extras = { color: activity.color, tags: activity.tags }
    // THE SHARED WRITER (offer/offeringWriter.ts). DURATIONS ARE APPOINTMENT-ONLY
    // and drop-in is CLASS-ONLY, the same asymmetry the forms enforce: a model
    // that puts both on one activity gets the half that applies to what it said
    // the activity was. WHO MAY BOOK IS DERIVED (docs/class-access-derived.md):
    // the plans that include the class and the drop-in it sells; `tier`
    // survives only as the model's way of saying "members only", the wall.
    // A draft with no drop-in price follows the studio's usual price, which is
    // exactly how an activity stored with no `dropIn` was always read.
    batch.set(
      ref,
      isAppointment
        ? newAppointmentDocument(
            { name: activity.name, description: activity.description, durations: activity.durations ?? [] },
            stamp,
            extras
          )
        : newClassDocument(
            {
              name: activity.name,
              ...(activity.description ? { description: activity.description } : {}),
              signupRequired: tier === 'members',
              includedPlanIds: gatePlanIds,
              dropIn:
                activity.dropInPriceAmount !== undefined
                  ? { mode: 'custom', priceAmount: activity.dropInPriceAmount }
                  : { mode: 'studio' },
            },
            stamp,
            // A draft sets no trial and no member rate, the only two answers
            // that read the studio's default price.
            null,
            extras
          )
    )
  })

  await batch.commit()
  return { activities: draft.activities.length, plans: draft.plans.length }
})
