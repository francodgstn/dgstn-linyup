import 'server-only'
import { adminDb } from '@/lib/firebase-admin'

// Status for the demo-tenant settings page. READ-ONLY and server-side, like
// every other query here — the mutations are callables (see the page's card),
// because they run for minutes and write across a whole tenant.

const DEMO_TEAM_ID = 'linyup-demo'
const REVIEW_ACCESS_DOC = 'review_access'

export interface DemoTenantStatus {
  provisioned: boolean
  teamId: string
  name: string | null
  slug: string | null
  /** Should be true. If it is not, the tenant is polluting platform metrics. */
  internal: boolean
  /** Should be 'silent'. Anything else means it can send mail from production. */
  messagingMode: string | null
  /** Should be false. A demo tenant with a payment account can take real money. */
  hasConnectAccount: boolean
  contacts: number
  sessions: number
}

export interface ReviewAccessStatus {
  configured: boolean
  enabled: boolean
  /** The legacy single address — still the reviewer's, and still written. */
  email: string | null
  /** EVERY address this one code opens. The console showed only `email` while
   *  the document grew a list (closed-test testers get one each), so an operator
   *  read the blast radius of a live auth bypass as one account when it was
   *  twenty-one. */
  addresses: string[]
  /** Every contact of the demo tenant, as {email, name} — the menu an operator
   *  picks from. The server refuses an address that is not on this list, so
   *  offering anything else would only produce a rejected save. */
  candidates: Array<{ email: string; name: string }>
  expiresMs: number | null
  expired: boolean
  note: string | null
  updatedBy: string | null
}

export async function getDemoTenantStatus(): Promise<DemoTenantStatus> {
  const db = adminDb
  const team = await db.collection('teams').doc(DEMO_TEAM_ID).get()
  if (!team.exists) {
    return {
      provisioned: false,
      teamId: DEMO_TEAM_ID,
      name: null,
      slug: null,
      internal: false,
      messagingMode: null,
      hasConnectAccount: false,
      contacts: 0,
      sessions: 0,
    }
  }
  const t = team.data() as Record<string, unknown>
  const [policy, contacts, sessions] = await Promise.all([
    db.collection('messaging_policies').doc(DEMO_TEAM_ID).get(),
    db.collection('contacts').where('teamId', '==', DEMO_TEAM_ID).count().get(),
    db.collection('sessions').where('teamId', '==', DEMO_TEAM_ID).count().get(),
  ])
  const payments = (t.payments ?? null) as { connectAccountId?: string } | null
  return {
    provisioned: true,
    teamId: DEMO_TEAM_ID,
    name: (t.name as string) ?? null,
    slug: (t.slug as string) ?? null,
    internal: (t.flags as { internal?: boolean } | undefined)?.internal === true,
    messagingMode: (policy.data()?.mode as string) ?? null,
    hasConnectAccount: !!payments?.connectAccountId,
    contacts: contacts.data().count,
    sessions: sessions.data().count,
  }
}

export async function getReviewAccessStatus(): Promise<ReviewAccessStatus> {
  const [snap, contacts] = await Promise.all([
    adminDb.collection('app_settings').doc(REVIEW_ACCESS_DOC).get(),
    adminDb.collection('contacts').where('teamId', '==', DEMO_TEAM_ID).get(),
  ])
  const candidates = contacts.docs
    .map((d) => {
      const c = d.data()
      return {
        email: ((c.email as string) ?? '').toLowerCase().trim(),
        name: [c.firstname, c.lastname].filter(Boolean).join(' ') || d.id,
      }
    })
    .filter((c) => !!c.email)
    .sort((a, b) => a.email.localeCompare(b.email))
  if (!snap.exists) {
    return {
      configured: false,
      enabled: false,
      email: null,
      addresses: [],
      candidates: [],
      expiresMs: null,
      expired: true,
      note: null,
      updatedBy: null,
    }
  }
  const d = snap.data() as Record<string, unknown>
  const expiresMs =
    (d.expires_at as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null
  return {
    configured: true,
    enabled: d.enabled === true,
    email: (d.email as string) ?? null,
    // Same union the server does (`reviewAccessAddresses`): legacy + list,
    // normalized and de-duplicated, so the count here is the count that logs in.
    addresses: [
      ...new Set(
        [d.email, ...(Array.isArray(d.emails) ? d.emails : [])]
          .filter((e): e is string => typeof e === 'string')
          .map((e) => e.toLowerCase().trim())
          .filter(Boolean)
      ),
    ],
    expiresMs,
    expired: typeof expiresMs === 'number' ? expiresMs <= Date.now() : true,
    note: (d.note as string) ?? null,
    updatedBy: (d.updated_by as string) ?? null,
    candidates,
    // The CODE is deliberately not read back — see getReviewAccess in
    // packages/functions/src/ops/index.ts.
  }
}
