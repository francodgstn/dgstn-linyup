// How a person is NAMED on a public leaderboard — one rule, two member surfaces.
//
// A leaderboard is the one place a studio shows its members to each other, so
// it is also the one place a person who has NOT yet joined must not be shown by
// name: a trial visitor did not sign up to appear on a wall. They are reduced
// to initials; everyone else gets a first name and a last initial.
//
// The Space and the member app each carried this rule inline, and they had
// already parted: the app compared stage strings untyped (so a renamed stage
// would silently de-anonymise trials in the app alone) and fell back to
// "Unknown" where the Space fell back to "?". The Space's comment even said
// "same as the mobile app's leaderboard". It was not, and nothing could have
// told either side. Owned here so the two cannot disagree again.

import { ACQUISITION_STAGES, type AcquisitionStage } from '../types/contact'

/** The stages of somebody who has not joined — typed against the real union,
 *  so a renamed stage fails the build instead of quietly showing a name. */
const TRIAL_STAGES: readonly AcquisitionStage[] = ['trial_booked', 'trial_attended']

/** Is this stage one that must be anonymised on a shared surface? Accepts the
 *  loose `string | null` the entry rows actually carry. */
export function isTrialStage(stage: string | null | undefined): boolean {
  return (
    !!stage &&
    (ACQUISITION_STAGES as readonly string[]).includes(stage) &&
    TRIAL_STAGES.includes(stage as AcquisitionStage)
  )
}

/** What a leaderboard row prints for this person. `'?'` when there is nothing
 *  to print — never a word, because a word gets translated three ways. */
export function leaderboardDisplayName(entry: {
  firstname?: string | null
  lastname?: string | null
  acquisition_stage?: string | null
}): string {
  const first = entry.firstname ?? ''
  const last = entry.lastname ?? ''
  if (isTrialStage(entry.acquisition_stage)) {
    const parts = [first[0], last[0]].filter(Boolean)
    return parts.length ? `${parts.join('.')}.` : '?'
  }
  const lastInitial = last ? ` ${last[0]}.` : ''
  return `${first}${lastInitial}`.trim() || '?'
}
