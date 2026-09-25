// In-app AI assistant — for studio staff (coaches, managers, owners). Two jobs:
// answer questions about THEIR studio by calling read tools, and help them find
// their way around Linyup.
//
// The data comes through the public API's read layer, never a Firestore read of
// its own. The tools are the registry's (api/tools/registry.ts), the ones the
// remote MCP server publishes to Claude and ChatGPT, answered for a principal
// built from the signed-in member (`resolveMemberPrincipal`). That buys, without
// a second implementation of either: a coach sees only their own people and
// sessions, a demotion applies to the next question, and every record leaves as
// an allow-list projection — `fieldCatalog.ts` fails the build for a field
// nobody classified. Contact details are withheld outright (ASSISTANT_SCOPES):
// the member may see them in the app, but sending them to a model is a separate
// decision, and the contact-summary precedent is that no identifying field
// reaches a prompt.
//
// Read-only: no tool writes, and the prompt says so.
//
// Gated: the caller must be a member of a team that has the (locked) ai-assistant
// plugin installed — so it only runs for teams the operator has unlocked.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { FunctionCallingConfigMode, type Content } from '@google/genai'
import { API_SCOPES, type ApiScope } from '@linyup/shared'
import { resolveMemberPrincipal } from '../api/auth/principal'
import { loadTeamContext } from '../api/context'
import { studioInstructions } from '../api/tools/instructions'
import { toolsFor, type ReadToolContext } from '../api/tools/registry'
import { getGenAI, ASSISTANT_MODEL, replyWasStopped } from '../utils/vertexClient'
import { pluginIsActive } from '../utils/plugins'
import { functionDeclarations, runToolLoop, type Generate } from './toolLoop'

const MAX_MESSAGES = 20
const MAX_CHARS_PER_MESSAGE = 4000
const UNLOCK_PLUGIN_ID = 'ai-assistant'
const RATE_LIMIT_MAX = 40 // messages per user + team per hour
const RATE_WINDOW_MS = 60 * 60 * 1000

/** What the assistant may read: every API scope except contact details. */
export const ASSISTANT_SCOPES: readonly ApiScope[] = API_SCOPES.filter((s) => s !== 'contacts:read:pii')

// Static app-capability index the model is grounded on. Keep concise; a richer,
// generated index (from NAV_SECTIONS/settings-nav/PLUGIN_REGISTRY) is a Phase-B
// improvement. Menu paths mirror the sidebar.
//
// IT GOES STALE SILENTLY, and did: this still said "Offer › Activities" and
// "Offer › Catalog" after both were renamed, so the assistant was confidently
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

const HELP_PROMPT = `You are Linyup's in-app assistant for studio staff (coaches, managers, owners). You have two jobs.

1. Answer questions about their studio by calling your tools — who has gone quiet, how full classes were, which memberships are canceling, what is on the schedule. Use the tools rather than guessing. Never state a number, a name or a date a tool did not return; if a tool refuses or finds nothing, say so plainly.
2. Help them find their way around Linyup. When relevant, tell them exactly where to go using the menu path from the app map below (e.g. "Settings › Roles"). Do not invent features that aren't in it.

You can read, not act: you cannot book, cancel, message or change anything. When they ask for an action, say where in the app they can do it.
Contact details (email, phone, address, date of birth) are never available to you, even though the member can see them in the app — point them to the contact's profile instead.
Be concise and practical, and reply in the language the member writes in.`

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
  const nowMs = Date.now()

  // The member, read NOW — the same principal rules the public API answers with.
  const decision = await resolveMemberPrincipal(uid, teamId, ASSISTANT_SCOPES)
  if ('refusal' in decision) throw new HttpsError('permission-denied', 'You are not a member of this team.')
  const principal = decision.principal

  // …and the (unlocked) assistant plugin must be installed for this team.
  // Through the ONE resolver, so an ORG-level install counts — this was its own
  // read, and a studio whose organization installed the plugin was refused.
  if (!(await pluginIsActive(teamId, UNLOCK_PLUGIN_ID))) {
    throw new HttpsError('failed-precondition', 'The AI assistant is not enabled for this team.')
  }

  // Rate-limit per user + team per hour — per question, however many tool calls it takes.
  const windowKey = Math.floor(nowMs / RATE_WINDOW_MS).toString()
  const rlRef = db.collection('rate_limits').doc(uid).collection('assistant_chat').doc(`${teamId}_${windowKey}`)
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(rlRef)
    const count = snap.exists ? (snap.data()!.count as number) : 0
    if (count >= RATE_LIMIT_MAX) return false
    tx.set(rlRef, { count: count + 1, updated_at: FieldValue.serverTimestamp() }, { merge: true })
    return true
  })
  if (!allowed) throw new HttpsError('resource-exhausted', 'You have reached the hourly limit. Try again later.')

  // Normalize + bound the conversation, then map to Vertex content format.
  const trimmed: Content[] = messages
    .slice(-MAX_MESSAGES)
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content).slice(0, MAX_CHARS_PER_MESSAGE) }],
    }))
  if (trimmed.length === 0 || trimmed[trimmed.length - 1].role !== 'user') {
    throw new HttpsError('invalid-argument', 'The last message must be from the user.')
  }

  const team = await loadTeamContext(teamId)
  const ctx: ReadToolContext = { principal, team, nowMs }
  const tools = toolsFor(ctx)
  const systemInstruction = `${HELP_PROMPT}\n\n${studioInstructions(principal, team, nowMs, 'assistant')}\n\n${APP_MAP}`
  const declarations = functionDeclarations(tools)

  const generate: Generate = (contents, { allowTools }) =>
    getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents,
      config: {
        systemInstruction,
        // Room for an answer that lists people or classes, not just a how-to.
        maxOutputTokens: 2048,
        // NO THINKING: choosing a read tool is function calling, which this
        // model does without a reasoning budget, and thinking tokens would spend
        // this cap before the answer is written (see vertexClient). Revisit only
        // if tool choice is visibly wrong.
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.2,
        tools: [{ functionDeclarations: declarations }],
        toolConfig: {
          functionCallingConfig: { mode: allowTools ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.NONE },
        },
      },
    })

  try {
    const { turn, toolsUsed } = await runToolLoop(generate, trimmed, tools, ctx)
    // `text` rather than walking candidates[0].content.parts — four optional
    // steps that each return undefined silently. See vertexClient.
    let reply = (turn.text ?? '').trim()
    if (!reply) throw new HttpsError('internal', 'The assistant returned an empty response.')
    // A long answer can still reach the cap. It is still worth showing, but as
    // what it is: cut, never as a finished answer.
    if (replyWasStopped(turn)) {
      console.warn(`[assistantChat] reply hit the output cap (team=${teamId})`)
      reply = endStoppedReply(reply)
    }
    console.info(`[assistantChat] team=${teamId} uid=${uid} role=${principal.role} tools=${toolsUsed.join(',') || 'none'}`)
    return { reply, tools: toolsUsed }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[assistantChat] Vertex error:', (err as Error).message)
    throw new HttpsError('internal', 'The assistant is unavailable right now.')
  }
})
