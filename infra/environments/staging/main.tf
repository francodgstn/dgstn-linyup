# ─────────────────────────────────────────────────────────────────────────────
# Staging environment — wires the reusable modules together for linyup-staging.
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
    # App Check (docs/app-check-rollout.md). BOTH are needed to register the web
    # app: firebaseappcheck serves App Check itself, and the web provider is
    # reCAPTCHA ENTERPRISE — the Console no longer offers plain reCAPTCHA v3 for a
    # new web registration, and an Enterprise key lives in its own API. Declared
    # here rather than clicked through the Console's "enable this API?" prompt, so
    # a rebuilt project can register App Check without that detour.
    "firebaseappcheck.googleapis.com",
    "recaptchaenterprise.googleapis.com",
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
  env             = "staging"
  app_site_id     = var.app_site_id
  landing_site_id = var.landing_site_id

  depends_on = [module.services]
}

# ── Firestore database instance ───────────────────────────────────────────────
# Retention stays on the module default (7 days) deliberately: staging data is
# seeded (pnpm staging:seed) and reproducible. PITR still covers an accidental
# reset while someone is mid-validation.
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
  extra_accessor_members = ["serviceAccount:157648925506-compute@developer.gserviceaccount.com"]

  depends_on = [module.services]
}

# ── Billing budget + alerts ───────────────────────────────────────────────────
module "budget" {
  source          = "../../modules/budget"
  billing_account = var.billing_account
  project_number  = local.project_number
  env             = "staging"
  budget_amount   = var.budget_amount

  depends_on = [module.services]
}

# ── Error metric, alert policy, uptime check ──────────────────────────────────
# Until `alert_email` is set in terraform.tfvars, the metric and uptime check
# collect but NOTHING pages anyone — see `terraform output monitoring_alerting_enabled`.
module "monitoring" {
  source      = "../../modules/monitoring"
  project_id  = var.project_id
  env         = "staging"
  alert_email = var.alert_email
  uptime_host = var.uptime_host

  depends_on = [module.services]
}

# ── App Hosting backends (web + operator console) ─────────────────────────────
# Adopted into terraform 2026-08-26 (previously CLI-created; analysis A2/A5).
# The europe-west4 backends already exist and are imported — see the module
# header and infra/README.md for the import commands. The Developer Connect
# connection + repo link are Console-managed and referenced by name.
module "app_hosting" {
  source     = "../../modules/app-hosting"
  project_id = var.project_id
  location   = "europe-west4"
  app_id     = "1:157648925506:web:5e3aa70930d777f8374edb"
  repository = "projects/linyup-staging/locations/europe-west4/connections/apphosting-github-conn-2gwprb/gitRepositoryLinks/francodgstn-dgstn-linyup"

  backends = {
    "linyup-web-eu" = {
      root_directory  = "/apps/web"
      service_account = "firebase-app-hosting-compute@linyup-staging.iam.gserviceaccount.com"
    }
    "linyup-admin-eu" = {
      root_directory  = "/apps/admin"
      service_account = "linyup-admin@linyup-staging.iam.gserviceaccount.com"
    }
  }

  depends_on = [module.services]
}
