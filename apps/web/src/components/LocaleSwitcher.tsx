'use client'

// Compact language switcher — swaps the locale while preserving the current path
// (next-intl's locale-aware router). Reusable; used e.g. top-right on the demo /try
// page. Shows the current locale code with a globe.

import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { persistLocale } from '@/i18n/persistLocale'
import { Globe } from 'lucide-react'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const LABEL: Record<string, string> = { en: 'EN', de: 'DE', fr: 'FR', it: 'IT' }

export function LocaleSwitcher({
  className,
  triggerStyle,
  plain,
}: {
  className?: string
  /** Inline style overrides for the trigger — the public site/bio-link mounts
   *  sit on studio-chosen, runtime-computed palettes (accent colors,
   *  light/dark), which Tailwind utility classes can't express. One switcher,
   *  no fork. */
  triggerStyle?: React.CSSProperties
  /** Drops the trigger's border and background classes — the studio website's
   *  own mount, where the switcher sits beside plain nav links rather than in
   *  a toolbar. Every other mount keeps its bordered chip look untouched. */
  plain?: boolean
}) {
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const t = useTranslations('Common')

  return (
    <Select
      value={locale}
      onValueChange={(v) => {
        if (v && v !== locale) {
          // Before navigating — an unprefixed (English) URL is otherwise
          // re-resolved from Accept-Language. See persistLocale.
          persistLocale(v)
          // Preserve query + hash: a bare `pathname` replace drops an open
          // booking panel's `?book=1&session=…` (PublicSite) or a scroll
          // anchor, so the switch reads as a navigation rather than a
          // language change. Same fix as AuthContext's stored-locale adoption.
          const suffix =
            typeof window === 'undefined' ? '' : window.location.search + window.location.hash
          router.replace(`${pathname}${suffix}`, { locale: v })
        }
      }}
    >
      <SelectTrigger
        aria-label={t('language')}
        style={triggerStyle}
        className={cn(
          'h-8 w-auto gap-1.5 px-2 text-xs',
          plain && 'border-0 bg-transparent shadow-none hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent',
          className
        )}
      >
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {routing.locales.map((l) => (
          <SelectItem key={l} value={l} className="text-xs">
            {LABEL[l] ?? l.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
