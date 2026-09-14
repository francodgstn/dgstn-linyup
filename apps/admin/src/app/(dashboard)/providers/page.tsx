import { ExternalLink, BookOpen, Activity } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PROVIDERS, CATEGORY_ORDER, type Provider, type ProviderCategory } from '@/lib/providers'
import { getProviderCosts } from '@/lib/queries/providerCosts'
import { CostOverview } from './cost-overview'

export const metadata = { title: 'Providers · Linyup Ops' }

// The page reads live figures, so it must not be cached into a stale cost.
export const dynamic = 'force-dynamic'

function ProviderRow({ provider }: { provider: Provider }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="font-medium">{provider.name}</div>
        <div className="truncate text-xs text-muted-foreground">{provider.description}</div>
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
  const now = Date.now()
  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    providers: PROVIDERS.filter((p) => p.category === category),
  })).filter((g): g is { category: ProviderCategory; providers: Provider[] } => g.providers.length > 0)

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Third-party vendors the platform runs on: what each one says we are spending, and a
          one-click route into its control panel.
        </p>
      </div>

      {/* Every cost figure lives in this one section, in one card shape. The
          directory below is the way into each panel and repeats none of them. */}
      <CostOverview providers={byCategory.flatMap((g) => g.providers)} costs={costs} now={now} />

      <section aria-labelledby="directory-heading" className="flex flex-col gap-4">
        <h2 id="directory-heading" className="text-base font-semibold">
          Directory
        </h2>
        {byCategory.map(({ category, providers }) => (
          <div key={category} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-muted-foreground">{category}</h3>
            <Card className="gap-0 py-0 divide-y">
              {providers.map((p) => (
                <ProviderRow key={p.id} provider={p} />
              ))}
            </Card>
          </div>
        ))}
      </section>
    </div>
  )
}
