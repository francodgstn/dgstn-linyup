'use client'

// Refund a Connect payment — and, with it, the access the payment bought.
//
// The dialog offers an EDITABLE AMOUNT, which is the whole point of it: making
// a manager retype a money figure under pressure is the fat-finger failure this
// area is about, and a "cancellation fee" is nothing more than a smaller number
// typed here. It is only ever a suggestion on the wire — the callable checks it
// against what is still refundable and refuses what it cannot honor.
//
// WHERE THE CLIENT AND THE SERVER MUST AGREE. Two refusals remove partial
// refunds entirely:
//   • a COURSE is indivisible, and the client can prove that from the line item
//     alone — so it does not offer the option at all;
//   • a SUBSCRIPTION may be a divisible class pack or a plain plan, and the
//     client cannot tell — so it offers the option and renders the server's
//     refusal inline, next to the way out ("Refund the full amount instead").
// Suppress what is provable, explain the rest. Do not add a client-side rule
// that guesses at the rest — that is how the two sides drift.
//
// `full_refund_on_consumed_pack` IS A POLICY, NOT A FAILURE, and it reads like
// one: what is true ("Ana has used 3 of the 10 classes on this pack") and the
// rule ("A pack that has been used cannot be refunded here"). It has NO "what
// now" beat and no primary button — a used pack is not refundable in the app,
// and that is the decision rather than a gap. A disabled Refund button was worse
// than none: it asks the reader to work out what would enable it, and nothing
// would.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRefundMemberPayment } from '@/hooks/useConnect'
import { formatMoneyMinor, type UnifiedPaymentRow } from '@/lib/payments'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** `details` of the `full_refund_on_consumed_pack` refusal — two numbers and no
 *  money, because the refusal states a rule rather than proposing an amount. */
interface ConsumedPackFacts {
  unitsGranted: number
  unitsConsumed: number
}

function factsFrom(details: unknown): ConsumedPackFacts | null {
  const d = details as Partial<ConsumedPackFacts> | undefined
  if (!d || typeof d.unitsGranted !== 'number' || typeof d.unitsConsumed !== 'number') return null
  return { unitsGranted: d.unitsGranted, unitsConsumed: d.unitsConsumed }
}

