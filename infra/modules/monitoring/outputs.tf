output "alerting_enabled" {
  description = "Whether an alert can actually reach a human. False means the metric and uptime check are collecting but NOTHING pages anyone — set alert_email to change that."
  value       = local.alerting_enabled
}

output "uptime_enabled" {
  description = "Whether a public /api/health probe is configured for this environment."
  value       = local.uptime_enabled
}

output "error_metric_name" {
  description = "Log-based metric backing the error-rate alert."
  value       = google_logging_metric.errors.name
}

output "notification_channel_ids" {
  description = "The ops-email notification channel, as a list so it can be passed straight to a consumer that takes several (the billing budget). EMPTY when alert_email is unset — a consumer must treat that as 'nobody named', not as an error."
  value       = google_monitoring_notification_channel.email[*].id
}
