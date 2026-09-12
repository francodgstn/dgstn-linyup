# ─────────────────────────────────────────────────────────────────────────────
# Sandbox environment — the public demo playground (linyup-sandbox).
# Identical module wiring to staging; only project_id / site ids / budget differ.
# The web app is seeded with throwaway demo Club tenants (scripts/seed-sandbox.ts)
# and serves the public /try page (NEXT_PUBLIC_DEMO_MODE=true via
# apps/web/apphosting.sandbox.yaml).
# ─────────────────────────────────────────────────────────────────────────────

locals {
  # APIs required by the Linyup stack. Gen2 functions specifically need
  # run + cloudbuild + artifactregistry + eventarc + pubsub.
  apis = [
    "firebase.googleapis.com",
    "firebaserules.googleapis.com",
    "firebasehosting.googleapis.com",
    "firebaseapphosting.googleapis.com",
    "firestore.googleapis.com",
    "firebasestorage.googleapis.com",
    "storage.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com",
    "identitytoolkit.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "serviceusage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "billingbudgets.googleapis.com",
    "aiplatform.googleapis.com", # Vertex AI — in-app assistant
    "translate.googleapis.com",  # Cloud Translation — site translation Google provider
    # App Check — NOT ENABLED, deliberately (docs/app-check-rollout.md).
    #
    # App Check is implemented and inert: no site key is deployed, both enforce
    # flags are false. reCAPTCHA Enterprise is a THIRD-PARTY PROVIDER with its own
    # billing, and adopting one before there is a threat to answer is the cost
    # this defers — so the APIs it needs stay undeclared too, rather than the
    # project carrying an enabled dependency nothing calls.
    #
    # Uncomment BOTH when you do step 1 of the runbook (register the web app):
    # firebaseappcheck serves App Check itself, and an Enterprise site key lives
    # in its own API. Enabling them here rather than through the Console's
    # "enable this API?" prompt keeps the declared state of the project complete.
    # "firebaseappcheck.googleapis.com",
    # "recaptchaenterprise.googleapis.com",
  ]
}

# ── Project (created by Terraform, or referenced if create_project = false) ───
resource "google_project" "this" {
  count = var.create_project ? 1 : 0

  name            = var.project_id
  project_id      = var.project_id
  billing_account = var.billing_account
  org_id          = var.org_id
  folder_id       = var.folder_id

  # Firestore/App Engine location lock — never let Terraform tear the project down.
  lifecycle {
    prevent_destroy = true
  }
}

data "google_project" "this" {
  count      = var.create_project ? 0 : 1
  project_id = var.project_id
}

locals {
  project_number = var.create_project ? google_project.this[0].number : data.google_project.this[0].number
}

# ── API enablement ────────────────────────────────────────────────────────────
module "services" {
  source     = "../../modules/project-services"
  project_id = var.project_id
  apis       = local.apis

  depends_on = [google_project.this]
}

# ── Firebase init + web app + hosting sites ───────────────────────────────────
module "firebase" {
  source          = "../../modules/firebase-project"
  project_id      = var.project_id
  env             = "sandbox"
  app_site_id     = var.app_site_id
  landing_site_id = var.landing_site_id

  depends_on = [module.services]
}

# ── Firestore database instance ───────────────────────────────────────────────
# Retention stays on the module default (7 days) deliberately: sandbox hosts
# prospect demos and lead tenants, which are reseedable from scripts/leads/. PITR
# is still on — an accidental wipe mid-demo is the case worth covering here.
module "firestore" {
  source             = "../../modules/firestore"
  project_id         = var.project_id
  firestore_location = var.firestore_location

  depends_on = [module.services]
}

# ── Firebase Storage default bucket ───────────────────────────────────────────
module "storage" {
  source           = "../../modules/storage"
  project_id       = var.project_id
  storage_location = var.storage_location

  depends_on = [module.services]
}

# ── IAM: runtime SA + deploy SA roles ─────────────────────────────────────────
module "iam" {
  source          = "../../modules/iam"
  project_id      = var.project_id
  deploy_sa_email = var.deploy_sa_email

  # Functions run as the default compute SA, which must be able to sign custom
  # tokens as itself — see the variable's docs in modules/iam.
  extra_token_creator_sa_emails = [
    "${local.project_number}-compute@developer.gserviceaccount.com",
  ]

  depends_on = [module.services]
}

# ── Secret containers + accessor IAM ──────────────────────────────────────────
module "secrets" {
  source           = "../../modules/secrets"
  project_id       = var.project_id
  secret_ids       = var.secret_ids
  runtime_sa_email = module.iam.functions_runtime_email
  admin_sa_email   = module.iam.admin_runtime_email

  admin_writable_secret_ids = var.admin_writable_secret_ids

  # Functions are deployed under the default compute SA (setGlobalOptions sets no
  # serviceAccount), and roles/editor cannot READ secret payloads.
  extra_accessor_members = ["serviceAccount:1006203712444-compute@developer.gserviceaccount.com"]

  depends_on = [module.services]
}

# ── Billing budget + alerts ───────────────────────────────────────────────────
module "budget" {
  source          = "../../modules/budget"
  billing_account = var.billing_account
  project_number  = local.project_number
  env             = "sandbox"
  budget_amount   = var.budget_amount

  # Budget alerts go to the SAME channel as the error and uptime alerts. Empty
  # when alert_email is unset, in which case the budget falls back to GCP's
  # billing-admin default — `terraform output budget_alerts_named_recipient`
  # is the honest answer to "would anyone hear about a runaway bill?".
  notification_channels = module.monitoring.notification_channel_ids

  depends_on = [module.services]
}

# ── Error metric, alert policy, uptime check ──────────────────────────────────
# Until `alert_email` is set in terraform.tfvars, the metric and uptime check
# collect but NOTHING pages anyone — see `terraform output monitoring_alerting_enabled`.
module "monitoring" {
  source      = "../../modules/monitoring"
  project_id  = var.project_id
  env         = "sandbox"
  alert_email = var.alert_email
  uptime_host = var.uptime_host

  depends_on = [module.services]
}

# ── App Hosting backend (web) ─────────────────────────────────────────────────
# EU migration (us-central1 → europe-west4), 2026-08-26. terraform CREATES this
# backend (region, environment, service account) with NO codebase — a standalone
# Developer Connect connection is rejected by the backend API, and only App
# Hosting's own FIREBASE-app flow can mint an acceptable one. So `terraform apply`
# provisions the bare backend, then the repo is connected by hand in the Console
# (App Hosting → linyup-web-eu → settings → connect repository, root dir
# apps/web); the module's `ignore_changes = [codebase]` leaves that connection
# alone. Sandbox has ONE backend — no operator console here.
#
# After apply + connect + first rollout: flip the deploy-sandbox.yml rollout
# target (linyup-web → linyup-web-eu), cut the domain over, then delete the old
# us-central1 linyup-web backend.
module "app_hosting" {
  source     = "../../modules/app-hosting"
  project_id = var.project_id
  location   = "europe-west4"
  app_id     = "1:1006203712444:web:5f1a15e86998c7a42671b9"
  # repository intentionally unset — codebase is connected in the Console (above).

  backends = {
    "linyup-web-eu" = {
      service_account = "firebase-app-hosting-compute@linyup-sandbox.iam.gserviceaccount.com"
      environment     = "sandbox"
    }
  }

  depends_on = [module.services]
}
