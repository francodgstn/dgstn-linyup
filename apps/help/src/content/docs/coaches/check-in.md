---
title: Check-in & attendance
description: Marking attendance, walk-ins, no-shows, QR check-in and the kiosk.
sidebar:
  order: 2
---

Attendance is what moves a trial forward, keeps your numbers honest and powers the reminders that bring people back. It takes a few seconds per class.

## From the roster

Open a session from the schedule or the dashboard. Its roster is split into:

- **Check-ins**: people who are here
- **Confirmed, not checked in**: booked, not yet marked
- **No-shows**
- **Waitlist**

On each person, choose **Confirm attendance** or **Mark no-show**. You can also remove a booking or undo a check-in. **Export CSV** downloads the list.

:::tip[First visit]
Someone's first attendance moves them to **Trial attended** in your funnel automatically. See [Contacts & the funnel](/studio/contacts/).
:::

## Walk-ins

Someone turned up without booking? Choose **Add contact** on the session. Picking or creating the person books their seat. If they have no valid plan, Linyup warns you, and you can **Add anyway**.

## QR check-in

- **With the member app**: the member shows their QR code and you scan it with the **Check-in scanner** on the session. The scanner needs Chrome or Edge. Members can also scan your studio's QR code themselves.
- **With the kiosk**: see below.

## No-shows

If an online booking is still unmarked after the session, Linyup marks it as a no-show overnight. You can change it the next morning.

To discourage no-shows, go to **Settings → Booking → No-show policy**. Set a **Fee** and the number of **Strikes before a fee**. After that many no-shows, the member is emailed a payment link. Linyup never charges their card automatically, and you can waive the fee or resend the link.

## The kiosk

The **Kiosk** plugin turns a tablet at your entrance into a front-desk screen. It needs the Studio plan. It shows:

- today's schedule, and what's on now and next
- a **check-in QR code** that members scan with their phone
- **New here? Sign up** for walk-ins: they pick the class, enter their name and email, and are booked in
- a slideshow while nobody is using it

The kiosk lives at your public address, `/public/{your-slug}/kiosk`. Each tablet is unlocked once with a PIN from the kiosk settings. You can change the PIN, or sign out every device at once.
