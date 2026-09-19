'use client'

// THE consent step's state machine, shared by every public booking surface.
//
// One hook, because the alternative is five hand-written copies of "did they
// tick, and may we submit" — and the surfaces that would carry them
// (BookingForm, AppointmentPicker, the claim page, the kiosk, signup) each have
// their own submit shape, so the copies would diverge on the one question that
// decides whether a signature was collected at all.
//
// ── THE ZERO-COST RULE ──────────────────────────────────────────────────────
// The requirement callable is called IF AND ONLY IF the team's world-readable
// mirror lists at least one required waiver. Every tenant on the day this ships
// lists none, so `applies` is false, `ensure()` returns true without a network
// call, and not one acquisition path changes.
//
// ── WHY `ensure()` IS CALLED FROM THE SUBMIT, NOT FROM AN EFFECT ────────────
// The step needs an IDENTITY to answer for — email+name on the guest rails, a
// contact and a verification code on the returning-member rail — and the surface
// only has one at the moment the visitor submits. Resolving on mount would
// answer for nobody and then have to re-answer, and the two answers disagreeing
// is precisely how a visitor gets told there is nothing to sign and is then
// refused by the rail (on the returning-member path, after their verification
// code was already marked used).
//
// So: submit → `ensure(identity)` → either "clear, here are the acceptances" or
// "present the step". The step's own Confirm calls the SAME submit function,
// which calls `ensure` again and is cleared by the local ticks. No rail ever
// learns about waivers beyond those two lines.
//
// ── REFRESH IS EXPLICIT, NEVER A POLL ───────────────────────────────────────
// The requirement callable does a policy read plus a signer read per waiver on
// every call, and a household behind one NAT is one IP. The only refresh is the
// step's own Retry, driven by a visitor who is looking at an error.
//
// The server side of that bargain: the callable charges only an unproven caller
// who is asking about a person. Reading what you have to sign is never what
// spends the quota — charging it meant a gym, a school or a kiosk on one address
// could lock its own people out of booking anything.
//
// ── AN EMPTY LIST IS TWO DIFFERENT ANSWERS, AND THEY MUST NOT LOOK ALIKE ────
// "Resolved, and nothing is required" and "we could not resolve it" both leave
// `items` empty, and `[].every(…)` is `true` — so for as long as `ready` was
// derived from the list alone, the visitor got a live Confirm on an ERROR
// screen. Pressing it re-entered the submit, which returned the same `true` on
// its second pass and sent the booking, and the rail refused `waiver_required` a
// moment later. An empty requirement list BECAUSE WE FAILED TO LOAD IT must
// never read as "nothing required": `resolved` says a server answer was
// actually stored, `error` says the last attempt failed, and `ready` is false
// unless the first is true and the second is null. The step's error state
// carries a Retry, because a refusal with no next step is a dead end on a
// booking path.
//
// ── THE MIRROR IS A HINT; THE SERVER IS THE AUTHORITY ───────────────────────
// `applies` is computed from `TeamPublicProfile.required_waivers`, which is a
// world-readable mirror that can be briefly stale-EMPTY (a policy published
// seconds ago, a mirror write that lost a race). The whole zero-cost rule rests
// on trusting it, and that is right — right up to the moment the SERVER refuses
// with a waiver reason, which is proof the mirror is wrong. `recover()` is that
// moment: it forces the gate live for this tenant and resolves properly, so the
// refusal arrives with a step behind it instead of being a sentence the visitor
// can do nothing about. Without it the surfaces' own recovery branch called
// `ensure()`, which returned `true` from the `!applies` line and left them
// printing into a dead end.

import { useCallback, useMemo, useRef, useState } from 'react'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import {
  waiverAcceptancePayload,
  waiverNeedsVisitor,
  waiverRefusalReason,
  waiverSatisfiedLocally,
  type WaiverAcceptancePayload,
  type WaiverCallerIdentity,
  type WaiverRequirementItem,
  type WaiverRequirementResponse,
  type WaiverSignerChoice,
} from '@/lib/waiver'
import { callFunction } from '@/lib/callFunction'

/** The summary rows the team's public mirror carries. Only its LENGTH is read
 *  here: the mirror is a rendering hint and never a decision (the gate reads the
 *  server-written policy, which fails closed). */
export interface PublicRequiredWaiverSummary {
  documentId: string
}

interface Options {
  teamId: string | null
  /** `TeamPublicProfile.required_waivers`. Absent/empty ⇒ this hook is inert. */
  requiredWaivers?: PublicRequiredWaiverSummary[] | null
  /** The activity being booked, for an `activities`-scoped waiver. Pass null
   *  only when the rail genuinely has none — a null does NOT widen a narrowly
   *  scoped waiver, it excludes it, so a surface that could resolve an activity
   *  and did not would silently show fewer waivers than the gate enforces. */
  activityId?: string | null
}

