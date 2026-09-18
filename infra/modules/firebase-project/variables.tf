variable "project_id" {
  type        = string
  description = "Project to initialise Firebase on."
}

variable "env" {
  type        = string
  description = "Environment label used in display names (e.g. staging, prod)."
}

variable "app_site_id" {
  type        = string
  description = "Hosting site ID for the web app. MUST match .firebaserc (e.g. linyup-staging)."
}

variable "landing_site_id" {
  type        = string
  description = "Hosting site ID for the landing site. MUST match .firebaserc (e.g. linyup-staging-landing)."
}

variable "api_site_id" {
  type        = string
  description = "Hosting site ID for the public API + MCP server. MUST match .firebaserc (e.g. linyup-api-staging). Null: the environment has no api site."
  default     = null
}

variable "help_site_id" {
  type        = string
  description = "Hosting site ID for the public product docs (apps/help). MUST match .firebaserc (e.g. linyup-help-staging). Null: the environment has no docs site."
  default     = null
}
