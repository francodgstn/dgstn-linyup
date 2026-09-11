import assert from 'node:assert/strict'
import {
  EMPTY_CONTACT_FILTER,
  activeFilterKeys,
  calcAgeYears,
  compareContactsByAttention,
  contactAttentionReasons,
  contactNeedsAttention,
  contactMatchesGroup,
  countActiveFilters,
  expandRankRange,
  rankFilterIsActive,
  filterContacts,
  groupsForContact,
  matchesFilter,
  membersOfGroup,
  normalizeContactFilter,
  wouldCreateCycle,
  type ContactFilter,
  type ContactFilterContext,
  type ContactFilterSubject,
  type ContactGroup,
  type WaiverAcceptanceState,
  type WaiverSignerFacts,
} from '@linyup/shared'
import { evaluateContactConditions } from '../utils/automationEngine'

// Fixtures for the ONE contact predicate — the resolver shared by the contacts
// list, saved filter presets, dynamic contact groups and the automation
// engine's in_group condition.
// Run with: pnpm --filter @linyup/functions test

const NOW = Date.UTC(2026, 7, 16) // 2026-08-16, the reference "today"

function ts(iso: string) {
  return { seconds: Math.floor(new Date(iso).getTime() / 1000), nanoseconds: 0 }
}

/** A stored Timestamp, as `waiverAcceptanceState` reads one. */
function stamp(iso: string) {
  const ms = new Date(iso).getTime()
  return {
    toDate: () => new Date(ms),
    toMillis: () => ms,
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  }
}

function contact(overrides: Partial<ContactFilterSubject> = {}): ContactFilterSubject {
  return { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com', ...overrides }
}

function filter(overrides: Partial<ContactFilter> = {}): ContactFilter {
  return { ...EMPTY_CONTACT_FILTER, ...overrides }
}

function group(overrides: Partial<ContactGroup> & { id: string }): ContactGroup {
  return { name: overrides.id, parent_id: null, ...overrides }
}

describe('matchesFilter — empty filter', () => {
  it('matches everything', () => {
    assert.equal(matchesFilter(contact(), EMPTY_CONTACT_FILTER, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact(), null, { nowMs: NOW }), true)
  })

  it('counts no active dimensions', () => {
    assert.equal(countActiveFilters(EMPTY_CONTACT_FILTER), 0)
  })

  it('backfills missing keys from a partial (older saved preset)', () => {
    // A preset written before `tags`/`age` existed must not throw or over-match.
    assert.equal(matchesFilter(contact(), { stages: ['joined'] }, { nowMs: NOW }), false)
    assert.equal(
      matchesFilter(contact({ acquisition_stage: 'joined' }), { stages: ['joined'] }, { nowMs: NOW }),
      true,
    )
  })
})

describe('matchesFilter — subscriptions', () => {
  it('matches the primary subscription_type_id', () => {
    const c = contact({ subscription_type_id: 'adult-monthly' })
    assert.equal(matchesFilter(c, filter({ subscriptions: ['adult-monthly'] }), { nowMs: NOW }), true)
  })

  // The old contacts-page filter read ONLY subscription_type_id while the list
  // RENDERED from active_subscriptions, so these contacts showed a subscription
  // chip yet filtered as "none".
  it('matches a subscription held only in active_subscriptions', () => {
    const c = contact({ active_subscriptions: [{ subscription_type_id: 'kids-term' }] })
    assert.equal(matchesFilter(c, filter({ subscriptions: ['kids-term'] }), { nowMs: NOW }), true)
  })

  it("'none' means no subscription in EITHER field", () => {
    const bare = contact()
    const arrayOnly = contact({ active_subscriptions: [{ subscription_type_id: 'kids-term' }] })
    assert.equal(matchesFilter(bare, filter({ subscriptions: ['none'] }), { nowMs: NOW }), true)
    assert.equal(matchesFilter(arrayOnly, filter({ subscriptions: ['none'] }), { nowMs: NOW }), false)
  })

  it("ORs 'none' with a named type", () => {
    const f = filter({ subscriptions: ['none', 'adult-monthly'] })
    assert.equal(matchesFilter(contact(), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ subscription_type_id: 'adult-monthly' }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ subscription_type_id: 'kids-term' }), f, { nowMs: NOW }), false)
  })
})

describe('calcAgeYears', () => {
  it('is calendar-correct, not a 365.25-day division', () => {
    // Born 2013-08-17 — the day BEFORE the birthday in 2026 ⇒ still 12.
    assert.equal(calcAgeYears(Date.UTC(2013, 7, 17), NOW), 12)
    // Born 2013-08-16 — birthday today ⇒ 13.
    assert.equal(calcAgeYears(Date.UTC(2013, 7, 16), NOW), 13)
    // Leap-day birthday, non-leap reference year.
    assert.equal(calcAgeYears(Date.UTC(2016, 1, 29), NOW), 10)
  })
})

