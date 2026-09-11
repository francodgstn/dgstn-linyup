'use client'

import { useState, useRef, useEffect } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { usePublicSurfaces } from '@/hooks/usePublicSurfaces'
import { useSaveShortcut } from '@/hooks/useSaveShortcut'
import { useForm, useFieldArray, Controller, useWatch, type FieldErrors } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { IconPicker, DynamicIcon } from '@/components/ui/icon-picker'
import { ColorPicker, DEFAULT_ACCENT } from '@/components/ui/color-picker'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import BioLinkHome from '../../../(public)/public/[slug]/BioLinkHome'
import { toast } from 'sonner'
import {  TEAMS_COLLECTION, SYSTEM_LINK_META, resolveSystemLinkTarget, PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import type {
  Team,
  SocialPlatform,
  SurfaceThemePresetId,
  SystemLinkTarget,
} from '@linyup/shared'
import { SOCIAL_PLATFORMS, SOCIAL_LABELS } from '@/lib/bioLink'
import { ThemePresetPicker } from '@/components/theme/ThemePresetPicker'
import {
  ExternalLink,
  Globe,
  ImageIcon,
  Plus,
  Pencil,
  GripVertical,
  Trash2,
  X,
  Eye,
  EyeOff,
  Share2,
} from 'lucide-react'
import { SortableList, SortableItem } from '@/components/ui/sortable'
import { Tip } from '@/components/ui/tip'

// ─── form schema ─────────────────────────────────────────────────────────────

// Accepts an empty string (no URL) or a valid https:// / http:// URL.
// Rejects javascript:, data:, and other dangerous protocols (stored XSS prevention).
const safeUrl = z
  .string()
  .refine((v) => v === '' || /^https?:\/\/.+/.test(v), 'Must be a valid https:// URL')
  .optional()

const linkSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  url: safeUrl,
  showInBioLink: z.boolean(),
  iconName: z.string().optional(),
  // Set → this is a "page link" to one of the team's public surfaces.
  target: z
    .enum(['booking', 'signup', 'shop', 'shop-subscriptions', 'shop-products', 'shop-courses', 'space', 'site', 'documents', 'events'])
    .optional(),
})

const schema = z.object({
  // ONE choice, both colour schemes — see packages/shared/src/types/themePreset.ts.
  // '' means "still on the legacy theme + background fields", which is what a
  // bio-link authored before presets has and what the picker shows as unchosen.
  themePreset: z.string(),
  accentColor: z.string(),
  // social — one flat field per platform
  instagram: z.string().optional(),
  facebook: z.string().optional(),
  youtube: z.string().optional(),
  tiktok: z.string().optional(),
  x: z.string().optional(),
  linkedin: z.string().optional(),
  whatsapp: z.string().optional(),
  website: z.string().optional(),
  review: z.string().optional(),
  links: z.array(linkSchema),
})

type FormData = z.infer<typeof schema>

// ─── data hook ────────────────────────────────────────────────────────────────

function useTeam(teamId: string | null) {
  return useQuery<Team | null>({
    queryKey: ['team', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return snap.exists() ? ({ id: snap.id, ...snap.data() } as Team) : null
    },
  })
}

// ─── image upload section ─────────────────────────────────────────────────────

