'use client'

// The website theme picker — unlocked by the Site Themes plugin.
//
// A theme is a look + layout preset (packages/shared/src/types/siteTheme.ts).
// Picking one hands it to `onApply`, which runs `applySiteTheme` over the whole
// draft: the look lands in the site settings and styled section types move to
// the theme's style. Nothing is saved here — it is an edit like any other, kept
// only when the draft is saved.

import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { SITE_THEMES } from '@linyup/shared'
import type { SiteThemeDef, SiteThemeId } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { FONT_STACK } from '@/components/site/siteFonts'

export function ThemePicker({
  appliedTheme,
  installed,
  onApply,
}: {
  appliedTheme?: SiteThemeId
  /** Whether the Site Themes plugin is installed. Without it the picker is a
   *  pointer to the plugin, not a disabled control. */
  installed: boolean
  onApply: (theme: SiteThemeDef) => void
}) {
  const t = useTranslations('Website')

  if (!installed) {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        <Link href={'/settings/plugins' as Route} className="underline underline-offset-2">
          {t('themesInstallHint')}
        </Link>
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('themesHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {SITE_THEMES.map((theme) => {
          const applied = appliedTheme === theme.id
          const radius = theme.look.cardShape === 'square' ? '0px' : '0.75rem'
          const buttonRadius =
            theme.look.buttonShape === 'square' ? '0px' : theme.look.buttonShape === 'rounded' ? '0.5rem' : '9999px'
          return (
            <div key={theme.id} className="flex flex-col gap-3 rounded-lg border p-3">
              {/* A miniature of the look: its typeface in its case, a card in its
                  shape, a button in its shape and colour. */}
              <div
                className="border bg-background p-3"
                style={{
                  borderRadius: radius,
                  fontFamily: theme.look.font ? FONT_STACK[theme.look.font] : undefined,
                }}
              >
                <p
                  className="text-sm font-bold"
                  style={{ textTransform: theme.look.headingCase === 'uppercase' ? 'uppercase' : 'none' }}
                >
                  {t(theme.nameKey)}
                </p>
                <span
                  className="mt-2 inline-block px-3 py-1 text-[11px] font-semibold"
                  style={{
                    background: theme.look.buttonColor ?? 'var(--primary)',
                    color: '#ffffff',
                    borderRadius: buttonRadius,
                    textTransform: theme.look.headingCase === 'uppercase' ? 'uppercase' : 'none',
                  }}
                >
                  {t('themeApply')}
                </span>
              </div>
              <p className="flex-1 text-xs text-muted-foreground">{t(theme.descriptionKey)}</p>
              <Button
                type="button"
                size="sm"
                variant={applied ? 'secondary' : 'outline'}
                onClick={() => onApply(theme)}
              >
                {applied && <Check className="mr-1 h-3.5 w-3.5" />}
                {applied ? t('themeApplied') : t('themeApply')}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