describe('matchesFilter — age', () => {
  const twelve = contact({ birthdate: ts('2013-10-01') }) // 12 on 2026-08-16
  const thirteen = contact({ birthdate: ts('2013-01-05') }) // 13 on 2026-08-16
  const noBirthdate = contact()

  it('filters by current age', () => {
    const f = filter({ age: { mode: 'age', min: null, max: 12 } })
    assert.equal(matchesFilter(twelve, f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(thirteen, f, { nowMs: NOW }), false)
  })

  // The distinction that motivated two modes: both children below are born in
  // 2013 and share a season category, but their current ages differ.
  it('filters by birth year, which age mode would split', () => {
    const f = filter({ age: { mode: 'birth_year', min: 2013, max: 2013 } })
    assert.equal(matchesFilter(twelve, f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(thirteen, f, { nowMs: NOW }), true)

    const byAge = filter({ age: { mode: 'age', min: 12, max: 12 } })
    assert.equal(matchesFilter(twelve, byAge, { nowMs: NOW }), true)
    assert.equal(matchesFilter(thirteen, byAge, { nowMs: NOW }), false)
  })

  it('excludes contacts with no birthdate unless includeUnknown', () => {
    const f = filter({ age: { mode: 'age', min: 5, max: 99 } })
    assert.equal(matchesFilter(noBirthdate, f, { nowMs: NOW }), false)
    const lenient = filter({ age: { mode: 'age', min: 5, max: 99, includeUnknown: true } })
    assert.equal(matchesFilter(noBirthdate, lenient, { nowMs: NOW }), true)
  })

  it('is inert when both bounds are null', () => {
    const f = filter({ age: { mode: 'age', min: null, max: null } })
    assert.equal(matchesFilter(noBirthdate, f, { nowMs: NOW }), true)
    assert.equal(countActiveFilters(f), 0)
  })

  // The reason a snapshot group cannot express an age band: nothing is written
  // when a contact ages out, so only a live predicate stays correct.
  it('changes answer as the clock moves, with no change to the contact', () => {
    const f = filter({ age: { mode: 'age', min: null, max: 12 } })
    const beforeBirthday = Date.UTC(2026, 8, 30) // 2026-09-30
    const afterBirthday = Date.UTC(2026, 9, 2) // 2026-10-02
    assert.equal(matchesFilter(twelve, f, { nowMs: beforeBirthday }), true)
    assert.equal(matchesFilter(twelve, f, { nowMs: afterBirthday }), false)
  })
})

describe('matchesFilter — rank', () => {
  // A level VALUE is an ordinal inside its own system and means nothing across
  // systems. Two scales of different lengths, deliberately non-contiguous, so a
  // band cannot be mistaken for "every integer between".
  const HWAL = [{ value: 0 }, { value: 1 }, { value: 2 }, { value: 5 }, { value: 9 }]

  it('exact levels still match only what was ticked', () => {
    const f = filter({ rankFilter: { hwal: [2, 5] } })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 2 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 5 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 1 } }), f, { nowMs: NOW }), false)
  })

  it('a contact with no rank in the system never matches', () => {
    const f = filter({ rankFilter: { hwal: [2] } })
    assert.equal(matchesFilter(contact({ ranks: { other: 2 } }), f, { nowMs: NOW }), false)
    assert.equal(matchesFilter(contact(), f, { nowMs: NOW }), false)
  })

  it('"and above" is an open-ended band — the thing a tick-list cannot say', () => {
    const f = filter({ rankRanges: { hwal: { min: 2, max: null } } })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 1 } }), f, { nowMs: NOW }), false)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 2 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 9 } }), f, { nowMs: NOW }), true)
  })

  it('"and below" is the other open end', () => {
    const f = filter({ rankRanges: { hwal: { min: null, max: 2 } } })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 0 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 5 } }), f, { nowMs: NOW }), false)
  })

  it('both ends closed is an inclusive band', () => {
    const f = filter({ rankRanges: { hwal: { min: 1, max: 5 } } })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 1 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 5 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 9 } }), f, { nowMs: NOW }), false)
  })

  it('a band with both ends open is not a filter at all', () => {
    const f = filter({ rankRanges: { hwal: { min: null, max: null } } })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 0 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact(), f, { nowMs: NOW }), true)
    assert.equal(countActiveFilters(f), 0)
  })

  it('THE CROSS-SYSTEM TRAP: a high rank in another system is invisible to the band', () => {
    // The 12 is a beginner's ordinal in a long scale; the band is about `hwal`.
    // If this ever passes, someone has hoisted the threshold out of the
    // per-system value and rebuilt the old web primary-rank bug (see `primaryRank`) in a filter.
    const f = filter({ rankRanges: { hwal: { min: 5, max: null } } })
    assert.equal(
      matchesFilter(contact({ ranks: { hwal: 1, dragon: 12 } }), f, { nowMs: NOW }),
      false,
    )
  })

  it('systems are ORed — a match in either one is a match', () => {
    const f = filter({ rankRanges: { hwal: { min: 5, max: null }, dragon: { min: 3, max: null } } })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 1, dragon: 4 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 1, dragon: 1 } }), f, { nowMs: NOW }), false)
  })

  it('THE BAND OVERRIDES ITS MIRROR when the two disagree', () => {
    // This is what happens after a belt is inserted: the stored mirror is stale,
    // the band is not. A reader that understands bands must use the band.
    const f = filter({
      rankFilter: { hwal: [2, 5] },              // mirror, written before level 9 existed
      rankRanges: { hwal: { min: 2, max: null } },
    })
    assert.equal(matchesFilter(contact({ ranks: { hwal: 9 } }), f, { nowMs: NOW }), true)
  })

  it('a system with only a mirror still uses the mirror', () => {
    // Mixed filter: one system banded, one hand-ticked.
    const f = filter({
      rankFilter: { dragon: [3] },
      rankRanges: { hwal: { min: 5, max: null } },
    })
    assert.equal(matchesFilter(contact({ ranks: { dragon: 3 } }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ ranks: { dragon: 4 } }), f, { nowMs: NOW }), false)
  })

  it('A CROSSED BAND MATCHES NOBODY — it must never read as "dimension off"', () => {
    // The writer clamps so this should not be storable, and refuses to store a
    // band whose mirror would be empty. If one arrives anyway — hand-edited, or
    // from a future writer — the resolver must still close rather than open.
    // Failing open here is the exact hazard the two-key design exists to avoid.
    const f = filter({ rankRanges: { hwal: { min: 9, max: 0 } } })
    for (const value of [0, 1, 2, 5, 9]) {
      assert.equal(matchesFilter(contact({ ranks: { hwal: value } }), f, { nowMs: NOW }), false)
    }
    assert.equal(countActiveFilters(f), 1)
  })

  it('counts as one active dimension however it is expressed', () => {
    assert.equal(countActiveFilters(filter({ rankFilter: { hwal: [2] } })), 1)
    assert.equal(countActiveFilters(filter({ rankRanges: { hwal: { min: 2, max: null } } })), 1)
  })

  it('normalising drops an inert band but keeps a real one', () => {
    // Via countActiveFilters, which normalises. An all-open band must not make
    // the dimension read as active anywhere.
    assert.equal(countActiveFilters(filter({ rankRanges: { hwal: { min: null, max: null } } })), 0)
  })
})

