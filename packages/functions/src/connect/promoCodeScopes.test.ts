import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A SCOPE THE EDITOR OFFERS MUST HAVE A RAIL THAT TAKES A CODE.
//
// Three lists have to agree, and two of them can be widened without the third
// noticing:
//
//   `PromoScopeKind`  the type          — what a scope CAN be
//   `PROMO_TARGETS`   the resolver      — what the pricing side will honor
//   `SCOPES`          the promo editor  — what a studio may AIM A CODE AT
//
// The dangerous direction is the editor running ahead of the rail. A studio
// prints "20% off the autumn course", the checkout never passes a promo context
// because its callable has no `promoCode` parameter, every buyer pays full
// price, and the admin report says nothing at all — no error, no redemption, no
// complaint until somebody wonders why the campaign did nothing. That is the
// most expensive kind of silence in this area.
//
// So the editor's list is checked against the CALLABLES, read from source. A
// scope is allowed to be offered only when the rail that sells it accepts a
// code. `course_block` is the one that is deliberately absent today.
//
// Run with: pnpm --filter @linyup/functions test

const read = (abs: string) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
const FN = join(__dirname, '..')
const WEB = join(__dirname, '../../../../apps/web/src')
const SHARED = join(__dirname, '../../../shared/src')

/** The resolver's own set, read from source: it is module-private, and reading
 *  it rather than re-listing it is what keeps this honest. */
function promoTargets(): string[] {
  const src = read(join(SHARED, 'utils/paymentOptions.ts'))
  const m = src.match(/const PROMO_TARGETS: ReadonlySet<PaymentTarget\['kind'\]> = new Set\(\[([^\]]*)\]/)
  assert.ok(m, 'PROMO_TARGETS not found in paymentOptions.ts')
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

/** Which callable sells each scope, and therefore which one has to accept a
 *  code before the scope may be offered. Named rather than counted, so the
 *  claim is checkable by reading it. */
const RAIL_FOR_SCOPE: Record<string, string> = {
  drop_in: 'booking/dropIn.ts',
  appointment: 'appointments/checkout.ts',
  course: 'connect/payments.ts',
  product: 'connect/payments.ts',
  course_block: 'courseBlocks/checkout.ts',
}

/** Does that rail's callable take a `promoCode`? */
function railTakesPromo(file: string): boolean {
  return /promoCode\?: string/.test(read(join(FN, file)))
}

/** The scopes the promo editor offers a studio. */
function editorScopes(): string[] {
  const src = read(join(WEB, 'app/[locale]/(auth)/manage/promo-codes/page.tsx'))
  const m = src.match(/const SCOPES: PromoScopeKind\[\] = \[([^\]]*)\]/)
  assert.ok(m, 'SCOPES not found in the promo-codes page')
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

describe('the promo editor never offers a scope its rail cannot honor', () => {
  it('every offered scope has a callable that accepts a code', () => {
    const missing = editorScopes().filter((scope) => {
      const rail = RAIL_FOR_SCOPE[scope]
      return !rail || !railTakesPromo(rail)
    })
    assert.deepEqual(
      missing,
      [],
      `these scopes are offered but their rail takes no promoCode, so a code aimed ` +
        `at them would silently discount nothing: ${missing.join(', ')}`
    )
  })

  it('course_block is absent, and absent for a REASON that is still true', () => {
    // The moment `createCourseBlockCheckout` grows a `promoCode`, this flips and
    // says so, which is the prompt to add the scope in that same change.
    assert.equal(
      railTakesPromo(RAIL_FOR_SCOPE.course_block),
      false,
      'the course checkout now takes a promo code: add `course_block` to SCOPES'
    )
    assert.ok(!editorScopes().includes('course_block'))
  })

  it('and the resolver is deliberately AHEAD of the editor, not behind it', () => {
    // Ahead is safe: the pricing side honoring a scope nobody can aim at costs
    // nothing. Behind would mean a code the editor sold and the resolver
    // ignored, which is the same silent failure from the other end.
    const targets = promoTargets()
    for (const scope of editorScopes()) {
      assert.ok(
        targets.includes(scope),
        `${scope} is offered by the editor but is not a PROMO_TARGET`
      )
    }
    assert.ok(targets.includes('course_block'), 'the resolver is ready for it')
  })

  it('the pin is capable of failing', () => {
    // A source-reading assertion has no failing state to have been seen, so the
    // reader is run against a rail that does take a code.
    assert.equal(railTakesPromo('connect/payments.ts'), true)
  })
})
