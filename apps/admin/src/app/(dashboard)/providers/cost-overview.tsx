import type { ReactNode } from 'react'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import type {
  BrevoCreditSnapshot,
  BrevoPlanLine,
  DeeplUsageSnapshot,
  GcpCostSnapshot,
  StripeCostSnapshot,
} from '@linyup/shared'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'
import type { Provider } from '@/lib/providers'
import type { ProviderCosts } from '@/lib/queries/providerCosts'
import { cn } from '@/lib/utils'

/**
 * SPEND & USAGE — every figure a vendor will give us, in one place and one shape.
 *
 * ── UNIFIED IN SHAPE, NEVER IN NUMBER ───────────────────────────────────────
 * Every metered vendor gets the same card, read top to bottom the same way:
 * what KIND of number it is, the headline figure in the vendor's own unit, a
 * meter wherever the vendor reports a cap, any further figures from that
 * vendor, then the period and the moment it was measured. What is deliberately
 * NOT unified is the number itself: money month to date, money for a completed
 * month, credits left and characters used are different kinds of figure, and a
 * total across them would invent precision (`PlatformProviderCosts` in
 * @linyup/shared). The kind chip is there so two cards side by side cannot be
 * read as one unit.
 *
 * ── NEVER A CONFIDENT WRONG NUMBER ──────────────────────────────────────────
 * A block that could not be measured says "Not measured", and why, in the slot
 * its figure would have filled — never 0 because a vendor call failed. Vendors
 * with no feed at all are listed beneath the cards with their reason, so the
 * section has no unexplained blank either.
 */

type CostFeed = NonNullable<Provider['costFeed']>

/** One figure, or the honest absence of one. */
interface Figure {
  /** Formatted, in the vendor's unit. Null means NOT MEASURED — never zero. */
  value: string | null
  unit?: string
  /** What the number is — or, when `value` is null, why there is none. */
  caption: ReactNode
  /** What makes the figure partial. Always shown, never folded away. */
  warnings?: string[]
}

interface CostCardModel {
  /** Which kind of number this card holds, so no two cards read as one unit. */
  kind: string
  headline: Figure
  /** Only where the vendor itself reports a cap to measure against. */
  meter?: { used: number; cap: number; of: string }
  /** Further figures from the same vendor — beneath the headline, never summed into it. */
  more?: Figure[]
  /** The period the figures cover, in words. */
  period?: string
  /** When the vendor was asked — not the snapshot's date, which is `recordedOn`. */
  measuredAtMs?: number
  recordedOn?: string | null
}

const LOCALE = 'en-CH'

/** The captures run daily at 00:15 and Google's notification arrives several
 *  times a day, so a reading older than a day plus slack means a run was missed. */
const STALE_AFTER_MS = 26 * 3_600_000

/** Money in major units, to the Rappen — and never rounded to zero: a small real
 *  fee is not the same statement as no fee, and this page exists to be believed. */