describe('rankFilterIsActive — ONE answer, because there was briefly two', () => {
  it('is on for a mirror, for a band, and for both', () => {
    assert.equal(rankFilterIsActive(filter({ rankFilter: { hwal: [2] } })), true)
    assert.equal(rankFilterIsActive(filter({ rankRanges: { hwal: { min: 2, max: null } } })), true)
    assert.equal(
      rankFilterIsActive(filter({ rankFilter: { hwal: [2] }, rankRanges: { hwal: { min: 2, max: null } } })),
      true,
    )
  })

  it('is off for nothing, for empty level lists, and for an all-open band', () => {
    assert.equal(rankFilterIsActive(filter()), false)
    assert.equal(rankFilterIsActive(filter({ rankFilter: { hwal: [] } })), false)
    assert.equal(rankFilterIsActive(filter({ rankRanges: { hwal: { min: null, max: null } } })), false)
    assert.equal(rankFilterIsActive(null), false)
  })

  it('AGREES WITH THE MATCHER on a band that has no mirror', () => {
    // The disagreement this predicate exists to remove: the page counted levels
    // only, so a band without its mirror filtered the list to nothing while the
    // badge said no filter was on — an empty screen with nothing to clear.
    const f = filter({ rankRanges: { hwal: { min: 5, max: null } } })
    assert.equal(rankFilterIsActive(f), true)
    assert.equal(countActiveFilters(f), 1)
    assert.equal(matchesFilter(contact({ ranks: { hwal: 1 } }), f, { nowMs: NOW }), false)
  })
})

describe('expandRankRange — the mirror an older resolver reads', () => {
  const HWAL = [{ value: 0 }, { value: 1 }, { value: 2 }, { value: 5 }, { value: 9 }]

  it('takes the tail of a non-contiguous scale, not every integer', () => {
    assert.deepEqual(expandRankRange(HWAL, { min: 2, max: null }), [2, 5, 9])
  })

  it('takes the head for an upper bound', () => {
    assert.deepEqual(expandRankRange(HWAL, { min: null, max: 2 }), [0, 1, 2])
  })

  it('is inclusive at both ends', () => {
    assert.deepEqual(expandRankRange(HWAL, { min: 1, max: 5 }), [1, 2, 5])
  })

  it('an all-open band mirrors the whole scale', () => {
    assert.deepEqual(expandRankRange(HWAL, { min: null, max: null }), [0, 1, 2, 5, 9])
  })

  it('a band matching nothing mirrors an empty list', () => {
    assert.deepEqual(expandRankRange(HWAL, { min: 20, max: null }), [])
  })

  it('orders by VALUE, not by position in the levels array', () => {
    // Nothing sorts or validates `levels` on write, so a scale can be stored out
    // of order. The mirror must still come back ascending by value.
    const jumbled = [{ value: 9 }, { value: 0 }, { value: 5 }, { value: 2 }, { value: 1 }]
    assert.deepEqual(expandRankRange(jumbled, { min: 1, max: null }), [1, 2, 5, 9])
  })

  it('THE MIRROR AND THE BAND AGREE while the scale is unchanged', () => {
    // The property the whole two-key design rests on: an old resolver reading
    // the mirror reaches the same verdict as a new one reading the band.
    const range = { min: 2, max: null }
    const mirror = expandRankRange(HWAL, range)
    for (const { value } of HWAL) {
      const c = contact({ ranks: { hwal: value } })
      const viaMirror = matchesFilter(c, filter({ rankFilter: { hwal: mirror } }), { nowMs: NOW })
      const viaBand = matchesFilter(c, filter({ rankRanges: { hwal: range } }), { nowMs: NOW })
      assert.equal(viaMirror, viaBand, `disagreed at level ${value}`)
    }
  })
})

