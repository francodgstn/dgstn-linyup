import 'server-only'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

// Whether we're pointed at the Firebase emulators (local dev). Secret Manager
// has no emulator, so writing a secret locally is a no-op — the Functions
// emulator reads each secret from packages/functions/.env.local instead, as its
// env name (brevo-api-key → BREVO_API_KEY; see packages/functions/src/utils/secrets.ts).
export const useEmulators =
  process.env.USE_FIREBASE_EMULATORS === 'true' ||
  !!process.env.FIRESTORE_EMULATOR_HOST

const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  'demo-linyup'

// Cache the client across HMR / module re-evaluation.
const globalForSm = globalThis as { _smClient?: SecretManagerServiceClient }
function client(): SecretManagerServiceClient {
  return (globalForSm._smClient ??= new SecretManagerServiceClient())
}

export class SecretManagerUnavailableError extends Error {}

/**
 * Stores `value` as a new version of the named secret. Old versions are left
 * intact (Secret Manager keeps history); `latest` — which getSecret reads — now
 * points at this value.
 *
 * Normal path requires only `roles/secretmanager.secretVersionAdder` on the
 * secret (what Terraform grants the admin runtime SA). The secret CONTAINER is
 * created by Terraform, so the create branch below is a dev/bootstrap fallback
 * for setups where the container is missing — it needs `secretmanager.admin`
 * (or secretCreator) and won't run in a Terraform-provisioned environment.
 *
 * Throws SecretManagerUnavailableError when running against the emulators.
 */
export async function setSecret(secretName: string, value: string): Promise<void> {
  if (useEmulators) {
    throw new SecretManagerUnavailableError(
      `Secret Manager is unavailable against the emulators — set ${secretName
        .replace(/-/g, '_')
        .toUpperCase()} in packages/functions/.env.local instead.`,
    )
  }

  const parent = `projects/${projectId}`
  const secretPath = `${parent}/secrets/${secretName}`
  const payload = { data: Buffer.from(value, 'utf8') }

  // Add a version straight away — the container normally already exists.
  try {
    await client().addSecretVersion({ parent: secretPath, payload })
    return
  } catch (err) {
    if ((err as { code?: number }).code !== 5 /* NOT_FOUND */) throw err
  }

  // Fallback: container is missing — create it, then add the first version.
  await client().createSecret({
    parent,
    secretId: secretName,
    secret: { replication: { automatic: {} } },
  })
  await client().addSecretVersion({ parent: secretPath, payload })
}

// There is deliberately NO getSecretValue here. The console never reads a secret
// payload: it writes values and reports whether one is SET. Keeping it that way
// is what lets the runtime SA hold roles/secretmanager.viewer (versions.get —
// metadata only) instead of roles/secretmanager.secretAccessor (versions.access
// — plaintext). Adding a reader back means widening that grant across every
// environment, so treat it as a security decision, not a convenience.

/**
 * Reports whether the named secret has at least one accessible version (i.e. a
 * value the runtime can read). Returns false — never throws — when the container
 * or version is missing, so callers can render a "not configured" state. Used by
 * the Brevo settings status reader.
 *
 * Throws SecretManagerUnavailableError when running against the emulators, where
 * Secret Manager does not exist; the caller treats that as "not configured".
 */
export async function secretExists(secretName: string): Promise<boolean> {
  if (useEmulators) {
    throw new SecretManagerUnavailableError(
      'Secret Manager is unavailable against the emulators.',
    )
  }

  const name = `projects/${projectId}/secrets/${secretName}/versions/latest`
  try {
    const [version] = await client().getSecretVersion({ name })
    // ENABLED versions are readable; DESTROYED/DISABLED are not configured.
    return version.state === 'ENABLED' || version.state === 1
  } catch (err) {
    const code = (err as { code?: number }).code
    // NOT_FOUND (container/version missing) and PERMISSION_DENIED (the runtime
    // SA lacks secretAccessor — e.g. Terraform hasn't provisioned this secret
    // yet) are both "operator still needs to set this up", not page failures.
    // Warn so the cause is visible, but let the settings page render.
    if (code === 5 /* NOT_FOUND */) return false
    if (code === 7 /* PERMISSION_DENIED */) {
      console.warn(
        `[secrets] no access to '${secretName}' in ${projectId} — reporting it as not configured. ` +
          'Grant the runtime SA roles/secretmanager.secretAccessor (see infra/modules/secrets).',
      )
      return false
    }
    throw err
  }
}
