// `exportContactConsentHistory` — one member's COMPLETE consent history, as a
// self-contained artefact.
//
// ── WHY IT MATERIALIZES THE TEXT ────────────────────────────────────────────
// An acceptance row stores only the HASH of what was accepted; the one copy of
// the text lives in the immutable version document. That is a complete snapshot
// at every point that matters, at one copy of the text instead of one per
// signer — and it is sound ONLY because three invariants hold: a version is
// never updated, a published document can never be deleted, and a waiver
// document is callable-only. `DocumentVersion`'s docblock names all three. If
// any is ever relaxed, this decision has to be revisited in the same change.
//
// So the export reads the version documents and prints the FULL TEXT, plus the
// stored hash, plus an explicit match verdict. A mismatch is printed rather than
// hidden — and printed together with what to do about it, because an artefact
// that tells a lawyer the evidence is broken and stops there is worse than one
// that never checked.
//
// A VERDICT IS ONLY WORTH PRINTING IF IT CAN SAY "match". The other-records
// section was rendered with an empty version map, so every row in it was stamped
// `version_missing` — an integrity alarm fired unconditionally by the export's
// own shortcut, in the artefact a studio would hand a lawyer. Its versions are
// loaded too; only the TEXT stays unmaterialised there, deliberately.
//
// ── ONE BLOCK PER DOCUMENT THIS PERSON HAS EVENTS ON, AND NO OTHERS ─────────
// The candidate list used to be that set UNIONED with every waiver document the
// team holds, because an emailed guardian request that was ticked and never
// redeemed produced no acceptance row and would otherwise have gone unprinted.
// That mechanism is gone, nothing under `documents/{d}` names a contact except
// through an event any more, and the union's only remaining effect would be
// empty sections in an artefact a lawyer reads.
//
// ── THE TWO QUERIES, AND WHY THEY ARE NEVER MERGED ──────────────────────────
// The primary query is `acceptances where contactId == …`. The second is
// `acceptances where identity_key == …`, and it is MANDATORY rather than an
// optimization:
//
//   Anna books in March as "Anna Müller" and signs. In June a phone drops the
//   umlaut, "Anna Muller" fails the guest match's name half, a second contact is
//   created and she signs again. In September the studio exports HER consent
//   history from contact B and gets June only — the March version, the one she
//   actually signed under, absent from an artefact headed with her name.
//
// But an identity key is sha256(normalized email) and is NOT unforgeable, so a
// shared family mailbox gives a mother and her child the SAME key. Over-
// inclusion is harmless for a redemption cap and is a FABRICATION in a consent
// artefact. The second query's rows therefore render in their own labeled
// section — "other records for this email address" — carrying `contactId`,
// `subject_name` and `signer_role` on every row, under a header that says an
// email address is not a person.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// `operator` (a manager exporting a member's history) gets both sections.
// `self` (a member downloading their own from Space) gets only the first: the
// identity-key section would show them somebody else's records, which is an
// operator tool and not a right of subject access.
//
// AND BOTH QUERIES ARE SCOPED TO ONE TEAM — the tenant boundary, enforced in
// `loadEvents` by a required parameter rather than by a caller remembering. The
// identity-key pass is the reason it has to be said out loud: a collection group
// spans every tenant and an identity key is sha256(an email address), so an
// unscoped pass hands studio A its neighbors' signature rows the moment two
// studios share a member. The second section is therefore "other records at THIS
// studio for this email address" and the artefact says so; a person's history at
// another studio is not this studio's to print.

import * as admin from 'firebase-admin'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  DOCUMENTS_COLLECTION,
  DOCUMENT_ACCEPTANCES_SUBCOLLECTION,
  DOCUMENT_NOTICES_SUBCOLLECTION,
  DOCUMENT_SIGNERS_SUBCOLLECTION,
  DOCUMENT_VERSIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  contactIdentityKey,
  waiverAcceptanceState,
  type DocumentVersion,
  type Timestamp as StoredTimestamp,
  type WaiverAcceptanceEvent,
  type WaiverNoticeRow,
  type WaiverSignerState,
} from '@linyup/shared'
import { hasTeamRole } from '../utils/teams'
import { sha256Hex } from '../utils/crypto'
import { optionalContactSessionFromRequest } from '../utils/contactSession'

