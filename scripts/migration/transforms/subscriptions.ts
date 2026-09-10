/**
 * Canonical HMD Basel subscription types for the Linyup migration.
 *
 * Prices sourced from the published HMD Basel website pricing plans:
 *   C:\git\hmd\hmdbasel-website-astro\src\content\pricing-plans\en\
 *
 *   Essential:  CHF 60/month, CHF 600/year
 *   Students:   CHF 70/month, CHF 660/year
 *   Unlimited:  CHF 85/month, CHF 840/year
 *
 * Plus two special offers added for Linyup (not on the website at time of migration):
 *   Intro Offer:      CHF 100 one-time, 2 months all-inclusive
 *   One-time Class:   CHF 25  one-time, 1 class / 1 month
 *
 * SubscriptionRecurrence values must exactly match the union type in
 * packages/shared/src/types/contact.ts:
 *   'per_class' | 'one_time' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'
 *
 * Shape mirrors SubscriptionType + SubscriptionPrice from that same file, and is
 * declared here rather than imported so this file stays a plain data table. (The
 * `scripts/` tree CAN import @linyup/shared — a dozen backfills do — so if these
 * ever drift far enough to be worth binding together, nothing is stopping that.)
 */

export interface MigrationSubscriptionPrice {
  id: string
  amount: number
  recurrence: string   // SubscriptionRecurrence value
  included_months?: number
  label?: string
  active: boolean
}

export interface MigrationSubscriptionType {
  id: string
  name: string
  description?: string
  active: boolean
  public: boolean
  order: number
  prices: MigrationSubscriptionPrice[]
  /**
   * How much of the plan a member may use. Mirrors `SubscriptionUsageLimit`
   * (count + per: 'day' | 'week' | 'month'). ABSENT MEANS UNLIMITED, which is
   * what every plan but Essential is.
   *
   * It only binds where an activity actually lists the plan in
   * `accessRule.subscriptionTypeIds` — that list is what `resolvePaymentOptions`
   * reads before it consults the remaining allowance. On a class that is open to
   * everyone there is no plan in the transaction at all, so there is nothing for
   * a cap to count.
   */
  limits?: Array<{ count: number; per: 'day' | 'week' | 'month' }>
}

export const CANONICAL_SUBSCRIPTION_TYPES: MigrationSubscriptionType[] = [
  {
    id:          'essential',
    name:        'Essential',
    description: 'Get started with one class per week',
    active:      true,
    public:      true,
    order:       1,
    // THE ONE CAPPED PLAN (Franco, 2026-09-08). Stated as 4 per MONTH rather
    // than 1 per week, which is what the studio sells: a member who trains twice
    // one week and not at all the next has not overrun anything.
    limits:      [{ count: 4, per: 'month' }],
    prices: [
      {
        id:         'essential_monthly',
        amount:     60,
        recurrence: 'monthly',
        label:      'Monthly',
        active:     true,
      },
      {
        id:         'essential_annual',
        amount:     600,
        recurrence: 'annual',
        label:      'Annual',
        active:     true,
      },
    ],
  },
  {
    id:          'students',
    name:        'Students',
    description: 'Special rate for students — valid student ID required',
    active:      true,
    public:      true,
    order:       2,
    prices: [
      {
        id:         'students_monthly',
        amount:     70,
        recurrence: 'monthly',
        label:      'Monthly',
        active:     true,
      },
      {
        id:         'students_annual',
        amount:     660,
        recurrence: 'annual',
        label:      'Annual',
        active:     true,
      },
    ],
  },
  {
    id:          'unlimited',
    name:        'Unlimited',
    description: 'Train body and mind — access to all sessions',
    active:      true,
    public:      true,
    order:       3,
    prices: [
      {
        id:         'unlimited_monthly',
        amount:     85,
        recurrence: 'monthly',
        label:      'Monthly',
        active:     true,
      },
      {
        id:         'unlimited_annual',
        amount:     840,
        recurrence: 'annual',
        label:      'Annual',
        active:     true,
      },
    ],
  },
  {
    id:          'intro_offer',
    name:        'Intro Offer',
    description: '2 months all-inclusive — one-time welcome package',
    active:      true,
    public:      true,
    order:       4,
    prices: [
      {
        id:             'intro_offer_one_time',
        amount:         100,
        recurrence:     'one_time',
        included_months: 2,
        label:          '2 months all-inclusive',
        active:         true,
      },
    ],
  },
  {
    id:          'one_time_class',
    name:        'One-time Class',
    description: 'Drop-in single class',
    active:      true,
    public:      true,
    order:       5,
    prices: [
      {
        id:             'one_time_class_one_time',
        amount:         25,
        recurrence:     'one_time',
        included_months: 1,
        label:          'Single class',
        active:         true,
      },
    ],
  },
  {
    // THE COMP. Family, and people who support the club in ways that are not
    // money — full access, pays nothing (Franco, 2026-09-08). hmd-lineup called
    // it "Free", which in this product means three other things: the SaaS `free`
    // plan tier, the newcomer's free trial, and a class that is free to book. A
    // membership sitting beside those needed a word of its own.
    //
    // NO PRICES, and `public: false`: there is nothing to sell and nothing to
    // put on the pricing table. It is assigned by hand, which is exactly the
    // "just a container" shape `SubscriptionType.prices` documents as absent —
    // the same shape the Instructor plan below has.
    id:          'complimentary',
    name:        'Complimentary',
    description: 'Full access, no charge — family, supporters, and guests of the club',
    active:      true,
    public:      false,
    order:       6,
    prices:      [],
  },
  {
    // THE OTHER COMP — the people who TEACH. Structurally identical to
    // Complimentary (full access, no prices, `public: false`, assigned by hand)
    // and kept separate because the two answer different questions about a
    // roster: how many people the club comps, and how many of them are staff.
    // Folding coaches into Complimentary would make the first number unusable
    // and lose the second entirely.
    //
    // Canonical for the reason Complimentary is: it was a per-club source type
    // with a generated id, so every club that comps its coaches — which is every
    // club — had to invent its own. It grants no permission of any kind; who may
    // manage a team is `team_members`, and this is only what the coach pays.
    id:          'instructor',
    name:        'Instructor',
    description: 'Full access, no charge — coaches and assistant instructors',
    active:      true,
    public:      false,
    order:       7,
    prices:      [],
  },
]

