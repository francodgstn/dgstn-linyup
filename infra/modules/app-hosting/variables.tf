variable "project_id" {
  type        = string
  description = "GCP project id the backends live in."
}

variable "location" {
  type        = string
  default     = "europe-west4"
  description = <<-EOT
    App Hosting region. europe-west4 (Netherlands) is the nearest EU region —
    App Hosting does NOT run in europe-west6, where Firestore/Functions live.
    us-central1 is legacy (no EU region existed when the first backends were
    created); every backend is being moved to europe-west4.
  EOT
}

variable "app_id" {
  type        = string
  description = "Firebase Web App id (1:NNN:web:XXXX). Both web and admin backends link to the same web app."
}

variable "repository" {
  type        = string
  default     = null
  description = <<-EOT
    OPTIONAL. Full resource name of a FIREBASE-app Developer Connect
    gitRepositoryLink the backends build from, e.g.
    projects/<p>/locations/europe-west4/connections/<conn>/gitRepositoryLinks/<link>.

    Leave NULL (the default) to create the backends with no codebase and connect
    the repo by hand in the App Hosting settings UI afterwards — the supported
    path for a new project, because the backend API accepts a codebase only when
    its connection was minted by App Hosting's own FIREBASE-app flow (a standalone
    Developer Connect connection is a DEVELOPER_CONNECT-app link and is rejected).
    `ignore_changes = [codebase]` then keeps that hand-made connection intact.

    Set it only where a FIREBASE-app link already exists and is in state (staging).
    Read the current value with:
      gcloud developer-connect connections git-repository-links list \
        --project <p> --location europe-west4 --connection <conn>
  EOT
}

variable "backends" {
  description = <<-EOT
    backend_id => backend config. service_account must already hold
    roles/firebaseapphosting.computeRunner: the shared firebase-app-hosting-compute
    SA for the web app, the dedicated linyup-admin SA for the operator console (it
    writes Firestore + provider secrets). environment selects apphosting.<env>.yaml;
    null uses apphosting.yaml.

    root_directory applies ONLY when var.repository is set (terraform renders the
    codebase). Where the repo is Console-connected (var.repository null) it is
    unused — you enter the root directory in the UI instead — so omit it there.
    When set, store it with a LEADING SLASH ("/apps/web"), matching what
    `apphosting:backends:create --root-dir apps/web` writes, or import shows a
    permanent diff.
  EOT
  type = map(object({
    root_directory  = optional(string)
    service_account = string
    environment     = optional(string)
    display_name    = optional(string)
  }))
}
