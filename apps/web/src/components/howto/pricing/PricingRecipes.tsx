'use client'

// Part 2 of the Pricing section: "I want to…" — a wrap of goal chips; picking
// one fills a shared detail panel with four labelled blocks (how it works /
// set it up / what members see / check it). Data-driven from
// HowTo.pricing.recipes.items plus the PRICING_RECIPES deep-link wiring in
// ./data — the same i18n-array pattern as HowToFaq, but with structured
// content instead of a flat Q/A, and "Check it" always closing on the same
// Offer → Pricing link (the persona preview every recipe points at).
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { ArrowRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { PRICING_RECIPES, PRICING_CHECK_LINK, type PricingRecipeId, type PricingRecipeLink } from './data'

function LinkRow({ links, t }: { links: PricingRecipeLink[]; t: ReturnType<typeof useTranslations<'HowTo'>> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {links.map((l) => (
        <Link
          key={`${l.href}-${l.labelKey}`}
          href={l.href as Route}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {t(`pricing.linkLabels.${l.labelKey}` as Parameters<typeof t>[0])}
          <ArrowRight className="h-3 w-3" />
        </Link>
      ))}
    </div>
  )
}

export function PricingRecipes() {
  const t = useTranslations('HowTo')
  const [selected, setSelected] = useState<PricingRecipeId>(PRICING_RECIPES[0].id)
  const recipe = PRICING_RECIPES.find((r) => r.id === selected)!

  return (
    <div>
      <h3 className="text-base font-semibold">{t('pricing.recipes.title')}</h3>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('pricing.recipes.intro')}</p>

      <div role="tablist" className="mt-5 flex flex-wrap gap-2">
        {PRICING_RECIPES.map((r) => {
          const active = r.id === selected
          return (
            <button
              key={r.id}
              type="button"
              role="tab"
              id={`howto-recipe-tab-${r.id}`}
              aria-selected={active}
              aria-controls="howto-recipe-panel"
              onClick={() => setSelected(r.id)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              }`}
            >
              {t(`pricing.recipes.items.${r.id}.chip` as Parameters<typeof t>[0])}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id="howto-recipe-panel"
        aria-labelledby={`howto-recipe-tab-${selected}`}
        className="mt-4 rounded-xl border bg-card p-5"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('pricing.recipes.labels.how')}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {t(`pricing.recipes.items.${selected}.how` as Parameters<typeof t>[0])}
          </p>
        </div>

        <div className="mt-4 border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('pricing.recipes.labels.setup')}
          </p>
          <div className="mt-1.5">
            <LinkRow links={recipe.links} t={t} />
          </div>
        </div>

        <div className="mt-4 border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('pricing.recipes.labels.see')}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {t(`pricing.recipes.items.${selected}.see` as Parameters<typeof t>[0])}
          </p>
        </div>

        <div className="mt-4 border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('pricing.recipes.labels.check')}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {t(`pricing.recipes.items.${selected}.check` as Parameters<typeof t>[0])}
          </p>
          <div className="mt-1.5">
            <LinkRow links={[PRICING_CHECK_LINK]} t={t} />
          </div>
        </div>
      </div>
    </div>
  )
}
