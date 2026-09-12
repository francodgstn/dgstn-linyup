variable "billing_account" {
  type        = string
  description = "Billing account ID the budget is attached to."
}

variable "project_number" {
  type        = string
  description = "Numeric project number the budget filters on."
}

variable "env" {
  type        = string
  description = "Environment label used in the budget display name."
}

variable "budget_amount" {
  type        = number
  description = "Budget amount in whole currency units."
}

variable "currency_code" {
  type        = string
  description = "ISO currency code for the budget."
  default     = "CHF"
}

variable "threshold_percents" {
  type        = list(number)
  description = "ACTUAL-spend thresholds (as fractions of the budget) that trigger alerts. These fire after the money is spent."
  default     = [0.5, 0.9, 1.0]
}

variable "forecast_threshold_percents" {
  type        = list(number)
  description = "FORECAST-spend thresholds — fire mid-month when the trend ends over this fraction of the budget. The only rules that arrive in time to stop a runaway."
  default     = [1.0]
}

variable "notification_channels" {
  type        = list(string)
  description = "Cloud Monitoring notification channel IDs that budget alerts are sent to, on top of the billing-admin default. EMPTY means budget alerts reach only whoever holds Billing Account Administrator/User — which may be nobody who is looking. Max 5."
  default     = []
}

variable "project_id" {
  type        = string
  description = "Project the cost-feed Pub/Sub topic is created in. Only used when cost_feed_topic is true."
  default     = ""
}

variable "cost_feed_topic" {
  type        = bool
  description = "Create a Pub/Sub topic and publish budget evaluations to it, so `handleBudgetNotification` can record Google spend on the operator console's Providers page. False leaves the budget as an alarm only."
  default     = false
}

variable "cost_feed_topic_name" {
  type        = string
  description = "Topic name. A CONTRACT with BILLING_BUDGET_TOPIC in packages/functions/src/analytics/budgetNotification.ts — renaming one side silently stops the feed."
  default     = "linyup-billing-budget"
}
