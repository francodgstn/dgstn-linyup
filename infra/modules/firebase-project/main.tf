# Initialises Firebase on the project and creates the app-layer shells that the
# Firebase CLI later fills with content:
#   - the Firebase project itself
#   - a Web App (whose generated config feeds the NEXT_PUBLIC_* env vars)
#   - the Hosting sites (app + landing, and api / help where an environment has one)
#
# All google_firebase_* resources REQUIRE the google-beta provider.

resource "google_firebase_project" "this" {
  provider = google-beta
  project  = var.project_id
}

# ── Web App — generates the public client SDK config ──────────────────────────
resource "google_firebase_web_app" "app" {
  provider     = google-beta
  project      = var.project_id
  display_name = "Linyup ${var.env} Web"

  # Avoid deleting the web app (and its config) on a stray destroy.
  deletion_policy = "ABANDON"

  depends_on = [google_firebase_project.this]
}

data "google_firebase_web_app_config" "app" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.app.app_id
}

# ── Hosting sites — site_id MUST match the IDs declared in .firebaserc ─────────
# The target→site mapping (target:apply) stays with the Firebase CLI; Terraform
# only owns the site shells.
resource "google_firebase_hosting_site" "app" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.app_site_id

  depends_on = [google_firebase_project.this]
}

resource "google_firebase_hosting_site" "landing" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.landing_site_id

  depends_on = [google_firebase_project.this]
}

# The public API + MCP server site (docs/public-api.md -> Hosting target). Optional:
# only environments that set api_site_id have one, so sandbox and prod plan no
# change until theirs exists. Its custom domain (api-stg.linyup.com) and the
# public invoker on the `api` function stay out of Terraform, like the other
# sites' domains and every function's IAM, which firebase deploy owns.
resource "google_firebase_hosting_site" "api" {
  count    = var.api_site_id == null ? 0 : 1
  provider = google-beta
  project  = var.project_id
  site_id  = var.api_site_id

  depends_on = [google_firebase_project.this]
}

# The public product docs site (apps/help -> Hosting target `help`,
# docs.linyup.com). Optional like `api`: sandbox has none. Its custom domain
# stays out of Terraform with the others.
resource "google_firebase_hosting_site" "help" {
  count    = var.help_site_id == null ? 0 : 1
  provider = google-beta
  project  = var.project_id
  site_id  = var.help_site_id

  depends_on = [google_firebase_project.this]
}

# ── Identity Platform (GCIP) ──────────────────────────────────────────────────
# REQUIRED for the `beforeSignup` (beforeUserCreated) blocking function that
# gates new-user signup. Creating this upgrades the project's Firebase Auth to
# Identity Platform. The blocking-function TRIGGER is registered by
# `firebase deploy --only functions` (it writes config.blocking_functions), so we
# ignore that field to avoid Terraform reverting the deploy on each apply. We
# also ignore sign_in so Terraform never disturbs the Console-managed providers
# (Email/Google/Apple/Facebook). Requires identitytoolkit.googleapis.com (already
# in each env's `apis`) and a Blaze project (already true via Functions/App Hosting).
resource "google_identity_platform_config" "this" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_firebase_project.this]

  lifecycle {
    # multi_tenant joined this list on 2026-08-18. Terraform saw a multi_tenant
    # block on the live config that this resource does not declare, so every plan
    # proposed removing it. Linyup's tenant boundary is `teamId` in Firestore —
    # GCIP multi-tenancy is not used and never has been — so the block is a
    # Console/API artifact of enabling Identity Platform, not configuration we
    # own. Ignoring it keeps plans clean without Terraform reaching into live auth
    # config to turn something off that nothing asked for. Same reasoning as
    # sign_in above: Console-managed, not ours to reconcile.
    ignore_changes = [blocking_functions, sign_in, multi_tenant]
  }
}
