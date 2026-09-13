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
# The provider argument is `monitoring_notification_channels` (max 5) — NOT
# `monitor_notification_channels`, which does not exist and fails at plan time
# with "An argument named ... is not expected here".
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

  # An `all_updates_rule` is needed for EITHER a named channel or the cost-feed
  # topic, so the block is emitted when either is asked for and each field is
  # filled independently. Without the block GCP still mails billing admins, but
  # nothing is routed to the ops channel and nothing is published.
  dynamic "all_updates_rule" {
    for_each = (length(var.notification_channels) > 0 || var.cost_feed_topic) ? [1] : []
    content {
      monitoring_notification_channels = var.notification_channels
      pubsub_topic                     = var.cost_feed_topic ? google_pubsub_topic.budget[0].id : null
      # Billing admins keep their default mail too — see the header.
      disable_default_iam_recipients = false
    }
  }
}

# ── The budget as a COST FEED, not just an alarm ─────────────────────────────
# A budget notification carries `costAmount` and `budgetAmount`, and GCP
# publishes one several times a day — which makes this topic the cheapest
# possible source of "what are we spending on Google right now". The
# alternative is a BigQuery billing export: opt-in, hours of delay, and
# billable itself, for one number on one page.
#
# `handleBudgetNotification` (packages/functions/src/analytics/) subscribes and
# writes the figure onto the daily `platform_metrics/{date}` snapshot, so the
# operator console's Providers page gets history for free rather than a spot
# reading. Created only when `cost_feed_topic` is true, so an environment that
# just wants the alarm pays for nothing extra.
#
# THE TOPIC NAME IS A CONTRACT with that function's BILLING_BUDGET_TOPIC
# constant — a rename here silently stops the feed, since a Pub/Sub trigger on
# a topic that never publishes is indistinguishable from a quiet month.
resource "google_pubsub_topic" "budget" {
  count = var.cost_feed_topic ? 1 : 0

  project = var.project_id
  name    = var.cost_feed_topic_name
}

# ── NO PUB/SUB IAM BINDING HERE, DELIBERATELY ────────────────────────────────
#
# An earlier version granted roles/pubsub.publisher to
# `billing-budgets@system.gserviceaccount.com`. That FAILS THE APPLY:
#
#   Error 400: Service account billing-budgets@system.gserviceaccount.com
#   does not exist.
#
# Cloud Billing's budget service agent is a billing-account-level identity, and
# project-level IAM cannot resolve it. The provider's own canonical Pub/Sub
# budget example (upstream `billing_budget_optional`, run as a live acceptance
# test against real GCP) creates ONLY the topic and the budget with
# `all_updates_rule.pubsub_topic` — no IAM resource of any kind — so Cloud
# Billing arranges publish access itself when the budget names the topic.
#
# IF DELIVERY EVER TURNS OUT NOT TO WORK, this is the first place to look, and
# the symptom is the quiet one: the function deploys, the topic exists, and
# nothing ever arrives. `infra/README.md` → "The budget is also the cost feed"
# carries the check.
