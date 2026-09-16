'use client'

/**
 * THE THEME PICKER for a public surface — a wall of preset tiles plus one
 * CUSTOM tile whose colours the studio sets directly.
 *
 * ── TWO WAYS IN ─────────────────────────────────────────────────────────────
 * 1. Pick a preset. No effort — a light/dark pair in one hue, drawn split so
 *    both versions are visible before it is chosen.
 * 2. Pick the custom tile and set the colours: a light-page colour and a
 *    dark-page colour, or one colour for the whole site. The colour you pick IS
 *    the page (see themeDerive.ts) — there is no strength dial, because that was
 *    the thing that made a simple idea feel complicated.
 *
 * ── NOTHING IS PRESELECTED FOR A LEGACY SURFACE ─────────────────────────────
 * `value` is empty for a studio still on the old fields, and the picker says so
 * rather than highlighting a preset it did not choose — its page keeps rendering
 * from the legacy fields until it picks one here.
 *
 * The custom controls render only when `onCustomChange` is passed, so a surface
 * that offers presets only (bio-link, org site) shows the tiles and no more.
 */

import { useTranslations } from 'next-intl'
import { Check, Moon, Palette } from 'lucide-react'
import { SURFACE_THEME_PRESETS, deriveCustomPreset } from '@linyup/shared'
import type { SurfaceThemePresetId } from '@linyup/shared'
import { ColorPicker } from '@/components/ui/color-picker'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'

/** Where the custom colours start before a studio has chosen — a light indigo
 *  page and a deep indigo night, recognisably Linyup rather than an arbitrary
 *  pair. */
export const DEFAULT_CUSTOM_LIGHT = '#eef2ff'
export const DEFAULT_CUSTOM_DARK = '#12162a'

export interface ThemePresetPickerProps {
  /** The chosen preset id, or '' for a surface still on the legacy fields. */
  value: SurfaceThemePresetId | ''
  onChange: (id: SurfaceThemePresetId) => void
  /** The studio's accent, drawn on each swatch so the pairing is visible. */
  accentColor?: string
  disabled?: boolean
  // ── the custom theme — absent handlers mean this surface offers presets only ──
  light?: string
  dark?: string
  single?: boolean
  lighting?: boolean
  onCustomChange?: (next: {
    light: string
    dark?: string
    single: boolean
    lighting: boolean
  }) => void
}

