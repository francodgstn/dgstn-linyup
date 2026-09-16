'use client'

import { useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ICON_CATEGORIES } from '@/lib/bioLink'
import { Tip } from '@/components/ui/tip'

// ─── dynamic icon renderer ────────────────────────────────────────────────────

export function DynamicIcon({ name, className }: { name?: string; className?: string }) {
  if (!name) return <Globe className={className} />
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Icon = (LucideIcons as any)[name] as React.FC<{ className?: string }> | undefined
  return Icon ? <Icon className={className} /> : <Globe className={className} />
}

// ─── icon picker ─────────────────────────────────────────────────────────────

interface Props {
  value?: string
  onChange: (name: string) => void
  className?: string
}

export function IconPicker({ value, onChange, className }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
          className
        )}
      >
        <DynamicIcon name={value} className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
          {ICON_CATEGORIES.map((cat) => (
            <div key={cat.label}>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                {cat.label}
              </p>
              <div className="grid grid-cols-6 gap-1">
                {cat.icons.map((name) => (
                  <Tip key={name} label={name}>
                    <button
                      type="button"
                      aria-label={name}
                      onClick={() => {
                        onChange(name)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded hover:bg-muted transition-colors',
                        value === name &&
                          'bg-primary/10 text-primary ring-1 ring-inset ring-primary/30'
                      )}
                    >
                      <DynamicIcon name={name} className="h-4 w-4" />
                    </button>
                  </Tip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
