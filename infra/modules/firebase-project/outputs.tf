# The web app config is public-by-design (it ships in the browser bundle as
# NEXT_PUBLIC_* values), so these outputs are not marked sensitive.

output "web_app_id" {
  description = "Firebase Web App ID."
  value       = google_firebase_web_app.app.app_id
}

output "web_config" {
  description = "Public Firebase client SDK config for the web app (feeds NEXT_PUBLIC_* env vars)."
  value = {
    api_key             = data.google_firebase_web_app_config.app.api_key
    auth_domain         = data.google_firebase_web_app_config.app.auth_domain
    project_id          = var.project_id
    storage_bucket      = data.google_firebase_web_app_config.app.storage_bucket
    messaging_sender_id = data.google_firebase_web_app_config.app.messaging_sender_id
    app_id              = google_firebase_web_app.app.app_id
  }
}

output "app_site_id" {
  description = "Hosting site ID for the web app."
  value       = google_firebase_hosting_site.app.site_id
}

output "landing_site_id" {
  description = "Hosting site ID for the landing site."
  value       = google_firebase_hosting_site.landing.site_id
}

output "api_site_id" {
  description = "Hosting site ID for the public API + MCP server, or null where the environment has none."
  value       = var.api_site_id == null ? null : google_firebase_hosting_site.api[0].site_id
}

output "help_site_id" {
  description = "Hosting site ID for the public product docs, or null where the environment has none."
  value       = var.help_site_id == null ? null : google_firebase_hosting_site.help[0].site_id
}
