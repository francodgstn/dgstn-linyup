// `requestWaiverAcceptance` — a studio ASKING somebody to sign.
//
// ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
// This folder ships create, update, publish, setRequirement, archive, resolve,
// revoke, signInSpace and export — and, until now, nothing that asks a contact to
// accept anything. So a studio that made a document mandatory had no remedy for
// the people already on its books: the requirement binds at their next booking,
// where they meet it as a refusal, on the acquisition path, with no warning. The
// document was published, the switch was on, the compliance work was done, and
// the only mechanism for closing the gap was hoping everybody tried to book.
//
// ── IT IS A REQUEST, NOT A GATE CHANGE, AND IT WRITES NO STATE ──────────────
// No acceptance row, no signer row, no `waiver_policy` edit, no counter. It reads
// the policy, reads signer rows, and sends mail. There is therefore nothing to
// reconcile, nothing to release and nothing a retry can corrupt — which is why it
// is deliberately absent from BOTH censuses: it puts nobody in a room
// (`waivers/gate.ts`) and it writes no ledger row (`waivers/accept.ts`).
//
// ── IT SENDS THE SPACE LINK, AND SO IT COVERS REQUIRED WAIVERS ONLY ─────────
// The signing surface already exists: `/public/{slug}/space`, backed by
// `signWaiverInSpace`, which resolves the WHOLE waiver policy whatever its scope.
// Inventing a second one would mean a second consent step, a second acceptance
// path and a second answer to "does this tick count".
//
// The consequence is a real limit, and it is refused by name rather than papered
// over: a document that is only "Shown at signup" is NOT in `waiver_policy`, so
// Space neither shows nor signs it, and asking somebody to sign it would send
// them to a page with nothing on it. `document_not_required` says so, and the
// panel that offers the action says what to do about it (turn on "Required before
// booking", which is one switch away on the same page).
//
// ── SINGLE AND BULK ARE ONE SHAPE ───────────────────────────────────────────
// `contactIds: string[]`. A per-row "Ask to sign" is a bulk of one, so there is
// one code path, one outcome vocabulary and one idempotency rule.
//
// ── SAFE TO CALL TWICE, AND STILL ABLE TO REMIND ────────────────────────────
// Two calls in the SAME DAY send one mail; a call tomorrow sends another. The
// `mail_sends` idempotency key carries the document, the version, the contact and
// the calendar day, so a double-click (or a manager repeating a bulk send over an
// overlapping selection) costs nothing, while a genuine reminder next week is not
// swallowed. Keying it on the relationship alone is the waitlist notifier's
// recorded bug — a person silently never mailed again — and keying it on nothing
// makes the button a way to mail a member forty times.
//
// Anyone whose signature is currently `valid` is skipped, always: the state is
// re-read at send time, so a bulk selection made against a list that has since
// moved does not badger somebody who signed five minutes ago.

import * as admin from 'firebase-admin'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  DOCUMENTS_COLLECTION,
  localizedPublicUrl,
  waiverAcceptanceState,
  waiverStateSatisfiesGate,
  type RequiredWaiverEntry,
  type WaiverAcceptanceState,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { sendEmail, idempotencyKey } from '../utils/email'
import { getHostingUrl } from '../utils/env'
import { getTeam } from '../utils/teams'
import { loadSignerFacts, loadWaiverPolicy } from './gate'
import { buildWaiverRequestEmail, isLang, waiverRequestSubject, type Lang } from './requestEmail'

/**
 * The ceiling on one call. A studio-plan roster is 250 people and an
 * organization's is larger, so a "select all, ask everyone" is a legitimate
 * request — but an unbounded one is a callable that runs for minutes and a
 * mailing that cannot be stopped. The client sends the selection in chunks; the
 * refusal names the number so it can.
 */
export const MAX_WAIVER_REQUEST_RECIPIENTS = 200

/** What happened for one person. Five outcomes, each with its own copy — a bulk
 *  send that reports only a total teaches a manager to trust it blindly. */
export type WaiverRequestOutcome =
  | 'sent'
  /** Already valid at send time. Never mailed, and not a failure. */
  | 'already_signed'
  | 'no_email'
  /** Suppressed address, tenant messaging policy, or mail disabled. */
  | 'not_delivered'
  /** Not this team's contact, or archived/deleted. */
  | 'skipped'

export interface WaiverRequestResult {
  contactId: string
  outcome: WaiverRequestOutcome
}

/** The `mail_sends` key. Per document VERSION and per calendar day — see the
 *  module header for why both, and why neither may be dropped. */
export function waiverRequestMailKey(
  documentId: string,
  version: number,
  contactId: string,
  dayKey: string
): string {
  return idempotencyKey('waiver-request', documentId, `v${version}`, contactId, dayKey)
}

/** `YYYY-MM-DD` in the studio's timezone-of-record, so "today" is one day for
 *  everybody rather than shifting at 01:00 for a manager in Zurich. */
export function requestDayKey(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' })
}

