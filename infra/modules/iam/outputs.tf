output "functions_runtime_email" {
  description = "Email of the dedicated Cloud Functions runtime service account."
  value       = google_service_account.functions_runtime.email
}

output "play_publisher_email" {
  description = "Google Play publisher SA email — the address to invite in Play Console. Null where create_play_publisher is false."
  value       = one(google_service_account.play_publisher[*].email)
}

output "admin_runtime_email" {
  description = "Email of the dedicated admin console (App Hosting) runtime service account."
  value       = google_service_account.admin_runtime.email
}