export interface WaiverGate {
  /** Does this tenant require anything at all? False ⇒ every method is a no-op
   *  and no network call is ever made. */
  applies: boolean
  /** Resolved rows, once `ensure()` has run. */
  items: WaiverRequirementItem[]
  /** True while the step should be on screen. */
  presented: boolean
  loading: boolean
  /** A failure of the requirement callable itself (not a refusal — those come
   *  back from the rail). Rendered as a blocking message WITH a retry, because a
   *  step that cannot load is not a step the visitor can pass — and because the
   *  alternative was an empty list that read as "nothing required". */
  error: 'load' | 'rate_limited' | null
  /** Has a server answer actually been stored? False after a failed load, which
   *  is the state `items.length === 0` cannot distinguish on its own. */
  resolved: boolean
  ticks: Record<string, boolean>
  setTick: (documentId: string, value: boolean) => void
  /**
   * THE SELF-DECLARATION, per document — rendered only on a waiver the studio
   * flagged `mayIncludeMinors`. Undefined ⇒ not answered, which is what keeps
   * the Confirm dead: a default would answer, on the visitor's behalf, a
   * question the record then attributes to them.
   */
  choices: Record<string, WaiverSignerChoice | undefined>
  setChoice: (documentId: string, value: WaiverSignerChoice) => void
  /** The optional guardian name, per document. Optional on purpose: a required
   *  field's worth of friction, on the acquisition path, for a string nothing
   *  verifies. */
  guardianNames: Record<string, string | undefined>
  setGuardianName: (documentId: string, value: string) => void
  /** Every outstanding item satisfied by what the visitor did here — and a
   *  server answer was actually received. False on the error screen. */
  ready: boolean
  /** The payload to send with the booking call. */
  acceptances: WaiverAcceptancePayload[]
  /** True ⇒ clear to submit. False ⇒ the step is now presented; stop. */
  ensure: (identity: WaiverCallerIdentity) => Promise<boolean>
  /**
   * THE ANSWER TO A SERVER REFUSAL THE MIRROR DID NOT PREDICT.
   *
   * Call it from the catch of any booking call with the error and the identity
   * that made it. True ⇒ the step (or its error state) is now on screen, so
   * stash the submit and stop. False ⇒ this was not a waiver refusal, or the
   * requirement resolved clean; print the sentence.
   *
   * It forces the gate live for this tenant, because the server refusing with a
   * waiver reason is proof that `required_waivers` was stale-empty — the one
   * case the zero-cost rule cannot cover, and previously a dead end.
   */
  recover: (err: unknown, identity: WaiverCallerIdentity) => Promise<boolean>
  /** Re-ask the server (the step's Retry). */
  refresh: () => Promise<void>
  /** Leave the step (Back). Keeps the resolved rows so re-entering is free. */
  dismiss: () => void
  /** Forget everything — a different session, a different person. */
  reset: () => void
}

