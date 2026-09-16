'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  doc, setDoc, deleteDoc, getDoc, serverTimestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { usePluginDiscovery } from '@/hooks/usePluginDiscovery'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import {
  TEAMS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
} from '@linyup/shared'
import type { PluginManifest, InstalledPlugin, PluginCategory, PluginAccess } from '@linyup/shared'
import { pluginAccessForPlan, requirementBlockers } from '@linyup/shared'
import { installableManifests, manifestById } from '@/plugins/registry'
import { PluginIcon } from '@/plugins/icons'
import { pluginSlot } from '@/plugins/slots'
import { usePlan } from '@/hooks/usePlan'
import { useUpgradeModal } from '@/contexts/UpgradeModalContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
// Plugin icons resolve through @/plugins/icons; only this page's own chrome
// icons are imported here.
import {
  Search, ImageIcon, CheckCircle2, Coins, Lock, Clock, BadgeCheck,
  ChevronDown,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Tooltip as UITooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// ─── Icon map ─────────────────────────────────────────────────────────────────

// Icon resolution lives in @/plugins/icons — one map, because three had already
// drifted apart (see that file's header).

// ─── What removal actually does ───────────────────────────────────────────────

/**
 * Removing a plugin deletes `teams/{teamId}/installed_plugins/{pluginId}`, which
 * fires `onInstalledPluginStatusChange`. THAT TRIGGER IS THE OWNER of the list of
 * plugins whose removal tears public artefacts down — this map only supplies the
 * copy for the ones it names, so add an arm there and add its key here.
 *
 * Everything not listed has no teardown arm: the install doc goes, the feature's
 * gate closes, the data stays (finance says so in the trigger explicitly, and
 * `sync/documentsDegating.test.ts` pins that a document's public mirrors are
 * never torn down at all — that teardown once deleted the public copy of a
 * document a booking gate pointed at). So the default copy may promise the data
 * is kept, and the copy for anything named below must NOT.
 */
const REMOVE_EFFECT_KEY: Record<
  string,
  'removeConfirmBodyWebsite' | 'removeConfirmBodyCourses' | 'removeConfirmBodyBundle' | 'removeConfirmBodyApiKeys'
> = {
  // revokeAllApiKeys: every key the team issued is revoked, for good — a
  // reinstall does not bring one back, so integrations need new keys.
  'api-connectors': 'removeConfirmBodyApiKeys',
  // A CONTAINER's removal also removes the members the reconciler installed for
  // it, so the default copy ("your data is kept") is true of the data but not of
  // the features. Say both.
  hmd: 'removeConfirmBodyBundle',
  // unpublishSiteForTeam: deletes site_published/{teamId}, flags the draft disabled.
  website: 'removeConfirmBodyWebsite',
  // deleteAllCoursePublicProfiles: batch-deletes every course public_profile
  // mirror. Nothing rewrites them on reinstall — syncCoursePublicProfile only
  // fires on a courses/{id} write — so each course must be re-published.
  'online-courses': 'removeConfirmBodyCourses',
}

// ─── Owner check ──────────────────────────────────────────────────────────────

function useIsOwner(teamId: string | null, userId: string | null) {
  return useQuery<boolean>({
    queryKey: ['team-role', teamId, userId],
    enabled: !!teamId && !!userId,
    queryFn: async () => {
      if (!teamId || !userId) return false
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId, TEAM_MEMBERS_SUBCOLLECTION, userId))
      return snap.exists() && snap.data()?.role === 'owner'
    },
  })
}

// ─── Category tabs ────────────────────────────────────────────────────────────

type CategoryFilter = 'all' | PluginCategory

// ─── Badge helpers ────────────────────────────────────────────────────────────

/**
 * Compact, icon-only signal row for the plugin GRID card — declutters the dense
 * text-badge stack down to a few small icons, each explained on hover. Category
 * is intentionally omitted here (it's filterable via the tabs and shown in the
 * detail modal). Plan/price + upgrade are already conveyed by the action button,
 * so they appear here only as a supplementary hint (useful for non-owners who see
 * no action button). Renders nothing when there's no signal to show.
 */
