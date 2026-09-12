import { ExternalLink, BookOpen, Activity } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PROVIDERS, CATEGORY_ORDER, type Provider, type ProviderCategory } from '@/lib/providers'
import { getProviderCosts, type ProviderCosts } from '@/lib/queries/providerCosts'

export const metadata = { title: 'Providers · Linyup Ops' }

// The page reads live figures, so it must not be cached into a stale cost.
export const dynamic = 'force-dynamic'

function ageLabel(fromDate: string | null, fetchedAtMs: number): string {
  const days = Math.floor((Date.now() - fetchedAtMs) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return fromDate ?? `${days} days ago`
}

/**
 * ONE number per card, in the unit the vendor actually reports — money for
 * Google, credits for Brevo, characters for DeepL. Deliberately not converted
 * into a common "spend" figure: see `PlatformProviderCosts` in @linyup/shared.
 *
 * A provider with no live feed renders its `costNote` instead. Nothing renders
 * as an unexplained blank, and nothing ever renders as 0 because a vendor call
 * failed — a cost screen is the one place a confident wrong number does real
 * damage.
 */
function CostLine({ provider, costs }: { provider: Provider; costs: ProviderCosts }) {
  if (!provider.costFeed) {
    return provider.costNote ? (
      <div className="mt-0.5 text-xs text-muted-foreground/80">{provider.costNote}</div>
    ) : null
  }

  if (provider.costFeed === 'gcp') {
    const g = costs.gcp
    if (!g) {
      return (
        <div className="mt-0.5 text-xs text-muted-foreground/80">
          Spend not measured yet — the billing budget publishes it once{' '}
          <code>cost_feed_topic</code> is applied.
        </div>
      )
    }
    const pct = g.budget_amount ? Math.round((g.month_to_date / g.budget_amount) * 100) : null
    return (
      <div className="mt-0.5 text-xs">
        <span className="font-medium tabular-nums">
          {g.month_to_date.toFixed(2)} {g.currency}
        </span>{' '}
        <span className="text-muted-foreground">
          month to date
          {g.budget_amount !== null && ` of ${g.budget_amount} ${g.currency}`}
          {pct !== null && ` (${pct}%)`} · {ageLabel(costs.from.gcp, g.received_at_ms)}
        </span>
      </div>
    )
  }

  if (provider.costFeed === 'brevo') {
    const b = costs.brevo
    if (!b) {
      return (
        <div className="mt-0.5 text-xs text-muted-foreground/80">
          Credits not measured — no API key in this environment, or the account call failed.
        </div>
      )
    }
    return (
      <div className="mt-0.5 text-xs">
        {b.plans.map((line) => (
          <span key={`${line.type}-${line.credits_type}`} className="mr-3">
            <span className="font-medium tabular-nums">{line.credits.toLocaleString()}</span>{' '}
            <span className="text-muted-foreground">
              {line.credits_type === 'sendLimit' ? 'email' : line.credits_type} credits ·{' '}
              {line.type}
            </span>
          </span>
        ))}
        <span className="text-muted-foreground">{ageLabel(costs.from.brevo, b.fetched_at_ms)}</span>
      </div>
    )
  }

  const d = costs.deepl
  if (!d) {
    return (
      <div className="mt-0.5 text-xs text-muted-foreground/80">
        Usage not measured — DeepL is not the configured translation provider, or no key is set.
      </div>
    )
  }
  const pct = d.character_limit ? Math.round((d.characters_used / d.character_limit) * 100) : null
  return (
    <div className="mt-0.5 text-xs">
      <span className="font-medium tabular-nums">{d.characters_used.toLocaleString()}</span>{' '}
      <span className="text-muted-foreground">
        characters
        {d.character_limit !== null
          ? ` of ${d.character_limit.toLocaleString()}${pct !== null ? ` (${pct}%)` : ''}`
          : ' (no cap on this plan)'}{' '}
        · {ageLabel(costs.from.deepl, d.fetched_at_ms)}
      </span>
    </div>
  )
}

function ProviderRow({ provider, costs }: { provider: Provider; costs: ProviderCosts }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="font-medium">{provider.name}</div>
        <div className="truncate text-xs text-muted-foreground">{provider.description}</div>
        <CostLine provider={provider} costs={costs} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {provider.docsUrl && (
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Docs"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          >
            <BookOpen />
            <span className="hidden sm:inline">Docs</span>
          </a>
        )}
        {provider.statusUrl && (
          <a
            href={provider.statusUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Status"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          >
            <Activity />
            <span className="hidden sm:inline">Status</span>
          </a>
        )}
        <a
          href={provider.panelUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ size: 'sm' }))}
        >
          <ExternalLink />
          Open panel
        </a>
      </div>
    </div>
  )
}

export default async function ProvidersPage() {
  const costs = await getProviderCosts()
  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    providers: PROVIDERS.filter((p) => p.category === category),
  })).filter((g): g is { category: ProviderCategory; providers: Provider[] } => g.providers.length > 0)

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Third-party vendors the platform runs on, what each one says we are spending, and a
          one-click route into its control panel. Figures are shown in the unit the vendor
          reports — they are not added up, because they are not the same kind of number.
        </p>
      </div>

      {byCategory.map(({ category, providers }) => (
        <section key={category} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{category}</h2>
          <Card className="gap-0 py-0 divide-y">
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} costs={costs} />
            ))}
          </Card>
        </section>
      ))}
    </div>
  )
}
