/**
 * Waits for the functions emulator to work through the Firestore trigger queue
 * a seed leaves behind.
 *
 * ── WHY A SEED IS NOT DONE WHEN ITS WRITES ARE ───────────────────────────────
 * The Firestore emulator hands trigger events to the functions emulator one at
 * a time, and every trigger's first invocation cold-starts a worker. A full
 * `seed-emulator.ts` run causes ~6,500 trigger executions (sessions, bookings,
 * mirrors, and the writes THOSE make), so the queue drains 9-11 minutes after
 * the seed's last write — measured on firebase-tools 15.18.0 and 15.30.1 alike.
 *
 * Until then the stack looks broken in a way nothing reports: a status flip on
 * `installed_plugins` "never runs" its trigger (it is queued behind the seed),
 * a public mirror is missing, a counter is zero. And the emulator stamps an
 * event's `time` when it DELIVERS it, not when the document was written, so the
 * log hides the lag too.
 *
 * ── THE SENTINEL ─────────────────────────────────────────────────────────────
 * The queue is not observable, so this writes through it: the same
 * `surfaces_updated_at` nudge `touchTeamForSurfaceRecompute` uses (a field
 * nothing reads), then polls until `syncTeamPublicProfile` has copied that
 * write's time onto the team's public profile as `updated_at`. The queue is
 * FIFO, so the sentinel coming out means everything queued before it has too.
 * Work those triggers wrote while draining queues up BEHIND it, so the probe
 * repeats until one comes through within `settledLagMs`.
 *
 * Opt-in by address: the caller names the functions emulator (host:port) it
 * started. Without one — a seed against firestore+auth only, or a hand-run
 * `tsx` — there is nothing to wait for and this returns at once. It never fails
 * a seed: a timeout warns and returns.
 */
import admin from 'firebase-admin'

export interface TriggerDrainOptions {
  /** host:port of the functions emulator; empty or undefined skips the wait. */
  functionsHost: string | undefined
  /** A seeded team whose public profile the sentinel is read back from. */
  teamId: string
  /** A probe that returns within this is taken as an empty queue. */
  settledLagMs?: number
  /** Give up (with a warning) after this long. */
  timeoutMs?: number
}

const POLL_MS = 2_000
const PROGRESS_MS = 30_000
const REGISTRY_WAIT_MS = 120_000
const SENTINEL_TRIGGER = 'syncTeamPublicProfile'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** True once the functions emulator reports the sentinel's trigger as loaded. */
async function sentinelTriggerLoaded(functionsHost: string): Promise<boolean> {
  const deadline = Date.now() + REGISTRY_WAIT_MS
  for (;;) {
    try {
      const res = await fetch(`http://${functionsHost}/backends`, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) {
        const body = (await res.json()) as {
          backends?: { functionTriggers?: { entryPoint?: string }[] }[]
        }
        const loaded = (body.backends ?? []).some((b) =>
          (b.functionTriggers ?? []).some((t) => t.entryPoint === SENTINEL_TRIGGER)
        )
        if (loaded) return true
      }
    } catch {
      // not up yet — discovery can take up to FUNCTIONS_DISCOVERY_TIMEOUT
    }
    if (Date.now() > deadline) return false
    await sleep(POLL_MS)
  }
}

export async function waitForTriggerQueue(
  db: admin.firestore.Firestore,
  { functionsHost, teamId, settledLagMs = 10_000, timeoutMs = 30 * 60_000 }: TriggerDrainOptions
): Promise<void> {
  if (!functionsHost) {
    console.log('\n   (Not waiting for triggers: SEED_FUNCTIONS_EMULATOR_HOST is empty. If functions are')
    console.log('    running, they keep working through this seed for several more minutes.)')
    return
  }

  if (!(await sentinelTriggerLoaded(functionsHost))) {
    console.warn(
      `\n⚠️  Not waiting for triggers: the functions emulator at ${functionsHost} has no ` +
        `${SENTINEL_TRIGGER} loaded.`
    )
    return
  }

  console.log('\n⏳  Waiting for the functions emulator to work through the trigger queue…')
  console.log('    (a full seed leaves ~10 minutes of it; data read before then is incomplete)')

  const teamRef = db.collection('teams').doc(teamId)
  const profileRef = teamRef.collection('public_profile').doc(teamId)
  const started = Date.now()
  let lastProgress = started

  while (Date.now() - started < timeoutMs) {
    const probeStart = Date.now()
    const { writeTime } = await teamRef.update({
      surfaces_updated_at: admin.firestore.FieldValue.serverTimestamp(),
    })

    for (;;) {
      const synced = (await profileRef.get()).get('updated_at') as admin.firestore.Timestamp | undefined
      if (synced && synced.toMillis() >= writeTime.toMillis()) break
      if (Date.now() - started >= timeoutMs) break
      if (Date.now() - lastProgress >= PROGRESS_MS) {
        lastProgress = Date.now()
        console.log(`    … ${Math.round((Date.now() - started) / 1000)}s`)
      }
      await sleep(POLL_MS)
    }

    const lag = Date.now() - probeStart
    if (lag <= settledLagMs) {
      console.log(`    triggers settled after ${Math.round((Date.now() - started) / 1000)}s`)
      return
    }
  }

  console.warn(
    `\n⚠️  Gave up waiting for triggers after ${Math.round(timeoutMs / 60_000)} min — they are still ` +
      'running. Check the emulator log before trusting derived data.'
  )
}