function PluginBadgeIcons({
  manifest,
  access,
}: {
  manifest: PluginManifest
  access: PluginAccess
}) {
  const t = useTranslations('Plugins')

  // Icons are monochrome (muted) at rest and reveal their semantic colour only on
  // hover — keeps the grid calm while still signalling on interaction.
  //
  // `tooltip` defaults to `label`. It exists for the one signal whose label is a
  // word rather than a fact: a tooltip reading "Recommended" over an icon that
  // already means "recommended" explains nothing (UX-65), so it says who is
  // recommending and on what basis. The aria-label stays the short form.
  //
  // NOT A STAR: the star now means "favourite" in the nav, and the settings rail
  // — which carries that very toggle — renders down the left of THIS page, so a
  // star here would put both meanings on one screen. Not `Puzzle` either (every
  // card is a plugin) and not `Sparkles`/`Award` (already the AI and gamification
  // plugin glyphs in this same grid). `BadgeCheck` reads as endorsed and is
  // unclaimed here.
  const items: {
    key: string
    icon: LucideIcon
    label: string
    tooltip?: string
    hoverClassName: string
  }[] = []

  if (manifest.recommended) {
    items.push({
      key: 'recommended',
      icon: BadgeCheck,
      label: t('recommended'),
      tooltip: t('recommendedWhy'),
      hoverClassName: 'hover:text-amber-500',
    })
  }
  if (access.kind === 'included') {
    items.push({ key: 'included', icon: CheckCircle2, label: t('accessIncluded'), hoverClassName: 'hover:text-green-600' })
  } else if (access.kind === 'addon') {
    items.push({ key: 'addon', icon: Coins, label: t('addonPrice', { price: access.priceMonthly }), hoverClassName: 'hover:text-primary' })
  } else if (access.kind === 'upgrade') {
    items.push({ key: 'upgrade', icon: Lock, label: t('badgeUpgrade', { plan: access.minPlan }), hoverClassName: 'hover:text-foreground' })
  }
  if (manifest.status === 'coming_soon') {
    items.push({ key: 'coming_soon', icon: Clock, label: t('statusComingSoon'), hoverClassName: 'hover:text-foreground' })
  }

  // BETA IS NOT A HOVER STATE. Every other badge on this card answers "can I
  // have it and what does it cost", which a reader looks up when they are
  // deciding; beta answers "should you trust the output", which they need
  // whether or not they thought to ask. It was one of these hover-only glyphs
  // and it was the wrong shape for what it says (Franco, 2026-08-28), so it
  // renders as a word, beside them, and stays visible once installed — the
  // caveat outlives the decision to install.
  const isBeta = manifest.status === 'beta'

  if (items.length === 0 && !isBeta) return null

  return (
    <TooltipProvider delay={200}>
      <div className="flex items-center gap-2.5">
        {isBeta && (
          <Badge
            variant="secondary"
            className="border-blue-200 bg-blue-50 text-[0.6875rem] font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300"
          >
            {t('statusBeta')}
          </Badge>
        )}
        {items.map(({ key, icon: Icon, label, tooltip, hoverClassName }) => (
          <UITooltip key={key}>
            <TooltipTrigger
              className={cn('inline-flex cursor-help text-muted-foreground/60 transition-colors', hoverClassName)}
              aria-label={label}
            >
              <Icon className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{tooltip ?? label}</TooltipContent>
          </UITooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}

/**
 * Returns the full text-badge set for the plugin DETAIL MODAL (more room there).
 *
 * Badges rendered (in order, only when relevant):
 *   1. Category — always shown (muted, outline style).
 *   2. "Recommended" — amber tint, only when manifest.recommended is true.
 *   3. Plan / price — green "Included", primary-tinted add-on price, or
 *      upgrade requirement. Omitted when access.kind === 'included' AND plan is
 *      studio/org (it's the default — not worth saying).
 *   4. Status — "Coming soon" / "Beta" when not 'available'. Installed status
 *      is shown separately in the card (not as a badge here).
 */
function PluginBadges({
  manifest,
  access,
  categoryLabel,
  showInstalled,
  installedByOrg,
}: {
  manifest: PluginManifest
  access: PluginAccess
  categoryLabel: string
  showInstalled?: boolean
  installedByOrg?: boolean
}) {
  const t = useTranslations('Plugins')

  return (
    <div className="flex flex-wrap gap-1.5">
      {/* Category */}
      <Badge variant="outline" className="text-xs text-muted-foreground">
        {categoryLabel}
      </Badge>

      {/* Recommended — the word is meaningless without its basis, so the badge
          carries the explanation on hover here too (UX-65). Same string as the
          grid's signal icon; there is one definition of "recommended", not two. */}
      {manifest.recommended && (
        <TooltipProvider delay={200}>
          <UITooltip>
            <TooltipTrigger className="cursor-help" aria-label={t('recommended')}>
              <Badge
                variant="secondary"
                className="text-xs bg-amber-50 text-amber-700 border-amber-200"
              >
                {t('recommended')}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{t('recommendedWhy')}</TooltipContent>
          </UITooltip>
        </TooltipProvider>
      )}

      {/* Plan / price tier */}
      {access.kind === 'included' && (
        <Badge variant="outline" className="text-xs border-green-500/50 text-green-600">
          {t('accessIncluded')}
        </Badge>
      )}
      {access.kind === 'addon' && (
        <Badge
          variant="secondary"
          className="text-xs border-primary/30 bg-primary/10 text-primary"
        >
          {t('addonPrice', { price: access.priceMonthly })}
        </Badge>
      )}
      {access.kind === 'upgrade' && (
        <Badge variant="outline" className="text-xs">
          {t('badgeUpgrade', { plan: access.minPlan })}
        </Badge>
      )}

      {/* Status */}
      {manifest.status === 'coming_soon' && (
        <Badge variant="secondary" className="text-xs">
          {t('statusComingSoon')}
        </Badge>
      )}
      {manifest.status === 'beta' && (
        <Badge
          variant="secondary"
          className="text-xs bg-blue-50 text-blue-700 border-blue-200"
        >
          {t('statusBeta')}
        </Badge>
      )}

      {/* Installed state (optional — shown in modal or when caller requests it) */}
      {showInstalled && (
        installedByOrg ? (
          <Badge
            variant="secondary"
            className="text-xs bg-blue-50 text-blue-700 border-blue-200"
          >
            {t('orgManagedBadge')}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-xs border-green-500 text-green-600"
          >
            <span className="mr-1 h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
            {t('statusInstalled')}
          </Badge>
        )
      )}
    </div>
  )
}

// ─── Plugin card ──────────────────────────────────────────────────────────────

function PluginCard({
  manifest,
  access,
  isInstalled,
  installedByOrg,
  isOwner,
  onInstall,
  onRemove,
  onConfigure,
  onUpgrade,
  onUnlock,
  onDetails,
  installing,
}: {
  manifest: PluginManifest
  access: PluginAccess
  isInstalled: boolean
  installedByOrg: boolean
  isOwner: boolean
  onInstall: () => void
  onRemove: () => void
  onConfigure: () => void
  onUpgrade: () => void
  onUnlock: () => void
  onDetails: () => void
  installing: boolean
}) {
  const t = useTranslations('Plugins')

  return (
    <div
      className="group rounded-xl border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:border-foreground/20 hover:shadow-sm transition-all"
      onClick={onDetails}
      role="button"
      tabIndex={0}
      aria-label={t(manifest.nameKey as Parameters<typeof t>[0])}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDetails() }}
    >
      {/* Header row: icon + name + installed dot */}
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted group-hover:bg-muted/80 transition-colors">
          <PluginIcon name={manifest.iconName} className="h-4.5 w-4.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm leading-tight truncate">
              {t(manifest.nameKey as Parameters<typeof t>[0])}
            </span>
            {manifest.locked && !isInstalled && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground shrink-0">
                <Lock className="h-2.5 w-2.5" />
                {t('lockedBadge')}
              </span>
            )}
            {isInstalled && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0"
                aria-label={t('statusInstalled')}
              />
            )}
          </div>
          {/* One-line description */}
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
            {t(manifest.descriptionKey as Parameters<typeof t>[0])}
          </p>
        </div>
      </div>

      {/* Compact signal icons (recommended / plan / status) with hover tooltips */}
      <PluginBadgeIcons manifest={manifest} access={access} />

      {/* Action row — stop propagation so card-click (→ details) is separate */}
      {isOwner && (
        <div
          className="mt-auto pt-1 flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {isInstalled ? (
            installedByOrg ? (
              <span className="text-xs text-muted-foreground">{t('orgManagedHint')}</span>
            ) : (
              <>
                {manifest.hasOwnerConfig && (
                  <Button size="sm" variant="outline" onClick={onConfigure}>
                    {t('configure')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={onRemove}
                >
                  {t('remove')}
                </Button>
              </>
            )
          ) : manifest.locked ? (
            <Button size="sm" variant="outline" onClick={onUnlock}>
              <Lock className="h-3.5 w-3.5" />
              {t('unlock')}
            </Button>
          ) : access.kind === 'upgrade' ? (
            <Button size="sm" variant="outline" onClick={onUpgrade}>
              {t('upgradeCta')}
            </Button>
          ) : access.kind === 'addon' ? (
            <Button
              size="sm"
              variant="default"
              onClick={onInstall}
              disabled={manifest.status === 'coming_soon' || installing}
            >
              {installing ? t('installing') : t('addonAdd', { price: access.priceMonthly })}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={onInstall}
              disabled={manifest.status === 'coming_soon' || installing}
            >
              {installing ? t('installing') : t('install')}
            </Button>
          )}
          <button
            className="ml-auto text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
            onClick={onDetails}
          >
            {t('detailsLink')}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Plugin detail modal ──────────────────────────────────────────────────────

function PluginDetailModal({
  manifest,
  access,
  isInstalled,
  installedByOrg,
  isOwner,
  onInstall,
  onRemove,
  onConfigure,
  onUpgrade,
  onUnlock,
  installing,
  categoryLabel,
  open,
  onClose,
}: {
  manifest: PluginManifest | null
  access: PluginAccess | null
  isInstalled: boolean
  installedByOrg: boolean
  isOwner: boolean
  onInstall: () => void
  onRemove: () => void
  onConfigure: () => void
  onUpgrade: () => void
  onUnlock: () => void
  installing: boolean
  categoryLabel: string
  open: boolean
  onClose: () => void
}) {
  const t = useTranslations('Plugins')

  if (!manifest || !access) return null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <PluginIcon name={manifest.iconName} className="h-5 w-5 text-muted-foreground" />
            </div>
            <DialogTitle className="text-base">
              {t(manifest.nameKey as Parameters<typeof t>[0])}
            </DialogTitle>
          </div>
        </DialogHeader>

        {/* Screenshot area */}
        {manifest.screenshot ? (
          <div className="rounded-lg overflow-hidden border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={manifest.screenshot}
              alt={t('screenshotAlt', { name: t(manifest.nameKey as Parameters<typeof t>[0]) })}
              className="w-full object-cover"
            />
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/50 flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
            <ImageIcon className="h-8 w-8 opacity-30" />
            <span className="text-xs">{t('screenshotPlaceholder')}</span>
          </div>
        )}

        {/* Full description */}
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(manifest.descriptionKey as Parameters<typeof t>[0])}
        </p>

        {/* Badges */}
        <PluginBadges
          manifest={manifest}
          access={access}
          categoryLabel={categoryLabel}
          showInstalled={isInstalled}
          installedByOrg={installedByOrg}
        />

        {/* Org-managed hint */}
        {isInstalled && installedByOrg && (
          <p className="text-xs text-muted-foreground">{t('orgManagedHint')}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>

          {isOwner && (
            isInstalled ? (
              installedByOrg ? null : (
                <div className="flex gap-2">
                  {manifest.hasOwnerConfig && (
                    <Button
                      variant="outline"
                      onClick={() => { onClose(); onConfigure() }}
                    >
                      {t('configure')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => { onClose(); onRemove() }}
                  >
                    {t('remove')}
                  </Button>
                </div>
              )
            ) : manifest.locked ? (
              <Button onClick={() => { onClose(); onUnlock() }}>
                <Lock className="h-4 w-4" />
                {t('unlock')}
              </Button>
            ) : access.kind === 'upgrade' ? (
              <Button onClick={() => { onClose(); onUpgrade() }}>
                {t('upgradeCta')}
              </Button>
            ) : access.kind === 'addon' ? (
              <Button
                onClick={() => { onClose(); onInstall() }}
                disabled={manifest.status === 'coming_soon' || installing}
              >
                {installing
                  ? t('installing')
                  : t('addonAdd', { price: access.priceMonthly })}
              </Button>
            ) : (
              <Button
                onClick={() => { onClose(); onInstall() }}
                disabled={manifest.status === 'coming_soon' || installing}
              >
                {installing ? t('installing') : t('install')}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Config dialog ────────────────────────────────────────────────────────────

function PluginConfigDialog({
  manifest,
  open,
  onClose,
}: {
  manifest: PluginManifest | null
  open: boolean
  onClose: () => void
}) {
  const t = useTranslations('Plugins')

  if (!manifest) return null

  // Resolved by convention from the plugin's own folder — a plugin that ships a
  // ConfigPanel.tsx gets a panel with nothing central to edit. This was a
  // hardcoded map of four, which is the sort of list a fifth plugin silently
  // fails to join.
  const ConfigPanel = manifest.hasOwnerConfig ? pluginSlot(manifest.id, 'ConfigPanel') : null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PluginIcon name={manifest.iconName} className="h-4 w-4" />
            {t(manifest.nameKey as Parameters<typeof t>[0])}
          </DialogTitle>
        </DialogHeader>
        {ConfigPanel ? <ConfigPanel /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Unlock dialog (locked plugins) ───────────────────────────────────────────
// Locked plugins install only via the unlockPlugin callable after a strong-key
// check. The real-time useInstalledPlugins snapshot picks up the new install doc,
// so there's nothing to refetch on success.

function PluginUnlockDialog({
  manifest,
  teamId,
  open,
  onClose,
}: {
  manifest: PluginManifest | null
  teamId: string | null
  open: boolean
  onClose: () => void
}) {
  const t = useTranslations('Plugins')
  // `useInstalledPlugins` is a live snapshot and needs nothing; the setup
  // checklist's "explore the plugins" step is a cached `getDocs` and does.
  const invalidateSetupChecklist = useInvalidateSetupChecklist()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const reset = () => { setKey(''); setError(null); setSubmitting(false) }

  async function submit() {
    if (!manifest || !teamId || !key.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await httpsCallable(functions, 'unlockPlugin')({ teamId, pluginId: manifest.id, key: key.trim() })
      void invalidateSetupChecklist()
      toast.success(`${t(manifest.nameKey as Parameters<typeof t>[0])} · ${t('unlockSuccess')}`)
      reset()
      onClose()
    } catch {
      setError(t('unlockError'))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); onClose() } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {manifest ? t(manifest.nameKey as Parameters<typeof t>[0]) : t('unlockTitle')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('unlockDesc')}</p>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('unlockPlaceholder')}
            autoComplete="off"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose() }}>{t('cancel')}</Button>
          <Button onClick={submit} disabled={!key.trim() || submitting}>
            {submitting ? t('installing') : t('unlock')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Collapsible section (installed / available) ───────────────────────────────

function PluginSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left group"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )}
        />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {count}
        </span>
      </button>
      {open && (
        <div className="grid gap-4 sm:grid-cols-2">{children}</div>
      )}
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PluginsPage() {
  const t = useTranslations('Plugins')
  const { user, currentTeamId } = useAuth()
  const { plugins: installedPlugins, isInstalled, getConfig, isLoading: pluginsLoading } = useInstalledPlugins()
  const { data: isOwner, isLoading: roleLoading } = useIsOwner(currentTeamId, user?.uid ?? null)
  const { canDiscover } = usePluginDiscovery()
  const { plan, isTrialing } = usePlan()
  const { openUpgradeModal } = useUpgradeModal()
  const invalidateSetupChecklist = useInvalidateSetupChecklist()
  const searchParams = useSearchParams()

  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [configPlugin, setConfigPlugin] = useState<PluginManifest | null>(null)
  const [detailPlugin, setDetailPlugin] = useState<PluginManifest | null>(null)
  const [confirmAddon, setConfirmAddon] = useState<PluginManifest | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<PluginManifest | null>(null)
  const [unlockTarget, setUnlockTarget] = useState<PluginManifest | null>(null)
  const [installedOpen, setInstalledOpen] = useState(true)
  const [availableOpen, setAvailableOpen] = useState(true)

  // ── Deep-link: ?plugin=<id> auto-opens the detail modal once per distinct value ──
  // Track the last param value we acted on so that closing the modal does not
  // reopen it (the param stays in the URL until the user navigates away).
  const lastAutoOpenedRef = useRef<string | null>(null)

  useEffect(() => {
    const pluginParam = searchParams.get('plugin')
    if (!pluginParam) return
    // Only auto-open once per distinct param value.
    if (lastAutoOpenedRef.current === pluginParam) return
    // `installableManifests()`, not the whole registry: a bundle member's id is
    // treated exactly like an unknown one, so ?plugin=<member> opens nothing.
    // The container is the card, and the modal would otherwise name and describe
    // a plugin nobody can install on its own.
    const manifest = installableManifests().find((m) => m.id === pluginParam)
    if (!manifest) return
    // A guessed ?plugin= is discovery too — the detail modal names and describes
    // the plugin. Treat an out-of-audience id exactly like an unknown one.
    if (!canDiscover(manifest) && !isInstalled(manifest.id)) return
    lastAutoOpenedRef.current = pluginParam
    setDetailPlugin(manifest)
  }, [searchParams, canDiscover, isInstalled])

  // WHY THESE MUTATIONS INVALIDATE ANYTHING AT ALL: the page's own list is a
  // live `onSnapshot` (`useInstalledPlugins`) and refreshes itself, but the setup
  // checklist counts `installed_plugins` through a cached `getDocs`, so its
  // "explore the plugins" step would sit open until the poll came round. Every
  // write below that adds or removes an install therefore says so.
  //
  // ── Install mutation ──
  const installMutation = useMutation({
    mutationFn: async (manifest: PluginManifest) => {
      if (!currentTeamId || !user) throw new Error('Not authenticated')
      const docRef = doc(db, TEAMS_COLLECTION, currentTeamId, INSTALLED_PLUGINS_SUBCOLLECTION, manifest.id)
      const payload: Omit<InstalledPlugin, 'installedAt'> & { installedAt: ReturnType<typeof serverTimestamp> } = {
        pluginId: manifest.id,
        teamId: currentTeamId,
        installedAt: serverTimestamp() as ReturnType<typeof serverTimestamp>,
        installedBy: user.uid,
        status: 'active',
        config: {},
      }
      // Requirements are NOT written here: `reconcileRequirements` is the one
      // writer of a requirement install, because this is only one of five
      // writers of an install document and the Coach path for finance
      // (`activatePluginAddon`) never comes through the client at all.
      await setDoc(docRef, payload)
    },
    onMutate: (manifest) => setInstallingId(manifest.id),
    onSettled: () => setInstallingId(null),
    onError: () => toast.error(t('errorInstall')),
    onSuccess: (_, manifest) => {
      void invalidateSetupChecklist()
      toast.success(t(manifest.nameKey as Parameters<typeof t>[0]) + ' installed')
    },
  })

  // ── Remove mutation (Studio/Org included plugins — client-side) ──
  const removeMutation = useMutation({
    mutationFn: async (pluginId: string) => {
      if (!currentTeamId) throw new Error('Not authenticated')
      const docRef = doc(db, TEAMS_COLLECTION, currentTeamId, INSTALLED_PLUGINS_SUBCOLLECTION, pluginId)
      await deleteDoc(docRef)
    },
    onSuccess: () => { void invalidateSetupChecklist() },
    onError: () => toast.error(t('errorRemove')),
  })

  // ── Coach add-on mutations ──
  const activateAddonMutation = useMutation({
    mutationFn: async (manifest: PluginManifest) => {
      if (!currentTeamId) throw new Error('Not authenticated')
      await httpsCallable(functions, 'activatePluginAddon')({ teamId: currentTeamId, pluginId: manifest.id })
    },
    onMutate: (manifest) => setInstallingId(manifest.id),
    onSettled: () => setInstallingId(null),
    onError: () => toast.error(t('errorInstall')),
    onSuccess: (_, manifest) => {
      void invalidateSetupChecklist()
      toast.success(t(manifest.nameKey as Parameters<typeof t>[0]) + ' activated')
    },
  })

  const deactivateAddonMutation = useMutation({
    mutationFn: async (pluginId: string) => {
      if (!currentTeamId) throw new Error('Not authenticated')
      await httpsCallable(functions, 'deactivatePluginAddon')({ teamId: currentTeamId, pluginId })
    },
    onSuccess: () => { void invalidateSetupChecklist() },
    onError: () => toast.error(t('errorRemove')),
  })

  function handleInstall(manifest: PluginManifest) {
    const access = pluginAccessForPlan(manifest, plan)
    if (access.kind === 'addon') {
      if (isTrialing) activateAddonMutation.mutate(manifest)
      else setConfirmAddon(manifest)
    } else {
      installMutation.mutate(manifest)
    }
  }

  // Removal is never a bare click: it can take a public website offline, delete
  // every course listing, and (for a paid coach add-on) change the subscription.
  // The confirm below states which of those applies before anything happens.
  function handleRemove(manifest: PluginManifest) {
    setConfirmRemove(manifest)
  }

  function performRemove(manifest: PluginManifest) {
    const access = pluginAccessForPlan(manifest, plan)
    const run = access.kind === 'addon'
      ? deactivateAddonMutation.mutateAsync(manifest.id)
      : removeMutation.mutateAsync(manifest.id)
    // Close on SUCCESS only — a failed removal (Stripe refusing the item change,
    // say) leaves the confirmation standing behind its toast rather than
    // dismissing as if it had worked.
    run.then(() => setConfirmRemove(null)).catch(() => {})
  }

  const isLoading = pluginsLoading || roleLoading

  // ── Category tabs ──
  const CATEGORIES: { key: CategoryFilter; label: string }[] = [
    { key: 'all',        label: t('categoryAll') },
    { key: 'engagement', label: t('categoryEngagement') },
    { key: 'commerce',   label: t('categoryCommerce') },
    { key: 'web',        label: t('categoryWeb') },
    { key: 'data',       label: t('categoryData') },
  ]

  const categoryLabelMap: Record<PluginCategory, string> = {
    engagement: t('categoryEngagement'),
    commerce: t('categoryCommerce'),
    web: t('categoryWeb'),
    data: t('categoryData'),
  }

  const search = searchTerm.trim().toLowerCase()
  const filteredPlugins = installableManifests()
    // Discovery allow-list (see PluginAudience). A tenant-specific plugin is
    // invisible to everyone it does not name — EXCEPT to a tenant already
    // running it, which keeps its card (and its Configure/Remove controls) in
    // the Installed section below whatever the list says today. Removing a
    // tenant from an allow-list must not take its live feature away.
    .filter((m) => canDiscover(m) || isInstalled(m.id))
    .filter((m) => categoryFilter === 'all' || m.category === categoryFilter)
    .filter(
      (m) =>
        !search ||
        t(m.nameKey).toLowerCase().includes(search) ||
        t(m.descriptionKey).toLowerCase().includes(search),
    )
    .sort((a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false))

  // Split into installed vs. available (org-managed installs count as installed).
  const installedList = filteredPlugins.filter((m) => isInstalled(m.id))
  const availableList = filteredPlugins.filter((m) => !isInstalled(m.id))

  const renderCard = (manifest: PluginManifest) => {
    const entry = installedPlugins.find((e) => e.manifest.id === manifest.id)
    return (
      <PluginCard
        key={manifest.id}
        manifest={manifest}
        access={pluginAccessForPlan(manifest, plan)}
        isInstalled={isInstalled(manifest.id)}
        installedByOrg={entry?.source === 'org'}
        isOwner={!!isOwner}
        installing={installingId === manifest.id}
        onInstall={() => handleInstall(manifest)}
        onRemove={() => handleRemove(manifest)}
        onConfigure={() => setConfigPlugin(manifest)}
        onUpgrade={() => openUpgradeModal({ minPlan: manifest.minPlan })}
        onUnlock={() => setUnlockTarget(manifest)}
        onDetails={() => setDetailPlugin(manifest)}
      />
    )
  }

  // Detail plugin's access + installed state (derived)
  const detailAccess = detailPlugin ? pluginAccessForPlan(detailPlugin, plan) : null
  const detailIsInstalled = detailPlugin ? isInstalled(detailPlugin.id) : false
  const detailEntry = detailPlugin
    ? installedPlugins.find((e) => e.manifest.id === detailPlugin.id)
    : null
  const detailInstalledByOrg = detailEntry?.source === 'org'

  // ── Removal confirmation: the real consequence, per plugin ──
  const removeName = confirmRemove
    ? t(confirmRemove.nameKey as Parameters<typeof t>[0])
    : ''
  const removeBodyKey = confirmRemove
    ? (REMOVE_EFFECT_KEY[confirmRemove.id] ?? 'removeConfirmBody')
    : 'removeConfirmBody'
  // NO CASCADE, AND NO SILENT BREAKAGE: removing a plugin another installed
  // plugin requires is refused here, naming the requirer. `reconcileRequirements`
  // would put it straight back anyway — refusing with a reason is the honest
  // version of that, and it is the only version the tenant can act on.
  const removeBlockedBy = confirmRemove
    ? requirementBlockers(
        confirmRemove.id,
        installedPlugins.map((e) => e.installation.pluginId)
      )
    : []
  const removeBlockedNames = removeBlockedBy
    .map((id) => {
      const m = manifestById(id)
      return m ? t(m.nameKey as Parameters<typeof t>[0]) : id
    })
    .join(', ')
  const removeAccess = confirmRemove ? pluginAccessForPlan(confirmRemove, plan) : null
  // `addonItemId` is written by activatePluginAddon ONLY when it actually added a
  // Stripe subscription item; a trial install carries `addonFreeTrial` instead. So
  // this — not the plan, and not `isTrialing` — is what says money is involved.
  const removeAddonItemId = confirmRemove
    ? (getConfig(confirmRemove.id) as { addonItemId?: string } | undefined)?.addonItemId
    : undefined
  const removePending = removeMutation.isPending || deactivateAddonMutation.isPending

  if (isLoading) {
    return (
      <div className="max-w-3xl space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
      </div>

      {/* Coach add-on hint */}
      {plan === 'coach' && (
        <div className="rounded-lg border border-primary/30 bg-primary/[0.04] px-4 py-3 text-sm">
          <p className="font-medium">{t('coachAddonBannerTitle')}</p>
          <p className="text-muted-foreground">{t('coachAddonBannerBody')}</p>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="pl-9"
        />
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map(({ key, label }) => (
          <Button
            key={key}
            size="sm"
            variant={categoryFilter === key ? 'secondary' : 'ghost'}
            onClick={() => setCategoryFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* Installed */}
      {installedList.length > 0 && (
        <PluginSection
          title={t('sectionInstalled')}
          count={installedList.length}
          open={installedOpen}
          onToggle={() => setInstalledOpen((v) => !v)}
        >
          {installedList.map(renderCard)}
        </PluginSection>
      )}

      {/* Available (not installed) */}
      {availableList.length > 0 && (
        <PluginSection
          title={t('sectionAvailable')}
          count={availableList.length}
          open={availableOpen}
          onToggle={() => setAvailableOpen((v) => !v)}
        >
          {availableList.map(renderCard)}
        </PluginSection>
      )}

      {filteredPlugins.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-12">
          {t('emptySearch')}
        </p>
      )}

      {/* Plugin detail modal */}
      <PluginDetailModal
        manifest={detailPlugin}
        access={detailAccess}
        isInstalled={detailIsInstalled}
        installedByOrg={detailInstalledByOrg}
        isOwner={!!isOwner}
        installing={detailPlugin ? installingId === detailPlugin.id : false}
        categoryLabel={detailPlugin ? categoryLabelMap[detailPlugin.category] : ''}
        onInstall={() => { if (detailPlugin) handleInstall(detailPlugin) }}
        onRemove={() => { if (detailPlugin) handleRemove(detailPlugin) }}
        onConfigure={() => { if (detailPlugin) setConfigPlugin(detailPlugin) }}
        onUpgrade={() => { if (detailPlugin) openUpgradeModal({ minPlan: detailPlugin.minPlan }) }}
        onUnlock={() => { if (detailPlugin) setUnlockTarget(detailPlugin) }}
        open={!!detailPlugin}
        onClose={() => setDetailPlugin(null)}
      />

      {/* Config dialog */}
      <PluginConfigDialog
        manifest={configPlugin}
        open={!!configPlugin}
        onClose={() => setConfigPlugin(null)}
      />

      {/* Unlock dialog (locked plugins) */}
      <PluginUnlockDialog
        manifest={unlockTarget}
        teamId={currentTeamId}
        open={!!unlockTarget}
        onClose={() => setUnlockTarget(null)}
      />

      {/* Removal confirmation — names what removal actually does to this
          plugin's data, and what it does to the money when it is a billed
          add-on. Never a generic "are you sure". */}
      <AlertDialog
        open={!!confirmRemove}
        onOpenChange={(v) => { if (!v && !removePending) setConfirmRemove(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeConfirmTitle', { name: removeName })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(removeBodyKey, { name: removeName })}
            </AlertDialogDescription>
            {removeAccess?.kind === 'addon' && (
              <p className="text-sm text-muted-foreground">
                {removeAddonItemId
                  ? t('removeConfirmBilling', { price: removeAccess.priceMonthly })
                  : t('removeConfirmBillingUnbilled')}
              </p>
            )}
            {confirmRemove?.locked && (
              <p className="text-sm text-muted-foreground">
                {t('removeConfirmLocked', { name: removeName })}
              </p>
            )}
            {removeBlockedBy.length > 0 && (
              <p className="text-sm text-destructive">
                {t('removeConfirmRequiredBy', { name: removeName, requirers: removeBlockedNames })}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removePending}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removePending || removeBlockedBy.length > 0}
              onClick={() => { if (confirmRemove) performRemove(confirmRemove) }}
            >
              {removePending ? t('removing') : t('remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add-on price confirmation (paid coach) */}
      <Dialog open={!!confirmAddon} onOpenChange={(v) => { if (!v) setConfirmAddon(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('addonConfirmTitle')}</DialogTitle>
          </DialogHeader>
          {confirmAddon && (
            <p className="text-sm text-muted-foreground">
              {t('addonConfirmBody', {
                name: t(confirmAddon.nameKey as Parameters<typeof t>[0]),
                price: confirmAddon.addon?.coachPriceMonthly ?? 0,
              })}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAddon(null)}>{t('cancel')}</Button>
            <Button
              onClick={() => {
                const m = confirmAddon
                setConfirmAddon(null)
                if (m) activateAddonMutation.mutate(m)
              }}
            >
              {t('addonConfirmCta')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
