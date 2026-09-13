# Creates Secret Manager secret CONTAINERS and grants the functions runtime SA
# read access. Secret VALUES are added out-of-band (gcloud secrets versions add)
# so plaintext never lands in Terraform state — there are deliberately no
# google_secret_manager_secret_version resources here.
#
# Secret IDs match the convention in packages/functions/src/utils/secrets.ts:
#   stripe-secret-key → env STRIPE_SECRET_KEY (hyphens→underscores, uppercased).

resource "google_secret_manager_secret" "secret" {
  for_each = toset(var.secret_ids)

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }
}

# Functions runtime SA may read every secret container.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = toset(var.secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_email}"

  depends_on = [google_secret_manager_secret.secret]
}

# Admin console runtime SA may ADD new versions of the secrets it manages.
resource "google_secret_manager_secret_iam_member" "admin_version_adder" {
  for_each = toset(var.admin_writable_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${var.admin_sa_email}"

  depends_on = [google_secret_manager_secret.secret]
}

# ...and see WHETHER a version exists — metadata only, never the payload.
#
# The console's settings pages report a "configured / not configured" status via
# secretExists(), which calls getSecretVersion → secretmanager.versions.get. With
# secretVersionAdder alone (versions.add) that read returned PERMISSION_DENIED,
# which secret-manager.ts swallows into `false`. So a save succeeded and the UI
# then said "not configured", in every environment — the value was there, the
# console just could not see it.
#
# viewer, NOT secretAccessor, is the right role: secretAccessor grants
# versions.access (the plaintext payload), which the console does not need and
# must not have. The two actions that did read plaintext (Brevo test-send, Stripe
# key verify) were removed for exactly this reason — see the notes in
# apps/admin/src/lib/secret-manager.ts. Adding either back means widening this to
# secretAccessor across every environment.
resource "google_secret_manager_secret_iam_member" "admin_viewer" {
  for_each = toset(var.admin_writable_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.viewer"
  member    = "serviceAccount:${var.admin_sa_email}"

  depends_on = [google_secret_manager_secret.secret]
}

# Same secretAccessor grant, for identities beyond the nominal runtime SA. Kept
# as its own resource so the existing accessor bindings above are not rekeyed
# (that would destroy and recreate all of them).
#
# `distinct()` on BOTH lists is load-bearing, not tidiness. These are
# hand-maintained lists in three environment files, and a secret listed twice —
# which has happened, by two edits each adding it with its own comment — makes
# this `for` expression produce the same map key twice and FAILS THE PLAN with
# "Duplicate object key". Every other resource in this module keys off
# `toset(...)`, which dedupes silently, so a duplicate is invisible until it
# reaches exactly this one. A list that is merely untidy should not be able to
# stop an apply.
resource "google_secret_manager_secret_iam_member" "extra_accessor" {
  for_each = {
    for pair in setproduct(distinct(var.secret_ids), distinct(var.extra_accessor_members)) :
    "${pair[0]}|${pair[1]}" => { secret_id = pair[0], member = pair[1] }
  }

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member

  depends_on = [google_secret_manager_secret.secret]
}