describe('matchesFilter — tags and custom fields', () => {
  it('ORs tags within the dimension', () => {
    const c = contact({ tags: ['competition', 'volunteer'] })
    assert.equal(matchesFilter(c, filter({ tags: ['competition'] }), { nowMs: NOW }), true)
    assert.equal(matchesFilter(c, filter({ tags: ['staff'] }), { nowMs: NOW }), false)
    assert.equal(matchesFilter(c, filter({ tags: ['staff', 'volunteer'] }), { nowMs: NOW }), true)
  })

  it('ANDs custom-field conditions', () => {
    const c = contact({ custom_fields: { licence: 'A123', weight: 62, waiver: true } })
    const ok = filter({
      customFields: [
        { fieldId: 'licence', op: 'is_set' },
        { fieldId: 'weight', op: 'gt', value: 60 },
      ],
    })
    assert.equal(matchesFilter(c, ok, { nowMs: NOW }), true)

    const bad = filter({
      customFields: [
        { fieldId: 'licence', op: 'is_set' },
        { fieldId: 'weight', op: 'lt', value: 60 },
      ],
    })
    assert.equal(matchesFilter(c, bad, { nowMs: NOW }), false)
  })

  it('compares ISO dates lexically', () => {
    const c = contact({ custom_fields: { medical_check: '2026-03-01' } })
    const f = filter({ customFields: [{ fieldId: 'medical_check', op: 'lt', value: '2026-06-01' }] })
    assert.equal(matchesFilter(c, f, { nowMs: NOW }), true)
  })

  it('handles booleans and empties', () => {
    const c = contact({ custom_fields: { waiver: false } })
    assert.equal(
      matchesFilter(c, filter({ customFields: [{ fieldId: 'waiver', op: 'equals', value: false }] }), { nowMs: NOW }),
      true,
    )
    assert.equal(
      matchesFilter(c, filter({ customFields: [{ fieldId: 'missing', op: 'is_empty' }] }), { nowMs: NOW }),
      true,
    )
    assert.equal(
      matchesFilter(c, filter({ customFields: [{ fieldId: 'missing', op: 'is_set' }] }), { nowMs: NOW }),
      false,
    )
  })
})

describe('matchesFilter — search', () => {
  it('matches name or email, case-insensitively', () => {
    const c = contact()
    assert.equal(matchesFilter(c, filter({ search: 'love' }), { nowMs: NOW }), true)
    assert.equal(matchesFilter(c, filter({ search: 'ADA@' }), { nowMs: NOW }), true)
    assert.equal(matchesFilter(c, filter({ search: 'babbage' }), { nowMs: NOW }), false)
  })

  it('counts as an active dimension, so presets capture it', () => {
    assert.equal(countActiveFilters(filter({ search: 'love' })), 1)
    assert.equal(countActiveFilters(filter({ search: '   ' })), 0)
  })
})

describe('matchesFilter — consent', () => {
  // The five states are `waiverAcceptanceState`'s, and this dimension computes
  // them THROUGH it. These fixtures therefore assert the wiring (the ledger, the
  // floor, the missing-context arm) rather than restating the state machine —
  // `waivers/waiverState.test.ts` owns that.
  const DOC = 'house-rules'

  function signer(overrides: Partial<WaiverSignerFacts> = {}): WaiverSignerFacts {
    return {
      accepted_version: 2,
      accepted_at: stamp('2026-01-10T09:00:00Z'),
      valid_until: null,
      status: 'active',
      ...overrides,
    }
  }

  function ledger(
    signers: Record<string, WaiverSignerFacts>,
    minValidVersion = 1,
  ): ContactFilterContext {
    return { nowMs: NOW, consent: { [DOC]: { minValidVersion, signers } } }
  }

  const signed = contact({ id: 'c1' })
  const never = contact({ id: 'c2' })

  it('finds the people who have never signed — the reason the dimension exists', () => {
    const ctx = ledger({ c1: signer() })
    const f = filter({ consent: { documentId: DOC, states: ['none'] } })
    assert.equal(matchesFilter(never, f, ctx), true)
    assert.equal(matchesFilter(signed, f, ctx), false)
  })

  it('reads the state through waiverAcceptanceState, floor included', () => {
    const f = (states: WaiverAcceptanceState[]) => filter({ consent: { documentId: DOC, states } })
    // valid
    assert.equal(matchesFilter(signed, f(['valid']), ledger({ c1: signer() })), true)
    // superseded — a require_resign publish moved the floor above the signature,
    // and NO signer row was written for it.
    assert.equal(matchesFilter(signed, f(['superseded']), ledger({ c1: signer() }, 3)), true)
    assert.equal(matchesFilter(signed, f(['valid']), ledger({ c1: signer() }, 3)), false)
    // expired — lazily, against the instant frozen on the signature.
    const lapsed = signer({ valid_until: stamp('2026-06-01T00:00:00Z') })
    assert.equal(matchesFilter(signed, f(['expired']), ledger({ c1: lapsed })), true)
    // revoked outranks both.
    const withdrawn = signer({ status: 'revoked', valid_until: stamp('2026-06-01T00:00:00Z') })
    assert.equal(matchesFilter(signed, f(['revoked']), ledger({ c1: withdrawn })), true)
  })

  it('ORs the selected states, like every other dimension', () => {
    const f = filter({ consent: { documentId: DOC, states: ['none', 'expired'] } })
    const ctx = ledger({ c1: signer({ valid_until: stamp('2026-06-01T00:00:00Z') }) })
    assert.equal(matchesFilter(signed, f, ctx), true)
    assert.equal(matchesFilter(never, f, ctx), true)
    assert.equal(matchesFilter(contact({ id: 'c3' }), filter({
      consent: { documentId: DOC, states: ['valid'] },
    }), ctx), false)
  })

  it('matches NOBODY when the ledger was not loaded — never everybody', () => {
    // A partial context must not widen a result set. An empty list is visible;
    // a full one silently emails people who already signed.
    const f = filter({ consent: { documentId: DOC, states: ['none'] } })
    assert.equal(matchesFilter(never, f, { nowMs: NOW }), false)
    assert.equal(matchesFilter(never, f, { nowMs: NOW, consent: {} }), false)
  })

  it('matches nobody when the subject carries no id', () => {
    // A signer row is keyed on contactId. An unidentifiable subject is excluded
    // rather than defaulted into "never signed".
    const f = filter({ consent: { documentId: DOC, states: ['none'] } })
    assert.equal(matchesFilter(contact(), f, ledger({})), false)
  })

  it('is off unless BOTH a document and a state are chosen', () => {
    const ctx = ledger({ c1: signer() })
    assert.equal(matchesFilter(signed, filter({ consent: { documentId: DOC, states: [] } }), ctx), true)
    assert.equal(matchesFilter(signed, filter({ consent: { documentId: '', states: ['none'] } }), ctx), true)
    assert.equal(countActiveFilters(filter({ consent: { documentId: DOC, states: [] } })), 0)
    assert.equal(countActiveFilters(filter({ consent: { documentId: DOC, states: ['none'] } })), 1)
  })

  it('survives into a dynamic group rule, and drives a group', () => {
    // The whole leverage of the dimension: one addition, and a group/automation
    // can target the unsigned. Only `groups` is stripped from a rule.
    const unsigned = group({
      id: 'unsigned',
      rule: filter({ consent: { documentId: DOC, states: ['none'] } }),
    })
    const ctx = ledger({ c1: signer() })
    assert.equal(contactMatchesGroup(never, unsigned, ctx), true)
    assert.equal(contactMatchesGroup(signed, unsigned, ctx), false)
    assert.deepEqual(
      membersOfGroup([signed, never], unsigned, ctx).map((c) => c.id),
      ['c2'],
    )
  })
})