export const requestWaiverAcceptance = onCall(async (request: CallableRequest<unknown>) => {
  const data = (request.data ?? {}) as {
    teamId?: string
    documentId?: string
    contactIds?: unknown
  }
  const teamId = (data.teamId ?? '').trim()
  const documentId = (data.documentId ?? '').trim()
  const contactIds = Array.isArray(data.contactIds)
    ? [...new Set(data.contactIds.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()))]
    : []

  if (!teamId || !documentId) {
    throw new HttpsError('invalid-argument', 'teamId and documentId are required')
  }
  if (contactIds.length === 0) {
    throw new HttpsError('invalid-argument', 'At least one contact is required')
  }
  if (contactIds.length > MAX_WAIVER_REQUEST_RECIPIENTS) {
    throw new HttpsError('invalid-argument', 'Too many contacts in one request', {
      reason: 'too_many_contacts',
      max: MAX_WAIVER_REQUEST_RECIPIENTS,
    })
  }
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  await assertManager(request.auth.uid, teamId)

  // NO PLAN GATE, on `revokeWaiverAcceptance`'s reasoning: gates govern creating
  // and requiring, never operating a requirement that is already live. A
  // downgraded studio whose waiver still refuses bookings must be able to chase
  // the signatures that unblock them.

  const policy = await loadWaiverPolicy(teamId)
  const entry: RequiredWaiverEntry | undefined = policy.find((e) => e.documentId === documentId)
  if (!entry) {
    // Either the document is not this team's, or it is not required — and from
    // here those are the same fact: Space presents the waiver policy, so a
    // document outside it has no page to send anybody to.
    throw new HttpsError('failed-precondition', 'That document is not required before booking.', {
      reason: 'document_not_required',
    })
  }

  const team = await getTeam(teamId)
  if (!team?.slug) {
    throw new HttpsError('failed-precondition', 'This team has no public address yet.', {
      reason: 'team_has_no_slug',
    })
  }
  const lang: Lang = isLang(team.language) ? team.language : 'en'
  const teamName = team.name || 'Your studio'
  // Locale-pinned on the team's language, which is the language the request
  // mail below is written in (`lang`).
  const spaceUrl = localizedPublicUrl(getHostingUrl(), lang, team.slug, 'space')

  const db = admin.firestore()
  const nowMs = Date.now()
  const dayKey = requestDayKey(nowMs)
  const results: WaiverRequestResult[] = []

  // Sequential rather than a fan-out: a mailing is rate-shaped work, and one
  // provider hiccup should slow the call rather than fail 200 sends at once.
  for (const contactId of contactIds) {
    const snap = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
    const contact = snap.exists ? snap.data()! : null
    // THE TENANT ASSERTION. A manager may only ask their OWN contacts, and the
    // ids arrive off a client payload.
    if (!contact || contact.teamId !== teamId || contact.deleted_at || contact.archived_at) {
      results.push({ contactId, outcome: 'skipped' })
      continue
    }

    const signers = await loadSignerFacts([entry], contactId)
    const state: WaiverAcceptanceState = waiverAcceptanceState(
      { min_valid_version: entry.min_valid_version },
      signers[documentId] ?? null,
      nowMs
    )
    if (waiverStateSatisfiesGate(state)) {
      results.push({ contactId, outcome: 'already_signed' })
      continue
    }

    const email = ((contact.email as string | undefined) ?? '').trim()
    if (!email) {
      // A CONTACT WITH NO ADDRESS IS REPORTED, NEVER SILENTLY DROPPED. It is the
      // one outcome the manager has to act on themselves — a paper copy at the
      // door — and a total that quietly excluded them would read as "everyone
      // was asked".
      results.push({ contactId, outcome: 'no_email' })
      continue
    }

    const { html, text } = buildWaiverRequestEmail({
      firstname: ((contact.firstname as string | undefined) ?? '').trim(),
      teamName,
      documentTitle: entry.title,
      // `valid` was handled above, so the state here is one of the four the mail
      // has an opening line for.
      state: state as Exclude<WaiverAcceptanceState, 'valid'>,
      spaceUrl,
      lang,
    })

    try {
      const outcome = await sendEmail({
        to: email,
        subject: waiverRequestSubject(entry.title, lang),
        html,
        text,
        // AS THE STUDIO. A request to sign the studio's own house rules arriving
        // from Linyup is a phishing mail with our name on it.
        teamId,
        tags: ['waiver-request'],
        idempotencyKey: waiverRequestMailKey(documentId, entry.current_version, contactId, dayKey),
      })
      // `sendEmail` reports a non-delivery by RETURNING: a suppressed address (an
      // earlier hard bounce), a `silent`/`allowlist` messaging policy, or mail
      // switched off. The one `skipped` that IS a delivery carries a
      // providerMessageId — the ledger reporting a send that already went out.
      const delivered = !outcome.skipped || !!outcome.providerMessageId
      results.push({ contactId, outcome: delivered ? 'sent' : 'not_delivered' })
    } catch (err) {
      console.error(`[waivers] request mail to contact ${contactId} failed:`, err) // eslint-disable-line no-console
      results.push({ contactId, outcome: 'not_delivered' })
    }
  }

  const counts = results.reduce<Record<WaiverRequestOutcome, number>>(
    (acc, r) => ({ ...acc, [r.outcome]: acc[r.outcome] + 1 }),
    { sent: 0, already_signed: 0, no_email: 0, not_delivered: 0, skipped: 0 }
  )

  return { documentId, counts, results }
})
