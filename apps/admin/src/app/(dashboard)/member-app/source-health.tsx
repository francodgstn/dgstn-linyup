import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/format'
import type { SourceRow } from '@/lib/queries/storePresence'
import type { StoreSourceStatus } from '@linyup/shared'

// ── THE POINT OF THIS COMPONENT ────────────────────────────────────────────
// The member app is pre-launch, so nearly every panel on this page is empty.
// An empty panel looks exactly like a broken integration, and an operator who
// learns to ignore one grey card will ignore the one that matters later.
//
// So the four states never collapse into "no data":
//   ok              we asked and got an answer
//   not_configured  no credential — the EXPECTED state today, not a fault
//   unavailable     the vendor said "nothing yet" — also not a fault
//   error           it went wrong, and `error` says how

const LABELS: Record<StoreSourceStatus, string> = {
  ok: 'OK',
  not_configured: 'Not configured',
  unavailable: 'No data yet',
  error: 'Failed',
}

const VARIANTS: Record<StoreSourceStatus, 'success' | 'secondary' | 'outline' | 'destructive'> = {
  ok: 'success',
  // Grey, deliberately — a missing credential is a to-do, not an incident.
  not_configured: 'secondary',
  unavailable: 'outline',
  error: 'destructive',
}

const SOURCE_NAMES: Record<string, string> = {
  itunes: 'Public listing (iTunes lookup)',
  asc_versions: 'App Store versions & submissions',
  asc_reviews: 'App Store reviews',
  asc_testflight: 'TestFlight builds & feedback',
  asc_sales: 'Daily sales reports',
  asc_vitals: 'Power & performance metrics',
  play_reviews: 'Play reviews (last 7 days)',
  play_reporting: 'Android vitals & anomalies',
  play_gcs: 'Play bulk reports',
}

export function StatusBadge({ status }: { status: StoreSourceStatus }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>
}

export function SourceHealthList({ sources }: { sources: SourceRow[] }) {
  if (sources.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        The ingest has not run for this store yet.
      </p>
    )
  }

  return (
    <ul className="flex flex-col divide-y text-xs">
      {sources.map((s) => (
        <li key={s.id} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="font-medium">{SOURCE_NAMES[s.id] ?? s.id}</div>
            {s.error && <div className="mt-0.5 text-destructive">{s.error}</div>}
            <div className="mt-0.5 text-muted-foreground">
              {/* Two clocks, both shown. "When we last reached the vendor" and
                  "what the vendor has data through" are different questions, and
                  a single timestamp answering both puts a fresh-looking stamp
                  over stale numbers. */}
              {s.lastOkMs
                ? `Last success ${formatDateTime(s.lastOkMs)}`
                : 'Never succeeded'}
              {s.lastAttemptMs ? ` · checked ${formatDateTime(s.lastAttemptMs)}` : ''}
            </div>
          </div>
          <StatusBadge status={s.status} />
        </li>
      ))}
    </ul>
  )
}