// ─── Contact subscription field matching ─────────────────────────────────────
//
// HEURISTIC — matches a contact's source `subscription_type_name` to the
// canonical types by case-insensitive keyword lookup. This is a best-effort
// approximation and MUST be validated against the real source data after migration.
//
// Match logic (evaluated in order; first match wins):
//   exactly "free"  → complimentary   (EXACT, see below)
//   instructor      → instructor
//   intro           → intro_offer
//   one / single / drop / drop.in / drop-in → one_time_class
//   unlimited       → unlimited
//   student(s)      → students
//   essential       → essential
//
// "free" is the one rule anchored to the WHOLE name rather than matched as a
// substring, because the substring is a trap: "Free Trial" is a newcomer's first
// class and must never become a lifetime comp, and "Free Weights" is not a
// membership at all. Anchoring costs nothing here — a club that comps somebody
// writes "Free", not "Free-ish".
//
// If no keyword matches, the contact's subscription fields are left unchanged.

type CanonicalMatch = {
  typeId:   string
  typeName: string
  prices:   MigrationSubscriptionPrice[]
}

const KEYWORD_MAP: Array<{ regex: RegExp; typeId: string }> = [
  { regex: /^\s*free\s*$/i,         typeId: 'complimentary' },
  // A SUBSTRING, unlike `free`, and BEFORE `students?`: "Head Instructor" and
  // "Assistant Instructor" are the same comp, and a "Student Instructor" is an
  // instructor rather than a student — first match wins, so the order is the
  // answer to that.
  { regex: /instructor/i,           typeId: 'instructor'    },
  { regex: /intro/i,                typeId: 'intro_offer'   },
  { regex: /one|single|drop/i,      typeId: 'one_time_class' },
  { regex: /unlimited/i,            typeId: 'unlimited'     },
  { regex: /students?/i,            typeId: 'students'      },
  { regex: /essential/i,            typeId: 'essential'     },
]

const TYPE_INDEX = new Map<string, MigrationSubscriptionType>(
  CANONICAL_SUBSCRIPTION_TYPES.map((t) => [t.id, t]),
)

/**
 * Does this SOURCE type duplicate a canonical one we are about to seed?
 *
 * Pass 11 does two things to a team's plans: it copies the source's own
 * `subscription_types`, and it writes the five canonical ones. Where a source
 * plan is called "Unlimited" and a canonical plan is called "Unlimited", the
 * studio ends up with both — the rich one with prices and a description, and a
 * bare one carrying nothing but a name. That is what a real import produced for
 * HMD Basel: duplicate Unlimited, Intro Offer, Student and Essential.
 *
 * Over the whole federation this drops exactly those four (only one team has
 * plans at all), and keeps ClassPass, Fitpass, Free and Instructor, which have
 * no canonical counterpart. The contact-side matcher sends the members of a
 * dropped type to the canonical id, so nothing is orphaned by the skip.
 */
export function sourceTypeDuplicatesCanonical(name: string | undefined | null): boolean {
  return matchSubscriptionType(name) !== null
}

/** Returns the canonical match for the given source subscription_type_name, or null. */
export function matchSubscriptionType(sourceName: string | undefined | null): CanonicalMatch | null {
  if (!sourceName) return null
  for (const { regex, typeId } of KEYWORD_MAP) {
    if (regex.test(sourceName)) {
      const type = TYPE_INDEX.get(typeId)!
      return { typeId, typeName: type.name, prices: type.prices }
    }
  }
  return null
}

/**
 * Given a matched canonical type and the source recurrence hint, returns the
 * best-matching price from that type's prices list.
 *
 * For types with a single price (intro_offer, one_time_class) the only price
 * is returned regardless of the recurrence hint.
 *
 * For types with monthly + annual prices:
 *   - If the source recurrence contains 'annual' or 'year', pick the annual price.
 *   - Otherwise default to monthly.
 */
export function pickSubscriptionPrice(
  prices: MigrationSubscriptionPrice[],
  sourceRecurrence: string | undefined | null,
): MigrationSubscriptionPrice {
  if (prices.length === 1) return prices[0]
  const hint = (sourceRecurrence ?? '').toLowerCase()
  const isAnnual = /annual|year/.test(hint)
  return prices.find((p) => p.recurrence === (isAnnual ? 'annual' : 'monthly')) ?? prices[0]
}
