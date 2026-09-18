---
title: Connect an AI assistant (MCP)
description: Ask questions about your studio from Claude, ChatGPT or Claude Code through Linyup's remote MCP server.
sidebar:
  order: 2
---

Linyup runs a remote **MCP** (Model Context Protocol) server, so you can connect an AI assistant to your studio and ask questions in plain language:

- _"Who hasn't come in three weeks?"_
- _"How full were Thursday classes last month?"_
- _"What did we earn from drop-ins in August?"_

Access is **read-only**, and limited to the scopes you grant.

## What the assistant can look up

| Tool | What it answers |
|---|---|
| `get_studio_overview` | A summary of your studio |
| `find_contacts`, `get_contact`, `get_contact_history` | Finding people and their history |
| `list_inactive_contacts` | Who has stopped coming |
| `get_schedule`, `get_session_roster`, `list_events` | What's on, and who's booked |
| `list_offerings`, `list_memberships` | What you offer and who holds which plan |
| `get_attendance_trend`, `get_class_fill_rates` | Attendance and fill rates over time |
| `get_revenue_summary` | Revenue |

## Connecting

Assistants that support remote MCP connectors (claude.ai, ChatGPT, VS Code) sign in with your Linyup account and ask you to approve access. You can see and revoke connected apps under **Settings → API keys**. Tools like Claude Code can use an API key instead.

:::note[Draft]
TODO before publishing: the server URL, and step-by-step setup for claude.ai, ChatGPT and Claude Code, with screenshots.
:::
