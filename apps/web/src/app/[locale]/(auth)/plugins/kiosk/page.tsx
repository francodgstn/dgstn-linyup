'use client'

// Kiosk mode — a fixed, low-chrome public page for the studio's entrance tablet.
// Layout/structure is FIXED (built by the (public)/public/[slug]/kiosk route); this
// settings page only lets the owner/manager flip features on/off and manage the
// standby slideshow + device PIN lock. Mirrors the website plugin's page shape
// (draft state + explicit Save); the config itself is one setDoc on
// installed_plugins/kiosk.config with merge:true.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { toast } from 'sonner'
import {
  Monitor, Copy, Check, ExternalLink, Plus, X, RotateCw, LogOut, Lock,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { usePlan } from '@/hooks/usePlan'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DEFAULT_KIOSK_CONFIG } from '@linyup/shared'
import type { KioskConfig, KioskScheduleView, KioskTheme } from '@linyup/shared'
import { useKioskConfig, saveKioskConfig, uploadKioskMedia } from '@/plugins/kiosk/hooks'
import { Tip } from '@/components/ui/tip'

const MAX_IMAGE_MB = 10
const MAX_VIDEO_MB = 60

function generatePin(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1_000_000).padStart(6, '0')
}

function FeatureRow({
  label, hint, checked, onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export default function KioskSettingsPage() {
  const t = useTranslations('Kiosk')
  const { user, currentTeamId, team, teamRole } = useAuth()
  const qc = useQueryClient()
  const { isAtLeast, isLoading: planLoading } = usePlan()
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const { data: savedConfig, isLoading: configLoading } = useKioskConfig(currentTeamId)

  const [config, setConfig] = useState<KioskConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [copiedPin, setCopiedPin] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Initialize the working draft once data has settled.
  useEffect(() => {
    if (config || configLoading || !currentTeamId) return
    setConfig(savedConfig ?? DEFAULT_KIOSK_CONFIG)
  }, [config, configLoading, savedConfig, currentTeamId])

  function mutate(updater: (c: KioskConfig) => KioskConfig) {
    setConfig((c) => (c ? updater(c) : c))
    setDirty(true)
  }

  const saveMutation = useMutation({
    mutationFn: async (next: KioskConfig) => {
      if (!currentTeamId || !user) throw new Error('Not authenticated')
      await saveKioskConfig(currentTeamId, user.uid, next)
    },
    onSuccess: () => {
      setDirty(false)
      toast.success(t('saved'))
      qc.invalidateQueries({ queryKey: ['kiosk-config', currentTeamId] })
    },
    onError: () => toast.error(t('errorSave')),
  })

  // Owner-only: writing installed_plugins/* is owner-gated in firestore.rules
  // (same as marketplace install/uninstall), so a manager's save would fail.
  const canManage = teamRole === 'owner'
  const eligible = isAtLeast('studio')
  const isLoading = planLoading || pluginsLoading || configLoading || !config

  if (isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  if (!isInstalled('kiosk') || !eligible) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-10 text-center">
        <Monitor className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{t('notInstalledTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('notInstalledBody')}</p>
        <Link
          href={'/plugins' as Route}
          className="mt-4 inline-block text-sm text-primary hover:underline"
        >
          {t('goToPlugins')} →
        </Link>
      </div>
    )
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-10 text-center">
        <Lock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{t('restrictedTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('restrictedBody')}</p>
      </div>
    )
  }

  const slug = team?.slug ?? null
  const kioskUrl = slug
    ? (typeof window !== 'undefined' ? window.location.origin : '') + `/public/${slug}/kiosk`
    : null

  async function copyPin() {
    if (!config?.lock.pin) return
    try {
      await navigator.clipboard.writeText(config.lock.pin)
      setCopiedPin(true)
      setTimeout(() => setCopiedPin(false), 1500)
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  function toggleFeature(key: keyof KioskConfig['features'], value: boolean) {
    mutate((c) => ({ ...c, features: { ...c.features, [key]: value } }))
  }

  function toggleLock(enabled: boolean) {
    mutate((c) => {
      if (!enabled) return { ...c, lock: { ...c.lock, enabled: false } }
      const pin = c.lock.pin ?? generatePin()
      const epoch = c.lock.epoch === 0 ? 1 : c.lock.epoch
      return { ...c, lock: { enabled: true, pin, epoch } }
    })
  }

  // Rotate / sign-out are one-shot actions (not draft form fields): they persist
  // immediately, together with any other pending edits, since the config doc is a
  // single full-overwrite blob (same pattern as the website builder's publish button).
  function rotatePin() {
    if (!config) return
    const next: KioskConfig = {
      ...config,
      lock: { ...config.lock, pin: generatePin(), epoch: config.lock.epoch + 1 },
    }
    setConfig(next)
    setConfirmRotate(false)
    saveMutation.mutate(next, { onSuccess: () => toast.success(t('pinRotatedToast')) })
  }

  function signOutAll() {
    if (!config) return
    const next: KioskConfig = { ...config, lock: { ...config.lock, epoch: config.lock.epoch + 1 } }
    setConfig(next)
    setConfirmSignOut(false)
    saveMutation.mutate(next, { onSuccess: () => toast.success(t('pinSignedOutToast')) })
  }

  async function handleAddMedia(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !currentTeamId) return
    const isVideo = file.type.startsWith('video')
    const maxBytes = (isVideo ? MAX_VIDEO_MB : MAX_IMAGE_MB) * 1024 * 1024
    if (file.size > maxBytes) {
      toast.error(t('standbyUploadTooLarge', { max: isVideo ? MAX_VIDEO_MB : MAX_IMAGE_MB }))
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setUploading(true)
    try {
      const item = await uploadKioskMedia(currentTeamId, file)
      mutate((c) => ({ ...c, standby: { ...c.standby, media: [...c.standby.media, item] } }))
    } catch {
      toast.error(t('standbyUploadError'))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function removeMedia(index: number) {
    mutate((c) => ({
      ...c,
      standby: { ...c.standby, media: c.standby.media.filter((_, i) => i !== index) },
    }))
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            {kioskUrl ? (
              <a
                href={kioskUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {kioskUrl.replace(/^https?:\/\//, '')}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <p className="mt-0.5 text-sm text-muted-foreground">{t('subtitle')}</p>
            )}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => config && saveMutation.mutate(config)}
          disabled={!dirty || saveMutation.isPending}
        >
          {saveMutation.isPending ? t('saving') : t('save')}
        </Button>
      </div>

      {/* Appearance */}
      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">{t('appearanceTitle')}</h2>
        <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
          <Label className="text-xs">{t('themeLabel')}</Label>
          <Select
            value={config.theme}
            onValueChange={(v) => mutate((c) => ({ ...c, theme: v as KioskTheme }))}
          >
            <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('themeAuto')}</SelectItem>
              <SelectItem value="light">{t('themeLight')}</SelectItem>
              <SelectItem value="dark">{t('themeDark')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {/* Features */}
      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">{t('featuresTitle')}</h2>
        <FeatureRow
          label={t('featureSchedule')}
          hint={t('featureScheduleHint')}
          checked={config.features.schedule}
          onChange={(v) => toggleFeature('schedule', v)}
        />
        {config.features.schedule && (
          <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
            <Label className="text-xs">{t('scheduleViewLabel')}</Label>
            <Select
              value={config.scheduleView}
              onValueChange={(v) => mutate((c) => ({ ...c, scheduleView: v as KioskScheduleView }))}
            >
              <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="calendar">{t('scheduleViewCalendar')}</SelectItem>
                <SelectItem value="list">{t('scheduleViewList')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <FeatureRow
          label={t('featureNowNext')}
          hint={t('featureNowNextHint')}
          checked={config.features.nowNext}
          onChange={(v) => toggleFeature('nowNext', v)}
        />
        <FeatureRow
          label={t('featureCheckinQr')}
          hint={t('featureCheckinQrHint')}
          checked={config.features.checkinQr}
          onChange={(v) => toggleFeature('checkinQr', v)}
        />
        <FeatureRow
          label={t('featureWalkIn')}
          hint={t('featureWalkInHint')}
          checked={config.features.walkIn}
          onChange={(v) => toggleFeature('walkIn', v)}
        />
        <FeatureRow
          label={t('featureStandby')}
          hint={t('featureStandbyHint')}
          checked={config.features.standby}
          onChange={(v) => toggleFeature('standby', v)}
        />
      </section>

      {/* Standby slideshow */}
      {config.features.standby && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">{t('standbyTitle')}</h2>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('standbyIdleLabel')}</Label>
            <Input
              type="number"
              min={5}
              value={config.standby.idleSeconds}
              onChange={(e) =>
                mutate((c) => ({
                  ...c,
                  standby: { ...c.standby, idleSeconds: Math.max(5, Number(e.target.value) || 0) },
                }))
              }
              className="h-9 w-28"
            />
            <p className="text-xs text-muted-foreground">{t('standbyIdleHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('standbyMediaLabel')}</Label>
            {config.standby.media.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('standbyMediaEmpty')}</p>
            )}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {config.standby.media.map((m, i) => (
                <div key={i} className="relative aspect-square overflow-hidden rounded-md border bg-muted">
                  {m.type === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <video src={m.url} className="h-full w-full object-cover" muted />
                  )}
                  <Tip label={t('standbyRemoveMedia')}>
                    <button
                      type="button"
                      onClick={() => removeMedia(i)}
                      aria-label={t('standbyRemoveMedia')}
                      className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 hover:bg-background"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Tip>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-input text-xs text-muted-foreground hover:border-primary/50 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {uploading ? t('standbyUploading') : t('standbyAddMedia')}
              </button>
            </div>
            <input ref={fileRef} type="file" accept="image/*,video/*" onChange={handleAddMedia} className="hidden" />
          </div>
        </section>
      )}

      {/* PIN lock (device pairing) */}
      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t('pinSectionTitle')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('pinSectionHint')}</p>
          </div>
          <Switch checked={config.lock.enabled} onCheckedChange={toggleLock} />
        </div>

        {config.lock.enabled && config.lock.pin && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-3">
            <Label className="text-xs">{t('pinLabel')}</Label>
            <div className="flex items-center gap-2">
              <code className="rounded bg-background px-2.5 py-1 font-mono text-lg tracking-[0.3em]">
                {config.lock.pin}
              </code>
              <Tip label={t('pinCopy')}>
                <Button variant="outline" size="icon-sm" onClick={copyPin} aria-label={t('pinCopy')}>
                  {copiedPin ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </Tip>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>
                <RotateCw className="h-3.5 w-3.5" />
                {t('pinRotate')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmSignOut(true)}>
                <LogOut className="h-3.5 w-3.5" />
                {t('pinSignOutAll')}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Rotate PIN confirm */}
      <AlertDialog open={confirmRotate} onOpenChange={(v) => { if (!v) setConfirmRotate(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pinRotateConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('pinRotateConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={rotatePin}>{t('pinRotateConfirmCta')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sign out all confirm */}
      <AlertDialog open={confirmSignOut} onOpenChange={(v) => { if (!v) setConfirmSignOut(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pinSignOutConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('pinSignOutConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={signOutAll}>{t('pinSignOutConfirmCta')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