describe('dynamic groups', () => {
  const manual = group({ id: 'squad-a' })
  const juniors = group({
    id: 'juniors',
    rule: filter({ age: { mode: 'age', min: null, max: 12 } }),
  })

  it('resolves manual membership from group_ids', () => {
    assert.equal(contactMatchesGroup(contact({ group_ids: ['squad-a'] }), manual), true)
    assert.equal(contactMatchesGroup(contact(), manual), false)
  })

  it('derives dynamic membership from the rule, ignoring group_ids', () => {
    const kid = contact({ birthdate: ts('2016-05-02') })
    const adult = contact({ birthdate: ts('1990-05-02'), group_ids: ['juniors'] })
    assert.equal(contactMatchesGroup(kid, juniors, { nowMs: NOW }), true)
    // Stored membership is irrelevant for a dynamic group — the rule is the truth.
    assert.equal(contactMatchesGroup(adult, juniors, { nowMs: NOW }), false)
  })

  it('lists a contact\'s groups without needing a contact list', () => {
    const kid = contact({ birthdate: ts('2016-05-02'), group_ids: ['squad-a'] })
    const names = groupsForContact(kid, [manual, juniors], { nowMs: NOW }).map((g) => g.id)
    assert.deepEqual(names.sort(), ['juniors', 'squad-a'])
  })

  it('lists members out of an already-loaded list', () => {
    const contacts = [
      contact({ firstname: 'Kid', birthdate: ts('2016-05-02') }),
      contact({ firstname: 'Adult', birthdate: ts('1990-05-02') }),
    ]
    const members = membersOfGroup(contacts, juniors, { nowMs: NOW })
    assert.deepEqual(members.map((c) => c.firstname), ['Kid'])
  })

  it('cannot recurse: the groups dimension is stripped inside a rule', () => {
    const a: ContactGroup = group({ id: 'a', rule: filter({ groups: ['b'] }) })
    const b: ContactGroup = group({ id: 'b', rule: filter({ groups: ['a'] }) })
    // Would stack-overflow if the groups dimension survived into rule evaluation.
    assert.equal(contactMatchesGroup(contact(), a, { groups: [a, b], nowMs: NOW }), true)
    assert.equal(matchesFilter(contact(), filter({ groups: ['a'] }), { groups: [a, b], nowMs: NOW }), true)
  })

  it('expands a selected parent to its descendants', () => {
    const parent = group({ id: 'seniors' })
    const child = group({ id: 'seniors-comp', parent_id: 'seniors' })
    const ctx = { groups: [parent, child], nowMs: NOW }
    const f = filter({ groups: ['seniors'] })
    assert.equal(matchesFilter(contact({ group_ids: ['seniors-comp'] }), f, ctx), true)
    assert.equal(matchesFilter(contact({ group_ids: ['other'] }), f, ctx), false)
  })

  it('expands into a DYNAMIC descendant, resolving its rule', () => {
    const parent = group({ id: 'youth' })
    const dyn = group({
      id: 'youth-u12',
      parent_id: 'youth',
      rule: filter({ age: { mode: 'age', min: null, max: 12 } }),
    })
    const ctx = { groups: [parent, dyn], nowMs: NOW }
    const kid = contact({ birthdate: ts('2016-05-02') })
    assert.equal(matchesFilter(kid, filter({ groups: ['youth'] }), ctx), true)
  })

  it('falls back to stored membership when the group is not in context', () => {
    // A partial context must never silently widen the result set.
    const f = filter({ groups: ['unknown-group'] })
    assert.equal(matchesFilter(contact({ group_ids: ['unknown-group'] }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact(), f, { nowMs: NOW }), false)
  })
})

// UX-62 — the two dimensions a manager kept reaching for and not finding.
describe('matchesFilter — has notes', () => {
  // The dimension reads `notes_count`, a denormalised counter the
  // `trackContactNotes` trigger maintains. The predicate is pure and never
  // leaves the contact document, which is the whole reason the counter exists:
  // notes are a subcollection and a filter cannot go and read one.
  it('is off by default and matches everybody', () => {
    assert.equal(matchesFilter(contact(), filter()), true)
    assert.equal(matchesFilter(contact({ notes_count: 0 }), filter()), true)
  })

  it('keeps a contact with at least one note', () => {
    assert.equal(matchesFilter(contact({ notes_count: 1 }), filter({ hasNotes: true })), true)
    assert.equal(matchesFilter(contact({ notes_count: 9 }), filter({ hasNotes: true })), true)
  })

  it('drops a contact with none', () => {
    assert.equal(matchesFilter(contact({ notes_count: 0 }), filter({ hasNotes: true })), false)
  })

  it('treats an ABSENT counter as none', () => {
    // Every contact written before the counter existed has no field at all, and
    // a backfill only reaches those that actually have notes. Absent must read
    // as zero, not as unknown-so-keep — the alternative shows the whole roster
    // under a filter that promises the opposite.
    assert.equal(matchesFilter(contact(), filter({ hasNotes: true })), false)
  })

  it('is independent of hasAlerts', () => {
    // Two counters, two subcollections, two triggers. They were briefly easy to
    // confuse because the second was copied from the first.
    const noted = contact({ notes_count: 2, alerts_count: 0 })
    const alerted = contact({ notes_count: 0, alerts_count: 2 })
    assert.equal(matchesFilter(noted, filter({ hasNotes: true })), true)
    assert.equal(matchesFilter(noted, filter({ hasAlerts: true })), false)
    assert.equal(matchesFilter(alerted, filter({ hasNotes: true })), false)
    assert.equal(matchesFilter(alerted, filter({ hasAlerts: true })), true)
  })

  it('ANDs with the other dimensions, like every arm', () => {
    const c = contact({ notes_count: 1, tags: ['vip'] })
    assert.equal(matchesFilter(c, filter({ hasNotes: true, tags: ['vip'] })), true)
    assert.equal(matchesFilter(c, filter({ hasNotes: true, tags: ['other'] })), false)
  })

  it('a stored filter written before this dimension existed still parses', () => {
    // Saved presets and dynamic group rules are both PERSISTED ContactFilters
    // and neither is migrated, so `normalizeContactFilter` has to default the
    // key rather than leave it undefined.
    const stored = { ...EMPTY_CONTACT_FILTER } as Record<string, unknown>
    delete stored.hasNotes
    assert.equal(matchesFilter(contact({ notes_count: 0 }), stored as unknown as ContactFilter), true)
  })

  it('names itself in activeFilterKeys, so a dynamic group can describe it', () => {
    assert.ok(activeFilterKeys(filter({ hasNotes: true })).includes('hasNotes'))
    assert.ok(!activeFilterKeys(filter()).includes('hasNotes'))
  })
})

describe('matchesFilter — coach assignment', () => {
  const f = (coaches: string[]) => filter({ coaches })
  it("narrows to one coach's people", () => {
    assert.equal(matchesFilter(contact({ assigned_coach_ids: ['u1'] }), f(['u1']), { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ assigned_coach_ids: ['u2'] }), f(['u1']), { nowMs: NOW }), false)
    assert.equal(matchesFilter(contact(), f(['u1']), { nowMs: NOW }), false)
  })
  it('ORs several coaches, and matches a contact assigned to more than one', () => {
    assert.equal(matchesFilter(contact({ assigned_coach_ids: ['u2', 'u3'] }), f(['u1', 'u2']), { nowMs: NOW }), true)
  })
  it("'none' finds the unassigned", () => {
    assert.equal(matchesFilter(contact(), f(['none']), { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ assigned_coach_ids: [] }), f(['none']), { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ assigned_coach_ids: ['u1'] }), f(['none']), { nowMs: NOW }), false)
  })
  it("'none' ORs with a named coach, like every other dimension", () => {
    const both = f(['none', 'u1'])
    assert.equal(matchesFilter(contact({ assigned_coach_ids: ['u1'] }), both, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact(), both, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ assigned_coach_ids: ['u9'] }), both, { nowMs: NOW }), false)
  })
})

