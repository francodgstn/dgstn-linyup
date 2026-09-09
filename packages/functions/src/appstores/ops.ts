/* eslint-disable no-console */
/**
 * Operator-triggered refresh of the app-store presence docs.
 *
 * ── THIS IS THE CREDENTIAL VALIDATOR, NOT JUST A CONVENIENCE ───────────────
 * The ops console can WRITE a secret version but deliberately cannot READ one
 * (`admin_writable_secret_ids` grants `secretVersionAdder` + `viewer`, never
 * `secretAccessor` — see infra/modules/secrets/variables.tf). So the console can
 * only ever report "configured / not configured" from metadata, and a WRONG key
 * looks exactly like a right one until something actually calls the API.
 *
 * That something is this. It must stay one click from wherever a key is pasted,
 * and its per-source return value is what the console renders — otherwise the
 * only way to find out a key is bad is to wait for tomorrow's cron.
 */
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import type { StorePlatform } from '@linyup/shared'
import { requireOperator } from '../utils/operator'
import { runStoreIngest } from './ingest'

export const refreshStorePresence = onCall(
  { timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const operator = requireOperator(request)

    const { platform } = (request.data ?? {}) as { platform?: string }
    if (platform !== undefined && platform !== 'ios' && platform !== 'android') {
      throw new HttpsError('invalid-argument', "platform must be 'ios' or 'android'")
    }

    console.log(`[appstores] manual refresh (${platform ?? 'all'}) by ${operator}`)

    // `force` bypasses STORE_INGEST_ENABLED: the kill switch exists to stop an
    // UNATTENDED cron reaching the one real App Store record, and a human who
    // just clicked the button is by definition attending.
    return runStoreIngest(platform as StorePlatform | undefined, { force: true })
  },
)
