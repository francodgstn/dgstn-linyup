---
title: Receiving replies (inbound mail)
status: living
area: platform
---
# Receiving replies (inbound mail)

> **Scope:** how Linyup **receives** replies to the mail it sends. Brevo
> (`packages/functions/src/mail/`) is **send-only** — it has no inbox — so replies
> need a separate inbound path. This runbook captures the verified live setup: OVH
> email redirection for receiving, plus Gmail "Send mail as" routed through Brevo's
> SMTP relay for replying. **Documentation only** — no Linyup code or config depends
> on any of this; it lives entirely in DNS, OVH, and a personal Gmail account.

## Why

Brevo's transactional API delivers outbound mail but never accepts inbound. Linyup
sends from **two** From identities (see
[`packages/functions/src/mail/README.md`](../packages/functions/src/mail/README.md)):

| Stream | From | Reply-To | Where a reply lands |
|---|---|---|---|
| System mail | `hello@linyup.com` | _(none)_ | `hello@linyup.com` |
| Managed studio mail | `studios@linyup.com` | the studio's own contact email | the **studio** (not us) |

So replies we care about arrive at `hello@` (and occasionally `studios@`, when a
recipient strips the Reply-To). A **catch-all** forward covers both addresses and any
future one (`support@`, `billing@`, …) without per-address setup.

The plan, end to end:

1. **Inbound** — `linyup.com` MX points at **OVH email redirection**; `hello@` and a
   catch-all forward to a personal inbox.
2. **Outbound replies** — Gmail **"Send mail as" `hello@linyup.com`**, sending through
   **Brevo's SMTP relay** so manual replies are DKIM-signed by Brevo and
   DMARC-aligned, exactly like campaign mail.

---

## 1. Inbound — OVH email redirection

OVH's domain plans include free **email redirection** (alias → external inbox); no
mailbox is provisioned, OVH just forwards.

1. In the OVH Control Panel, open the `linyup.com` domain → **Email** → ensure the
   **MX Plan / email redirection** service is enabled.
2. Add redirections:
   - `hello@linyup.com` → _your personal inbox_
   - `*@linyup.com` (catch-all) → _same inbox_ — covers `studios@` and anything future.
3. OVH sets the receiving **MX** records to `mx*.mail.ovh.net`. Let OVH manage those.

**This coexists with Brevo.** Receiving (MX) and sending (Brevo SPF/DKIM `TXT`) are
independent record types on the same zone:

- **MX** → OVH — controls who accepts mail _for_ `linyup.com`.
- **SPF / DKIM `TXT`** → Brevo — authorises Brevo to send _as_ `linyup.com`.

Adding OVH MX records does **not** touch the Brevo TXT records, and vice-versa. Don't
delete the Brevo DKIM / SPF entries when enabling OVH.

---

## 2. Outbound replies — Gmail "Send mail as" via the Brevo relay

So that a manual reply from your personal inbox leaves *as* `hello@linyup.com` and
passes SPF/DKIM/DMARC (instead of looking like spoofing), send it through Brevo's SMTP
relay — the same authenticated path the app's campaign mail uses.

> Do the **OVH forward (step 1) first** — Gmail emails a verification code to
> `hello@linyup.com` during this setup, and it can only arrive once the forward is live.

1. Gmail → **Settings → Accounts and Import → "Send mail as" → Add another email
   address**.
2. Name `Linyup`, address `hello@linyup.com`, **untick** "Treat as an alias".
3. Send through SMTP:
   - **SMTP server:** `smtp-relay.brevo.com`
   - **Port:** `587` (STARTTLS)
   - **Username:** your Brevo account login email
   - **Password:** a Brevo **SMTP key** — generate it under Brevo → **SMTP & API →
     SMTP**. This is a *different* credential from the REST `brevo-api-key` the Cloud
     Functions use; do not reuse that one here.
4. Gmail sends a confirmation code to `hello@linyup.com`; it forwards (via step 1) to
   your inbox — enter it to verify.

After this, composing in Gmail lets you pick `hello@linyup.com` in the **From**
dropdown, and the message is relayed (and DKIM-signed) by Brevo.

---

## Authentication (SPF / DKIM / DMARC)

Everything routes through Brevo for *sending*, so alignment is already handled by the
existing Brevo domain authentication — no new sending auth is needed for replies:

- **DKIM** — already configured in Brevo for `linyup.com`. Replies sent through the
  relay are DKIM-signed by Brevo → DMARC-aligned, just like app mail.
- **SPF** — the `linyup.com` SPF `TXT` already includes Brevo (`include:spf.brevo.com`),
  which authorises the relay.
- **OVH** — only **receives**, so it needs no SPF/DKIM of its own.
- **DMARC** — make sure a `_dmarc.linyup.com` `TXT` record exists. Start permissive
  (`v=DMARC1; p=none; rua=mailto:hello@linyup.com`) and tighten to `quarantine` /
  `reject` once you've confirmed all legitimate mail aligns.

---

## Verification

```bash
# Receiving — MX should be OVH
dig +short MX linyup.com
#   → 1 mx1.mail.ovh.net.  /  5 mx2.mail.ovh.net.  …

# Sending — Brevo SPF/DKIM TXT must still be intact (not clobbered by the OVH change)
dig +short TXT linyup.com           # SPF line includes "include:spf.brevo.com"
dig +short TXT mail._domainkey.linyup.com   # Brevo DKIM key (selector may differ)

# DMARC policy present
dig +short TXT _dmarc.linyup.com    # → "v=DMARC1; p=none; ..."
```

Then end-to-end:

1. **Receiving:** send a mail from any external account to `hello@linyup.com` (and a
   random `anything@linyup.com` for the catch-all) → both land in the personal inbox.
2. **Sending as:** reply from Gmail using the `hello@linyup.com` From, addressed to a
   [mail-tester.com](https://www.mail-tester.com) probe (or your own other inbox).
   Check **SPF, DKIM and DMARC all pass** — in Gmail, _⋮ → Show original_ shows
   `PASS` for all three.

---

## Notes & future

- **Higher cold-outreach volume.** If/when outreach scales, move that stream to a
  dedicated subdomain (e.g. `mail.linyup.com`) to isolate sending reputation. This is a
  config-only change via the existing `MAIL_*_FROM` params
  (`packages/functions/src/mail/README.md` → *Environment*) — **no code change** — plus
  matching OVH redirection / Brevo auth on the subdomain.
- **System-vs-studio subdomain split.** `hello@` and `studios@` could later send from
  separate subdomains for finer reputation isolation; deferred until volume justifies
  it. The sender code already keeps the two identities separate, so the seam is ready.
- **Forwarding is not a mailbox.** OVH redirection forwards copies; there's no archive
  at `linyup.com`. If a shared, searchable history is ever needed, provision a real
  mailbox (OVH email, Google Workspace, …) instead of a redirect.