function money(major: number): string {
  if (major !== 0 && Math.abs(major) < 0.01) return '< 0.01'
  return major.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function count(n: number): string {
  return n.toLocaleString(LOCALE)
}

/** Same rule as `money`: real usage never reads as 0%. */
function percent(used: number, cap: number): string {
  const pct = (used / cap) * 100
  return used > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

/** 'YYYY-MM' or 'YYYY-MM-DD' → "September 2026". In UTC, so a month cannot slip. */
function monthName(iso: string): string {
  const [year, month] = iso.split('-').map(Number)
  if (!year || !month) return iso
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(LOCALE, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function measuredLabel(atMs: number, now: number): { text: string; stale: boolean } {
  const ageMs = Math.max(0, now - atMs)
  const minutes = Math.floor(ageMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const when =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} min ago`
        : hours < 24
          ? `${hours} h ago`
          : days === 1
            ? '1 day ago'
            : `${days} days ago`
  return { text: `Measured ${when}`, stale: ageMs > STALE_AFTER_MS }
}

function gcpCard(g: GcpCostSnapshot | null, recordedOn: string | null): CostCardModel {
  const kind = 'Money · month to date'
  if (!g) {
    return {
      kind,
      headline: {
        value: null,
        caption: (
          <>
            The billing budget publishes spend once <code>cost_feed_topic</code> is applied.
          </>
        ),
      },
    }
  }
  return {
    kind,
    headline: {
      value: money(g.month_to_date),
      unit: g.currency,
      caption:
        g.budget_amount !== null
          ? `spent so far, against a ${count(g.budget_amount)} ${g.currency} budget`
          : 'spent so far — the notification named no budget',
    },
    meter: g.budget_amount
      ? { used: g.month_to_date, cap: g.budget_amount, of: 'of budget' }
      : undefined,
    period: g.interval_start ? `${monthName(g.interval_start)}, so far` : 'This billing month, so far',
    measuredAtMs: g.received_at_ms,
    recordedOn,
  }
}

function stripeCard(st: StripeCostSnapshot | null, recordedOn: string | null): CostCardModel {
  const kind = 'Money · last completed month'
  if (!st) {
    return {
      kind,
      headline: {
        value: null,
        caption: 'Needs a completed month of finance reports, or the platform call failed.',
      },
    }
  }
  // TWO FIGURES, NEVER ONE TOTAL. Linyup runs Connect as direct charges with the
  // studio as fee payer, so it pays Stripe nothing on the member→studio rail:
  // adding these together would overstate COGS by the whole width of payment
  // volume. The platform bill is the headline; the studios' figure sits below a
  // rule, smaller and separately labeled, so the card cannot be read as one sum.
  return {
    kind,
    headline: st.platform
      ? {
          value: money(st.platform.fees_minor / 100),
          unit: st.platform.currency,
          caption: 'Linyup’s own Stripe bill (SaaS billing) — our cost',
          warnings: st.platform.truncated
            ? ['At least this much: the page cap was hit, so this is a floor.']
            : undefined,
        }
      : { value: null, caption: 'Linyup’s own Stripe bill — the platform call failed.' },
    more: [
      st.studios
        ? {
            value: money(st.studios.fees_minor / 100),
            unit: st.studios.currency,
            caption: `paid to Stripe by studios — their cost, not ours · ${count(st.studios.teams_counted)} tenant(s) counted`,
            warnings:
              st.studios.teams_missing_report > 0
                ? [
                    `${count(st.studios.teams_missing_report)} tenant(s) had no report for the month, so this is short.`,
                  ]
                : undefined,
          }
        : { value: null, caption: 'What studios paid Stripe — their cost, not ours.' },
    ],
    period: monthName(st.month),
    measuredAtMs: st.fetched_at_ms,
    recordedOn,
  }
}

/** Brevo reports every plan line's credits as `sendLimit` — the SMS line
 *  included — so it is the line's TYPE that says what the credits buy. */
function creditsUnit(line: BrevoPlanLine): string {
  return line.type === 'sms' ? 'SMS credits' : 'email credits'
}

function brevoCard(b: BrevoCreditSnapshot | null, recordedOn: string | null): CostCardModel {
  const kind = 'Credits · balance'
  if (!b) {
    return {
      kind,
      headline: {
        value: null,
        caption: 'No API key in this environment, or the account call failed.',
      },
    }
  }
  // Email leads: it is what the platform spends credits on every day. Any other
  // line (SMS runs 30–50× email per message) sits beneath it — never added to it.
  const lines = [...b.plans].sort((x, y) => Number(x.type === 'sms') - Number(y.type === 'sms'))
  const figure = (line: BrevoPlanLine): Figure => ({
    value: count(line.credits),
    unit: creditsUnit(line),
    caption: `left on the ${line.type} plan`,
  })
  const [lead, ...rest] = lines
  return {
    kind,
    headline: lead ? figure(lead) : { value: null, caption: 'The account reported no plan lines.' },
    more: rest.map(figure),
    period: 'Balance right now',
    measuredAtMs: b.fetched_at_ms,
    recordedOn,
  }
}

function deeplCard(d: DeeplUsageSnapshot | null, recordedOn: string | null): CostCardModel {
  const kind = 'Characters · this period'
  if (!d) {
    return {
      kind,
      headline: {
        value: null,
        caption: 'DeepL is not the configured translation provider, or no key is set.',
      },
    }
  }
  return {
    kind,
    headline: {
      value: count(d.characters_used),
      unit: 'characters',
      caption:
        d.character_limit !== null
          ? `translated, against the key’s ${count(d.character_limit)} cap`
          : 'translated — no cap on this plan',
    },
    meter: d.character_limit
      ? { used: d.characters_used, cap: d.character_limit, of: 'of cap' }
      : undefined,
    period: 'The key’s current billing period',
    measuredAtMs: d.fetched_at_ms,
    recordedOn,
  }
}

function cardFor(feed: CostFeed, costs: ProviderCosts): CostCardModel {
  switch (feed) {
    case 'gcp':
      return gcpCard(costs.gcp, costs.from.gcp)
    case 'stripe':
      return stripeCard(costs.stripe, costs.from.stripe)
    case 'brevo':
      return brevoCard(costs.brevo, costs.from.brevo)
    case 'deepl':
      return deeplCard(costs.deepl, costs.from.deepl)
  }
}

/** The amber mark, never amber TEXT: amber on a light card is too faint to read,
 *  and the lines it marks are the ones that say a figure is partial or old. */
function AttentionMark({ className }: { className?: string }) {
  return (
    <TriangleAlert aria-hidden className={cn('size-3.5 shrink-0 text-[var(--warning)]', className)} />
  )
}

function FigureView({ figure, lead = false }: { figure: Figure; lead?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {figure.value === null ? (
        <span className={cn('font-semibold text-muted-foreground', lead ? 'text-2xl' : 'text-base')}>
          Not measured
        </span>
      ) : (
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span
            className={cn('font-semibold tabular-nums', lead ? 'text-3xl tracking-tight' : 'text-lg')}
          >
            {figure.value}
          </span>
          {figure.unit && <span className="text-sm text-muted-foreground">{figure.unit}</span>}
        </span>
      )}
      <span className="text-xs text-muted-foreground">{figure.caption}</span>
      {figure.warnings?.map((warning) => (
        <span key={warning} className="flex items-start gap-1 text-xs font-medium text-foreground">
          <AttentionMark className="mt-px" />
          <span>{warning}</span>
        </span>
      ))}
    </div>
  )
}

/** Usage against a cap the vendor reported. Past 100% the bar stays full but the
 *  percentage keeps counting — an overrun is the one thing this must not hide.
 *  Color appears only when the share needs attention, so a healthy bar stays
 *  neutral and amber and red keep their meaning. */
function Meter({ used, cap, of }: { used: number; cap: number; of: string }) {
  const ratio = used / cap
  const label = `${percent(used, cap)} ${of}`
  const attention = ratio >= 0.9 ? 'critical' : ratio >= 0.75 ? 'high' : null
  return (
    <div className="flex flex-col gap-1">
      <div
        role="meter"
        aria-label="Share used"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
        aria-valuetext={label}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full',
            attention === 'critical'
              ? 'bg-destructive'
              : attention === 'high'
                ? 'bg-[var(--warning)]'
                : 'bg-foreground/60',
          )}
          style={{ width: `${Math.min(ratio, 1) * 100}%` }}
        />
      </div>
      <span
        className={cn(
          'text-xs tabular-nums',
          attention === 'critical'
            ? 'font-medium text-destructive'
            : attention === 'high'
              ? 'font-medium text-foreground'
              : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </div>
  )
}

function CostCard({
  provider,
  model,
  now,
}: {
  provider: Provider
  model: CostCardModel
  now: number
}) {
  const measured = model.measuredAtMs != null ? measuredLabel(model.measuredAtMs, now) : null
  return (
    <Card id={`cost-${provider.id}`} className="gap-3">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <span className="font-semibold">{provider.name}</span>
          <Badge variant="secondary">{model.kind}</Badge>
        </div>
        <a
          href={provider.panelUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open panel for ${provider.name}`}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-mt-1 -mr-2')}
        >
          <ExternalLink />
          <span className="hidden sm:inline">Open panel</span>
        </a>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <FigureView figure={model.headline} lead />
        {model.meter && <Meter {...model.meter} />}
        {model.more && model.more.length > 0 && (
          <div className="flex flex-col gap-3 border-t pt-3">
            {model.more.map((figure, i) => (
              <FigureView key={i} figure={figure} />
            ))}
          </div>
        )}
        {(model.period || measured) && (
          <div className="mt-auto flex flex-wrap items-center gap-x-1.5 border-t pt-3 text-xs text-muted-foreground">
            {model.period && <span>{model.period}</span>}
            {model.period && measured && <span aria-hidden>·</span>}
            {measured && model.measuredAtMs != null && (
              <span
                title={`${formatDateTime(model.measuredAtMs)}${model.recordedOn ? ` · on the ${model.recordedOn} snapshot` : ''}`}
                className={cn(
                  'inline-flex items-center gap-1',
                  measured.stale && 'font-medium text-foreground',
                )}
              >
                {measured.stale && <AttentionMark />}
                {measured.text}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function NotMetered({ providers }: { providers: Provider[] }) {
  if (providers.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed px-4 py-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Not metered here
      </span>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        {providers.map((p) => (
          <div key={p.id} className="contents">
            <dt className="font-medium">{p.name}</dt>
            <dd className="mb-1.5 text-muted-foreground sm:mb-0">{p.costNote}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function CostOverview({
  providers,
  costs,
  now,
}: {
  providers: Provider[]
  costs: ProviderCosts
  now: number
}) {
  const metered = providers.flatMap((p) => (p.costFeed ? [{ provider: p, feed: p.costFeed }] : []))
  const unmetered = providers.filter((p) => !p.costFeed && p.costNote)

  return (
    <section aria-labelledby="spend-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="spend-heading" className="text-base font-semibold">
          Spend &amp; usage
        </h2>
        <p className="text-sm text-muted-foreground">
          What each vendor reports, in its own unit and for its own period — side by side, never
          added up, because they are not the same kind of number.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {metered.map(({ provider, feed }) => (
          <CostCard key={provider.id} provider={provider} model={cardFor(feed, costs)} now={now} />
        ))}
      </div>
      <NotMetered providers={unmetered} />
    </section>
  )
}