describe('matchesFilter — in NO group', () => {
  const manual = group({ id: 'squad-a' })
  const juniors = group({
    id: 'juniors',
    rule: filter({ age: { mode: 'age', min: null, max: 12 } }),
  })
  const ctx: ContactFilterContext = { groups: [manual, juniors], nowMs: NOW }
  const none = filter({ groups: ['none'] })

  it('finds a contact in no group at all', () => {
    assert.equal(matchesFilter(contact({ birthdate: ts('1990-05-02') }), none, ctx), true)
  })
  it('excludes a contact in a MANUAL group', () => {
    assert.equal(matchesFilter(contact({ birthdate: ts('1990-05-02'), group_ids: ['squad-a'] }), none, ctx), false)
  })
  it('excludes a contact only a DYNAMIC group claims — the whole point', () => {
    // group_ids is empty; the junior is derived into `juniors` by her birthdate.
    assert.equal(matchesFilter(contact({ birthdate: ts('2016-05-02') }), none, ctx), false)
  })
  it('ORs with a named group', () => {
    const f = filter({ groups: ['none', 'squad-a'] })
    assert.equal(matchesFilter(contact({ birthdate: ts('1990-05-02'), group_ids: ['squad-a'] }), f, ctx), true)
    assert.equal(matchesFilter(contact({ birthdate: ts('1990-05-02') }), f, ctx), true)
    assert.equal(matchesFilter(contact({ birthdate: ts('2016-05-02') }), f, ctx), false)
  })
  it('falls back to stored membership with no group context', () => {
    assert.equal(matchesFilter(contact(), none, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ group_ids: ['x'] }), none, { nowMs: NOW }), false)
  })
})

