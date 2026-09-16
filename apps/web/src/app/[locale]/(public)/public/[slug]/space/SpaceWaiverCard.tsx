'use client'

// The member's own view of what they have signed — and of what a
// `require_resign` publish has just made them owe.
//
// Two mounts, one component:
//   • SpaceHome renders it as a BANNER (`variant="banner"`), above the cards,
//     and only when something is outstanding. That is the point of the whole
//     surface: until this existed, a superseded signature announced itself by
//     refusing a booking — a compliance feature introducing itself at the worst
//     possible moment, to a member who was doing nothing wrong.
//   • AccountHome renders it as a CARD, always, beside the profile — the answer
//     to "what have I agreed to", which is a member's own question about their
//     own record.
//
// ── WHY IT IS NOT `WaiverStep` ──────────────────────────────────────────────
// The booking step answers ONE question — "what stands between you and this
// booking" — and renders nothing about what is already in order. This surface
// answers the opposite one: "what have I agreed to", which is a member's own
// question about their own record, and it has to list the SIGNED documents too.
// So the rendering differs; nothing else does. The payload is built by the
// shared `waiverAcceptancePayload`, the states come from the server's one
// predicate, and the tick is recorded by the same ledger writer every rail uses.
// There is no second answer to "does this count" here.
//
// ── WHAT IT COVERS: EVERYTHING THE STUDIO REQUIRES ──────────────────────────
// It asks with `surface: 'space'`, so the server answers for EVERY required
// waiver rather than only the all-bookings ones, and `signWaiverInSpace` records
// against the same set.
//
// It used to answer for the all-bookings ones only, and that made this panel a
// dead end for the member it exists for: `selfCheckIn` and the mobile scanner
// refuse over an ACTIVITY-scoped waiver and send the member here to sign it, and
// here it was neither shown nor signable. A member standing at a door was told
// to go somewhere that could not help them, with no other route — they need not
// have a booking form open at all.
//
// Widening is sound because this surface is not a gate: it books nothing and
// admits nobody. Which waivers a booking REQUIRES is still decided by the gate,
// from the policy, against the activity in hand.
//
// ── EVERY ROW HERE IS SIGNABLE HERE, AND THAT IS THE WHOLE POINT ───────────
// This panel used to carry a third state: a date-of-birth question, and rows
// that resolved to "a parent or guardian must sign this one" with no control
// beside them — a dead end on the one surface a member refused at a door is
// sent to. Both are gone with the guardian machinery. Every outstanding row now
// offers Review-and-sign, and a waiver the studio flagged `mayIncludeMinors`
// simply asks its second question — participant, or parent/guardian — inline,
// exactly as the booking step does.

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { httpsCallable } from 'firebase/functions'
import { CheckCircle2, FileText, ShieldAlert } from 'lucide-react'
import { functions } from '@/lib/firebase'
import { RichTextContent } from '@/components/RichTextEditor'
import {
  waiverAcceptancePayload,
  waiverErrorMessage,
  waiverSatisfiedLocally,
  type WaiverRequirementItem,
  type WaiverRequirementResponse,
  type WaiverSignerChoice,
} from '@/lib/waiver'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from './SpaceAuthProvider'
import { useSpaceTheme } from './useSpaceTheme'
import { usePublicTeam } from '../PublicTeamProvider'