/** Bounds the artefact. A member with more acceptance events than this is not a
 *  member, and an unbounded export is a way to read a whole tenant one contact
 *  at a time. */
const MAX_EVENTS = 500

function iso(ts: StoredTimestamp | null | undefined): string | null {
  return ts ? ts.toDate().toISOString() : null
}

export interface ConsentExportVersion {
  version: number
  publish_outcome: string
  published_at: string | null
  published_by_name: string
  /** Set when this snapshot was minted RETROACTIVELY by the version backfill.
   *  Somebody who signed a terms document in 2025 signed text that was captured
   *  in 2026, and printing that as an ordinary publish would assert more than
   *  happened. */
  backfilled_at: string | null
  bodyHash: string
  bodyChars: number
}

export interface ConsentExportEvent {
  acceptanceId: string
  documentId: string
  documentTitle: string
  kind: string
  version: number
  accepted_at: string | null
  signer_role: string
  signer_name: string
  signer_email: string
  signer_email_verified_by: string
  subject_name: string
  subject_email: string | null
  validity_months_at_signing: number | null
  valid_until: string | null
  ip: string | null
  user_agent: string | null
  locale: string | null
  source: string
  method: string
  contactId: string
  revoked_by?: string | null
  revoked_reason?: string | null
  revokes_acceptance_id?: string | null
  /** The exact text, materialized from the immutable version document. */
  bodyHtml: string | null
  stored_body_hash: string
  /** `match` | `mismatch` | `version_missing`. Printed, never suppressed. */
  hash_verdict: 'match' | 'mismatch' | 'version_missing'
}

interface DocumentBlock {
  documentId: string
  title: string
  slug: string
  kind: string
  current_version: number | null
  min_valid_version: number | null
  versions: ConsentExportVersion[]
  events: ConsentExportEvent[]
  notices: Array<{
    version: number
    attempt: number
    state: string
    email: string | null
    created_at: string | null
    sent_at: string | null
    resolved_at: string | null
  }>
  current_state: string
}

/** Load every version of one document, newest last, plus a hash→text map. */
async function loadVersions(documentId: string): Promise<Map<number, DocumentVersion>> {
  const snap = await admin
    .firestore()
    .collection(DOCUMENTS_COLLECTION)
    .doc(documentId)
    .collection(DOCUMENT_VERSIONS_SUBCOLLECTION)
    .get()
  const out = new Map<number, DocumentVersion>()
  for (const d of snap.docs) {
    const v = d.data() as DocumentVersion
    out.set(v.version, v)
  }
  return out
}

/**
 * PURE. The fingerprint check, exported so the artefact's one integrity claim is
 * asserted by a fixture.
 *
 * `version_missing` is an ALARM — it says the snapshot this signature names
 * could not be read, and the artefact tells its reader to run the checker. It
 * must therefore only ever be produced by a genuinely absent snapshot. The
 * other-records section used to be rendered against an empty map, so it stamped
 * this on every row it printed: a whole section of false alarms, which teaches
 * the reader to ignore the one that is real.
 */
export function waiverHashVerdict(
  version: Pick<DocumentVersion, 'bodyHash'> | null | undefined,
  storedBodyHash: string
): ConsentExportEvent['hash_verdict'] {
  if (!version) return 'version_missing'
  return version.bodyHash === storedBodyHash ? 'match' : 'mismatch'
}

