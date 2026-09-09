import 'server-only'
import type { PlatformMetricsDoc } from '@linyup/shared'
import { PLATFORM_METRICS_COLLECTION } from '@linyup/shared'
import { adminDb } from '@/lib/firebase-admin'

export interface MetricsPoint {
  date: string
  totalAccounts: number
  activeAccounts: number
  mrr: number
  contacts: number
  trials: number
  /**
   * Addresses mailed on the day BEFORE `date` (see PlatformMailMetrics). null on
   * every snapshot with no mail block — a zero there would draw a flat line
   * through history that never happened.
   *
   * Null on every snapshot taken before `capturePlatformMetrics` started
   * writing the block. The overview's platform mail KPIs do not depend on this
   * — they are aggregated live in `./messaging`.
   */
  emailsSent: number | null
}

// Reads the daily platform_metrics snapshots (written by capturePlatformMetrics)
// for the last `days`, oldest-first — ready to plot.
export async function getMetricsHistory(days: number): Promise<MetricsPoint[]> {
  const snap = await adminDb
    .collection(PLATFORM_METRICS_COLLECTION)
    .orderBy('date', 'desc')
    .limit(days)
    .get()

  const points = snap.docs.map((d) => {
    const m = d.data() as PlatformMetricsDoc
    return {
      date: m.date,
      totalAccounts: m.accounts?.total ?? 0,
      activeAccounts: m.accounts?.by_status?.active ?? 0,
      mrr: m.mrr?.estimated_chf ?? 0,
      contacts: m.contacts?.total_active ?? 0,
      trials: m.trials?.active ?? 0,
      emailsSent: m.mail?.sent_yesterday ?? null,
    } satisfies MetricsPoint
  })

  return points.reverse()
}
