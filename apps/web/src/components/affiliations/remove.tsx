'use client'

import { httpsCallable } from 'firebase/functions'
import { Trash2 } from 'lucide-react'
import { functions } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * TAKING SOMEBODY OFF THE BOOKS — the action that replaced the 'guest' status.
 *
 * There used to be no way to do this from either roster. The status selector
 * only ever called `upsertAffiliation`, so the nearest thing to "not a member"
 * was picking the built-in `guest` status — which WRITES an affiliation row, and
 * a row is exactly what discloses the contact to the organisation
 * (`orgAdminMayReadContact`). The control labelled "not a member" was the one
 * that made someone a member. `removeAffiliation` existed but was wired only to
 * the contact detail page. See `docs/org-contact-visibility.md`.
 *
 * ── WHY IT IS NOT A VALUE IN THE STATUS LIST ────────────────────────────────
 *
 * Because deleting a row and marking it lapsed are different acts on different
 * people. `expired` keeps the record that this person WAS a member, which is
 * what a federation needs when they come back or ask for proof. Deleting throws
 * that away, and is right only when the row should never have existed. Offering
 * removal as one more entry in the same dropdown would put an irreversible act
 * one mis-click from a routine one, with no confirmation between them — so it is
 * a separate control with its own dialog, and the dialog says which of the two
 * this is.
 *
 * ── AND WHY IT IS NOT A SOFT FLAG ───────────────────────────────────────────
 *
 * The row IS the disclosure, so hiding a contact from the organisation again
 * means the row has to GO. `onAffiliationWrite` recomputes
 * `affiliation_summary` from the rows that remain, so this genuinely reverses:
 * the contact drops out of `org_ids` and the read rule stops admitting the org
 * on the next evaluation. A status that merely read "removed" would leave them
 * visible for ever.
 */

export interface RemoveAffiliationArgs {
  teamId: string
  contactId: string
  affiliationId: string
}

/** The id the UI carries for "this contact holds no affiliation of this type".
 *
 *  A SENTINEL, never a `status_id`. It exists only in component state and in the
 *  keys of the roster's per-status tallies; nothing writes it, and no status def
 *  answers to it. Shaped like the pages' other non-values (`__all__`) so it
 *  cannot collide with a tenant-invented status id. */
export const NO_AFFILIATION = '__none__'

/** Call the removeAffiliation callable for a single affiliation. */
export async function removeAffiliationCall(args: RemoveAffiliationArgs): Promise<void> {
  const fn = httpsCallable<RemoveAffiliationArgs, { success?: boolean }>(
    functions,
    'removeAffiliation',
  )
  await fn(args)
}

/** The row's remove control. Rendered only where there is a row to remove. */
export function RemoveAffiliationButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  )
}

/**
 * Confirmation for a removal. Namespace-agnostic like `RenewConfirmDialog` — the
 * copy comes from whichever surface opened it, so the studio roster and the org
 * roster each keep their own wording.
 */
export function RemoveConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  busy,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  busy?: boolean
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
