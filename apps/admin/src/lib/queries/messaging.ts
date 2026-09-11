import 'server-only'
import { AggregateField, FieldPath, Timestamp, type Query } from 'firebase-admin/firestore'
import {
  MESSAGING_POLICIES_COLLECTION,
  MAIL_SENDS_COLLECTION,
  APP_SETTINGS_COLLECTION,
  type MessagingPolicy,
  LEDGER_RETENTION_DAYS,
  PLATFORM_METRICS_COLLECTION,
} from '@linyup/shared'
import { adminDb } from '@/lib/firebase-admin'

// Operator view of a tenant's outbound-messaging state: the (operator-only)
// delivery policy + the tenant's recent mail_sends ledger entries, including
// 'suppressed' ones — so "why didn't X get that email?" is answerable at a
// glance. See packages/functions/src/mail/README.md → "Per-tenant delivery policy".

export interface MailSendRow {
  id: string
  status: string
  suppressReason: string | null
  stream: string
  channel: string // 'email' | 'sms'
  updatedMs: number | null
}

// The policy handed to the (client) card — plain JSON only: Firestore Timestamps
// can't cross the server→client component boundary.
export type SerializablePolicy = Omit<MessagingPolicy, 'updated_at' | 'updated_by'>

// The functions deployment's messaging ENV params (kill switches, TEST_MODE,
// default mode), published hourly by the functions runtime to
// app_settings/messaging_env — see packages/functions/src/mail/messagingEnvStatus.ts.
// null = never published (functions not deployed / first hour after rollout).
export interface MessagingEnvStatus {
  mailEnabled: boolean
  smsEnabled: boolean
  testMode: boolean
  testEmail: string | null
  defaultMode: string
  updatedMs: number | null
}

// ── Volume ──────────────────────────────────────────────────────────────────
// Aggregated straight off the ledger. No stored counter: nothing here is
// write-contended, and an aggregation cannot drift out of sync with the rows it
// reads. See packages/functions/src/mail/mailMetrics.ts.
//
// A ROW IS A PROVIDER CALL, NOT AN EMAIL — one call may carry several addresses.
// So the "sent" figures SUM `recipient_count` (the addresses, which is what an
// operator reads "Emails" to mean) while the suppressed figure COUNTS rows: a
// suppressed send reached nobody and carries `recipient_count: 0`.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Why every volume figure needs a caveat next to it: the ledger only became a
 * complete send log in the 2026-08 mail change. Before that a row was written
 * only when the call site passed an idempotency key — a minority of sends — and
 * those older rows carry no `channel`, so they are not counted here at all.
 * There is no backfill because the sends were never recorded.
 */
export const MAIL_LEDGER_NOTE =
  `Counts sends recorded since the ledger became complete (2026-08); earlier sends were only recorded when the call site passed an idempotency key. Ledger rows age out after ${LEDGER_RETENTION_DAYS.mail_sends} days, so a studio's figures cover that window; the platform total is carried forward nightly.`

const RETENTION_MS = LEDGER_RETENTION_DAYS.mail_sends * 86_400_000

export interface MailVolume {
  /** Addresses handed to the provider in the last 30 days. */
  last30d: number
  /** Of the last 30 days, how many SENDS were dropped before the provider. */
  suppressed30d: number
  /** Every address this tenant has mailed within the ledger's retention window
   *  (`LEDGER_RETENTION_DAYS.mail_sends`) — the ledger holds no more than that,
   *  and no per-tenant running total is kept (see mail/mailMetrics.ts for why). */
  retained: number
}

export interface MessagingVolume {
  /** null when an aggregation failed (typically a missing index). */
  email: MailVolume | null
  /** SMS is a SEPARATE figure — it costs prepaid credits, mail does not. */
  smsLast30d: number | null
}

// null (not 0) on failure — a missing index must render as "—", never as a
// confident zero. The error is LOGGED rather than swallowed: a FAILED_PRECONDITION
// carries the index-creation URL, and without it an operator sees "—" with no
// trace anywhere of why. Mirrors countOrNull in
// packages/functions/src/mail/mailMetrics.ts.
async function countOrNull(query: Query): Promise<number | null> {
  try {
    return (await query.count().get()).data().count
  } catch (err) {
    console.warn('[messaging] mail count failed:', err)
    return null
  }
}

// Addresses, not rows — see the section header. Same posture and the same
// indexes: an aggregation is served by the index the equivalent query uses.
async function sumRecipientsOrNull(query: Query): Promise<number | null> {
  try {
    const snap = await query.aggregate({ recipients: AggregateField.sum('recipient_count') }).get()
    return snap.data().recipients
  } catch (err) {
    console.warn('[messaging] mail recipient sum failed:', err)
    return null
  }
}

export interface MessagingInfo {
  policy: SerializablePolicy | null
  recentSends: MailSendRow[]
  volume: MessagingVolume
  env: MessagingEnvStatus | null
}

