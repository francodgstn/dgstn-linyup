output "budget_name" {
  description = "Resource name of the created billing budget."
  value       = google_billing_budget.this.name
}

output "budget_alerts_named_recipient" {
  description = "Whether budget alerts go to a channel this config NAMES. False means they fall back to GCP's billing-admin default only — mail still goes somewhere, but nothing here says where, and it is not the address the error alerts use."
  value       = length(var.notification_channels) > 0
}

output "budget_amount" {
  description = "The configured monthly budget, echoed so `terraform output` answers \"what is the ceiling?\" without opening a tfvars file."
  value       = "${var.budget_amount} ${var.currency_code}"
}
