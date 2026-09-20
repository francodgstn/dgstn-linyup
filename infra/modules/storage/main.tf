# Creates the default Firebase Storage bucket and links it to the Firebase project.
#
# Without this, `firebase deploy --only storage` fails with "Firebase Storage has
# not been set up". The underlying GCS bucket is created first, then linked to
# Firebase via the google_firebase_storage_bucket resource.
#
# WARNING: location is effectively IMMUTABLE — changing it requires deleting and
# recreating the bucket (and losing all data). europe-west6 (Zurich) is locked on
# the first apply.

resource "google_storage_bucket" "default" {
  provider = google-beta
  project  = var.project_id
  name     = "${var.project_id}.firebasestorage.app"
  location = var.storage_location

  uniform_bucket_level_access = true

  # Never let Terraform delete the bucket with its data.
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_firebase_storage_bucket" "default" {
  provider  = google-beta
  project   = var.project_id
  bucket_id = google_storage_bucket.default.name

  depends_on = [google_storage_bucket.default]
}

# ── Object access for the server-side runtimes ────────────────────────────────
#
# A PROJECT EDITOR CAN WRITE TO THIS BUCKET AND CANNOT READ BACK FROM IT.
#
# `uniform_bucket_level_access` above (correctly) makes GCS ignore object ACLs —
# and object ACLs are the ONLY thing that normally hands project editors object
# READ on a bucket. What survives is the bucket-level legacy binding a new bucket
# is born with, `projectEditor → roles/storage.legacyBucketOwner`, and that role
# grants `storage.objects.create`, `.delete` and `.list` but NOT
# `storage.objects.get`. Nothing else in these projects granted it, so every
# server-side download 403'd from the day the bucket was created:
#
#   `[invoices] created …` immediately followed by
#   `… does not have storage.objects.get access to … /invoice.pdf`
#
# — the save succeeded and the read-back that emails it did not. It broke every
# caller of `readVerified` (packages/functions/src/pdf/files.ts): Tarif 595
# receipt download + email, and QR-bill invoice download + email. Confirmed on
# sandbox and staging; prod had no failures only because nothing had been issued
# there yet, its bucket policy being identical.
#
# SECOND INSTANCE OF ONE CLASS. Secret Manager had exactly this shape — basic
# `roles/editor` not covering a data-plane permission for the runtime identity —
# and was patched the same way (`extra_accessor_members` in modules/secrets).
# When a new API starts storing or reading tenant data, assume the runtime SA
# needs an explicit data-plane role and check, rather than trusting Editor.
#
# `roles/storage.objectUser` is the whole of object CRUD (get/create/delete/
# list/update) and none of the bucket administration the legacy binding already
# covers.
resource "google_storage_bucket_iam_member" "object_users" {
  for_each = toset(var.object_user_members)

  bucket = google_storage_bucket.default.name
  role   = "roles/storage.objectUser"
  member = each.value
}
