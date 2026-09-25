"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

// ─── Items registry ──────────────────────────────────────────────────────────
// SelectContent parses its children during render to extract value→label pairs
// and syncs them to SelectPrimitive.Root via the `items` prop (Base UI's native
// mechanism). This avoids relying on portaled SelectItem effects, which only
// fire after the popup is first opened.
//
// modal={false} prevents Base UI's scroll lock from hiding the page scrollbar.

type SelectEntry = { value: unknown; label: string }

const SetItemsCtx = React.createContext<React.Dispatch<React.SetStateAction<SelectEntry[]>> | null>(null)

function extractEntries(children: React.ReactNode): SelectEntry[] {
  const out: SelectEntry[] = []
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    const p = child.props as Record<string, unknown>
    if (p.value !== undefined && p.value !== null) {
      // `label` also switches the item to the two-line title+sublabel layout, so
      // a row whose children are inline DECORATION (a color dot, an icon, a tree
      // indent) uses `textValue` instead: it registers the trigger's text without
      // touching how the row renders.
      const label =
        p.label ?? p.textValue ?? (typeof p.children === "string" ? p.children : undefined)
      if (label !== undefined) out.push({ value: p.value, label: String(label) })
    } else {
      out.push(...extractEntries(p.children as React.ReactNode))
    }
  })
  return out
}

function Select<Value, Multiple extends boolean | undefined = false>(
  props: SelectPrimitive.Root.Props<Value, Multiple>,
) {
  const [items, setItems] = React.useState<SelectEntry[]>([])
  return (
    <SetItemsCtx.Provider value={setItems}>
      <SelectPrimitive.Root modal={false} items={items} {...props} />
    </SetItemsCtx.Provider>
  )
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />}
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger">) {
  const setItems = React.useContext(SetItemsCtx)

  // Extract value→label mapping from children synchronously during render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = React.useMemo(() => extractEntries(children), [children])

  // Sync to SelectPrimitive.Root before paint via layout effect
  React.useLayoutEffect(() => {
    setItems?.(entries)
  }, [entries, setItems])

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        data-slot="select-positioner"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            // Width: at least the trigger, at least 11rem, then free to grow to
            // fit the longest option (capped to the viewport). Previously pinned
            // to `w-(--anchor-width)`, which truncated options under a narrow
            // field — you couldn't read what you were choosing.
            "relative isolate z-50 max-h-(--available-height) min-w-[max(var(--anchor-width),11rem)] max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  label,
  textValue,
  ...props
}: SelectPrimitive.Item.Props & {
  /** Title of a TWO-LINE item: rendered as the row's text, with `children` shown
   *  beneath it as a muted sublabel. Also what the trigger displays. */
  label?: string
  /** The trigger's text for a row that renders its own inline content — a color
   *  dot, an icon, a hierarchy indent. Registers the label WITHOUT changing the
   *  layout, which is the difference from `label`.
   *
   *  One of `label`, `textValue`, or a plain-string child is REQUIRED: with none
   *  of them nothing registers and the trigger falls back to printing the raw
   *  `value` — a document id, a number, an account code. Pinned by
   *  packages/functions/src/web/selectItemLabels.test.ts. */
  textValue?: string
}) {
  void textValue // consumed by extractEntries during render, not needed here
  const hasRichContent = label !== undefined

  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        hasRichContent ? "flex-col items-start gap-0" : "items-center gap-1.5",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex shrink-0 gap-2 whitespace-nowrap items-center">
        {hasRichContent ? label : children}
      </SelectPrimitive.ItemText>
      {hasRichContent && children && (
        <span className="text-xs text-muted-foreground leading-tight">{children}</span>
      )}
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 top-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
