'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import type { Route } from 'next'
import type { SubscriptionType } from '@linyup/shared'
import { useAutomationRules, rulesForSubscriptionType } from '@/hooks/useAutomationRules'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Workflow, Plus, Pencil, ChevronRight } from 'lucide-react'

// Short, friendly label for the trigger types that reference a subscription.
function triggerLabel(type: string, t: (k: string) => string): string {
  switch (type) {
    case 'subscription_added':
      return t('autoTriggerSubscribed')
    case 'subscription_removed':
      return t('autoTriggerUnsubscribed')
    case 'subscription_changed':
      return t('autoTriggerChanged')
    default:
      return type
  }
}

/**
 * Read-only "Automations" panel shown in the subscription-type editor: lists the
 * rules that reference this type, and offers a quick "create automation" menu that
 * deep-links the automations builder prefilled with this subscription as the source.
 */
export function SubscriptionAutomationsSection({
  teamId,
  subscriptionType,
}: {
  teamId: string
  subscriptionType: SubscriptionType
}) {
  const t = useTranslations('TeamSettings')
  const router = useRouter()
  const { data: rules = [], isLoading } = useAutomationRules(teamId)
  const related = rulesForSubscriptionType(rules, subscriptionType.id)

  const go = (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    router.push(`/automations?${qs}` as Route)
  }

  // The "sub event might be multiple" — each maps to a delta trigger scoped to this type.
  const createOptions = [
    { key: 'subscription_added', label: t('autoCreateSubscribed') },
    { key: 'subscription_removed', label: t('autoCreateUnsubscribed') },
  ]

  return (
    <div className="space-y-2.5 pt-4 border-t">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">{t('autoSectionTitle')}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <Plus className="h-3.5 w-3.5" />
            {t('autoCreate')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {createOptions.map((o) => (
              <DropdownMenuItem
                key={o.key}
                onClick={() => go({ newTrigger: o.key, subType: subscriptionType.id })}
              >
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : related.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('autoNone')}</p>
      ) : (
        <div className="divide-y rounded-md border">
          {related.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => go({ editRule: r.id })}
              className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{r.name || t('autoUntitled')}</p>
                <p className="text-xs text-muted-foreground">{triggerLabel(r.trigger.type, t)}</p>
              </div>
              {!r.active && (
                <Badge variant="outline" className="text-[0.625rem] shrink-0">
                  {t('autoPaused')}
                </Badge>
              )}
              <Pencil className="h-3.5 w-3.5 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors shrink-0" />
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