function toExportEvent(
  id: string,
  e: WaiverAcceptanceEvent,
  documentTitle: string,
  versions: Map<number, DocumentVersion>
): ConsentExportEvent {
  const version = versions.get(e.version) ?? null
  // The hash is checked against the text the export is ABOUT to print. A
  // disagreement means the stored fingerprint and the stored text no longer
  // describe each other — the Admin SDK bypasses `allow write: if false`, so a
  // migration or a console edit is the realistic cause.
  const verdict = waiverHashVerdict(version, e.body_hash)
  return {
    acceptanceId: id,
    documentId: e.documentId,
    documentTitle,
    kind: e.kind,
    version: e.version,
    accepted_at: iso(e.accepted_at),
    signer_role: e.signer_role,
    signer_name: e.signer_name,
    signer_email: e.signer_email,
    signer_email_verified_by: e.signer_email_verified_by,
    subject_name: e.subject_name,
    subject_email: e.subject_email,
    validity_months_at_signing: e.validity_months_at_signing,
    valid_until: iso(e.valid_until),
    ip: e.ip,
    user_agent: e.user_agent,
    locale: e.locale,
    source: e.source,
    method: e.method,
    contactId: e.contactId,
    revoked_by: e.revoked_by ?? null,
    revoked_reason: e.revoked_reason ?? null,
    revokes_acceptance_id: e.revokes_acceptance_id ?? null,
    bodyHtml: version ? version.bodyHtml : null,
    stored_body_hash: e.body_hash,
    hash_verdict: verdict,
  }
}

/**
 * A collection-group pass over `acceptances`, by one indexed field — ALWAYS
 * SCOPED TO ONE TEAM.
 *
 * ── THE DEFECT THIS SIGNATURE EXISTS TO PREVENT ─────────────────────────────
 * The first cut ran `where('identity_key', '==', …)` with no team filter. A
 * collection group spans EVERY tenant, and an identity key is
 * sha256(normalized email) — a value two studios' members share the moment they
 * share an address. So a manager at studio A exporting one of their own members
 * received studio B's signature rows: names, addresses, consent history,
 * rendered into a downloadable artefact under studio A's letterhead. In a
 * multi-tenant SaaS that is the worst category of defect, and it was one missing
 * `where`.
 *
 * `teamId` is therefore a REQUIRED parameter rather than an option, so the
 * unscoped call cannot be written at all. The `contactId` pass is scoped too:
 * a contact id already belongs to exactly one team, so the filter is redundant
 * there today — and "redundant today" is how the other one got written.
 */
async function loadEvents(
  field: 'contactId' | 'identity_key',
  value: string,
  teamId: string
): Promise<Array<{ id: string; data: WaiverAcceptanceEvent }>> {
  const snap = await admin
    .firestore()
    .collectionGroup(DOCUMENT_ACCEPTANCES_SUBCOLLECTION)
    .where('teamId', '==', teamId)
    .where(field, '==', value)
    .orderBy('accepted_at', 'desc')
    .limit(MAX_EVENTS)
    .get()
  // BELT, BESIDE THE BRACES. The query is the fix; this is what makes the fix
  // TESTABLE without an emulator and what keeps a future index change or a
  // loosened filter from turning back into a tenant leak. It is pure, it is
  // exported, and `export.test.ts` drives the cross-tenant case through it.
  return keepOwnTeam(
    snap.docs.map((d) => ({ id: d.id, data: d.data() as WaiverAcceptanceEvent })),
    teamId
  )
}

/** PURE. Drop every row that does not belong to the exporting team. A row with
 *  no `teamId` at all is dropped too: an unattributable consent record must not
 *  be printed under a studio's name on the strength of a missing field. */
export function keepOwnTeam<T extends { data: { teamId?: string } }>(
  rows: T[],
  teamId: string
): T[] {
  return rows.filter((r) => r.data.teamId === teamId)
}

