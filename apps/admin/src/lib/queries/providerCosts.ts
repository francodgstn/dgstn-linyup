import 'server-only'
import type {
  BrevoCreditSnapshot,
  DeeplUsageSnapshot,
  GcpCostSnapshot,
  PlatformMetricsDoc,
} from '@linyup/shared'
import { PLATFORM_METRICS_COLLECTION } from '@linyup/shared'
import { adminDb } from '@/lib/firebase-admin'

/**
 * PROVIDER COST / USAGE for the Providers page.
 *
 * ── WHY IT LOOKS BACK A FEW DAYS INSTEAD OF READING TODAY ───────────────────
 * Each provider block is written independently and any of them can be missing
 * from a given day: Google's arrives by Pub/Sub whenever the budget evaluates,
 * Brevo's and DeepL's are fetched by the 00:15 capture and omitted when the
 * vendor call fails or the key is unset. Reading only today's doc would
 * therefore show "not measured" for a provider that answered perfectly well
 * yesterday, which is a worse answer than a figure with its age on it.
 *
 * So this takes the most recent block PER PROVIDER from the last few snapshots
 * and hands the age to the UI. A few document reads, once per page view.
 *
 * ── AND WHY IT NEVER SUBSTITUTES A ZERO ─────────────────────────────────────
 * Every field is null when no block was found. The page renders that as "not
 * measured" and says why it might be — a cost screen exists to be believed, so
 * a confident zero from a failed vendor call is the one output worth avoiding
 * more than a blank. See `PlatformProviderCosts` in @linyup/shared.
 */

/** How many daily snapshots back to look for a provider's most recent block. */
const LOOKBACK_DAYS = 7

export interface ProviderCosts {
  gcp: GcpCostSnapshot | null
  brevo: BrevoCreditSnapshot | null
  deepl: DeeplUsageSnapshot | null
  /** The snapshot date each block came from, for "as of" display. */
  from: { gcp: string | null; brevo: string | null; deepl: string | null }
}

const EMPTY: ProviderCosts = {
  gcp: null,
  brevo: null,
  deepl: null,
  from: { gcp: null, brevo: null, deepl: null },
}

export async function getProviderCosts(): Promise<ProviderCosts> {
  let snap
  try {
    snap = await adminDb
      .collection(PLATFORM_METRICS_COLLECTION)
      .orderBy('date', 'desc')
      .limit(LOOKBACK_DAYS)
      .get()
  } catch {
    // A failed read is indistinguishable to the reader from "nothing recorded",
    // and both render the same honest way — so there is nothing to add by
    // throwing and blanking the whole page.
    return EMPTY
  }

  const out: ProviderCosts = { ...EMPTY, from: { ...EMPTY.from } }

  // Newest first, so the FIRST block seen for a provider is its latest.
  for (const doc of snap.docs) {
    const m = doc.data() as PlatformMetricsDoc
    const p = m.providers
    if (!p) continue
    if (!out.gcp && p.gcp) {
      out.gcp = p.gcp
      out.from.gcp = m.date
    }
    if (!out.brevo && p.brevo) {
      out.brevo = p.brevo
      out.from.brevo = m.date
    }
    if (!out.deepl && p.deepl) {
      out.deepl = p.deepl
      out.from.deepl = m.date
    }
  }

  return out
}
