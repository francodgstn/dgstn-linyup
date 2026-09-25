'use client'

// One color picker for the whole admin. Replaces the bare `<input type="color">`
// that was copy-pasted across the activities, event-type, bio-link, website,
// ranking and embed surfaces — three of which had already grown their own
// hand-rolled swatch grid off the same palette.
//
// Swatches are the primary affordance on purpose: these colors land on calendar
// blocks and public cards, so a curated palette is what keeps them legible in
// both light and dark mode. Free hex picking stays available for brand colors,
// where the studio genuinely has a specific value in mind.

import { useEffect, useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Input } from './input'
import { cn } from '@/lib/utils'
import { COLOR_PRESETS, DEFAULT_ACCENT, HEX_RE, normalizeHex } from '@/lib/colors'

// The color constants live in `@/lib/colors` (dependency-free) so that public
// routes needing only a hex don't pull react-colorful in via this module.
// Re-exported here for convenience of callers that use both.
export { COLOR_PRESETS, DEFAULT_ACCENT, normalizeHex }

export interface ColorPickerProps {
  value?: string | null
  onChange: (hex: string) => void
  /** Override the swatch palette (defaults to COLOR_PRESETS). */
  presets?: readonly string[]
  /** Class for the trigger swatch — size it to fit the surrounding form. */
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

export function ColorPicker({
  value,
  onChange,
  presets = COLOR_PRESETS,
  className,
  disabled,
  id,
  'aria-label': ariaLabel,
}: ColorPickerProps) {
  const color = normalizeHex(value)
  // Local draft so a half-typed hex ("#3b8") doesn't fire onChange on every
  // keystroke; only committed once it parses.
  const [draft, setDraft] = useState(color)
  useEffect(() => setDraft(color), [color])

  function commitDraft(next: string) {
    setDraft(next)
    if (HEX_RE.test(next.trim())) onChange(next.trim().toLowerCase())
  }

  return (
    <Popover>
      <PopoverTrigger
        id={id}
        disabled={disabled}
        aria-label={ariaLabel ?? color}
        className={cn(
          'h-9 w-14 shrink-0 rounded-md border border-input bg-background p-1 transition-colors hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        <span
          className="block h-full w-full rounded-sm ring-1 ring-inset ring-foreground/10"
          style={{ background: color }}
        />
      </PopoverTrigger>

      <PopoverContent className="w-60 space-y-3 p-3">
        <div className="grid grid-cols-8 gap-1.5">
          {presets.map((p) => {
            const active = normalizeHex(p) === color
            return (
              <button
                key={p}
                type="button"
                onClick={() => onChange(normalizeHex(p))}
                aria-label={p}
                aria-pressed={active}
                className={cn(
                  'h-5 w-5 rounded-full ring-1 ring-inset ring-foreground/10 transition-transform hover:scale-115',
                  active && 'ring-2 ring-foreground ring-offset-2 ring-offset-popover'
                )}
                style={{ background: p }}
              />
            )
          })}
        </div>

        <HexColorPicker
          color={color}
          onChange={onChange}
          style={{ width: '100%', height: 132 }}
        />

        <Input
          value={draft}
          onChange={(e) => commitDraft(e.target.value)}
          onBlur={() => setDraft(color)}
          spellCheck={false}
          aria-label="Hex"
          className="h-8 font-mono text-xs"
        />
      </PopoverContent>
    </Popover>
  )
}
