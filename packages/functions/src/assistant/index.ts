// In-app AI assistant (v1) — a navigation & help copilot for studio staff. It
// answers "how do I / where is X" and points to the right page. Read-only: it has
// NO access to the team's data and takes no actions (those are later phases).
//
// Gated: the caller must be a member of a team that has the (locked) ai-assistant
// plugin installed — so it only runs for teams the operator has unlocked.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { to } from '../utils/async'
import { isTeamMember } from '../utils/teams'
import { getGenAI, ASSISTANT_MODEL, replyWasStopped } from '../utils/vertexClient'
import { pluginIsActive } from '../utils/plugins'

const MAX_MESSAGES = 20
const MAX_CHARS_PER_MESSAGE = 4000
const UNLOCK_PLUGIN_ID = 'ai-assistant'
const RATE_LIMIT_MAX = 40 // messages per user + team per hour
const RATE_WINDOW_MS = 60 * 60 * 1000

// Static app-capability index the model is grounded on. Keep concise; a richer,
// generated index (from NAV_SECTIONS/settings-nav/PLUGIN_REGISTRY) is a Phase-B
// improvement. Menu paths mirror the sidebar.
//
// IT GOES STALE SILENTLY, and did: this still said "Offer › Activities" and
// "Offer › Catalogue" after both were renamed, so the assistant was confidently
// directing studios to a menu that no longer existed — wrong answers with no
// error anywhere (Franco, 2026-09-02). Nothing checks this against the real
// nav, which is exactly what the generated index above would fix. Until then:
// rename a nav row, grep here.
const APP_MAP = `Linyup dashboard map (menu path → what it's for):
- Dashboard — overview.
- Run › Schedule — calendar of sessions. Run › Bookings — booking requests.
  Run › Contacts — your people (profiles, notes, follow-ups, appointments).
  Run › Payments — money in (needs Stripe Connect). Run › Automations — rules that act on contacts/bookings.
  Run › Day sheet — the printable list a coach carries to the door. Run › Coaches — staff (Studio+).
  Run › Groups (plugin) — manual and rule-based contact groups.
- Manage › Offerings — the one place activities (classes and appointments) and plans
  (subscriptions) are created, priced and linked to each other; also lists courses and products.
  Manage › Pricing — read-only view of what everything costs. Manage › Places — locations and rooms.
  Manage › Promo codes, Online courses, Products, Documents, Affiliation.
  Manage › Finance and Assets (plugins) — the books and the asset register.
- Grow › All public pages — hub of every public surface (bio-link, website, shop, space, booking, signup, forms, documents) with a default-landing picker; Space settings lives under it, and what the shop sells is Manage › Offerings. Grow › Bio link — the link-in-bio editor. Grow › Website, Forms, Gamification — plugin surfaces.
- Settings › Team (general, payments/currency, branding), Booking, Event types, Members, Roles (capabilities per role), Plugins (marketplace), Billing (plan & invoices).
Contact detail tabs: Profile, Appointments, Stats, Bookings, Plans & Affiliation, Payments, Activity, Follow-ups (alerts + outreach), Gamification.`

const SYSTEM_PROMPT = `You are Linyup's in-app assistant for studio staff (coaches, managers, owners).
Help them find features and learn how to do things in Linyup. Be concise and practical.
When relevant, tell them exactly where to go using the menu path (e.g. "Settings › Roles").
Only discuss the Linyup app. If asked about their private data (specific contacts, numbers)
or to perform an action, explain that you can't do that yet — you currently help with
navigation and how-to. Do not invent features that aren't in the app map.

${APP_MAP}`

type ChatMessage = { role: 'user' | 'assistant'; content: string }

/**
 * A reply the model was stopped in the middle of, made to read as cut rather
 * than as a finished answer: it ends at its last whole sentence or line, and
 * says so with "…". A full stop after a digit is not a sentence end — "2." in a
 * numbered list is how an answer here usually starts a step.
 */
export function endStoppedReply(text: string): string {
  const t = text.trimEnd()
  if (!t) return t
  let end = -1
  let atLineBreak = false
  for (const m of t.matchAll(/(?<!\d)[.!?](?=\s|$)|\n/g)) {
    const at = m.index ?? 0
    atLineBreak = m[0] === '\n'
    end = atLineBreak ? at : at + 1
  }
  if (end <= 0) return `${t.replace(/[\s,;:–—-]+$/, '')}…`
  const kept = t.slice(0, end).trimEnd()
  return atLineBreak ? `${kept}\n…` : `${kept} …`
}

export const assistantChat = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, messages } = (request.data ?? {}) as { teamId?: string; messages?: ChatMessage[] }

  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpsError('invalid-argument', 'messages must be a non-empty array.')
  }

  const db = admin.firestore()

  // Caller must be a team member…
  const [memberErr, isMember] = await to(isTeamMember(uid, teamId))
  if (memberErr || !isMember) throw new HttpsError('permission-denied', 'You are not a member of this team.')

  // …and the (unlocked) assistant plugin must be installed for this team.
  // Through the ONE resolver, so an ORG-level install counts — this was its own
  // read, and a studio whose organisation installed the plugin was refused.
  if (!(await pluginIsActive(teamId, UNLOCK_PLUGIN_ID))) {
    throw new HttpsError('failed-precondition', 'The AI assistant is not enabled for this team.')
  }

  // Rate-limit per user + team per hour.
  const windowKey = Math.floor(Date.now() / RATE_WINDOW_MS).toString()
  const rlRef = db.collection('rate_limits').doc(uid).collection('assistant_chat').doc(`${teamId}_${windowKey}`)
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(rlRef)
    const count = snap.exists ? (snap.data()!.count as number) : 0
    if (count >= RATE_LIMIT_MAX) return false
    tx.set(rlRef, { count: count + 1, updated_at: FieldValue.serverTimestamp() }, { merge: true })
    return true
  })
  if (!allowed) throw new HttpsError('resource-exhausted', 'You have reached the hourly limit. Try again later.')

  // Normalise + bound the conversation, then map to Vertex content format.
  const trimmed = messages
    .slice(-MAX_MESSAGES)
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: String(m.content).slice(0, MAX_CHARS_PER_MESSAGE) }],
    }))
  if (trimmed.length === 0 || trimmed[trimmed.length - 1].role !== 'user') {
    throw new HttpsError('invalid-argument', 'The last message must be from the user.')
  }

  try {
    const response = await getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: trimmed,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 1024,
        // NO THINKING: a how-to answer grounded on the app map needs no
        // reasoning budget, and thinking tokens would spend this cap before the
        // answer is written (see vertexClient).
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.3,
      },
    })
    // `response.text` rather than walking candidates[0].content.parts — four
    // optional steps that each return undefined silently. See vertexClient.
    let reply = (response.text ?? '').trim()
    if (!reply) throw new HttpsError('internal', 'The assistant returned an empty response.')
    // A long answer can still reach the cap. It is still worth showing, but as
    // what it is: cut, never as a finished answer.
    if (replyWasStopped(response)) {
      console.warn(`[assistantChat] reply hit the output cap (team=${teamId})`)
      reply = endStoppedReply(reply)
    }
    return { reply }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[assistantChat] Vertex error:', (err as Error).message)
    throw new HttpsError('internal', 'The assistant is unavailable right now.')
  }
})