// UX-44 — "who needs me today", derived from facts already on the contact.
describe('contact attention', () => {
  const ctx: ContactFilterContext = { nowMs: NOW }
  it('reports nothing for a contact with nothing waiting', () => {
    assert.deepEqual(contactAttentionReasons(contact({ total_sessions: 3, last_session_at: ts('2026-08-12') }), ctx), [])
    assert.equal(contactNeedsAttention(contact({ total_sessions: 3, last_session_at: ts('2026-08-12') }), ctx), false)
  })
  it('orders several reasons by urgency, alerts first', () => {
    const c = contact({ alerts_count: 2, lead_acknowledged: false, acquisition_stage: 'trial_booked' })
    assert.deepEqual(contactAttentionReasons(c, ctx), ['alerts', 'trial_pending', 'new_lead'])
  })
  it('does NOT call a brand-new contact "gone quiet"', () => {
    // No attended session yet: inactivity here is newness, not churn.
    const c = contact({ created_at: ts('2020-01-01') })
    assert.equal(contactAttentionReasons(c, ctx).includes('gone_quiet'), false)
  })
  it('calls a lapsed attender gone quiet', () => {
    const c = contact({ total_sessions: 12, last_session_at: ts('2026-01-01') })
    assert.deepEqual(contactAttentionReasons(c, ctx), ['gone_quiet'])
  })
  it('is filterable, so it works in dynamic groups and automations too', () => {
    const f = filter({ needsAttention: true })
    assert.equal(matchesFilter(contact({ pending_signup: true }), f, ctx), true)
    assert.equal(matchesFilter(contact({ total_sessions: 3, last_session_at: ts('2026-08-12') }), f, ctx), false)
  })
  it('sorts the urgent first and alphabetically within a tier', () => {
    const list = [
      contact({ firstname: 'Zoe', lastname: 'Zeta', total_sessions: 3, last_session_at: ts('2026-08-12') }),
      contact({ firstname: 'Bo', lastname: 'Beta', alerts_count: 1 }),
      contact({ firstname: 'Al', lastname: 'Alpha', total_sessions: 3, last_session_at: ts('2026-08-12') }),
    ]
    const sorted = [...list].sort((a, b) => compareContactsByAttention(a, b, ctx))
    assert.deepEqual(sorted.map((c) => c.firstname), ['Bo', 'Al', 'Zoe'])
  })
})

describe('wouldCreateCycle', () => {
  const a = group({ id: 'a' })
  const b = group({ id: 'b', parent_id: 'a' })
  const c = group({ id: 'c', parent_id: 'b' })
  const groups = [a, b, c]

  it('allows a normal re-parent', () => {
    assert.equal(wouldCreateCycle(groups, 'c', 'a'), false)
    assert.equal(wouldCreateCycle(groups, 'c', null), false)
  })

  it('rejects self-parenting and descendant-parenting', () => {
    assert.equal(wouldCreateCycle(groups, 'a', 'a'), true)
    assert.equal(wouldCreateCycle(groups, 'a', 'c'), true)
    assert.equal(wouldCreateCycle(groups, 'b', 'c'), true)
  })
})

describe('filterContacts', () => {
  it('ANDs across dimensions', () => {
    const contacts = [
      contact({ firstname: 'A', acquisition_stage: 'joined', tags: ['comp'] }),
      contact({ firstname: 'B', acquisition_stage: 'joined', tags: [] }),
      contact({ firstname: 'C', acquisition_stage: 'trial_booked', tags: ['comp'] }),
    ]
    const out = filterContacts(contacts, filter({ stages: ['joined'], tags: ['comp'] }), { nowMs: NOW })
    assert.deepEqual(out.map((c) => c.firstname), ['A'])
  })
})

// ─── the automation engine's in_group condition ───────────────────────────────
// It must resolve membership exactly as every other surface does — delegating to
// the shared resolver rather than reimplementing expansion/fallback.

