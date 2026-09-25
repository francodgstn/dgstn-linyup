import assert from 'node:assert/strict'
import { ticketToReceipt } from './expoProvider'

// WHY THIS IS PINNED.
//
// `sendPush` prunes a token on ONE status only: 'dead'. Getting this
// classification wrong in either direction is a real defect — too eager
// deletes a device that would have delivered tomorrow (a member stops
// getting notifications with no error anywhere); too lax lets a genuinely
// unregistered token sit forever, which is exactly the rot pruning exists to
// stop (see sendPush.ts's module header). Expo's ticket carries the signal in
// `details.error === 'DeviceNotRegistered'` — every other code is transient
// or caller-side and must map to 'error', never 'dead'.
describe('expoProvider — ticketToReceipt', () => {
  it('an ok ticket is sent', () => {
    assert.deepEqual(ticketToReceipt('tok1', { status: 'ok', id: 'abc' }), {
      token: 'tok1',
      status: 'ok',
    })
  })

  it('DeviceNotRegistered is DEAD — the only status sendPush prunes on', () => {
    assert.deepEqual(
      ticketToReceipt('tok1', { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }),
      { token: 'tok1', status: 'dead', error: 'gone' }
    )
  })

  it('MessageTooBig is a transient error, NOT dead — must not be pruned', () => {
    const receipt = ticketToReceipt('tok1', {
      status: 'error',
      message: 'too big',
      details: { error: 'MessageTooBig' },
    })
    assert.equal(receipt.status, 'error')
  })

  it('MessageRateExceeded is a transient error, NOT dead', () => {
    const receipt = ticketToReceipt('tok1', {
      status: 'error',
      details: { error: 'MessageRateExceeded' },
    })
    assert.equal(receipt.status, 'error')
  })

  it('an error ticket with no recognized code is still just an error, not dead', () => {
    const receipt = ticketToReceipt('tok1', { status: 'error', message: 'unknown thing' })
    assert.equal(receipt.status, 'error')
    assert.equal(receipt.error, 'unknown thing')
  })

  it('a missing ticket (vendor returned fewer entries than requested) is an error', () => {
    const receipt = ticketToReceipt('tok1', undefined)
    assert.equal(receipt.status, 'error')
    assert.equal(receipt.token, 'tok1')
  })
})
