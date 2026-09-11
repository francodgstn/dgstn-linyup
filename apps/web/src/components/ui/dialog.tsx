"use client"

/**
 * Dialog primitive.
 *
 * ── THE SCROLL RULE (read this before adding a long dialog) ──────────────────
 *
 * A dialog that can outgrow the viewport scrolls its BODY, never the popup.
 * Scroll the popup and the footer scrolls with it, so the manager finishes a
 * long form and then has to scroll back down to find Save — and on a short
 * viewport she cannot see the primary action while touching the last field.
 * The close button rides away with it too.
 *
 * So: never put `max-h-*` / `overflow-y-auto` on `DialogContent`. Wrap the
 * scrollable part in `<DialogBody>` instead. Its presence is the opt-in — the
 * popup then becomes a flex column with a viewport-bounded height, and the
 * header and footer are fixed rows around the scrolling body.
 *
 *   <DialogContent className="sm:max-w-lg">
 *     <DialogHeader>…</DialogHeader>
 *     <DialogBody className="space-y-4">…fields…</DialogBody>
 *     <DialogFooter>…</DialogFooter>
 *   </DialogContent>
 *
 * If the footer lives INSIDE the form (so the submit button stays a plain
 * `type="submit"`), the form is the row that has to grow, so it joins the flex
 * chain and carries the spacing the body no longer inherits:
 *
 *   <DialogContent className="sm:max-w-lg">
 *     <DialogHeader>…</DialogHeader>
 *     <form onSubmit={…} className="flex min-h-0 flex-1 flex-col gap-4">
 *       <DialogBody className="space-y-4">…fields…</DialogBody>
 *       <DialogFooter>…</DialogFooter>
 *     </form>
 *   </DialogContent>
 *
 * `DialogBody` gives its children no spacing of its own — carry over whatever
 * rhythm they had (the popup's own gap is `gap-6`).
 *
 * Short dialogs need no decision: a two-line confirm has no `DialogBody`, so
 * nothing changes for it, and even one that opts in only shows the pin once the
 * body actually overflows (`max-h` is a maximum, not a height). A form-level
 * error belongs in the pinned footer, where it stays visible with the button
 * it blocks.
 *
 * THE SLOT ALSO DECIDES MOBILE POSITION. A dialog carrying a `DialogBody` is
 * pinned near the TOP of a phone screen instead of being centred — see the note
 * beside that rule in `DialogContent`. So opting into the scroll behaviour and
 * opting into the mobile placement are one decision, made once, by the same
 * signal: this dialog can be tall.
 *
 * `AlertDialog` (./alert-dialog.tsx) deliberately does NOT share this — see the
 * note there.
 */

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          // A DialogBody anywhere inside turns the popup into a bounded flex
          // column: the body scrolls, the header/footer/close button do not.
          // Without one the popup is untouched — see THE SCROLL RULE above.
          "has-data-[slot=dialog-body]:flex has-data-[slot=dialog-body]:max-h-[calc(100dvh-2rem)] has-data-[slot=dialog-body]:flex-col has-data-[slot=dialog-body]:overflow-hidden",
          // ── ON A PHONE, A TALL DIALOG RISES TO THE TOP ─────────────────────
          // Centring is right for a two-line confirm and wrong for anything
          // that scrolls. A picker with a search field, centred on a phone,
          // puts that field near the middle of the screen — and the moment it
          // is focused the keyboard covers the bottom half, so the list you are
          // filtering is mostly gone. `position: fixed` measures the LAYOUT
          // viewport, which the keyboard does not shrink, so the popup does not
          // move out of the way on its own.
          //
          // Gated on the same `DialogBody` signal as the height rule above,
          // deliberately: that slot is already this file's declaration of "this
          // dialog can outgrow the viewport", which is exactly the set that
          // benefits. A short confirm keeps the centring it should have.
          // (The height cap above is already `100dvh - 2rem`, which is exactly
          // what a 1rem top inset leaves — so it needs no mobile variant.)
          "has-data-[slot=dialog-body]:max-sm:top-4 has-data-[slot=dialog-body]:max-sm:translate-y-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-2", className)}
      {...props}
    />
  )
}

/**
 * The scrolling middle row. Its presence is what switches `DialogContent` into
 * a pinned header/footer layout — see THE SCROLL RULE at the top of this file.
 * Carries no spacing of its own: pass the rhythm its children need.
 *
 * ── WHY IT SAYS `overflow-x-hidden` TOO ────────────────────────────────────
 * `overflow-y: auto` alone does NOT leave the other axis alone: CSS promotes
 * `overflow-x: visible` to `auto` whenever the other axis is not visible. So
 * every dialog with a body silently gained a horizontal scrollbar the moment
 * any child was a pixel too wide — reported on the subscription form during the
 * prod canary of 2026-08-23.
 *
 * This is the BACKSTOP, not the fix. The fix is that the child wraps or shrinks
 * (the price row there now does both), because hiding an overflow hides a
 * control. It is here because a scrollbar under a form is never the right answer
 * for any dialog, so the default should not be able to produce one.
 */
/**
 * ── WHY IT BLEEDS TO THE RIGHT EDGE (`-mr-4 pr-4`) ──────────────────────────
 * A scrollbar is painted at its container's border edge, and the container used
 * to stop at the popup's `p-4` padding — which put the scrollbar 16px inside the
 * popup, exactly the band the close button occupies. On the subscription form
 * the two overlapped outright: the button spans 8–36px from the right edge, the
 * scrollbar 16–21px.
 *
 * Padding cannot fix that (it is INSIDE the scroll container, so the scrollbar
 * does not move). The container itself has to reach the popup's edge, which is
 * what the negative margin does; `pr-4` then gives the CONTENT back the inset it
 * just lost. This assumes the popup's default `p-4`, the same assumption
 * `DialogFooter` already makes one function below.
 *
 * ── A POPUP THAT PASSES `p-0` MUST PASS `mr-0` HERE ────────────────────────
 *
 * A full-bleed dialog (its own bordered header, `DialogContent className="…
 * p-0"`) has no padding for the negative margin to cancel, so the body reaches
 * 16px PAST the popup's right edge and every child lands flush against the
 * border — while the left keeps its inset, which is what makes it read as "the
 * modal lost its padding" rather than as an overflow. Both dialogs that do this
 * (the affiliations type manager, the website preview) pass `mr-0`; a third one
 * should too.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mr-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-4", className)}
      {...props}
    />
  )
}

/**
 * The pinned footer. `-mx-4 -mb-4` bleeds it to the dialog's edges, which
 * ASSUMES the content is padded `p-4` (the default).
 *
 * ON A `p-0` DIALOG, PASS `mx-0 mb-0`. Without it the footer is laid out 1rem
 * outside the content box on three sides, and since a dialog carrying a
 * `DialogBody` is also `overflow-hidden`, that rim is clipped — the trailing
 * button loses its corner and looks jammed into the edge.
 */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-semibold",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