function minorFromMajorInput(text: string): number | null {
  const n = Number(text.replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

export function RefundPaymentDialog({
  teamId,
  target,
  memberName,
  onClose,
}: {
  teamId: string
  target: UnifiedPaymentRow | null
  /** Display name of the contact the payment is assigned to, when known. */
  memberName?: string | null
  onClose: () => void
}) {
  const t = useTranslations('PaymentsDashboard')
  const refund = useRefundMemberPayment()

  const [packFacts, setPackFacts] = useState<ConsumedPackFacts | null>(null)
  const [editing, setEditing] = useState(false)
  const [amountText, setAmountText] = useState('')
  const [inlineError, setInlineError] = useState<string | null>(null)
  /** Set once the server has told us this row is a class pack. Only then can the
   *  client know a partial is pointless — before that it cannot tell a pack from
   *  a plain plan, so it must keep offering the option. */
  const [partialRefused, setPartialRefused] = useState(false)

  // Every open starts clean — a refusal from the previous row must not carry over.
  useEffect(() => {
    setPackFacts(null)
    setEditing(false)
    setAmountText('')
    setInlineError(null)
    setPartialRefused(false)
  }, [target?.key])

  if (!target) return null

  const currency = target.currency
  // WHAT A FULL REFUND ACTUALLY RETURNS — the gross MINUS what has already gone
  // back, because a `partially_refunded` row is refundable again. Every amount
  // this dialog prints comes from here: showing the gross next to a Refund
  // button is a wrong money figure at the exact moment a manager commits.
  const maxRefundableMinor = Math.max(0, target.amount - target.amountRefunded)
  const who = memberName?.trim() || t('unassigned')

  const editedMinor = editing ? minorFromMajorInput(amountText) : null
  const amountInvalid =
    editing && (editedMinor === null || editedMinor > maxRefundableMinor)

  /** What the primary button will send: undefined = a full refund. */
  const submitMinor: number | undefined = editing ? (editedMinor ?? undefined) : undefined

  const primaryLabel = editing
    ? t('refundAmountAction', {
        amount: formatMoneyMinor(editedMinor ?? 0, currency),
      })
    : t('refundAmountAction', { amount: formatMoneyMinor(maxRefundableMinor, currency) })

  // A USED PACK IS A DEAD END, and it looks like one: no primary button at all.
  // Nothing the manager can type here would work, so offering a control — even a
  // disabled one — would only invite the question of what unlocks it.
  const isPolicyStatement = !!packFacts
  const primaryDisabled = refund.isPending || amountInvalid

  // Offered unless the client can PROVE it is pointless: a course is
  // indivisible by kind, and a pack has said so already.
  const partialOffered =
    target.lineItem?.kind !== 'course' && !partialRefused && !isPolicyStatement

  function openEditor(prefillMinor: number) {
    setEditing(true)
    setInlineError(null)
    setAmountText((prefillMinor / 100).toFixed(2))
  }

  async function submit() {
    if (!target) return
    setInlineError(null)
    try {
      const res = await refund.mutateAsync({
        teamId,
        paymentIntentId: target.paymentId,
        ...(submitMinor !== undefined ? { amount: submitMinor } : {}),
      })
      // The money went back; the access did not. Not a failure of the refund —
      // but the studio has to finish the job by hand, so it must not be silent.
      if (res.reversal?.state === 'failed') {
        toast.warning(t('refundReversalFailed', { name: who }))
      } else if (res.subscriptionCancelled === 'failed') {
        // The money went back but the membership may still renew: the studio
        // has to cancel it by hand, so this must not read as a clean success.
        toast.warning(t('refundSubscriptionCancelFailed', { name: who }))
      } else if (res.subscriptionCancelled === 'cancelled') {
        toast.success(t('refundSubscriptionCancelled'))
      } else {
        toast.success(t('refundSuccess'))
      }
      onClose()
    } catch (err) {
      const e = err as { details?: Record<string, unknown> }
      const reason = e?.details?.reason as string | undefined
      if (reason === 'full_refund_on_consumed_pack') {
        const f = factsFrom(e.details)
        if (f) {
          setPackFacts(f)
          setEditing(false)
          setInlineError(null)
          return
        }
      }
      if (reason === 'partial_refund_on_pack') {
        // Now we know it is a pack: stop offering an amount that cannot be taken.
        setPartialRefused(true)
        setEditing(false)
        setInlineError(t('refundPackPartial'))
        return
      }
      if (reason === 'partial_refund_on_indivisible') {
        setInlineError(t('refundIndivisible'))
        return
      }
      toast.error(
        reason === 'gift_card_partially_redeemed'
          ? t('giftCardRefundPartlyRedeemed')
          : reason === 'gift_card_partial_refund_unsupported'
            ? t('giftCardRefundPartialUnsupported')
            : t('refundError')
      )
    }
  }

  // "What else this takes back", from the line item. Deliberately hedged for the
  // subscription case: the server clears the membership only if THIS payment is
  // the one that set it up, and the client cannot know whether a newer payment
  // has since taken ownership.
  const kind = target.lineItem?.kind
  const consequence =
    kind === 'subscription'
      ? t('refundReversesSubscription')
      : kind === 'course'
        ? t('refundReversesCourse', { name: who })
        : null

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {packFacts ? t('refundConsumedTitle') : t('refundConfirmTitle')}
          </AlertDialogTitle>
          {/* what is true */}
          <AlertDialogDescription>
            {packFacts
              ? t('refundConsumedWhat', {
                  name: who,
                  used: packFacts.unitsConsumed,
                  granted: packFacts.unitsGranted,
                })
              : t('refundConfirmBody', {
                  amount: formatMoneyMinor(maxRefundableMinor, currency),
                })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* the rule (policy statement) / what else this takes back (confirm) */}
        {(packFacts || consequence) && (
          <p className="-mt-4 text-sm text-muted-foreground">
            {packFacts ? t('refundConsumedRule') : consequence}
          </p>
        )}

        {/* what now — nothing at all in the policy-statement state */}
        <div className="space-y-2">
          {editing ? (
            <div className="space-y-1.5">
              <Label htmlFor="refund-amount">{t('refundAmountLabel')}</Label>
              <Input
                id="refund-amount"
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0.01"
                max={(maxRefundableMinor / 100).toFixed(2)}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
              />
              <p className={`text-xs ${amountInvalid ? 'text-destructive' : 'text-muted-foreground'}`}>
                {t('refundAmountMax', {
                  amount: formatMoneyMinor(maxRefundableMinor, currency),
                })}
              </p>
              {/* The way back. Without it, a manager who tries a partial refund
                  on an indivisible sale and is refused has no route but Cancel. */}
              {!isPolicyStatement && (
                <button
                  type="button"
                  className="text-sm underline text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setEditing(false)
                    setInlineError(null)
                  }}
                >
                  {t('refundFullAmountInstead')}
                </button>
              )}
            </div>
          ) : (
            partialOffered && (
              <button
                type="button"
                className="text-sm underline text-muted-foreground hover:text-foreground"
                onClick={() => openEditor(maxRefundableMinor)}
              >
                {t('refundDifferentAmount')}
              </button>
            )
          )}
          {inlineError && <p className="text-sm text-destructive">{inlineError}</p>}
        </div>

        <AlertDialogFooter>
          {/* "Close", not "Cancel", once the dialog has stopped asking anything. */}
          <AlertDialogCancel>
            {isPolicyStatement ? t('close') : t('cancel')}
          </AlertDialogCancel>
          {/* Deliberately NOT an AlertDialogPrimitive.Close: a refusal has to be
              able to keep the dialog open and re-render it as the rule. */}
          {!isPolicyStatement && (
            <AlertDialogAction onClick={() => void submit()} disabled={primaryDisabled}>
              {refund.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {primaryLabel}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