function ImageUploadField({
  label,
  url,
  onUpload,
  onRemove,
  aspectRatio = 'square',
}: {
  label: string
  url: string | null
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void>
  aspectRatio?: 'square' | 'wide'
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      await onUpload(file)
    } finally {
      setUploading(false)
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {url ? (
        <div
          className={`relative overflow-hidden rounded-lg border bg-muted ${aspectRatio === 'wide' ? 'h-28' : 'h-20 w-20'}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="w-full h-full object-cover" />
          <button
            type="button"
            onClick={onRemove}
            className="absolute top-1 right-1 rounded-full bg-background/80 p-0.5 hover:bg-background transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className={`${aspectRatio === 'wide' ? 'w-full h-20' : 'h-20 w-20'} rounded-lg border-2 border-dashed border-input hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 text-xs`}
        >
          <ImageIcon className="h-4 w-4" />
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleChange}
        className="hidden"
      />
    </div>
  )
}

// ─── appearance tab ───────────────────────────────────────────────────────────

function AppearanceTab({
  control,
  profileImageUrl,
  heroImageUrl,
  onProfileUpload,
  onHeroUpload,
  onProfileRemove,
  onHeroRemove,
}: {
  control: ReturnType<typeof useForm<FormData>>['control']
  profileImageUrl: string | null
  heroImageUrl: string | null
  onProfileUpload: (f: File) => Promise<void>
  onHeroUpload: (f: File) => Promise<void>
  onProfileRemove: () => Promise<void>
  onHeroRemove: () => Promise<void>
}) {
  const t = useTranslations('BioLink')
  // Fed to the picker so each swatch shows the studio's OWN accent against both
  // halves, rather than the preset's placeholder one.
  const accentColorValue = useWatch({ control, name: 'accentColor' })

  return (
    <div className="space-y-6">
      {/* Profile + hero images */}
      <div className="space-y-4">
        <p className="text-sm font-medium">{t('images')}</p>
        <div className="flex gap-4 flex-wrap">
          <ImageUploadField
            label={t('profilePhoto')}
            url={profileImageUrl}
            onUpload={onProfileUpload}
            onRemove={onProfileRemove}
            aspectRatio="square"
          />
          <div className="flex-1 min-w-[180px]">
            <ImageUploadField
              label={t('coverImage')}
              url={heroImageUrl}
              onUpload={onHeroUpload}
              onRemove={onHeroRemove}
              aspectRatio="wide"
            />
          </div>
        </div>
      </div>

      {/* Theme — ONE control carrying both colour schemes.
          It replaces a light/dark/auto switch AND a free background colour or
          gradient. Those two crossed: "auto" with a fixed background followed
          the viewer for the text and not for the page, and a light theme with a
          dark background was patched over by a luminance check that silently
          ignored the studio's own choice. The registry
          (packages/shared/src/types/themePreset.ts) holds the full list of
          crossings this removed, and the hooks for a custom theme later. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('bioLinkTheme')}</p>
        <Controller
          control={control}
          name="themePreset"
          render={({ field }) => (
            <ThemePresetPicker
              value={(field.value as SurfaceThemePresetId | '') ?? ''}
              onChange={field.onChange}
              accentColor={accentColorValue}
            />
          )}
        />
      </div>

      {/* Accent color */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('accentColor')}</p>
        <Controller
          control={control}
          name="accentColor"
          render={({ field }) => (
            <ColorPicker
              value={field.value}
              onChange={field.onChange}
              className="h-7 w-7 rounded-full"
              aria-label={t('accentColor')}
            />
          )}
        />
      </div>

      {/* THE BACKGROUND PICKER IS GONE, and that is the point. It was the
          half of the pair that crossed with the theme above; a preset carries
          the background for BOTH colour schemes, so there is nothing left to
          choose separately. A studio that had picked a colour or a gradient
          keeps it until it chooses a preset here — the renderer falls back. */}
    </div>
  )
}

// ─── links tab ────────────────────────────────────────────────────────────────

// Display label for a page-link target (badge + Add-menu item + chip).
function useTargetLabel() {
  const t = useTranslations('BioLink')
  const KEYS: Record<SystemLinkTarget, Parameters<typeof t>[0]> = {
    booking: 'bookingLink',
    events: 'eventsLink',
    signup: 'membershipLink',
    shop: 'shopLink',
    'shop-subscriptions': 'subscriptionsLink',
    'shop-products': 'productsLink',
    'shop-courses': 'shopCoursesLink',
    space: 'coursesLink',
    site: 'siteLink',
    documents: 'documentsLink',
  }
  return (target: SystemLinkTarget): string => t(KEYS[target])
}

function LinksTab({
  control,
  register,
  availableTargets,
}: {
  control: ReturnType<typeof useForm<FormData>>['control']
  register: ReturnType<typeof useForm<FormData>>['register']
  availableTargets: SystemLinkTarget[]
}) {
  const t = useTranslations('BioLink')
  const targetLabel = useTargetLabel()
  const { fields, append, remove, move } = useFieldArray({ control, name: 'links' })
  // Live values for the collapsed card headers — useFieldArray `fields` is a snapshot.
  const watched = useWatch({ control, name: 'links' })

  // Which link card is expanded; a newly-added link auto-expands.
  const [openId, setOpenId] = useState<string | null>(null)
  const wantOpenLast = useRef(false)
  useEffect(() => {
    if (wantOpenLast.current && fields.length > 0) {
      setOpenId(fields[fields.length - 1].id)
      wantOpenLast.current = false
    }
  }, [fields.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Page links (booking, signup, shop, courses, website) and custom links share ONE
  // list so they can be reordered freely. Page links carry a badge and have no URL
  // field; both kinds are added via the "Add link" placeholder menu below.
  const usedTargets = new Set(
    (fields as Array<{ target?: SystemLinkTarget }>).map((f) => f.target).filter(Boolean)
  )
  const addableTargets = availableTargets.filter((tgt) => !usedTargets.has(tgt))

  function addPageLink(target: SystemLinkTarget) {
    wantOpenLast.current = true
    append({
      label: targetLabel(target),
      description: '',
      url: '',
      showInBioLink: true,
      iconName: SYSTEM_LINK_META[target].defaultIcon,
      target,
    })
  }

  function addCustomLink() {
    wantOpenLast.current = true
    append({ label: '', description: '', url: '', showInBioLink: true })
  }

  return (
    <div className="space-y-2.5">
      <SortableList ids={fields.map((sf) => sf.id)} onReorder={move}>
        {fields.map((field, i) => {
          const f = field as typeof field & { target?: SystemLinkTarget }
          const wl = watched?.[i] as Partial<FormData['links'][number]> | undefined
          const systemBadge = f.target ? targetLabel(f.target) : null
          const isSystem = systemBadge !== null
          const iconName =
            (wl?.iconName as string | undefined) ||
            (f.target ? SYSTEM_LINK_META[f.target].defaultIcon : 'Link2')
          const open = openId === field.id
          const displayLabel =
            (wl?.label as string | undefined) || (isSystem ? systemBadge! : t('addCustomLink'))
          return (
            <SortableItem id={field.id} key={field.id}>
              {({ setNodeRef, style, attributes, listeners, isDragging }) => (
                <div
                  ref={setNodeRef}
                  style={style}
                  className={`rounded-lg border bg-card${wl?.showInBioLink === false ? ' opacity-60' : ''}${
                    isDragging ? ' shadow-lg ring-1 ring-border' : ''
                  }`}
                >
                  {/* Card header — mirrors the website builder section card */}
                  <div className="flex items-center gap-1.5 p-3">
                    <button
                      type="button"
                      {...attributes}
                      {...listeners}
                      className="shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                    >
                      <GripVertical className="h-4 w-4" />
                    </button>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <DynamicIcon name={iconName} className="h-4 w-4" />
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : field.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{displayLabel}</span>
                        {isSystem && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {systemBadge}
                          </Badge>
                        )}
                      </div>
                      {!isSystem && (
                        <p className="truncate text-xs text-muted-foreground">
                          {(wl?.url as string | undefined) || 'https://'}
                        </p>
                      )}
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Controller
                        control={control}
                        name={`links.${i}.showInBioLink`}
                        render={({ field: cf }) => (
                          <Tip label={t('showOnBioLink')}>
                            <button
                              type="button"
                              onClick={() => cf.onChange(!cf.value)}
                              aria-label={t('showOnBioLink')}
                              className="rounded p-1 hover:bg-muted"
                            >
                              {cf.value === false ? (
                                <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </Tip>
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : field.id)}
                        className="rounded p-1 hover:bg-muted"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (open) setOpenId(null)
                          remove(i)
                        }}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Collapsible body */}
                  {open && (
                    <div className="space-y-3 border-t p-3">
                      <div className="flex gap-2 items-start">
                        <Controller
                          control={control}
                          name={`links.${i}.iconName`}
                          render={({ field: cf }) => <IconPicker value={cf.value} onChange={cf.onChange} />}
                        />
                        <div className="flex-1 space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              {...register(`links.${i}.label`)}
                              placeholder={t('linkLabel')}
                              className="h-9 text-sm"
                            />
                            <Input
                              {...register(`links.${i}.description`)}
                              placeholder={t('linkDesc')}
                              className="h-9 text-sm"
                            />
                          </div>
                          {!isSystem && (
                            <Input
                              {...register(`links.${i}.url`)}
                              type="url"
                              placeholder="https://"
                              className="h-9 text-sm font-mono"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </SortableItem>
          )
        })}
      </SortableList>

      {/* Add link — dashed placeholder mirrors the website builder's "Add section" */}
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-input py-3 text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground">
          <Plus className="h-4 w-4" />
          {t('addLink')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onClick={addCustomLink} className="gap-2">
            <DynamicIcon name="Link2" className="h-4 w-4 text-muted-foreground" />
            {t('addCustomLink')}
          </DropdownMenuItem>
          {addableTargets.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t('addPageLink')}
                </DropdownMenuLabel>
                {addableTargets.map((tgt) => (
                  <DropdownMenuItem key={tgt} onClick={() => addPageLink(tgt)} className="gap-2">
                    <DynamicIcon
                      name={SYSTEM_LINK_META[tgt].defaultIcon}
                      className="h-4 w-4 text-muted-foreground"
                    />
                    {targetLabel(tgt)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// ─── social tab ───────────────────────────────────────────────────────────────

function SocialTab({ register }: { register: ReturnType<typeof useForm<FormData>>['register'] }) {
  const t = useTranslations('BioLink')

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('socialDesc')}</p>
      {SOCIAL_PLATFORMS.map((platform) => (
        <div key={platform} className="flex items-center gap-3">
          <span className="text-sm font-medium w-24 shrink-0">{SOCIAL_LABELS[platform]}</span>
          <Input
            {...register(platform as keyof FormData)}
            placeholder="https://"
            className="h-8 text-sm font-mono"
          />
        </div>
      ))}
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

const BIO_TABS = ['appearance', 'links', 'social'] as const
type Tab = (typeof BIO_TABS)[number]

// ─── share preview (UX-31) ───────────────────────────────────────────────────
//
// WHAT THE STUDIO IS ACTUALLY SHARING. The panel beside this one shows the PAGE;
// this shows the LINK — the card WhatsApp, Instagram, LinkedIn and Slack build
// from the metadata `(public)/public/[slug]/page.tsx` emits. The two are the
// same three facts (cover image, name, description) on purpose: a preview that
// does not look like what a visitor receives is not a preview.
//
// It is a faithful mock, not a live unfurl — nothing here fetches the page. It
// reads the same fields the metadata reads, from the form the studio is editing,
// so an image swapped a second ago is already reflected.
function SharePreview({
  url,
  name,
  description,
  imageUrl,
}: {
  url: string
  name: string
  description?: string
  imageUrl: string | null
}) {
  const t = useTranslations('BioLink')
  const host = url.replace(/^https?:\/\//, '').split('/')[0]

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Share2 className="h-3.5 w-3.5" />
        {t('sharePreview')}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="h-32 w-full object-cover" />
        ) : (
          <div className="flex h-32 w-full items-center justify-center bg-muted text-xs text-muted-foreground">
            {t('sharePreviewNoImage')}
          </div>
        )}
        <div className="space-y-0.5 p-3">
          <p className="text-xs uppercase text-muted-foreground">{host}</p>
          <p className="truncate text-sm font-semibold">{name}</p>
          {description ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>
          ) : (
            // An empty description is the common case and it shows as a blank
            // line in every chat app, so it is named here with the way to fix
            // it rather than left as a gap the studio has to interpret.
            <p className="text-xs text-muted-foreground">
              {t('sharePreviewNoDescription')}{' '}
              <Link href={'/settings/team' as Route} className="text-primary hover:underline">
                {t('sharePreviewEditDescription')}
              </Link>
            </p>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('sharePreviewHint')}</p>
    </div>
  )
}

export default function TeamBioLinkEditorPage() {
  const { currentTeamId } = useAuth()
  const { data: team, isLoading } = useTeam(currentTeamId)
  // Public-surface availability comes from the shared usePublicSurfaces hook so the
  // page-link picker and the "Public page" hub read identical state (no drift).
  const { flags } = usePublicSurfaces()
  const { coursesActive, connectEnabled, productsActive, websiteActive, documentsLive, eventsLive } = flags

  // Page-link surfaces this team can offer (before subtracting already-added). The
  // generic `shop` target stays valid for back-compat but isn't suggested — the three
  // shop sections (memberships/products/courses) deep-link the relevant tab instead.
  // booking/signup are base features; the rest follow their plugin / Connect state.
  const offeredTargets: SystemLinkTarget[] = [
    'booking',
    'signup',
    'shop-subscriptions',
    'shop-products',
    'shop-courses',
    'space',
    'site',
    'documents',
    'events',
  ]
  const availableTargets = offeredTargets.filter((tgt) => {
    if (tgt === 'shop-subscriptions') return connectEnabled
    if (tgt === 'shop-products') return productsActive
    if (tgt === 'shop-courses') return coursesActive
    if (tgt === 'space') return coursesActive
    if (tgt === 'site') return websiteActive
    // documents surface goes live once the plugin is installed AND ≥1 published +
    // public document exists — same "published content, not just plugin" gating
    // as site/space (activeSurfaces computed server-side by syncTeamPublicProfile).
    if (tgt === 'documents') return documentsLive
    // Events are a base feature but PRIVATE by default, so the surface is live
    // only once the studio has published one — same "published content, not just
    // a feature" gating as documents.
    if (tgt === 'events') return eventsLive
    return true // booking, signup
  })
  const qc = useQueryClient()
  const t = useTranslations('BioLink')

  const [tab, setTab] = useTabParam(BIO_TABS, 'links')
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null)
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null)

  // Initialise image state when team loads
  useEffect(() => {
    if (team) {
      setProfileImageUrl(team.profileImage ?? null)
      setHeroImageUrl(team.heroImage ?? null)
    }
  }, [team?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isSubmitting, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: getDefaults(team ?? null),
  })

  // Re-populate form when team data arrives.
  useEffect(() => {
    if (team) reset(getDefaults(team))
  }, [team?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live preview values
  const formValues = useWatch({ control })

  // Ctrl/Cmd+S saves the bio-link form (when there are unsaved changes).
  useSaveShortcut(() => {
    if (isDirty && !isSubmitting) handleSubmit(onSubmit, onInvalidForm)()
  })

  // ── image helpers ────────────────────────────────────────────────────────

  async function uploadImage(file: File, path: string): Promise<string> {
    const ext = file.name.split('.').pop() ?? 'jpg'
    const sRef = storageRef(storage, `${path}.${ext}`)
    await uploadBytes(sRef, file)
    return getDownloadURL(sRef)
  }

  async function handleProfileUpload(file: File) {
    if (!currentTeamId) return
    const url = await uploadImage(file, `teams/${currentTeamId}/portal/profile`)
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { profileImage: url })
    setProfileImageUrl(url)
    await qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
  }

  async function handleHeroUpload(file: File) {
    if (!currentTeamId) return
    const url = await uploadImage(file, `teams/${currentTeamId}/portal/hero`)
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { heroImage: url })
    setHeroImageUrl(url)
    await qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
  }

  async function handleProfileRemove() {
    if (!currentTeamId) return
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { profileImage: null })
    setProfileImageUrl(null)
    await qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
  }

  async function handleHeroRemove() {
    if (!currentTeamId) return
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { heroImage: null })
    setHeroImageUrl(null)
    await qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
  }

  // ── save ──────────────────────────────────────────────────────────────────

  async function onSubmit(data: FormData) {
    if (!currentTeamId) return

    const socialLinks = SOCIAL_PLATFORMS.filter(
      (p) => data[p as keyof FormData] as string | undefined
    ).map((p) => ({ platform: p, url: data[p as keyof FormData] as string }))

    // Firestore rejects `undefined` values — strip them before any write
    const bioLinkPayload = stripUndefined({
      // WRITTEN ONLY WHEN CHOSEN, and the legacy fields are left exactly as they
      // are. A studio that set its look with the old controls and has not
      // touched the picker keeps that look; converting a live public page as a
      // side effect of saving an unrelated field would be a change nobody asked
      // for. `resolveBioLinkPalette` reads the preset first and falls back.
      ...(data.themePreset ? { bioLinkThemePreset: data.themePreset } : {}),
      bioLinkAccentColor: data.accentColor,
      socialLinks,
      links: data.links,
    })

    try {
      // ① Write public_profile first — only needs team-member permission, source of
      //    truth for the public bio-link. Must succeed.
      const profileRef = doc(db, TEAMS_COLLECTION, currentTeamId, PUBLIC_PROFILE_SUBCOLLECTION, currentTeamId)
      await setDoc(
        profileRef,
        stripUndefined({
          type: 'team',
          slug: team?.slug ?? '',
          name: team?.name ?? '',
          ...bioLinkPayload,
        }),
        { merge: true }
      )

      // ② Also update the team doc (needs owner role) so the editor form re-hydrates
      //    correctly after reload. Non-fatal: log but don't fail the whole save.
      updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
        ...bioLinkPayload,
      }).catch((err) => {
        console.warn('[bio-link save] team doc update failed (non-fatal):', err)
      })

      await qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
      toast.success('Bio-link settings saved')
    } catch (err) {
      console.error('[bio-link save] failed:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to save. Please try again.')
    }
  }

  function onInvalidForm(errors: FieldErrors<FormData>) {
    toast.error('Some fields have errors — check the form and try again.')
    console.error('[bio-link save] form validation errors:', JSON.stringify(errors, null, 2))
  }

  // ── preview data ──────────────────────────────────────────────────────────

  const previewTeam = {
    name: team?.name ?? '',
    description: team?.description,
    profileImage: profileImageUrl ?? undefined,
    heroImage: heroImageUrl ?? undefined,
    // The preview reads the same fields the public page does, in the same
    // order — preset first, the stored legacy pair behind it.
    bioLinkThemePreset: (formValues.themePreset as SurfaceThemePresetId) || undefined,
    bioLinkTheme: team?.bioLinkTheme,
    bioLinkAccentColor: formValues.accentColor,
    bioLinkBackground: team?.bioLinkBackground,
    socialLinks: SOCIAL_PLATFORMS.filter(
      (p) => formValues[p as keyof FormData] as string | undefined
    ).map((p) => ({ platform: p, url: formValues[p as keyof FormData] as string })),
    links: formValues.links as typeof team extends null ? undefined : Team['links'],
  }

  // ── loading / no team ─────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  if (!team || !currentTeamId) {
    return <p className="text-muted-foreground">{t('noTeam')}</p>
  }

  if (!team.slug) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <div className="rounded-xl border bg-muted/30 p-10 text-center space-y-2">
          <Globe className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="font-medium">{t('noSlugTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('noSlugDesc')}</p>
          {/* Was a raw <a href="../settings"> — a relative href that bypasses
              @/i18n/navigation and resolves wrongly under a locale prefix
              (UX-99). It now points at the page that actually holds the slug. */}
          <Link href={'/settings/team' as Route} className="text-sm text-primary hover:underline">
            {t('goToSettings')} →
          </Link>
        </div>
      </div>
    )
  }

  const bioLinkUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/public/${team.slug}`
      : `/public/${team.slug}`

  const tabs: { key: Tab; label: string }[] = [
    { key: 'links', label: t('tabLinks') },
    { key: 'appearance', label: t('tabAppearance') },
    { key: 'social', label: t('tabSocial') },
  ]

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <a
            href={bioLinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline flex items-center gap-1 mt-0.5"
          >
            {bioLinkUrl.replace(/^https?:\/\//, '')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <Button onClick={handleSubmit(onSubmit, onInvalidForm)} disabled={isSubmitting}>
          {isSubmitting ? t('saving') : t('save')}
        </Button>
      </div>

      {/* Two-column layout */}
      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        {/* ── Left: settings ── */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Tabs */}
          <div className="flex gap-0 border-b">
            {tabs.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === key
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit(onSubmit, onInvalidForm)}>
            {tab === 'appearance' && (
              <AppearanceTab
                control={control}
                profileImageUrl={profileImageUrl}
                heroImageUrl={heroImageUrl}
                onProfileUpload={handleProfileUpload}
                onHeroUpload={handleHeroUpload}
                onProfileRemove={handleProfileRemove}
                onHeroRemove={handleHeroRemove}
              />
            )}
            {tab === 'links' && (
              <LinksTab
                control={control}
                register={register}
                availableTargets={availableTargets}
              />
            )}
            {tab === 'social' && <SocialTab register={register} />}
          </form>
        </div>

        {/* ── Right: sticky preview ── */}
        <div className="lg:w-[400px] lg:flex-shrink-0 lg:sticky lg:top-6 lg:self-start space-y-4">
          {/* The LINK first, the PAGE below it: the card is what a prospect sees
              before they decide whether to tap at all. */}
          <SharePreview
            url={bioLinkUrl}
            name={team.name}
            description={team.description}
            imageUrl={heroImageUrl ?? profileImageUrl}
          />
          <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <Eye className="h-3.5 w-3.5" />
              {t('preview')}
            </div>
            <a
              href={bioLinkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              {t('openBioLink')}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="rounded-xl border overflow-hidden max-h-[calc(100vh-12rem)] overflow-y-auto shadow-sm">
            {/* Links are inert in the preview (onLinkClick prevents navigation). */}
            <BioLinkHome team={previewTeam} slug={team.slug} onLinkClick={() => {}} />
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Recursively removes `undefined` values so Firestore never sees them. */
function stripUndefined<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T
}

// Normalises stored links for the form, mapping any legacy is{Booking,Membership,
// Courses,Shop}Link booleans to the new `target` page-link discriminator. No
// injection/filtering — page links are added explicitly via the "+ Add" menu.
function buildLinks(rawLinks: Team['links']): FormData['links'] {
  return (rawLinks ?? []).map((l) => ({
    label: typeof l.label === 'string' ? l.label : '',
    description: typeof l.description === 'string' ? l.description : undefined,
    url: typeof l.url === 'string' ? l.url : '',
    showInBioLink:
      l.showInBioLink === true || l.showInBioLink === false ? l.showInBioLink : false,
    iconName: typeof l.iconName === 'string' ? l.iconName : undefined,
    target: resolveSystemLinkTarget(l) ?? undefined,
  }))
}

function getDefaults(team: Team | null): FormData {
  const sl = team?.socialLinks ?? []
  const getSocial = (p: SocialPlatform) => sl.find((s) => s.platform === p)?.url ?? ''

  return {
    themePreset: team?.bioLinkThemePreset ?? '',
    accentColor: typeof team?.bioLinkAccentColor === 'string' ? team.bioLinkAccentColor : DEFAULT_ACCENT,
    facebook: getSocial('facebook'),
    youtube: getSocial('youtube'),
    tiktok: getSocial('tiktok'),
    x: getSocial('x'),
    linkedin: getSocial('linkedin'),
    whatsapp: getSocial('whatsapp'),
    website: getSocial('website'),
    review: getSocial('review'),
    // Normalise stored links + map any legacy boolean flags to `target`.
    links: buildLinks(team?.links ?? []),
  }
}
