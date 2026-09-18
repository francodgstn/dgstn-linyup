---
title: Developer overview
description: Reach your studio's data from outside Linyup — a REST API for integrations, and an MCP server for AI assistants.
sidebar:
  order: 0
  label: Overview
---

Studio staff can reach their studio's data from outside Linyup in two ways:

- **A developer integration**, through a versioned **REST API**.
- **An AI assistant** (Claude, ChatGPT, Claude Code and others), through a remote **MCP server**, so an owner can ask _"who hasn't come in three weeks?"_ or _"how full were Thursday classes last month?"_.

Both are the same product: one address, the same credentials, the same data and permissions.

:::caution[Early access]
The API is currently **read-only**. The production endpoint is being rolled out; until then this section describes the API as it runs on our staging environment.
:::

## Access is per studio, and per scope

You create API keys in the app under **Settings → API keys**. Each key belongs to one studio and carries only the **scopes** you tick when you create it, plus an optional expiry. The secret is shown once.

| Scope | Grants |
|---|---|
| `contacts:read` | Contacts, without personal details |
| `contacts:read:pii` | Contacts' personal details (email, phone…) |
| `schedule:read` | Sessions, rosters, events |
| `offerings:read` | Activities and plans |
| `subscriptions:read` | Who holds which plan |
| `reports:read` | Weekly reports, attendance and fill-rate insights |
| `finance:read` | Revenue and finance reports |

<!-- TODO: confirm scope → endpoint mapping against packages/shared/src/types/api.ts before publishing. -->

## Where next

- [REST API](/developers/rest-api/): endpoints and the OpenAPI document
- [Connect an AI assistant (MCP)](/developers/mcp/)
- [Embed booking on your website](/developers/embed-booking/)
