---
title: REST API
description: Versioned, read-only REST endpoints for your studio's data.
sidebar:
  order: 1
---

The REST API lives under `/v1/` and authenticates with an API key from **Settings → API keys**.

## OpenAPI

The full, always-current reference is the OpenAPI 3 document at `GET /v1/openapi.json`. It needs no authentication and holds no studio data. Import it into Postman, Insomnia or your code generator of choice.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /v1/me` | The key and studio you are authenticated as |
| `GET /v1/team` | The studio |
| `GET /v1/contacts` | Contacts |
| `GET /v1/contacts/{id}/history` | A contact's booking and membership history |
| `GET /v1/sessions` | Scheduled sessions |
| `GET /v1/sessions/{id}/roster` | Who is booked into a session |
| `GET /v1/activities` | Your activities |
| `GET /v1/plans` | Your plans |
| `GET /v1/subscriptions?state=` | Subscriptions, filtered by state |
| `GET /v1/events` | Events |
| `GET /v1/reports/weekly` | Weekly report |
| `GET /v1/reports/finance` | Finance report |
| `GET /v1/insights/class-fill` | Class fill rates |

:::note[Draft]
TODO before publishing: base URL (api.linyup.com), authentication header format with a curl example, pagination, errors, rate limits.
:::