export function SpaceWaiverCard({ variant }: { variant: 'banner' | 'card' }) {
  const t = useTranslations('Waiver')
  const tSpace = useTranslations('Space')
  const locale = useLocale()
  const { teamId, isAuthenticated, contact } = useSpaceAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const { team } = usePublicTeam()

  const [items, setItems] = useState<WaiverRequirementItem[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  /** The self-declaration, per document, on a `mayIncludeMinors` waiver. No
   *  default: a preselected radio would answer, on the member's behalf, a
   *  question the record then attributes to them. */
  const [choices, setChoices] = useState<Record<string, WaiverSignerChoice | undefined>>({})
  const [guardianNames, setGuardianNames] = useState<Record<string, string | undefined>>({})

  // Inert unless the team's public mirror lists a required waiver — the same
  // zero-cost rule the booking surfaces run on.
  const applies = (team.required_waivers?.length ?? 0) > 0 && isAuthenticated && !!teamId

  const load = useCallback(
    async () => {
      if (!applies) return
      try {
        const fn = httpsCallable<Record<string, unknown>, WaiverRequirementResponse>(
          functions,
          'resolveWaiverRequirement'
        )
        // `surface: 'space'` is what asks for EVERY required waiver rather than
        // only the ones scoped to every booking. The server honours it for a
        // contact session and nothing else.
        const res = await fn({
          teamId,
          surface: 'space',
          ...(contact?.id ? { contactId: contact.id } : {}),
        })
        setItems(res.data.waivers ?? [])
      } catch (err: unknown) {
        // Silence TO THE VISITOR is correct here and nowhere else: this is an
        // ambient panel, not a step standing between somebody and a booking.
        // Rendering a failure as "you owe a signature" would be an accusation
        // produced by a network error.
        //
        // Silence to the DEVELOPER is never correct. The two obligations are
        // separate (lib/publicQueryError.ts), and only the first one is argued
        // above — without the log, a rules change that breaks this panel for
        // every studio looks exactly like every studio being up to date.
        reportPublicLoadFailure('space/waivers', err)
        setItems([])
      }
    },
    [applies, teamId, contact?.id]
  )

  useEffect(() => {
    void load()
  }, [load])

  if (!applies || !items || items.length === 0) return null

  const outstanding = items.filter((i) => i.action !== 'none')
  if (variant === 'banner' && outstanding.length === 0) return null

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  const sign = async () => {
    setBusy(true)
    setError(null)
    try {
      // The self-declaration rides WITH the tick, so `signWaiverInSpace`
      // snapshots it onto the acceptance in the same call.
      const payload = waiverAcceptancePayload(items, ticks, choices, guardianNames)
      if (payload.length === 0) return
      const fn = httpsCallable<Record<string, unknown>, { recorded: number }>(
        functions,
        'signWaiverInSpace'
      )
      await fn({ teamId, locale, waiverAcceptances: payload })
      setDone(true)
      setOpen(null)
      setTicks({})
      setChoices({})
      await load()
    } catch (err) {
      setError(waiverErrorMessage(err, t) ?? t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  const selfSignable = outstanding.filter((i) => i.action === 'sign_self')
  // What the member is actually about to sign, and whether each of those is
  // complete. Only TICKED items are judged — an untouched document is simply not
  // being signed, and holding the button hostage to it would strand anyone with
  // two outstanding waivers who wants to deal with one.
  const pendingSign = selfSignable.filter((i) => ticks[i.documentId])
  const canSign = pendingSign.every((i) =>
    waiverSatisfiedLocally(i, true, choices[i.documentId] ?? null)
  )

  return (
    <section className="rounded-2xl p-4" style={cardStyle}>
      <div className="mb-3 flex items-center gap-2">
        {outstanding.length > 0 ? (
          <ShieldAlert className="h-4 w-4" style={{ color: accent }} />
        ) : (
          <CheckCircle2 className="h-4 w-4" style={{ color: accent }} />
        )}
        <h2
          className="text-sm font-semibold uppercase tracking-wide"
          style={{ color: textMuted }}
        >
          {tSpace('waiverSectionTitle')}
        </h2>
      </div>

      {done && outstanding.length === 0 && (
        <p className="mb-3 text-sm" style={{ color: textMain }}>
          {tSpace('waiverAllSigned')}
        </p>
      )}

      <ul className="space-y-3">
        {items.map((item) => {
          const isOpen = open === item.documentId
          // Said on the row itself: a document with no state beside it reads as
          // broken.
          const state =
            item.action === 'none'
              ? tSpace('waiverStateSigned', { version: item.version })
              : item.state === 'superseded'
                  ? tSpace('waiverStateSuperseded')
                  : item.state === 'expired'
                    ? tSpace('waiverStateExpired')
                    : item.state === 'revoked'
                      ? tSpace('waiverStateRevoked')
                      : tSpace('waiverStateNone')
          return (
            <li key={item.documentId} className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium" style={{ color: textMain }}>
                    {item.title}
                  </p>
                  <p className="text-xs" style={{ color: textMuted }}>
                    {state}
                  </p>
                </div>
                {item.action === 'sign_self' && (
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : item.documentId)}
                    className="shrink-0 text-xs font-medium hover:underline"
                    style={{ color: accent }}
                  >
                    {isOpen ? tSpace('waiverHide') : tSpace('waiverReviewAndSign')}
                  </button>
                )}
              </div>

              {isOpen && (
                <div className="space-y-3">
                  <div
                    className="max-h-[40vh] overflow-y-auto rounded-xl p-3"
                    style={{ border: `1px solid ${cardBorder}` }}
                  >
                    <RichTextContent
                      html={item.bodyHtml}
                      className="prose-relaxed max-w-none text-sm"
                    />
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={ticks[item.documentId] === true}
                      disabled={busy}
                      onChange={(e) =>
                        setTicks((p) => ({ ...p, [item.documentId]: e.target.checked }))
                      }
                      className="mt-0.5 h-4 w-4 rounded"
                    />
                    <span style={{ color: textMain }}>
                      {t('selfConsentLabel', { document: item.title })}
                    </span>
                  </label>
                  {/* The second required choice, on a waiver the studio flagged
                      "participants may be minors". A self-declaration: it changes
                      what is recorded and what the studio's roster shows, never
                      whether anything is allowed. */}
                  {item.mayIncludeMinors && (
                    <fieldset
                      className="space-y-2 rounded-xl p-3"
                      style={{ border: `1px solid ${cardBorder}` }}
                    >
                      <legend className="px-1 text-sm font-medium" style={{ color: textMain }}>
                        {t('signerChoiceLabel')}
                      </legend>
                      {(['self', 'guardian'] as WaiverSignerChoice[]).map((value) => (
                        <label
                          key={value}
                          className="flex cursor-pointer items-start gap-3 text-sm"
                          style={{ color: textMain }}
                        >
                          <input
                            type="radio"
                            name={`space-signer-${item.documentId}`}
                            checked={choices[item.documentId] === value}
                            disabled={busy}
                            onChange={() =>
                              setChoices((p) => ({ ...p, [item.documentId]: value }))
                            }
                            className="mt-0.5 h-4 w-4"
                          />
                          <span>
                            {value === 'self' ? t('signerChoiceSelf') : t('signerChoiceGuardian')}
                          </span>
                        </label>
                      ))}
                      {choices[item.documentId] === 'guardian' && (
                        <input
                          type="text"
                          aria-label={t('guardianNameLabel')}
                          placeholder={t('guardianNameLabel')}
                          value={guardianNames[item.documentId] ?? ''}
                          disabled={busy}
                          onChange={(e) =>
                            setGuardianNames((p) => ({ ...p, [item.documentId]: e.target.value }))
                          }
                          className="w-full rounded-lg border bg-background px-3 py-2 text-base"
                        />
                      )}
                      <p className="text-xs" style={{ color: textMuted }}>
                        {t('signerChoiceNote')}
                      </p>
                    </fieldset>
                  )}
                  <p className="flex items-start gap-2 text-xs" style={{ color: textMuted }}>
                    <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{t('whatIsRecorded')}</span>
                  </p>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {/* Space is a consent surface like any other, so it answers to the SAME
          predicate the five gate-driven rails use — a tick alone is not consent
          on a `mayIncludeMinors` waiver, because the declaration has no default
          and the acceptance is immutable. Reading `ticks` directly here is what
          let a member sign without answering, and the ledger then recorded a
          choice they never made. The button still APPEARS as soon as something
          is ticked (the affordance is the point); it is disabled until every
          ticked item is genuinely satisfied. */}
      {pendingSign.length > 0 && (
        <button
          type="button"
          onClick={sign}
          disabled={busy || !canSign}
          className="mt-3 w-full rounded-full py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: accent, color: '#fff' }}
        >
          {busy ? t('signing') : t('signAction')}
        </button>
      )}

      {/* Said rather than implied: this panel now answers for everything the
          studio requires, including a document attached to one class — which is
          exactly what a member sent here from a door has to be able to sign. */}
      <p className="mt-3 text-[0.6875rem]" style={{ color: textMuted }}>
        {tSpace('waiverScopeNote')}
      </p>
    </section>
  )
}
