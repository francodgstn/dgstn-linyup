// ─── Usage counting and rate limiting ────────────────────────────────────────
//
// Two different jobs, deliberately cheap:
//
//   COUNTING  one `teams/{t}/api_usage/{yyyy-mm-dd}` document per day, bumped
//             with `FieldValue.increment` and retired by TTL. A usage figure for
//             the owner, not an audit trail — requests are logged, not stored.
//   LIMITING  an in-memory token bucket per credential per instance. The global
//             bound is the bucket × `maxInstances`, which is the point: a
//             Firestore-backed limiter would put a transaction (and the ~1
//             write/s per-document ceiling) in front of every read.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { API_USAGE_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'
import { ledgerExpiry } from '../utils/ledgerRetention'

export async function recordApiUsage(teamId: string, outcome: 'ok' | 'denied', nowMs: number = Date.now()): Promise<void> {
  const day = new Date(nowMs).toISOString().slice(0, 10)
  try {
    await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(API_USAGE_SUBCOLLECTION)
      .doc(day)
      .set(
        { [outcome === 'ok' ? 'requests' : 'denied']: FieldValue.increment(1), expires_at: ledgerExpiry('api_usage') },
        { merge: true }
      )
  } catch (err) {
    console.warn(`[api] usage count failed team=${teamId}:`, err)
  }
}

/** Requests one credential may burst to, and how many it regains per minute. */
export const RATE_BURST = 60
export const RATE_PER_MINUTE = 120

interface Bucket {
  tokens: number
  updatedMs: number
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly burst = RATE_BURST,
    private readonly perMinute = RATE_PER_MINUTE,
    private readonly maxKeys = 10_000
  ) {}

  /** Take one token; returns 0 when allowed, otherwise the seconds to wait. */
  take(key: string, nowMs: number = Date.now()): number {
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updatedMs: nowMs }
    const refill = ((nowMs - bucket.updatedMs) / 60_000) * this.perMinute
    bucket.tokens = Math.min(this.burst, bucket.tokens + refill)
    bucket.updatedMs = nowMs
    if (this.buckets.size >= this.maxKeys && !this.buckets.has(key)) this.buckets.clear()
    this.buckets.set(key, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - bucket.tokens) / this.perMinute) * 60)
  }
}
