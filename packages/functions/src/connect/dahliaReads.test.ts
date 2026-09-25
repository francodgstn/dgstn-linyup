import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE DAHLIA READS, PINNED TO THE SOURCE — because reverting any of them is
// currently INVISIBLE to every behavioral test in this repo.
//
// ── Why this file exists at all ──────────────────────────────────────────────
// The Basil→Dahlia defect shipped for one reason: `obj.field` on an `any`
// returns `undefined` instead of throwing, so three wrong-data bugs went out
// with a green suite behind them. objectShape.ts fixed the reads and pinned the
// FIELD LOCATIONS against the SDK's own declarations — but nothing pinned the
// CALL SITES. Re-inline `sub.current_period_end` at either site in
// connect/webhook.ts today and `pnpm --filter @linyup/functions test` still
// passes, all 1100-odd of it, exactly as it did before the defect was found.
//
// That is the same hole the migration was about, one level up: the guard was
// placed on the reader and not on anyone's obligation to use it.
//
// ── Why SOURCE assertions rather than behavioral tests ─────────────────────
// These handlers take a live Stripe client, firebase-functions and the Admin
// SDK; reaching `handleInvoice` behaviourally means standing up the emulator and
// a Stripe fixture per case, and the property under test — "this call site reads
// through the module, and this handler writes no `status`" — is a property of
// the TEXT. Same technique and same reasoning as connect/commitSites.test.ts and
// waivers/surfaces.test.ts, which pin counts and call-site lists the same way.
//
// A source guard cannot prove behavior. What it can do is make a silent
// reversion loud, which is precisely what was missing.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
/** SRC → packages/functions → packages → worktree root. The backfill script
 *  lives outside the package and is half of the writer-parity claim below. */
const ROOT = join(SRC, '..', '..', '..')

/** LF-normalized: CRLF on Windows, LF on CI, and these patterns span lines. */
function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** CODE only — these files describe the very field moves they must not perform,
 *  and counting a doc comment as a read is the confusion this file removes. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function countCalls(source: string, name: string): number {
  const re = new RegExp(`(?<!function\\s)\\b${name}\\(`, 'g')
  return (source.match(re) ?? []).length
}

/**
 * The body of a top-level `function NAME(...)`, signature excluded. Matches the
 * `async` form too — `async function x(` contains `function x(`.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} not found — this guard has drifted from the source`)
  const bodyStart = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart + 1, i)
    }
  }
  throw new Error(`unbalanced braces walking ${name}`)
}

/**
 * String and template literals blanked, so a field NAME quoted as data is not
 * mistaken for a read of that field. Both of these are legitimate and neither is
 * an access:
 *
 *   reportStripeShape('subscription.current_period_end', …)   ← the alarm's label
 *   { current_period_end: periodEnd }                          ← the Firestore key
 */
