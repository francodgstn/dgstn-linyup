# Billing budget + threshold alerts for an environment's project.
# Requires the billingbudgets API enabled and the caller to have billing perms
# on the billing account.
#
# ── WHO HEARS ABOUT IT ───────────────────────────────────────────────────────
# A budget with no `all_updates_rule` still sends mail — to whoever holds
# Billing Account Administrator/User on the billing account, by GCP default.
# That is implicit, unstated, and unrelated to `alert_email`, so the project
# could page one address for errors and a different set of people (or nobody
# who is looking) for a runaway bill. Passing `notification_channels` routes
# budget alerts to the SAME channel the error and uptime alerts use.
#
# `disable_default_iam_recipients` stays FALSE on purpose: billing admins keep
# getting the mail as well. A cost runaway is the one alert where two
# independent paths to a human is the right amount of redundancy.
#
# ── CURRENT vs FORECASTED SPEND ──────────────────────────────────────────────
# A CURRENT_SPEND threshold tells you money is already gone. A FORECASTED_SPEND
# threshold tells you mid-month that the trend ends over budget — which is the
# only one that arrives in time to stop a runaway (a trigger loop, an egress
# spike, a scheduled job that started failing expensively). Both are set: the
# current-spend rules for the record, the forecast rule for the warning.

resource "google_billing_budget" "this" {
  billing_account = var.billing_account
  display_name    = "Linyup ${var.env} budget"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.threshold_percents
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  # The early warning — "this month is TRENDING over" rather than "this month
  # WENT over".
  dynamic "threshold_rules" {
    for_each = var.forecast_threshold_percents
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "FORECASTED_SPEND"
    }
  }

  dynamic "all_updates_rule" {
    for_each = length(var.notification_channels) > 0 ? [1] : []
    content {
      monitor_notification_channels = var.notification_channels
      # Billing admins keep their default mail too — see the header.
      disable_default_iam_recipients = false
    }
  }
}
