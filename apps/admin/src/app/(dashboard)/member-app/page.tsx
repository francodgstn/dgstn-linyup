import Link from 'next/link'
import { ExternalLink, Apple, Smartphone, Info } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDate, formatDateTime } from '@/lib/format'
import { requireOperator } from '@/lib/require-operator'
import {
  getMobileAdoption,
  getStorePresence,
  getStoreReviews,
  type StorePresenceView,
  type StoreReviewView,
} from '@/lib/queries/storePresence'
import { PROVIDERS } from '@/lib/providers'
import { SourceHealthList } from './source-health'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Member app · Linyup Ops' }

const panelUrl = (id: string) => PROVIDERS.find((p) => p.id === id)?.panelUrl ?? '#'

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

function StoreCard({
  view,
  title,
  icon: Icon,
  providerId,
}: {
  view: StorePresenceView
  title: string
  icon: typeof Apple
  providerId: string
}) {
  const { listing, release, testing, vitals } = view

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>
          {view.appId ?? 'No app id configured'}
          {view.updatedMs ? ` · refreshed ${formatDateTime(view.updatedMs)}` : ' · never refreshed'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Listing — iOS only. Android has no block at all, deliberately:
            Google publishes no public lookup API, and the alternative is
            scraping the store page. Showing the asymmetry beats faking it. */}
        {listing ? (
          listing.live ? (
            <div className="flex flex-col divide-y">
              <Field label="On the store" value={<Badge variant="success">Live</Badge>} />
              <Field label="Version" value={listing.version ?? '—'} />
              <Field
                label="Rating"
                value={
                  listing.average_rating != null
                    ? `${listing.average_rating.toFixed(2)} · ${listing.rating_count ?? 0} ratings`
                    : '—'
                }
              />
              <Field
                label="Released"
                value={listing.released_at ? formatDate(Date.parse(listing.released_at)) : '—'}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Not on the App Store yet.</span> The
              public lookup for storefront <span className="font-mono">{listing.country}</span>{' '}
              returns nothing — which is the correct answer today, not a failure. Ratings, reviews
              and install figures stay empty until the day this flips.
            </div>
          )
        ) : null}

        {release && (
          <div className="flex flex-col divide-y">
            <Field
              label="Release state"
              value={<span className="font-mono text-xs">{release.state}</span>}
            />
            {release.version && <Field label="Version" value={release.version} />}
            {release.submission_state && (
              <Field
                label="Submission"
                value={<span className="font-mono text-xs">{release.submission_state}</span>}
              />
            )}
          </div>
        )}

        {testing?.builds?.length ? (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">
              {testing.track === 'testflight' ? 'TestFlight builds' : 'Testing'}
            </div>
            <ul className="flex flex-col divide-y text-sm">
              {testing.builds.slice(0, 5).map((b) => (
                <li key={`${b.version}-${b.build}`} className="flex justify-between gap-3 py-1">
                  <span className="font-mono text-xs">
                    {b.version ? `${b.version} (${b.build})` : b.build}
                  </span>
                  <span className="text-xs text-muted-foreground">{b.state}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {vitals && (
          <div className="flex flex-col divide-y">
            {/* null, not 0 — an app with no users produces an unknown crash
                rate, and "0%" would be a claim nobody can support. */}
            <Field
              label="Crash rate"
              value={vitals.crash_rate != null ? `${(vitals.crash_rate * 100).toFixed(2)}%` : '—'}
            />
            <Field
              label="ANR rate"
              value={vitals.anr_rate != null ? `${(vitals.anr_rate * 100).toFixed(2)}%` : '—'}
            />
            {vitals.anomalies?.length ? (
              <div className="py-2">
                <div className="mb-1 text-xs font-semibold text-[var(--warning)]">
                  {vitals.anomalies.length} anomal{vitals.anomalies.length === 1 ? 'y' : 'ies'}
                </div>
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {vitals.anomalies.slice(0, 5).map((a, i) => (
                    <li key={`${a.metric}-${i}`}>
                      <span className="font-mono">{a.metric}</span> ·{' '}
                      {formatDate(Date.parse(a.detected_at))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        <div>
          <div className="mb-1 text-xs font-semibold text-muted-foreground">Sources</div>
          <SourceHealthList sources={view.sources} />
        </div>

        <a
          href={panelUrl(providerId)}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-fit')}
        >
          <ExternalLink />
          Open {title}
        </a>
      </CardContent>
    </Card>
  )
}

function ReviewList({ reviews }: { reviews: StoreReviewView[] }) {
  if (reviews.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing yet. App Store reviews and TestFlight feedback both land here once the ingest has a
        credential — pre-launch, tester feedback is the whole stream.
      </p>
    )
  }

  return (
    <ul className="flex flex-col divide-y">
      {reviews.map((r) => (
        <li key={r.id} className="flex flex-col gap-1 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{r.platform === 'ios' ? 'iOS' : 'Android'}</Badge>
            {r.kind === 'beta_feedback' && <Badge variant="secondary">Tester feedback</Badge>}
            {r.rating != null && <span>{'★'.repeat(r.rating)}</span>}
            <span>{formatDate(r.submittedMs)}</span>
            {r.appVersion && <span className="font-mono">{r.appVersion}</span>}
          </div>
          {r.title && <div className="text-sm font-medium">{r.title}</div>}
          {r.body && <p className="text-sm whitespace-pre-wrap">{r.body}</p>}
          <div className="text-xs text-muted-foreground">
            {r.author ?? 'Anonymous'}
            {r.locale ? ` · ${r.locale}` : ''}
            {r.device ? ` · ${r.device}` : ''}
          </div>
          {r.responseBody && (
            <div className="mt-1 rounded-md bg-muted p-2 text-xs">
              <span className="font-medium">Replied in the portal:</span> {r.responseBody}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

export default async function MemberAppPage() {
  const [presence, reviews, adoption] = await Promise.all([
    getStorePresence(),
    getStoreReviews(),
    getMobileAdoption(),
    requireOperator(),
  ])

  const versionRows = adoption
    ? Object.entries(adoption.metrics.by_version).sort((a, b) => b[1] - a[1])
    : []

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Member app</h1>
        <p className="text-sm text-muted-foreground">
          What the two stores say about the app, plus what our own telemetry says about what is
          actually running.{' '}
          <Link href="/settings/mobile" className="underline underline-offset-2">
            Settings → Member app
          </Link>{' '}
          is where the min-version gate and store URLs are configured.
        </p>
      </div>

      {/* The single most important thing on this page, because without it every
          empty panel below reads as a broken integration. */}
      <Card className="border-dashed">
        <CardContent className="flex gap-3 pt-6 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">
              Two things neither store exposes through an API.
            </span>{' '}
            App Review&apos;s rejection message and Resolution Center thread, and Google
            Play&apos;s policy status and Console inbox. This page can tell you within seconds
            that a version was <span className="font-mono text-xs">REJECTED</span>; it cannot tell
            you why. For those, open the portal.
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <StoreCard
          view={presence.ios}
          title="App Store"
          icon={Apple}
          providerId="apple-app-store"
        />
        <StoreCard
          view={presence.android}
          title="Google Play"
          icon={Smartphone}
          providerId="google-play"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Adoption</CardTitle>
          <CardDescription>
            From our own <code className="font-mono text-xs">Contact.mobile_app</code> telemetry,
            not from either store — so it works before the app is published, and it answers the
            question a store dashboard cannot: what people are actually <em>running</em>.
            {adoption ? ` Snapshot of ${adoption.date}.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!adoption ? (
            <p className="text-sm text-muted-foreground">
              No snapshot carries a mobile block yet. The daily capture writes one at 00:15
              Europe/Zurich; a day whose aggregation fails omits the block rather than storing a
              zero.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-2xl font-semibold">{adoption.metrics.installs_seen}</div>
                  <div className="text-xs text-muted-foreground">Ever opened the app</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{adoption.metrics.active_30d}</div>
                  <div className="text-xs text-muted-foreground">Active in 30 days</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{adoption.metrics.embedded}</div>
                  <div className="text-xs text-muted-foreground">On the embedded build</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{versionRows.length}</div>
                  <div className="text-xs text-muted-foreground">Distinct versions</div>
                </div>
              </div>

              {versionRows.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">By version</div>
                  <ul className="flex flex-col divide-y text-sm">
                    {versionRows.slice(0, 8).map(([version, count]) => (
                      <li key={version} className="flex justify-between py-1">
                        <span className="font-mono text-xs">{version}</span>
                        <span>{count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reviews &amp; tester feedback</CardTitle>
          <CardDescription>
            App Store reviews, Play reviews and TestFlight feedback in one list. Note Play only
            exposes the last <span className="font-medium">seven days</span> of reviews — a poll
            that breaks for longer loses them from the API permanently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReviewList reviews={reviews} />
        </CardContent>
      </Card>
    </div>
  )
}