function stripLiterals(source: string): string {
  return source
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/**
 * Every `<receiver>.<field>` read in the source, as the set of RECEIVERS.
 *
 * Asserting the receiver set rather than "no matches" is what keeps this guard
 * both precise and strict: our own `target.current_period_end` (the backfill's
 * computed Target) is legal, `sub.current_period_end` is the defect, and a
 * receiver nobody has vetted yet shows up as a new name in the failure rather
 * than passing silently.
 */
function readReceivers(source: string, field: string): string[] {
  const re = new RegExp(`(\\w+)\\s*\\.\\s*${field}\\b`, 'g')
  const out = new Set<string>()
  for (const m of stripLiterals(source).matchAll(re)) out.add(m[1])
  return [...out].sort()
}

/** Receivers that are OUR OWN objects, never a Stripe payload. */
const OUR_OBJECTS = ['target']

describe('THE PERIOD IS READ THROUGH THE MODULE, AT EVERY SITE', () => {
  // Dahlia removed `current_period_start`/`current_period_end` from the
  // Subscription object and moved them onto each SubscriptionItem. objectShape's
  // `_assert_sub_has_no_period_end` pins that fact against the SDK; these pin
  // that nobody reads around it.
  const SITES: Record<string, number> = {
    // handleSubscription (the lifecycle write) + handleCheckoutCompleted (the
    // membership expiry at purchase). Both were original defect sites: the first
    // stored a null period end, the second a null membership expiry.
    'connect/webhook.ts': 2,
    // The SaaS rail had the identical bug for the identical reason — the studio's
    // own "next billing date" went blank in settings and the operator console.
    'utils/gateway/stripe.ts': 1,
  }

  for (const [file, expected] of Object.entries(SITES)) {
    it(`${file} reads the period ONLY through readSubscriptionPeriod`, () => {
      const src = code(read(file))
      assert.equal(
        countCalls(src, 'readSubscriptionPeriod'),
        expected,
        `${file} should have ${expected} readSubscriptionPeriod call site(s)`
      )
      for (const f of ['current_period_start', 'current_period_end']) {
        const receivers = readReceivers(src, f)
        assert.deepEqual(
          receivers,
          [],
          `${file} reads ${f} off ${receivers.join('/')}. Dahlia moved the period onto the ` +
            `subscription ITEM, so this returns undefined and stores null — the ` +
            `membership-expiry defect, re-committed. Use readSubscriptionPeriod.`
        )
      }
    })
  }

  it('the backfill reads BOTH ends of the period, through the same reader', () => {
    // Reading both is not the same as writing both — which rail gets which field
    // is pinned in THE BACKFILL WRITES WHAT THE WEBHOOK WRITES below.
    const script = readRoot('scripts/backfill-subscription-lifecycle.ts')
    const src = code(script)
    assert.equal(countCalls(src, 'readSubscriptionPeriod'), 1)
    // `target.current_period_*` is the script's own computed Target being
    // written out — legal. A Stripe object appearing here would not be.
    for (const f of ['current_period_start', 'current_period_end']) {
      assert.deepEqual(readReceivers(src, f), OUR_OBJECTS, `unexpected receiver reading ${f}`)
    }
    assert.ok(
      /current_period_start:\s*ts\(period\.start\)/.test(src),
      'the backfill must read current_period_start, not only the end'
    )
    assert.ok(/current_period_end:\s*ts\(period\.end\)/.test(src))
  })

  it('the cancellation is read through the module too, at every site', () => {
    // The billing-portal expression (`cancel_at` timestamp, boolean left FALSE)
    // is the one that surfaced nowhere. A site reading `sub.cancel_at_period_end`
    // directly is that defect again.
    for (const file of ['connect/webhook.ts', 'utils/gateway/stripe.ts']) {
      const src = code(read(file))
      assert.ok(
        countCalls(src, 'readSubscriptionCancellation') >= 1,
        `${file} must read the cancellation through the module`
      )
      const receivers = readReceivers(src, 'cancel_at_period_end')
      assert.deepEqual(
        receivers,
        [],
        `${file} reads cancel_at_period_end off ${receivers.join('/')} — that field is FALSE ` +
          `for a billing-portal cancellation, which is how portal cancellations surfaced ` +
          `nowhere. Use readSubscriptionCancellation.`
      )
    }
  })
})

describe('EVERY SURFACE THAT SHOWS A SUBSCRIPTION ASKS THE PREDICATE', () => {
  // The writers were fixed first, and each reading surface was converted one at
  // a time — which is how settings/billing ended up the LAST one still asking
  // the raw `cancel_at_period_end` at all three of its decision points (badge,
  // Reactivate, Cancel) after every sibling had stopped. Nothing noticed,
  // because "this file still reads the raw boolean" is invisible to a suite that
  // only tests the predicate.
  //
  // Same technique and same limits as the call-site guards above: this cannot
  // prove a page renders, only that it cannot quietly re-inline the boolean that
  // is FALSE for every billing-portal cancellation. What the predicate itself
  // answers for all four stored expressions × every status (absent included) is
  // pinned in utils/stripe/subscriptionLifecycle.test.ts.
  const SURFACES = [
    // A studio's own Linyup subscription.
    'apps/web/src/app/[locale]/(auth)/settings/billing/page.tsx',
    // An org owner's.
    'apps/web/src/app/[locale]/(auth)/org/[orgId]/billing/page.tsx',
    // A studio reading a MEMBER's membership. It lived in the contact's
    // PaymentsTab until 2026-08, when the section stopped being rendered twice
    // (once there, once on the Plans side of the same contact) and moved to the
    // one component both had been calling. The surface is the same surface — only
    // its address changed — so the entry follows it rather than being dropped.
    // It moved again on 2026-09-25, into the per-plan cards (a plan and the
    // billing that pays for it are one card, docs/multi-plan-holdings.md §5).
    'apps/web/src/app/[locale]/(auth)/contacts/[id]/PlansList.tsx',
    // The operator console's account detail.
    'apps/admin/src/lib/queries/account.ts',
    // The member-facing mirror: Space reads `Contact.active_subscriptions`, so
    // this trigger is the surface as far as the member is concerned.
    'packages/functions/src/sync/onMemberSubscriptionWrite.ts',
  ]

  const PREDICATES = [
    'subscriptionIsCancelling',
    'subscriptionEndsAt',
    'subscriptionEndsAtMs',
    'subscriptionCancellation',
  ]

  // Delegating to the shared ROLLUP counts as asking the predicate, because the
  // rollup asks it — and the assertion below pins that, so this is a closed
  // chain rather than a widened hole. It became necessary when the rollup moved
  // into @linyup/shared to get a second caller: the seed fixture writes
  // member_subscriptions through the Admin SDK, where no trigger fires, and a
  // seed computing its own rollup is exactly the divergence this file exists to
  // prevent.
  const DELEGATES = ['rollupMemberSubscriptions']
  const ROLLUP = 'packages/shared/src/utils/subscriptionRollup.ts'

  it(`${ROLLUP} is itself decided through the shared predicate`, () => {
    const src = code(readRoot(ROLLUP))
    assert.deepEqual(
      readReceivers(src, 'cancel_at_period_end'),
      [],
      `${ROLLUP} reads the raw boolean — the whole point of delegating to it is that it does not.`
    )
    assert.ok(
      PREDICATES.some((pr) => countCalls(src, pr) > 0),
      `${ROLLUP} is accepted as a delegate by the surfaces below, so it must call ` +
        `one of ${PREDICATES.join('/')} itself.`
    )
  })

  for (const file of SURFACES) {
    it(`${file} decides through the shared predicate`, () => {
      const src = code(readRoot(file))
      const receivers = readReceivers(src, 'cancel_at_period_end')
      assert.deepEqual(
        receivers,
        [],
        `${file} reads cancel_at_period_end off ${receivers.join('/')}. That boolean is FALSE ` +
          `for every cancellation made in the Stripe billing portal, so this surface is back to ` +
          `showing no badge, no end date, and "Cancel" to a subscriber who already cancelled. ` +
          `Ask shared/utils/subscriptionLifecycle.ts instead.`
      )
      assert.ok(
        [...PREDICATES, ...DELEGATES].some((p) => countCalls(src, p) > 0),
        `${file} shows a subscription but calls none of ${PREDICATES.join('/')} — ` +
          `nor ${DELEGATES.join('/')}, which ask them on its behalf`
      )
    })
  }

  it('settings/billing never dereferences a status that can be missing', () => {
    // `SaasSubscription.status` is declared non-optional, so TypeScript is no
    // help here: the SaaS webhook's `subscription.updated` branch writes no
    // status and merges, so an out-of-order `updated` creates a doc without one
    // (saas_subscriptions/hmd). `sub.status.replace('_', ' ')` threw on exactly
    // that doc and took the whole page with it — for the one owner whose
    // subscription was winding down.
    const src = code(readRoot('apps/web/src/app/[locale]/(auth)/settings/billing/page.tsx'))
    const derefs = [...src.matchAll(/\bsub\??\.status\s*\.\s*(\w+)/g)].map((m) => m[1])
    assert.deepEqual(
      derefs,
      [],
      `settings/billing calls .${derefs.join('/.')} directly on sub.status — that is a TypeError ` +
        'on a status-less doc. Go through storedStatus().'
    )
    assert.ok(
      /function storedStatus\(/.test(src),
      'storedStatus() is what makes the missing status representable — keep it'
    )
  })
})

describe('`status` HAS ONE OWNER, AND handleInvoice IS NOT IT', () => {
  const webhook = read('connect/webhook.ts')

  it('handleInvoice writes no status — the rule, not the comment about the rule', () => {
    // Until now this was enforced by a comment saying "must not start". Re-adding
    // `status: 'active'` there is invisible to the suite, and what it costs is
    // specific: Stripe orders `invoice.paid` and `customer.subscription.deleted`
    // however it likes, so a late or retried invoice would flip a canceled
    // subscription back to active and re-grant the entitlement behind it.
    const body = code(functionBody(webhook, 'handleInvoice'))
    const writes = body.match(/(?<![\w$])status\s*:/g) ?? []
    assert.deepEqual(
      writes,
      [],
      'handleInvoice assigns a `status` field. That fights handleSubscription, which owns ' +
        'it — and with no ordering guarantee between the two events, the loser is whichever ' +
        'arrives last. The invoice is authoritative for the PAYMENT outcome only ' +
        '(last_payment_status), which is why that key is spelled differently.'
    )
    // …and the outcome it IS authoritative for is still written, so this guard
    // cannot be satisfied by gutting the handler.
    assert.ok(
      /last_payment_status:\s*status/.test(body),
      'handleInvoice must still record the payment outcome it owns'
    )
  })

  it('handleSubscription DOES write it — the other half of the claim', () => {
    // An ownership rule needs both halves asserted, or deleting the write from
    // the owner would leave the rule technically satisfied and nobody writing a
    // status at all.
    const body = code(functionBody(webhook, 'handleSubscription'))
    assert.ok(
      /(?<![\w$])status:\s*sub\.status/.test(body),
      'handleSubscription must store the status off the subscription object'
    )
  })

  it('the rule is written down where the next reader will be', () => {
    const body = functionBody(webhook, 'handleInvoice')
    assert.ok(
      /WHO OWNS `status`/.test(body),
      'keep the ownership note beside the write it governs'
    )
  })
})

describe('THE BACKFILL WRITES WHAT THE WEBHOOK WRITES', () => {
  // A repair script that disagrees with the live writer does not fix a doc, it
  // creates a second truth that flaps at the next event. The two rails' handlers
  // store different FIELDS and disagree with EACH OTHER about an ended
  // subscription, so the script has to reproduce each one rather than pick a
  // house style.
  const script = readRoot('scripts/backfill-subscription-lifecycle.ts')
  const saasWebhook = read('saas-billing/index.ts')
  const webhook = read('connect/webhook.ts')

  /** The backfill's `payload()`, comments stripped. */
  const payloadBody = code(functionBody(code(script), 'payload'))

  /** The slice of `payload()` from one marker to the next. */
  function payloadBranch(from: string, to: string | null): string {
    const start = payloadBody.indexOf(from)
    assert.notEqual(start, -1, `payload() no longer contains "${from}" — this guard has drifted`)
    if (to === null) return payloadBody.slice(start)
    const end = payloadBody.indexOf(to, start)
    assert.notEqual(end, -1, `payload() no longer contains "${to}" after "${from}"`)
    return payloadBody.slice(start, end)
  }

  it('the Connect rail stores the period as a PAIR — handler, type and backfill together', () => {
    // Until 2026-08-31 the start was a SaaS-only field and this test pinned its
    // ABSENCE on the Connect rail (the backfill writing it was a repair
    // inventing a field). Accrual readiness added it deliberately — the start
    // says which SERVICE PERIOD an invoice bought (docs/finance-accrual.md,
    // Phase 0) — so the contract enforced here is the one the old failure
    // message stated: MemberSubscription declares it, handleSubscription writes
    // it, and the backfill writes it too. All three move together or none do.
    const handler = code(functionBody(webhook, 'handleSubscription'))
    assert.ok(
      /current_period_start:\s*periodStart/.test(handler),
      'handleSubscription must write the period START — same whole-record rail rule as the end, ' +
        'nulls included'
    )
    assert.ok(
      /current_period_end:\s*periodEnd/.test(handler),
      'handleSubscription must still write the period END it owns'
    )
    // LF-normalized, because the slice below is anchored on a bare newline and
    // core.autocrlf gives every Windows checkout CRLF. The needle then misses,
    // the slice collapses to nothing, and the assertion fails against an empty
    // string while the source it is guarding is perfectly correct. That failure
    // has now cost time twice in this repo — see the same note in
    // sync/documentsDegating.test.ts.
    const memberType = readRoot('packages/shared/src/types/connect.ts').replace(/\r\n/g, '\n')
    const ifaceStart = memberType.indexOf('export interface MemberSubscription {')
    assert.notEqual(ifaceStart, -1, 'MemberSubscription moved — this guard has drifted')
    const iface = memberType.slice(ifaceStart, memberType.indexOf('\n}\n', ifaceStart))
    assert.ok(
      /current_period_start/.test(iface),
      'MemberSubscription must declare the period start its writer produces'
    )
    const connect = payloadBranch("rail === 'connect'", "rail === 'saas'")
    assert.ok(
      /current_period_start:\s*target\.current_period_start/.test(connect),
      "the backfill's connect payload must write the start the webhook writes — the script " +
        'advertises byte-identity with the handler in its own header, and a run of it is also ' +
        'the repair that fills the starts on docs written before the field existed.'
    )
    assert.ok(/current_period_end:\s*target\.current_period_end/.test(connect))
  })

  it('…and the SaaS rail, which does have it, repairs BOTH ends', () => {
    // Where the field exists it is rendered as a PAIR (settings/billing prints
    // "start – end", the operator console prints the whole period), so fixing
    // only the end leaves both half-right and neither obviously wrong.
    assert.ok(
      /current_period_start: Timestamp \| null/.test(readRoot('packages/shared/src/types/saas.ts')),
      'SaasSubscription must declare the period start the backfill repairs'
    )
    assert.ok(/update\.current_period_start = Timestamp\.fromDate/.test(saasWebhook))
    // The LAST return in payload() is the SaaS live branch — connect and the
    // SaaS ended-rule both return before it.
    const live = payloadBody.slice(payloadBody.lastIndexOf('return {'))
    assert.ok(/current_period_start: target\.current_period_start/.test(live))
    assert.ok(/current_period_end: target\.current_period_end/.test(live))
    // …and only when Stripe states one, exactly as both live SaaS branches guard
    // with `if (event.currentPeriodStart)`. A null here would be a value the
    // handler would never write over a stored one.
    assert.ok(/\.\.\.\(target\.current_period_start/.test(live))
    assert.ok(/if \(event\.currentPeriodStart\)/.test(saasWebhook))
  })

  it('the SaaS handler still forces the pair false/null once a subscription has ENDED', () => {
    // If this changes, the backfill's mirror of it below is now the wrong shape.
    const branch = saasWebhook.slice(
      saasWebhook.indexOf("case 'subscription.cancelled':"),
      saasWebhook.indexOf("case 'payment.succeeded':")
    )
    assert.ok(branch.length > 0, 'the subscription.canceled branch moved')
    assert.ok(/update\.cancel_at_period_end = false/.test(branch))
    assert.ok(/update\.cancel_at = null/.test(branch))
    // …and writes the record fields ONLY when the payload carries them, so a
    // `deleted` event with no details cannot erase a reason an earlier `updated`
    // recorded. This conditionality is the part the backfill got wrong.
    assert.ok(/if \(event\.canceledAt\) update\.canceled_at =/.test(branch))
    assert.ok(/if \(event\.cancellationDetails\) update\.cancellation_details =/.test(branch))
    // …and writes NO billing period. Not an oversight in the handler: the
    // adapter builds this event from `cancellation(obj)` deliberately without
    // the period, because an ended subscription has no CURRENT one. The backfill
    // wrote it anyway — and `deleted` is terminal, so nothing would ever have
    // corrected that.
    assert.ok(
      !/update\.current_period_(start|end)/.test(branch),
      'the subscription.canceled branch now writes a billing period — if that is deliberate, ' +
        "the backfill's ended-branch has to start writing one too"
    )
  })

  it('the backfill mirrors that rule for the SaaS rail, and only for it', () => {
    assert.ok(
      /rail === 'saas' && target\.endedAtStripe/.test(payloadBody),
      'the ended-rule must be scoped to the SaaS rail — the Connect handler writes all ' +
        'its fields unconditionally on every event, so applying it there would be the drift ' +
        'this guard exists to stop, pointing the other way.'
    )
    const branch = payloadBranch("rail === 'saas' && target.endedAtStripe", 'return {\n    ...(')
    assert.ok(/cancel_at_period_end: false/.test(branch))
    assert.ok(/cancel_at: null/.test(branch))
    assert.ok(
      !/current_period_(start|end)/.test(branch),
      'the ended SaaS payload writes a billing period the subscription.canceled branch never ' +
        'writes — a "current" period stamped onto a subscription the codebase says has none'
    )
    assert.ok(
      /\.\.\.\(target\.canceled_at \? \{ canceled_at: target\.canceled_at \} : \{\}\)/.test(branch),
      'canceled_at must be written only when Stripe states one — never a null over a stored value'
    )
    assert.ok(
      /\.\.\.\(target\.cancellation_details/.test(branch),
      'cancellation_details must be written only when Stripe states one, or a repair run ' +
        'DELETES the churn reason on every ended SaaS subscription'
    )
  })

  it('the drift report compares through the rail’s vocabulary, not raw strings', () => {
    // Raw `stored.status !== target.stripeStatus` printed EVERY correctly-
    // canceled studio as drift — Stripe says `canceled`, SaasStatus says
    // `cancelled` — under a heading claiming a webhook event had been missed.
    const src = code(script)
    assert.ok(
      /expectedStoredStatus\(target\.stripeStatus, rail\)/.test(src),
      'the drift check must go through the rail’s vocabulary map'
    )
    assert.ok(
      !/stored\.status !== target\.stripeStatus/.test(src),
      'the drift check is comparing the two vocabularies as raw strings again'
    )
    const mapStart = src.indexOf('const SAAS_STATUS_FOR_STRIPE')
    assert.notEqual(mapStart, -1, 'SAAS_STATUS_FOR_STRIPE moved — this guard has drifted')
    const map = src.slice(mapStart, src.indexOf('}', mapStart))
    for (const s of [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ]) {
      assert.ok(
        new RegExp(`\\b${s}:`).test(map),
        `SAAS_STATUS_FOR_STRIPE has no case for Stripe's "${s}" — an unmapped status abstains, ` +
          'and an abstention reads exactly like "no drift"'
      )
    }
    // The target vocabulary it maps INTO, so a change to SaasStatus lands here.
    assert.ok(
      /'trial' \| 'active' \| 'past_due' \| 'cancelled' \| 'expired'/.test(
        readRoot('packages/shared/src/types/team.ts')
      ),
      'SaasStatus changed — re-check every value SAAS_STATUS_FOR_STRIPE maps into'
    )
  })

  it('the SaaS rail reads the subscription id from BOTH shapes that are stored', () => {
    // The blocker this replaces: `data.gateway_data?.subscription_id` is
    // `undefined` for every doc the webhook wrote before the shape was fixed, so
    // the SaaS half could not repair a single real document. saas-billing built
    // dotted STRING KEYS and persisted them with set(), which stores them
    // LITERALLY — update() would have made a nested map, set() does not.
    //
    // The writer now emits a nested map (see saas-billing/gatewayData.test.ts),
    // but this reader must keep BOTH arms: every doc written before that fix
    // still carries the literal until `pnpm backfill:gateway-data` converges it,
    // and this script is one of the things that has to work on those docs.
    const src = code(script)
    assert.ok(
      /data\['gateway_data\.subscription_id'\]/.test(src),
      'the literal dotted field is what un-migrated docs carry; reading only the nested map ' +
        'makes this script a no-op that reports success'
    )
    assert.ok(
      /data\.gateway_data as \{ subscription_id\?: unknown \}/.test(src),
      'the nested arm is what the fixed writer and the backfill produce'
    )
    // The writer side of that claim, so this guard notices if the shape moves again.
    assert.ok(
      !/update\['gateway_data\.[^']+'\]\s*=(?!\s*FieldValue\.delete)/.test(saasWebhook),
      'the SaaS writer is writing dotted keys again — set() stores those literally, which is ' +
        'the whole defect this guard exists for'
    )
    assert.ok(
      /await subRef\.set\(update, \{ merge: true \}\)/.test(saasWebhook),
      'the SaaS writer no longer persists with set() — if it moved to update(), dotted ' +
        'keys would be real nested maps and this reader could drop its literal arm'
    )
  })
})
