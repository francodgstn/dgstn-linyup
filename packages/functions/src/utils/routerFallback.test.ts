// When the router is not there — @linyup/shared → withRouterFallback.
//
// The fallback is what lets a client that ROUTES talk to a project that does not
// have the router yet (the member app ships over the air on its own lane), so the
// one property that matters is pinned here: it falls back ONLY when the member
// never ran. Falling back on a `not-found` the member itself threw would run a
// booking or a checkout twice.
//
// It lives in the functions suite because @linyup/shared has no test runner.
import assert from 'node:assert/strict'
import {
  isRouterMissingError,
  resetRouterFallbackMemory,
  withRouterFallback,
} from '@linyup/shared'

const err = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('isRouterMissingError — only the two cases where no member ran', () => {
  it('the function does not exist: the platform 404, as the client SDK reports it', () => {
    assert.ok(isRouterMissingError(err('functions/not-found', 'not-found')))
    assert.ok(isRouterMissingError(err('functions/not-found', 'Not-Found')))
    assert.ok(isRouterMissingError(err('not-found', 'not-found')))
  })

  it('the router exists but does not serve that name', () => {
    assert.ok(isRouterMissingError(err('functions/not-found', 'No such callable on rpcMember')))
  })

  it("NOT a member's own not-found — the member ran", () => {
    assert.ok(!isRouterMissingError(err('functions/not-found', 'Session not found')))
    assert.ok(!isRouterMissingError(err('functions/not-found', 'Contact not found')))
    assert.ok(!isRouterMissingError(err('functions/not-found', '')))
  })

  it('NOT any other failure, however it is spelled', () => {
    assert.ok(!isRouterMissingError(err('functions/internal', 'not-found')))
    assert.ok(!isRouterMissingError(err('functions/unavailable', 'not-found')))
    assert.ok(!isRouterMissingError(err('functions/permission-denied', 'permission-denied')))
    assert.ok(!isRouterMissingError(new Error('not-found')))
    assert.ok(!isRouterMissingError(null))
    assert.ok(!isRouterMissingError('not-found'))
  })
})

describe('withRouterFallback', () => {
  beforeEach(() => resetRouterFallbackMemory())

  it('uses the router when it is there, and never touches the direct name', async () => {
    let direct = 0
    const call = withRouterFallback<{ n: number }, string>({
      router: 'rpcMember',
      routed: async (d) => `routed:${d?.n}`,
      direct: async () => {
        direct++
        return 'direct'
      },
    })
    assert.equal(await call({ n: 1 }), 'routed:1')
    assert.equal(direct, 0)
  })

  it('falls back when the router is missing, reports it once, and passes the same payload', async () => {
    const seen: unknown[] = []
    const fallbacks: string[] = []
    let routed = 0
    const call = withRouterFallback<{ n: number }, string>({
      router: 'rpcMember',
      routed: async () => {
        routed++
        throw err('functions/not-found', 'not-found')
      },
      direct: async (d) => {
        seen.push(d)
        return 'direct'
      },
      onFallback: (r) => fallbacks.push(r),
    })
    assert.equal(await call({ n: 7 }), 'direct')
    assert.equal(await call({ n: 8 }), 'direct')
    assert.deepEqual(seen, [{ n: 7 }, { n: 8 }])
    assert.deepEqual(fallbacks, ['rpcMember'], 'reported once, not per call')
    assert.equal(routed, 1, 'a missing router costs ONE failed round trip, not one per call')
  })

  it('remembers per ROUTER — one missing router does not send another to its direct names', async () => {
    const missing = withRouterFallback<void, string>({
      router: 'rpcMember',
      routed: async () => {
        throw err('functions/not-found', 'not-found')
      },
      direct: async () => 'direct',
    })
    await missing()
    let routed = 0
    const present = withRouterFallback<void, string>({
      router: 'rpcCheckout',
      routed: async () => {
        routed++
        return 'routed'
      },
      direct: async () => 'direct',
    })
    assert.equal(await present(), 'routed')
    assert.equal(routed, 1)
  })

  it("rethrows a member's own error and does NOT run the direct name — nothing runs twice", async () => {
    for (const thrown of [
      err('functions/not-found', 'Session not found'),
      err('functions/failed-precondition', 'class is full'),
      err('functions/internal', 'internal'),
      err('functions/unavailable', 'not-found'),
    ]) {
      let direct = 0
      const call = withRouterFallback<void, string>({
        router: 'rpcCheckout',
        routed: async () => {
          throw thrown
        },
        direct: async () => {
          direct++
          return 'direct'
        },
      })
      await assert.rejects(call(), (e) => e === thrown)
      assert.equal(direct, 0, `fell back on ${thrown.message}`)
    }
  })

  it('a failure of the DIRECT call after a fallback surfaces as itself', async () => {
    const boom = err('functions/unauthenticated', 'Sign in to continue')
    const call = withRouterFallback<void, string>({
      router: 'rpcMember',
      routed: async () => {
        throw err('functions/not-found', 'No such callable on rpcMember')
      },
      direct: async () => {
        throw boom
      },
    })
    await assert.rejects(call(), (e) => e === boom)
  })
})
