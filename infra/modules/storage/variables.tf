variable "project_id" {
  type        = string
  description = "Project to create the Firebase Storage bucket in."
}

variable "storage_location" {
  type        = string
  description = "GCS bucket location (immutable after first apply)."
  default     = "europe-west6"
}

variable "object_user_members" {
  type        = list(string)
  description = <<-EOT
    IAM members granted roles/storage.objectUser on the default bucket — the
    server-side identities that must READ objects back, which project Editor
    does not cover under uniform bucket-level access (see main.tf).

    Fully-qualified members ("serviceAccount:…@…"), not bare emails.
  EOT
  default     = []
}