export function useWaiverGate({ teamId, requiredWaivers, activityId }: Options): WaiverGate {
  // Set by `recover()` when the SERVER refuses with a waiver reason. It is a
  // fact about the TENANT ("this team requires something the mirror did not
  // list"), not about the person, so it deliberately survives `reset()` — the
  // next walk-in at the same kiosk should not have to discover it again.
  const [forced, setForced] = useState(false)
  const forcedRef = useRef(false)
  const applies = !!teamId && ((requiredWaivers?.length ?? 0) > 0 || forced)

  const [items, setItems] = useState<WaiverRequirementItem[]>([])
  const [presented, setPresented] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<'load' | 'rate_limited' | null>(null)
  const [resolved, setResolved] = useState(false)
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [choices, setChoices] = useState<Record<string, WaiverSignerChoice | undefined>>({})
  const [guardianNames, setGuardianNames] = useState<Record<string, string | undefined>>({})

  // Mirrors of what `ensure()` has to read SYNCHRONOUSLY on its second pass.
  // Reading them off state instead would read the render that opened the step,
  // not the one the visitor ticked in.
  const itemsRef = useRef<WaiverRequirementItem[]>([])
  const ticksRef = useRef<Record<string, boolean>>({})
  const choicesRef = useRef<Record<string, WaiverSignerChoice | undefined>>({})
  const identityRef = useRef<WaiverCallerIdentity | null>(null)
  const presentedRef = useRef(false)
  // The two facts that separate "resolved, nothing required" from "could not
  // resolve". They are refs as well as state because `ensure()`'s second pass
  // answers SYNCHRONOUSLY, and a Confirm pressed on an error screen must be
  // refused by the same values the screen was rendered from.
  const resolvedRef = useRef(false)
  const errorRef = useRef<'load' | 'rate_limited' | null>(null)

  // BOTH catches in this hook end here — the first resolve and the step's Retry —
  // so this is the only place either read can leave a trace. The blocking screen
  // it raises is for the VISITOR and is not a trace: a studio reporting "nobody
  // can get past the waiver step" needs a line to grep, and the reason the
  // requirement call is failing (a rules change, a rate limit, a cold callable)
  // is only visible from inside the error. Rule 1 of lib/publicQueryError.ts —
  // there is no acceptable silent catch on a read path, not even one that already
  // shows the visitor something.
  const fail = useCallback((err: unknown) => {
    const reason = (err as { details?: { reason?: string } } | null)?.details?.reason
    const next = reason === 'rate_limited' ? 'rate_limited' : 'load'
    reportPublicLoadFailure(`waiver-gate/${next === 'rate_limited' ? 'rate-limited' : 'requirement'}`, err)
    errorRef.current = next
    setError(next)
  }, [])

  const call = useCallback(
    async (identity: WaiverCallerIdentity) => {
      const fn = callFunction<Record<string, unknown>, WaiverRequirementResponse>(
        'resolveWaiverRequirement'
      )
      const res = await fn({
        teamId,
        ...(activityId ? { activityId } : {}),
        ...identity,
      })
      return res.data.waivers ?? []
    },
    [teamId, activityId]
  )

  const store = useCallback((next: WaiverRequirementItem[]) => {
    // Read the PREVIOUS list before replacing it — the version comparison below
    // is against what was on screen, and comparing the new list with itself
    // would carry every tick forward unconditionally.
    const before = itemsRef.current
    // A tick belongs to the version that was on screen. A `require_resign`
    // publish landing between two resolves changes the text under the visitor,
    // and carrying the old tick forward would submit a signature for wording
    // they never saw — which is the one thing this whole design exists to
    // prevent. So a tick is dropped whenever its item's version moves. The
    // self-declaration rides with the tick and is dropped on the same rule.
    const kept: Record<string, boolean> = {}
    const keptChoices: Record<string, WaiverSignerChoice | undefined> = {}
    for (const item of next) {
      const prevItem = before.find((i) => i.documentId === item.documentId)
      if (prevItem && prevItem.version === item.version) {
        if (ticksRef.current[item.documentId]) kept[item.documentId] = true
        keptChoices[item.documentId] = choicesRef.current[item.documentId]
      }
    }
    itemsRef.current = next
    ticksRef.current = kept
    choicesRef.current = keptChoices
    // A SERVER ANSWER IS NOW ON RECORD. This is the ONLY place `resolved` turns
    // true, so an empty list can only read as "nothing required" when the empty
    // list actually came back from the server.
    resolvedRef.current = true
    errorRef.current = null
    setResolved(true)
    setError(null)
    setItems(next)
    setTicks(kept)
    setChoices(keptChoices)
  }, [])

  const outstandingOf = (list: WaiverRequirementItem[]) => list.filter(waiverNeedsVisitor)

  /**
   * The SYNCHRONOUS answer, off the refs, for `ensure()`'s second pass.
   *
   * The `resolved && no error` half is the guard, not a nicety: without it this
   * answers `true` for the empty list a FAILED load leaves behind, and the
   * Confirm on the error screen re-enters the submit and books.
   */
  const readyOf = useCallback(
    (list: WaiverRequirementItem[], t: Record<string, boolean>) =>
      resolvedRef.current &&
      errorRef.current === null &&
      list.every((i) =>
        waiverSatisfiedLocally(i, t[i.documentId] === true, choicesRef.current[i.documentId] ?? null)
      ),
    []
  )

  /** The resolve itself, with no opinion about whether this tenant applies —
   *  shared by the ordinary first pass and by `recover()`, so the two cannot
   *  drift into two different answers to "what did the server say". */
  const resolveNow = useCallback(
    async (identity: WaiverCallerIdentity): Promise<boolean> => {
      identityRef.current = identity

      // SECOND PASS — the step is on screen and its Confirm re-entered the same
      // submit. Nothing is re-fetched: the visitor's ticks are the answer, and a
      // re-fetch here would replace the version they just read.
      if (presentedRef.current) return readyOf(itemsRef.current, ticksRef.current)

      setLoading(true)
      try {
        const next = await call(identity)
        store(next)
        if (outstandingOf(next).length === 0) return true
        presentedRef.current = true
        setPresented(true)
        return false
      } catch (err) {
        // A step that cannot load is not a step anyone can pass, so this is
        // presented as a blocking message rather than swallowed — otherwise the
        // rail refuses `waiver_required` a moment later with nothing on screen
        // explaining it. `resolved` stays false, so `ready` is false and the
        // surrounding Confirm is dead until a Retry actually succeeds.
        fail(err)
        presentedRef.current = true
        setPresented(true)
        return false
      } finally {
        setLoading(false)
      }
    },
    [call, fail, readyOf, store]
  )

  const ensure = useCallback(
    async (identity: WaiverCallerIdentity): Promise<boolean> => {
      if (!applies) return true
      return resolveNow(identity)
    },
    [applies, resolveNow]
  )

  const recover = useCallback(
    async (err: unknown, identity: WaiverCallerIdentity): Promise<boolean> => {
      if (!waiverRefusalReason(err)) return false
      // The server has just contradicted the mirror. Trust the server: from here
      // on this gate resolves for real, whatever `required_waivers` says.
      forcedRef.current = true
      setForced(true)
      // Forget the previous answer — it is what the refusal disagreed with —
      // and re-present from scratch rather than re-using ticks for text nobody
      // has seen at this version.
      presentedRef.current = false
      itemsRef.current = []
      ticksRef.current = {}
      choicesRef.current = {}
      resolvedRef.current = false
      errorRef.current = null
      setPresented(false)
      setItems([])
      setTicks({})
      setChoices({})
      setResolved(false)
      setError(null)
      return !(await resolveNow(identity))
    },
    [resolveNow]
  )

  const refresh = useCallback(async () => {
    if ((!applies && !forcedRef.current) || !identityRef.current) return
    setLoading(true)
    try {
      store(await call(identityRef.current))
    } catch (err) {
      fail(err)
    } finally {
      setLoading(false)
    }
  }, [applies, call, fail, store])

  const setTick = useCallback((documentId: string, value: boolean) => {
    setTicks((prev) => {
      const next = { ...prev, [documentId]: value }
      ticksRef.current = next
      return next
    })
  }, [])

  // NO RE-RESOLVE ON A CHOICE, unlike the date-of-birth question this replaced.
  // That one changed the server's ANSWER — who was allowed to tick — so deciding
  // it locally would have put the age-of-majority rule in a second place. This
  // one changes nothing the server has to recompute: it is not a gate, it
  // selects nobody, and it rides with the tick. Re-asking would spend a
  // rate-limit unit to be told exactly what we already have on screen.
  const setChoice = useCallback((documentId: string, value: WaiverSignerChoice) => {
    setChoices((prev) => {
      const next = { ...prev, [documentId]: value }
      choicesRef.current = next
      return next
    })
  }, [])

  const setGuardianName = useCallback((documentId: string, value: string) => {
    setGuardianNames((prev) => ({ ...prev, [documentId]: value }))
  }, [])

  const dismiss = useCallback(() => {
    presentedRef.current = false
    setPresented(false)
  }, [])

  const reset = useCallback(() => {
    presentedRef.current = false
    itemsRef.current = []
    ticksRef.current = {}
    choicesRef.current = {}
    identityRef.current = null
    resolvedRef.current = false
    errorRef.current = null
    setPresented(false)
    setItems([])
    setTicks({})
    setChoices({})
    setGuardianNames({})
    setError(null)
    setResolved(false)
    // `forced` is NOT cleared. It is a fact about the tenant — the server told
    // us this team requires something its public mirror did not list — and the
    // next person at the same kiosk should not have to be refused once to
    // rediscover it.
  }, [])

  // Written off STATE rather than through `readyOf`'s refs, so React recomputes
  // it the moment either fact moves — a memo that read the refs would keep the
  // value it had before the load failed.
  const ready = useMemo(
    () =>
      resolved &&
      error === null &&
      items.every((i) =>
        waiverSatisfiedLocally(i, ticks[i.documentId] === true, choices[i.documentId] ?? null)
      ),
    [items, ticks, choices, error, resolved]
  )
  const acceptances = useMemo(
    () => waiverAcceptancePayload(items, ticks, choices, guardianNames),
    [items, ticks, choices, guardianNames]
  )

  return {
    applies,
    items,
    presented,
    loading,
    error,
    resolved,
    ticks,
    setTick,
    choices,
    setChoice,
    guardianNames,
    setGuardianName,
    ready,
    acceptances,
    ensure,
    recover,
    refresh,
    dismiss,
    reset,
  }
}