export async function getMessagingInfo(entityId: string): Promise<MessagingInfo> {
  const tenant = adminDb.collection(MAIL_SENDS_COLLECTION).where('team_id', '==', entityId)
  const email = tenant.where('channel', '==', 'email')
  const cut = Timestamp.fromMillis(Date.now() - THIRTY_DAYS_MS)
  const email30d = email.where('created_at', '>=', cut)
  // The retention window, explicitly — so the figure is what its label says
  // even before the TTL policy has aged the older rows out.
  const emailRetained = email.where('created_at', '>=', Timestamp.fromMillis(Date.now() - RETENTION_MS))

  const [policySnap, sendsSnap, envSnap, emailRetainedSent, email30dSent, email30dSuppressed, smsLast30d] =
    await Promise.all([
      adminDb.collection(MESSAGING_POLICIES_COLLECTION).doc(entityId).get(),
      tenant
        .orderBy('updated_at', 'desc')
        .limit(20)
        .get()
        // Ledger reads are best-effort — a missing index must not 500 the page.
        .catch(() => null),
      adminDb.collection(APP_SETTINGS_COLLECTION).doc('messaging_env').get().catch(() => null),
      // The sums need no `status != 'suppressed'` filter — a suppressed row
      // carries `recipient_count: 0`. Which is just as well: an inequality drops
      // documents where the field is absent, and it cannot be combined with the
      // `created_at` range anyway.
      sumRecipientsOrNull(emailRetained),
      sumRecipientsOrNull(email30d),
      countOrNull(email30d.where('status', '==', 'suppressed')),
      sumRecipientsOrNull(tenant.where('channel', '==', 'sms').where('created_at', '>=', cut)),
    ])

  let policy: SerializablePolicy | null = null
  if (policySnap.exists) {
    const d = policySnap.data() as MessagingPolicy
    policy = {
      entityId: d.entityId ?? entityId,
      mode: d.mode,
      ...(d.allowEmails ? { allowEmails: d.allowEmails } : {}),
      ...(d.allowPhones ? { allowPhones: d.allowPhones } : {}),
      ...(d.redirectEmail ? { redirectEmail: d.redirectEmail } : {}),
      ...(d.redirectPhone ? { redirectPhone: d.redirectPhone } : {}),
      ...(d.ignoreTestMode ? { ignoreTestMode: true } : {}),
      ...(d.note ? { note: d.note } : {}),
    }
  }
  const recentSends: MailSendRow[] = (sendsSnap?.docs ?? []).map((d) => {
    const data = d.data()
    return {
      id: d.id,
      status: (data.status as string) ?? '—',
      suppressReason: (data.suppress_reason as string) ?? null,
      stream: (data.stream as string) ?? '—',
      channel: (data.channel as string) ?? 'email',
      updatedMs: data.updated_at?.toMillis?.() ?? null,
    }
  })

  let env: MessagingEnvStatus | null = null
  if (envSnap?.exists) {
    const d = envSnap.data()!
    env = {
      mailEnabled: d.mail_enabled !== false,
      smsEnabled: d.sms_enabled === true,
      testMode: d.test_mode === true,
      testEmail: (d.test_email as string) ?? null,
      defaultMode: (d.default_mode as string) ?? 'live',
      updatedMs: d.updated_at?.toMillis?.() ?? null,
    }
  }

  const volume: MessagingVolume = {
    email:
      emailRetainedSent != null && email30dSent != null && email30dSuppressed != null
        ? {
            last30d: email30dSent,
            suppressed30d: email30dSuppressed,
            retained: emailRetainedSent,
          }
        : null,
    smsLast30d,
  }

  return { policy, recentSends, volume, env }
}

// ── Platform total ──────────────────────────────────────────────────────────
// The same aggregations without the tenant filter, so they include Linyup's own
// system mail (which carries no team_id and is therefore attributable to no
// studio). Computed live rather than read off a snapshot: an aggregation over an
// index is cheap at any volume this product will see, and it is right the
// moment the page loads instead of the morning after.

export interface PlatformMailVolume {
  /** Addresses mailed in the last 30 days. null when the aggregation failed. */
  last30d: number | null
  /** Addresses mailed since the ledger became complete — the running total the
   *  nightly snapshot carries forward (`PlatformMailMetrics.sent_cumulative`),
   *  NOT a sum over the ledger, which ages out. As of the latest snapshot;
   *  null when no snapshot carries one yet. */
  lifetime: number | null
}

/** How many nightly snapshots back to look for a carried-forward total. */
const CUMULATIVE_LOOKBACK = 40

async function latestCumulativeOrNull(): Promise<number | null> {
  try {
    const snap = await adminDb
      .collection(PLATFORM_METRICS_COLLECTION)
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(CUMULATIVE_LOOKBACK)
      .get()
    for (const doc of snap.docs) {
      const value = doc.get('mail.sent_cumulative') as unknown
      if (typeof value === 'number') return value
    }
    return null
  } catch (err) {
    console.warn('[messaging] snapshot read failed:', err)
    return null
  }
}

export async function getPlatformMailVolume(): Promise<PlatformMailVolume> {
  const email = adminDb.collection(MAIL_SENDS_COLLECTION).where('channel', '==', 'email')
  const email30d = email.where('created_at', '>=', Timestamp.fromMillis(Date.now() - THIRTY_DAYS_MS))

  const [lifetime, last30d] = await Promise.all([
    latestCumulativeOrNull(),
    sumRecipientsOrNull(email30d),
  ])

  return { last30d, lifetime }
}
