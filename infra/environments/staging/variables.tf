variable "project_id" {
  type        = string
  description = "Firebase/GCP project ID for this environment."
}

variable "region" {
  type        = string
  description = "Default region for functions, tasks, etc."
  default     = "europe-west6"
}

variable "firestore_location" {
  type        = string
  description = "Firestore location (immutable after first apply)."
  default     = "europe-west6"
}

variable "storage_location" {
  type        = string
  description = "Firebase Storage bucket location (immutable after first apply)."
  default     = "europe-west6"
}

# ── Project creation ──────────────────────────────────────────────────────────
variable "create_project" {
  type        = bool
  description = "If true, Terraform creates the GCP project. If false, references an existing one."
  default     = true
}

variable "billing_account" {
  type        = string
  description = "Billing account ID to link to the project and budget."
}

variable "org_id" {
  type        = string
  description = "Organization ID under which to create the project. Mutually exclusive with folder_id."
  default     = null
}

variable "folder_id" {
  type        = string
  description = "Folder ID under which to create the project. Mutually exclusive with org_id."
  default     = null
}

# ── CI deploy SA (from bootstrap outputs) ─────────────────────────────────────
variable "deploy_sa_email" {
  type        = string
  description = "Email of the CI deploy service account created in the bootstrap stack."
}

# ── Hosting site IDs (must match .firebaserc) ─────────────────────────────────
variable "app_site_id" {
  type        = string
  description = "Hosting site ID for the web app."
  default     = "linyup-staging"
}

variable "landing_site_id" {
  type        = string
  description = "Hosting site ID for the landing site."
  default     = "linyup-staging-landing"
}

# ── Secrets ───────────────────────────────────────────────────────────────────
variable "secret_ids" {
  type        = list(string)
  description = "Secret Manager containers to create (values added out-of-band)."
  default = [
    "stripe-secret-key",
    "stripe-webhook-secret",
    "stripe-connect-webhook-secret",
    "smtp-password",
    "smtp-encryption-key",
    "brevo-api-key",        # Brevo transactional API (all outbound mail)
    "brevo-webhook-secret", # authenticates Brevo's bounce/spam event callbacks
    "deepl-api-key",        # DeepL machine translation (public site/embed localization)
    "posthog-api-key",
    "ai-assistant-unlock-key", # strong key to unlock the locked AI assistant plugin
    # App-store insights (docs/app-store-insights.md). Present in STAGING as well
    # as prod, unlike cloudflare-api-token — and the difference is the point:
    # the Cloudflare token is prod-only because it WRITES (it registers hostnames
    # on the production zone), whereas every one of these is read-only against
    # Apple and Google. A read-only key off-prod is how the integration gets
    # exercised before it reaches production, and App Store Connect allows more
    # than one webhook per app, so staging can have its own without touching
    # prod's. The guard against unattended activity is STORE_INGEST_ENABLED,
    # which is 'false' here regardless.
    #
    # Deliberately NOT in sandbox: that project hosts prospect demos and has
    # nothing to do with the member app, so the containers would only ever be
    # empty there — which `readSecret` reports as `not_configured`, correctly.
    "apple-asc-key-id",
    "apple-asc-issuer-id",
    "apple-asc-private-key",
    "apple-asc-webhook-secret",
    "google-play-service-account",
  ]
}

# Secrets the ops console (Settings → Emails) may add new VERSIONS to. It never
# reads them back; code tracks a "configured" flag instead. Must stay a subset of
# secret_ids. The module default is the legacy ["smtp-password"], so this has to
# be set explicitly for the Brevo form to work.
variable "admin_writable_secret_ids" {
  type        = list(string)
  description = "Secret IDs the ops console may write new versions to (subset of secret_ids)."
  default = [
    "brevo-api-key",
    "brevo-webhook-secret",
    "deepl-api-key", # Translation (Settings → Translation)
    # Payments (Settings → Payments): the key plus BOTH webhook signing secrets.
    # stripe-connect-webhook-secret is the one that was empty in every
    # environment, so member→studio payments never confirmed.
    "stripe-secret-key",
    "stripe-webhook-secret",
    "stripe-connect-webhook-secret",
    # Settings → Translation: the DeepL key. Without this the save fails with
    # "PERMISSION_DENIED: secretmanager.versions.add".
    "deepl-api-key",
  ]
}

# ── Budget ────────────────────────────────────────────────────────────────────
variable "budget_amount" {
  type        = number
  description = "Monthly budget amount in whole currency units."
  default     = 100
}

# ── Monitoring ────────────────────────────────────────────────────────────────
variable "alert_email" {
  type        = string
  description = "Where alerts go. Empty means nobody is notified; the metric and uptime check still collect. Set in terraform.tfvars (gitignored)."
  default     = ""
}

variable "uptime_host" {
  type        = string
  description = "Public host probed at /api/health."
  default     = "app-stg.linyup.com"
}
