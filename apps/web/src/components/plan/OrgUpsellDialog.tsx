'use client'

/**
 * THE OFFER BEFORE THE SECOND STUDIO.
 *
 * Somebody about to create a second studio is describing an organization, and
 * the product has a tier for exactly that. Until this screen they went straight
 * to the signup wizard and got a second, entirely separate tenant — its own
 * members, its own contacts, its own bill — which is usually not what "I run two
 * places" means (Franco, 2028-08-28).
 *
 * IT IS AN OFFER, NOT A WALL. "Continue anyway" is a real control and does
 * exactly what it always did. There is no self-service lane for the Organization
 * tier — nothing calls `createOrganization` — so the primary action is a
 * conversation, and a screen that ended in a conversation with no way past it
 * would simply stop people doing something they are entitled to do.
 *
 * THE HINT UNDER IT IS THE POINT. Saying what continuing actually produces — a
 * separate studio, not a location under one account — is the whole reason this
 * screen earns its place. Without that sentence it is a marketing interstitial.
 *
 * The copy is borrowed, not written: the tagline and the three bullets are the
 * SAME `UpgradeModal.planContent.organization` strings the upgrade modal shows,
 * and the price comes from `orgPriceFrom()`, so this screen cannot drift from
 * the billing page.
 */

import { useTranslations } from 'next-intl'
import { Landmark, Check } from 'lucide-react'
import { ORG_PER_STUDIO } from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { usePlanName } from '@/hooks/usePlanName'
import { ORG_ENQUIRY_MAILTO } from '@/lib/salesContact'

export function OrgUpsellDialog({
  open,
  onClose,
  onContinue,
}: {
  open: boolean
  onClose: () => void
  onContinue: () => void
}) {
  const t = useTranslations('OrgUpsell')
  const tUM = useTranslations('UpgradeModal')
  const tPricing = useTranslations('Pricing')
  const tBilling = useTranslations('Billing')
  const planName = usePlanName()

  const features = tUM.raw('planContent.organization.features') as string[]

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet-50 dark:bg-violet-900/20">
            <Landmark className="h-6 w-6 text-violet-500" />
          </div>
          <DialogTitle className="text-center">{t('title')}</DialogTitle>
          <DialogDescription className="text-center">
            {tUM('planContent.organization.tagline')}
          </DialogDescription>
        </DialogHeader>

        {/* The tier's own name and RATE — not a total, and not "from". This
            tier is priced per studio at a flat rate, so the number that is true
            of every organization is the rate; the total is composed on the
            pricing page, where there is room for the calculator. */}
        <p className="text-center text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{planName('organization')}</span>
          {' · '}
          <span className="font-semibold text-foreground">CHF {ORG_PER_STUDIO.monthly}</span>{' '}
          {tPricing('perStudioMonth')}
        </p>

        <ul className="space-y-2">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
              <span>{f}</span>
            </li>
          ))}
        </ul>

        <div className="space-y-2 pt-2">
          <Button
            className="w-full"
            onClick={() => {
              window.location.href = ORG_ENQUIRY_MAILTO
            }}
          >
            {tBilling('talkToUs')}
          </Button>
          <Link
            href={'/settings/billing' as Route}
            onClick={onClose}
            className="block text-center text-sm text-primary hover:underline"
          >
            {tUM('compareAllPlans')}
          </Link>
        </div>

        <div className="border-t pt-3 text-center">
          <button
            type="button"
            onClick={onContinue}
            className="text-sm text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
          >
            {t('continueAnyway')}
          </button>
          <p className="mt-1 text-xs text-muted-foreground">{t('continueHint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