export const exportContactConsentHistory = onCall(async (request: CallableRequest<unknown>) => {
  const data = (request.data ?? {}) as {
    contactId?: string
    format?: 'json' | 'html'
    /** `self` omits the identity-key section. Never widened by the client: the
     *  server decides it from WHO is asking. */
    scope?: 'operator' | 'self'
  }
  const contactId = (data.contactId ?? '').trim()
  if (!contactId) throw new HttpsError('invalid-argument', 'contactId is required')

  const contactSnap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!contactSnap.exists) {
    throw new HttpsError('not-found', 'We could not find that contact.', {
      reason: 'contact_not_found',
    })
  }
  const contact = contactSnap.data()!
  const teamId = contact.teamId as string

  // ── Who may read this ─────────────────────────────────────────────────────
  // Two doors, and the SERVER decides which one was used — the client's `scope`
  // is a hint about rendering, never about authorization. A contact session may
  // only ever export ITSELF, which is also what makes the identity-key section
  // an operator-only artefact rather than a way to read a household.
  const session = optionalContactSessionFromRequest(request)
  let scope: 'operator' | 'self'
  if (session?.contactId === contactId && session.teamId === teamId) {
    scope = 'self'
  } else if (request.auth?.uid && (await hasTeamRole(request.auth.uid, teamId, 'manager'))) {
    scope = 'operator'
  } else {
    throw new HttpsError('permission-denied', 'You cannot export this history.')
  }

  const identityKey = contactIdentityKey(
    { email: (contact.email as string | undefined) ?? null, contactId },
    sha256Hex
  )

  const [own, byIdentity] = await Promise.all([
    loadEvents('contactId', contactId, teamId),
    // BOTH queries always run for an operator. Calling the second "optional" is
    // what made an evidential artefact quietly lossy.
    //
    // `teamId` comes off the CONTACT document that authorization was checked
    // against, never off the request: it is the same value `hasTeamRole` was
    // asked about one screen up, so the rows returned are exactly the tenant the
    // caller was cleared for.
    scope === 'operator' ? loadEvents('identity_key', identityKey, teamId) : Promise.resolve([]),
  ])

  const ownIds = new Set(own.map((e) => e.id))
  const otherRecords = byIdentity.filter((e) => !ownIds.has(e.id))

  // ── Per document ──────────────────────────────────────────────────────────
  // EXACTLY the documents this person has events on. It was that set unioned
  // with every waiver document the team holds, because a ticked-but-unredeemed
  // emailed guardian request produced no event row and would have gone
  // unprinted; that mechanism is gone, so the union's only remaining effect
  // would be empty sections — and every block below therefore has at least one
  // event by construction, with no skip needed to keep it that way.
  const documentIds = [...new Set(own.map((e) => e.data.documentId))]
  const nowMs = Date.now()
  const blocks: DocumentBlock[] = []
  const versionsByDocument = new Map<string, Map<number, DocumentVersion>>()
  for (const documentId of documentIds) {
    const docRef = admin.firestore().collection(DOCUMENTS_COLLECTION).doc(documentId)
    const events = own.filter((e) => e.data.documentId === documentId)
    const [docSnap, versions, signerSnap, noticesSnap] = await Promise.all([
      docRef.get(),
      loadVersions(documentId),
      docRef.collection(DOCUMENT_SIGNERS_SUBCOLLECTION).doc(contactId).get(),
      // Declared, append-only, and with no writer in this phase (`notify` is
      // deferred). Read anyway: the day it has one, an export taken before the
      // reader upgraded must not silently omit a version's notices.
      docRef
        .collection(DOCUMENT_NOTICES_SUBCOLLECTION)
        .where('contactId', '==', contactId)
        .limit(200)
        .get(),
    ])
    const d = docSnap.data() ?? {}
    const title = (d.title as string | undefined) ?? documentId
    const signer = signerSnap.exists ? (signerSnap.data() as WaiverSignerState) : null
    versionsByDocument.set(documentId, versions)
    blocks.push({
      documentId,
      title,
      slug: (d.slug as string | undefined) ?? '',
      kind: (d.kind as string | undefined) ?? 'other',
      current_version: (d.current_version as number | null | undefined) ?? null,
      min_valid_version: (d.min_valid_version as number | null | undefined) ?? null,
      versions: [...versions.values()]
        .sort((a, b) => a.version - b.version)
        .map((v) => ({
          version: v.version,
          publish_outcome: v.publish_outcome,
          published_at: iso(v.published_at),
          published_by_name: v.published_by_name,
          backfilled_at: iso(v.backfilled_at),
          bodyHash: v.bodyHash,
          bodyChars: v.bodyChars,
        })),
      events: events.map((e) => toExportEvent(e.id, e.data, title, versions)),
      notices: noticesSnap.docs.map((n) => {
        const row = n.data() as WaiverNoticeRow
        return {
          version: row.version,
          attempt: row.attempt,
          state: row.state,
          email: row.email,
          created_at: iso(row.created_at),
          sent_at: iso(row.sent_at),
          resolved_at: iso(row.resolved_at),
        }
      }),
      current_state: waiverAcceptanceState(
        { min_valid_version: (d.min_valid_version as number | undefined) ?? 0 },
        signer
          ? {
              accepted_version: signer.accepted_version,
              accepted_at: signer.accepted_at,
              valid_until: signer.valid_until ?? null,
              status: signer.status,
            }
          : null,
        nowMs
      ),
    })
  }

  // The other-records section carries its own document titles, resolved lazily
  // rather than by loading every document again.
  const otherTitles = new Map<string, string>(blocks.map((b) => [b.documentId, b.title]))
  const otherIds = [...new Set(otherRecords.map((e) => e.data.documentId))].filter(
    (id) => !otherTitles.has(id)
  )
  if (otherIds.length) {
    const snaps = await admin.firestore().getAll(
      ...otherIds.map((id) => admin.firestore().collection(DOCUMENTS_COLLECTION).doc(id))
    )
    snaps.forEach((s, i) => otherTitles.set(otherIds[i], (s.data()?.title as string) ?? otherIds[i]))
  }
  // ── AND THEIR VERSIONS, so the verdict is a verdict ────────────────────────
  // This section used to be rendered with an EMPTY version map, which made
  // `hash_verdict` read `version_missing` on every foreign row — an integrity
  // alarm, in the artefact a studio hands a lawyer, fired unconditionally by the
  // export's own shortcut. An artefact that cries wolf on every row of a section
  // teaches its reader to ignore the one row that means something. The text is
  // still deliberately NOT materialized here (these rows are a pointer for an
  // operator, not a signed artefact about this person) — but the fingerprint is
  // checked against the real snapshot, exactly as it is above.
  for (const id of otherIds) {
    if (!versionsByDocument.has(id)) versionsByDocument.set(id, await loadVersions(id))
  }

  const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()

  const payload: ExportPayload = {
    generated_at: new Date().toISOString(),
    generated_by: scope === 'self' ? 'contact' : (request.auth?.uid ?? null),
    scope,
    team: { id: teamId, name: (teamSnap.data()?.name as string | undefined) ?? '' },
    contact: {
      id: contactId,
      firstname: (contact.firstname as string | undefined) ?? '',
      lastname: (contact.lastname as string | undefined) ?? '',
      email: (contact.email as string | undefined) ?? null,
    },
    documents: blocks,
    /** Rows for the same EMAIL ADDRESS under a different contact id. Never
     *  merged into the member's own history: an email address is not a person,
     *  and a shared family mailbox would otherwise put a mother's and a child's
     *  signatures in one narrative. */
    other_records_for_this_email: otherRecords.map((e) => ({
      ...toExportEvent(
        e.id,
        e.data,
        otherTitles.get(e.data.documentId) ?? e.data.documentId,
        versionsByDocument.get(e.data.documentId) ?? new Map()
      ),
      // The text is deliberately NOT materialized for this section: these rows
      // are a pointer for an operator, not a signed artefact about this person.
      // The VERDICT is real, though — see above.
      bodyHtml: null,
    })),
    truncated: own.length >= MAX_EVENTS,
  }

  if (data.format === 'html') {
    return { format: 'html' as const, html: renderHtml(payload) }
  }
  return { format: 'json' as const, data: payload }
})

