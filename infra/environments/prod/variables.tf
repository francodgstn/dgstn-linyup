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
  default     = "linyup-prod"
}

variable "landing_site_id" {
  type        = string
  description = "Hosting site ID for the landing site."
  default     = "linyup-prod-landing"
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
    # Cloudflare for SaaS — custom domains. PROD ONLY, deliberately: the
    # feature is gated to linyup-prod (docs/custom-domains.md → "Environments"),
    # and a token that exists off-prod is a token that can register a hostname
    # on the production zone.
    "cloudflare-api-token",
    # App-store insights (docs/app-store-insights.md). All READ-ONLY against the
    # two vendors — nothing in this feature writes to Apple or Google.
    #
    # The key id and issuer id are identifiers rather than credentials, but they
    # live here rather than as `defineString` params because
    # packages/functions/.env.* are tracked in git and a value written there is
    # in the history forever. Same reasoning as OPERATOR_EMAILS.
    "apple-asc-key-id",
    "apple-asc-issuer-id",
    "apple-asc-private-key",    # the .p8, PEM or single-line base64
    "apple-asc-webhook-secret", # HMAC phrase shared with ASC → Integrations → Webhooks
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
    # Settings → Domains. Without this the save fails with
    # "PERMISSION_DENIED: secretmanager.versions.add".
    "cloudflare-api-token",
    # Settings → Translation: the DeepL key. Same failure mode as above when
    # missing.
    "deepl-api-key",
  ]
}

# ── Monitoring ────────────────────────────────────────────────────────────────
variable "alert_email" {
  type        = string
  description = "Where production alerts go. EMPTY MEANS NOBODY IS PAGED. Set it in terraform.tfvars (gitignored) — this is production, so treat an empty value as an open action item, not a default."
  default     = ""
}

variable "uptime_host" {
  type        = string
  description = "Public host probed at /api/health."
  default     = "app.linyup.com"
}

# ── Backups ───────────────────────────────────────────────────────────────────
# Answers the "decide retention" open item in docs/launch/data-safety-checklist.md.
# 14 weeks is the Firestore maximum for a daily schedule; lower it deliberately if
# storage cost ever becomes material, not by accident.
variable "backup_retention" {
  type        = string
  description = "Firestore daily-backup retention, in seconds. Default 14 weeks (the maximum)."
  default     = "8467200s"
}

# ── Budget ────────────────────────────────────────────────────────────────────
variable "budget_amount" {
  type        = number
  description = "Monthly budget amount in whole currency units."
  default     = 500
}
