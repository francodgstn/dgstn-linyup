variable "project_id" {
  type        = string
  description = "Project to create the secret containers on."
}

variable "secret_ids" {
  type        = list(string)
  description = "Secret Manager secret IDs to create (containers only, no values)."
}

variable "runtime_sa_email" {
  type        = string
  description = "Email of the functions runtime service account granted secretAccessor."
}

variable "admin_sa_email" {
  type        = string
  description = "Email of the admin console runtime SA, granted secretVersionAdder on admin_writable_secret_ids."
}

variable "admin_writable_secret_ids" {
  type        = list(string)
  description = "Secret IDs the admin console MANAGES — granted secretVersionAdder (write a new version) and viewer (see that a version exists) on each. Must be a subset of secret_ids. The console never reads payloads: viewer covers versions.get (metadata) and deliberately NOT versions.access (plaintext), which is what secretAccessor would add."
  default     = []
}

# Additional members granted secretAccessor on every secret, as fully-qualified
# IAM members ("serviceAccount:x@y"). Exists because deployed functions run under
# the default compute SA, whose roles/editor does NOT include
# secretmanager.versions.access. Empty by default so nothing is widened silently.
variable "extra_accessor_members" {
  type        = list(string)
  description = "Extra IAM members granted secretAccessor on all secrets (e.g. the default compute SA that functions actually run as)."
  default     = []
}