/** The artefact's shape, declared once so the JSON branch and the HTML renderer
 *  cannot drift apart. */
interface ExportPayload {
  generated_at: string
  generated_by: string | null
  scope: 'operator' | 'self'
  team: { id: string; name: string }
  contact: { id: string; firstname: string; lastname: string; email: string | null }
  documents: DocumentBlock[]
  other_records_for_this_email: ConsentExportEvent[]
  truncated: boolean
}

function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A self-contained HTML artefact — no stylesheet, no script, no external
 * reference. It is meant to be saved, mailed to a lawyer and opened years later,
 * so anything it does not carry inside itself is something it will one day be
 * missing.
 */
function renderHtml(p: ExportPayload): string {
  const name = `${p.contact.firstname} ${p.contact.lastname}`.trim() || p.contact.id
  const rows = (block: DocumentBlock) =>
    block.events
      .map(
        (e) => `
      <section class="event">
        <h4>${esc(e.kind === 'revoked' ? 'Revoked' : 'Accepted')} — version ${e.version} — ${esc(e.accepted_at)}</h4>
        <dl>
          <dt>Signed by</dt><dd>${esc(e.signer_name)} &lt;${esc(e.signer_email)}&gt; (${esc(e.signer_role)}, verified by ${esc(e.signer_email_verified_by)})</dd>
          <dt>About</dt><dd>${esc(e.subject_name)}${e.subject_email ? ` &lt;${esc(e.subject_email)}&gt;` : ''}</dd>
          ${e.signer_role === 'guardian' ? `<dt>Note</dt><dd><strong>Signed by somebody who declared themselves a parent or guardian. This is a SELF-DECLARATION: nothing verified the relationship, and no evidence of it was collected.</strong></dd>` : ''}
          <dt>Method</dt><dd>${esc(e.method)}, locale ${esc(e.locale ?? '—')}, IP ${esc(e.ip ?? '—')}</dd>
          <dt>Source</dt><dd>${esc(e.source)}</dd>
          <dt>Validity</dt><dd>${e.validity_months_at_signing == null ? 'does not lapse' : `${e.validity_months_at_signing} months, until ${esc(e.valid_until)}`}</dd>
          <dt>Text fingerprint</dt><dd>${esc(e.stored_body_hash)} — <strong>${esc(e.hash_verdict)}</strong></dd>
          ${e.revoked_reason ? `<dt>Revocation reason</dt><dd>${esc(e.revoked_reason)}</dd>` : ''}
        </dl>
        ${
          e.hash_verdict === 'mismatch'
            ? `<p class="warn">The stored fingerprint does not match the stored text for this version. The signature and its instant are unaffected; the text shown may have been altered after signing. Run <code>verify-waiver-ledger</code> and consult the version's published_at and published_by_name.</p>`
            : ''
        }
        ${
          e.hash_verdict === 'version_missing'
            ? `<p class="warn">The version this signature names could not be read, so the text below is absent. Run <code>verify-waiver-ledger</code>.</p>`
            : ''
        }
        ${e.bodyHtml ? `<div class="doc">${e.bodyHtml}</div>` : ''}
      </section>`
      )
      .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Consent history — ${esc(name)}</title>
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#111}
 h1,h2,h3,h4{line-height:1.25} h1{font-size:1.5rem} h2{font-size:1.15rem;border-bottom:1px solid #ddd;padding-bottom:.25rem;margin-top:2rem}
 dl{display:grid;grid-template-columns:12rem 1fr;gap:.25rem 1rem;margin:.5rem 0}
 dt{font-weight:600;color:#555} dd{margin:0}
 .event{border:1px solid #ddd;border-radius:.5rem;padding:1rem;margin:1rem 0}
 .doc{border-top:1px solid #eee;margin-top:1rem;padding-top:1rem}
 .warn{background:#fff4e5;border:1px solid #f0c36d;border-radius:.375rem;padding:.75rem}
 .note{background:#f6f6f6;border-radius:.375rem;padding:1rem}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}
</style></head><body>
<h1>Consent history — ${esc(name)}</h1>
<p>${esc(p.team.name)} · contact <code>${esc(p.contact.id)}</code>${p.contact.email ? ` · ${esc(p.contact.email)}` : ''}<br>
Exported ${esc(p.generated_at)}${p.generated_by ? ` by ${esc(p.generated_by)}` : ''}.</p>

<div class="note">
<p><strong>What these records assert, and what they do not.</strong> Each entry records that at the stated instant a browser at the stated address, reading the stated language rendering of the text whose fingerprint is given, submitted a tick. It does <em>not</em> establish that the person named is the person who ticked; <code>signer_email_verified_by</code> is the whole strength axis, and only <code>emailed_link</code> and <code>verified_code</code> demonstrate control of that specific mailbox.</p>
<p>A tick in a checkbox is the lightest signature this system could have chosen, taken deliberately for the lowest cost on the path to a booking. A <em>silent</em> publish below means the wording changed and nobody was told; a signature that predates one is a tick against text that no longer exists. Images referenced by a document are not covered by its version's immutability. Where a signer is recorded as a parent or guardian, that is a <strong>self-declaration made on the consent step</strong>: nothing verified the relationship and no evidence of it was collected. None of this is legal advice.</p>
${p.scope === 'operator' ? `<p><strong>An email address is not a person.</strong> The final section lists records held <em>by this studio</em> under the same email address but a different contact record. They may belong to somebody else in the same household. They are listed separately and are never merged into this person's history, and records held by any other studio are not included.</p>` : ''}
</div>

${p.documents
  .map(
    (block) => `
<h2>${esc(block.title)} <small>(${esc(block.kind)})</small></h2>
<p>Current state for this person: <strong>${esc(block.current_state)}</strong>.</p>
<h3>Versions</h3>
<table><tr><th>Version</th><th>Published</th><th>By</th><th>Outcome</th><th>Note</th></tr>
${block.versions
  .map(
    (v) =>
      `<tr><td>${v.version}</td><td>${esc(v.published_at)}</td><td>${esc(v.published_by_name)}</td><td>${esc(v.publish_outcome)}</td><td>${
        v.backfilled_at
          ? 'Snapshot taken retroactively — the text was captured after it was first published.'
          : v.publish_outcome === 'silent'
            ? 'Nobody was told the text changed.'
            : ''
      }</td></tr>`
  )
  .join('')}
</table>
<h3>Events</h3>
${rows(block)}
${
  block.notices.length
    ? `<h3>Notices</h3><table><tr><th>Version</th><th>Attempt</th><th>State</th><th>Sent</th></tr>${block.notices
        .map(
          (n) =>
            `<tr><td>${n.version}</td><td>${n.attempt}</td><td>${esc(n.state)}</td><td>${esc(n.sent_at)}</td></tr>`
        )
        .join('')}</table>`
    : ''
}`
  )
  .join('')}

${
  p.scope === 'operator'
    ? `<h2>Other records for this email address</h2>
<p>These are <strong>not</strong> part of ${esc(name)}'s history. They were found at this studio under the same email address and a different contact record — which a shared family mailbox produces routinely. Records held by other studios are outside this export.</p>
${
  p.other_records_for_this_email.length === 0
    ? '<p>None.</p>'
    : `<table><tr><th>Document</th><th>Version</th><th>When</th><th>Signer</th><th>Role</th><th>About</th><th>Contact</th></tr>${p.other_records_for_this_email
        .map(
          (e) =>
            `<tr><td>${esc(e.documentTitle)}</td><td>${e.version}</td><td>${esc(e.accepted_at)}</td><td>${esc(e.signer_name)}</td><td>${esc(e.signer_role)}</td><td>${esc(e.subject_name)}</td><td><code>${esc(e.contactId)}</code></td></tr>`
        )
        .join('')}</table>`
}`
    : ''
}
${p.truncated ? `<p class="warn">This export reached its row limit and may be incomplete.</p>` : ''}
</body></html>`
}