describe('evaluateContactConditions — in_group', () => {
  const manual = group({ id: 'squad-a' })
  const juniors = group({
    id: 'juniors',
    rule: filter({ age: { mode: 'age', min: null, max: 12 } }),
  })
  const parent = group({ id: 'seniors' })
  const child = group({ id: 'seniors-comp', parent_id: 'seniors' })
  const groups = [manual, juniors, parent, child]
  const now = new Date(NOW)

  function evalIn(groupId: string, c: ContactFilterSubject, ctx = { groups }) {
    return evaluateContactConditions([{ type: 'in_group', group_id: groupId }], c as never, now, ctx)
  }

  it('matches manual membership', () => {
    assert.equal(evalIn('squad-a', contact({ group_ids: ['squad-a'] })), true)
    assert.equal(evalIn('squad-a', contact()), false)
  })

  it('resolves a dynamic group per contact, with nothing materialized', () => {
    assert.equal(evalIn('juniors', contact({ birthdate: ts('2016-05-02') })), true)
    // Stored membership must NOT win over the rule.
    assert.equal(evalIn('juniors', contact({ birthdate: ts('1990-05-02'), group_ids: ['juniors'] })), false)
  })

  it('expands to descendants, like every other surface', () => {
    assert.equal(evalIn('seniors', contact({ group_ids: ['seniors-comp'] })), true)
    assert.equal(evalIn('seniors', contact({ group_ids: ['unrelated'] })), false)
  })

  it('falls back to stored membership when groups are unavailable', () => {
    // Context load failed / plugin absent: never widen the result set.
    assert.equal(evalIn('squad-a', contact({ group_ids: ['squad-a'] }), { groups: [] }), true)
    assert.equal(evalIn('squad-a', contact(), { groups: [] }), false)
  })

  it('matches nobody when the group_id is blank', () => {
    assert.equal(evalIn('', contact({ group_ids: ['squad-a'] })), false)
  })

  it('ANDs with the other conditions', () => {
    const c = contact({ group_ids: ['squad-a'], total_sessions: 3 })
    assert.equal(
      evaluateContactConditions(
        [{ type: 'in_group', group_id: 'squad-a' }, { type: 'sessions_attended_min', value: 5 }],
        c as never, now, { groups },
      ),
      false,
    )
    assert.equal(
      evaluateContactConditions(
        [{ type: 'in_group', group_id: 'squad-a' }, { type: 'sessions_attended_min', value: 2 }],
        c as never, now, { groups },
      ),
      true,
    )
  })
})

describe('missingEmail — who still needs a slip', () => {
  // `contact()` carries an address by default, so "no email" is stated
  // explicitly here rather than left to the fixture.
  const noEmail = (overrides: Partial<ContactFilterSubject> = {}) =>
    contact({ email: undefined, ...overrides })

  it('is off by default and keeps everyone', () => {
    assert.equal(matchesFilter(contact(), filter()), true)
    assert.equal(matchesFilter(noEmail(), filter()), true)
  })

  it('keeps a contact with no address at all', () => {
    assert.equal(matchesFilter(noEmail(), filter({ missingEmail: true })), true)
  })

  it('drops a contact that has one', () => {
    assert.equal(matchesFilter(contact(), filter({ missingEmail: true })), false)
  })

  it('treats an EMPTY or whitespace address as missing', () => {
    // Migrated rosters carry both. A contact whose email is '' or '   ' can
    // neither be mailed nor sign in, so keeping them out of the campaign hides
    // exactly the people it exists to find.
    assert.equal(matchesFilter(contact({ email: '' }), filter({ missingEmail: true })), true)
    assert.equal(matchesFilter(contact({ email: '   ' }), filter({ missingEmail: true })), true)
  })

  it('counts a login_emails entry as HAVING an address', () => {
    // The parent case: a child with no address of their own, whose parent's is
    // on the allow-list, can already reach their Space — `loginCandidates`
    // resolves a sign-in through that list. A slip would collect an address
    // nobody needed.
    assert.equal(
      matchesFilter(
        noEmail({ login_emails: ['parent@example.com'] }),
        filter({ missingEmail: true })
      ),
      false
    )
  })

  it('ignores an allow-list that is present but empty or blank', () => {
    assert.equal(matchesFilter(noEmail({ login_emails: [] }), filter({ missingEmail: true })), true)
    assert.equal(
      matchesFilter(noEmail({ login_emails: ['  '] }), filter({ missingEmail: true })),
      true
    )
  })

  it('composes with another dimension rather than replacing it', () => {
    // The campaign asks both at once: who is joined AND unreachable.
    const joined = noEmail({ acquisition_stage: 'joined' })
    assert.equal(matchesFilter(joined, filter({ missingEmail: true, stages: ['joined'] })), true)
    assert.equal(
      matchesFilter(joined, filter({ missingEmail: true, stages: ['trial_booked'] })),
      false
    )
  })

  it('survives a filter document written before the dimension existed', () => {
    // Saved presets and dynamic group rules are stored and never migrated.
    const legacy = normalizeContactFilter({ search: '', stages: ['joined'] })
    assert.equal(legacy.missingEmail, false)
    assert.equal(activeFilterKeys(legacy).includes('missingEmail'), false)
  })

  it('reports itself as active so the chip can render', () => {
    assert.equal(activeFilterKeys(filter({ missingEmail: true })).includes('missingEmail'), true)
  })
})