export function ThemePresetPicker({
  value,
  onChange,
  accentColor,
  disabled,
  light,
  dark,
  single,
  lighting,
  onCustomChange,
}: ThemePresetPickerProps) {
  const t = useTranslations('Themes')
  const offersCustom = !!onCustomChange
  const isCustom = value === 'custom'
  const cLight = light || DEFAULT_CUSTOM_LIGHT
  const cDark = dark || DEFAULT_CUSTOM_DARK
  const cSingle = !!single
  const cLighting = !!lighting

  // Derived through the SAME function the renderer uses, so a swatch is never a
  // second approximation of the page.
  const derived = deriveCustomPreset({
    light: cLight,
    dark: dark,
    single: cSingle,
    lighting: cLighting,
  })

  /** One writer for the four custom fields — they are one choice. */
  const emit = (patch: Partial<{ light: string; dark?: string; single: boolean; lighting: boolean }>) =>
    onCustomChange?.({ light: cLight, dark, single: cSingle, lighting: cLighting, ...patch })

  /** Selecting the custom tile has to WRITE the colours, not just the id: a
   *  'custom' theme with no stored light colour resolves to null and the page
   *  would silently fall back to its legacy look. */
  const pickCustom = () => {
    emit({})
    onChange('custom')
  }

  return (
    <div className="space-y-3">
      {/* PROPORTIONAL TILES — four across, so each is about a quarter width and
          a light/dark pair reads at a glance without a giant swatch. */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {SURFACE_THEME_PRESETS.map((preset) => {
          const selected = preset.id === value
          const accent = accentColor || preset.defaultAccent
          return (
            <Tile
              key={preset.id}
              selected={selected}
              disabled={disabled}
              onClick={() => onChange(preset.id)}
              accent={accent}
              lightBg={preset.light.background}
              darkBg={preset.dark.background}
              adaptive={preset.adaptive}
              label={t(preset.nameKey as Parameters<typeof t>[0])}
              badge={!preset.adaptive ? t('alwaysDark') : undefined}
            />
          )
        })}

        {offersCustom && (
          <Tile
            selected={isCustom}
            disabled={disabled}
            onClick={pickCustom}
            accent={accentColor || derived?.defaultAccent || DEFAULT_CUSTOM_DARK}
            lightBg={derived?.light.background ?? cLight}
            darkBg={derived?.dark.background ?? cDark}
            adaptive={!cSingle}
            label={t('custom')}
            icon={<Palette className="h-3 w-3 shrink-0 text-muted-foreground" />}
          />
        )}
      </div>

      {/* THE CUSTOM CONTROLS appear only when the custom tile is chosen —
          two rows, light then dark, the colour on each; a switch to use one
          colour; and the lighting effect. */}
      {offersCustom && isCustom && (
        <div className="space-y-3 rounded-lg border p-3">
          <ColourRow
            label={t('lightColour')}
            value={cLight}
            disabled={disabled}
            onChange={(hex) => emit({ light: hex })}
          />

          {/* The dark row is hidden under "one colour", because there is no dark
              version to set. */}
          {!cSingle && (
            <ColourRow
              label={t('darkColour')}
              value={cDark}
              disabled={disabled}
              onChange={(hex) => emit({ dark: hex })}
              onReset={dark ? () => emit({ dark: undefined }) : undefined}
              resetLabel={t('darkAuto')}
            />
          )}

          <ToggleRow
            label={t('singleColour')}
            hint={t('singleColourHint')}
            checked={cSingle}
            disabled={disabled}
            onChange={(v) => emit({ single: v })}
          />

          <ToggleRow
            label={t('lighting')}
            hint={t('lightingHint')}
            checked={cLighting}
            disabled={disabled}
            onChange={(v) => emit({ lighting: v })}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {isCustom
          ? cSingle
            ? t('customSingleHint')
            : t('customHint')
          : !value
            ? t('legacyHint')
            : SURFACE_THEME_PRESETS.find((p) => p.id === value)?.adaptive
              ? t('adaptiveHint')
              : t('fixedHint')}
      </p>
    </div>
  )
}

function Tile({
  selected,
  disabled,
  onClick,
  accent,
  lightBg,
  darkBg,
  adaptive,
  label,
  badge,
  icon,
}: {
  selected: boolean
  disabled?: boolean
  onClick: () => void
  accent?: string
  lightBg?: string
  darkBg?: string
  adaptive: boolean
  label: string
  badge?: string
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={`group relative overflow-hidden rounded-xl border text-left transition-all disabled:opacity-60 ${
        selected ? 'border-primary ring-2 ring-primary/30' : 'hover:border-primary/50'
      }`}
    >
      <div className="flex h-12">
        {adaptive ? (
          <>
            <div className="flex-1" style={{ background: lightBg }} aria-hidden />
            <div className="flex-1" style={{ background: darkBg }} aria-hidden />
          </>
        ) : (
          <div className="flex-1" style={{ background: lightBg }} aria-hidden />
        )}
      </div>
      {/* The accent over the seam, read against both halves at once. */}
      <span
        className="absolute left-1/2 top-6 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/70 shadow"
        style={{ background: accent }}
        aria-hidden
      />
      {selected && (
        <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
      <div className="flex items-center gap-1 px-2 py-1.5">
        {icon}
        <span className="truncate text-xs font-medium">{label}</span>
        {badge && (
          <Badge variant="outline" className="gap-1 px-1 py-0 text-xs font-normal">
            <Moon className="h-2.5 w-2.5" />
            {badge}
          </Badge>
        )}
      </div>
    </button>
  )
}

function ColourRow({
  label,
  value,
  disabled,
  onChange,
  onReset,
  resetLabel,
}: {
  label: string
  value: string
  disabled?: boolean
  onChange: (hex: string) => void
  onReset?: () => void
  resetLabel?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <ColorPicker
        value={value}
        disabled={disabled}
        aria-label={label}
        className="h-8 w-8"
        onChange={onChange}
      />
      <span className="text-xs font-medium">{label}</span>
      {onReset && (
        <button
          type="button"
          disabled={disabled}
          onClick={onReset}
          className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {resetLabel}
        </button>
      )}
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <div className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </div>
    </div>
  )
}
