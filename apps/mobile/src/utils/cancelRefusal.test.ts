import { cancelRefusalIsFinal, cancelRefusalKey } from './cancelRefusal';
import { callableErrorCode } from './callableError';

describe('cancelRefusalKey — a refused cancel names its reason', () => {
  it('reads the server reason first, whatever the code says', () => {
    expect(cancelRefusalKey({ code: 'functions/failed-precondition', details: { reason: 'past' } })).toBe('refusedPast');
    expect(cancelRefusalKey({ code: 'functions/not-found', details: { reason: 'session_gone' } })).toBe('refusedSessionGone');
    expect(cancelRefusalKey({ details: { reason: 'already_settled' } })).toBe('refusedAlreadySettled');
    expect(cancelRefusalKey({ details: { reason: 'not_found' } })).toBe('refusedNotFound');
  });

  it('falls back to the error code for a deployment older than the contract', () => {
    expect(cancelRefusalKey({ code: 'functions/not-found' })).toBe('refusedNotFound');
    expect(cancelRefusalKey({ code: 'failed-precondition' })).toBe('refusedAlreadySettled');
    expect(cancelRefusalKey({ code: 'functions/not-found', details: { reason: 'something-new' } })).toBe('refusedNotFound');
  });

  it('only an unexplained failure invites a retry', () => {
    expect(cancelRefusalKey({ code: 'functions/internal' })).toBe('failedTransient');
    expect(cancelRefusalKey(new Error('network'))).toBe('failedTransient');
    expect(cancelRefusalKey(null)).toBe('failedTransient');
    expect(cancelRefusalKey(undefined)).toBe('failedTransient');
    expect(cancelRefusalIsFinal({ code: 'functions/unavailable' })).toBe(false);
    expect(cancelRefusalIsFinal({ details: { reason: 'past' } })).toBe(true);
  });
});

describe('callableErrorCode', () => {
  it('strips the SDK prefix and ignores non-callable errors', () => {
    expect(callableErrorCode({ code: 'functions/already-exists' })).toBe('already-exists');
    expect(callableErrorCode({ code: 'already-exists' })).toBe('already-exists');
    expect(callableErrorCode(new Error('x'))).toBeNull();
    expect(callableErrorCode('already-exists')).toBeNull();
  });
});
