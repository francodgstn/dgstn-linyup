---
title: "Payments"
description: "Connecting Stripe, how members pay, memberships that renew, refunds, cash payments, gift cards and fees."
sidebar:
  order: 6
---

Members pay your studio directly, through your own Stripe account. Memberships, class packs, drop-ins, trials, appointments, courses and shop items are all paid this way. Every payment goes straight into your Stripe account, and Stripe pays it out to your bank. **Linyup never holds your money.**

## Connect Stripe

Go to **Settings → Payments**. On the card **Accept payments with Linyup**, choose **Start setup**.

Stripe opens its own form, where you enter your studio's details and the bank account for your payouts. It takes a few minutes. You get your own Stripe account, with full access to its dashboard. If you already use Stripe, sign in during setup: the details you have already verified are filled in for you.

When you come back, the card shows one of two states:

- **Ready**: you can accept payments.
- **Setup needed**: Stripe still needs a few details. Choose **Finish setup** to return to Stripe, then **Refresh**.

:::note[Before payments are ready]
Your public pages never offer something people can't pay for. Until Stripe is ready:
- the shop shows your prices without buy buttons;
- drop-in prices, priced trials and priced appointments are hidden;
- free trials and free bookings keep working as usual.
:::

## What people can pay for online

- **Memberships** that renew weekly, every two weeks, monthly, quarterly or yearly, and one-off plans such as class packs. See [How pricing fits together](/studio/pricing/).
- **Drop-ins** for a single class, and **priced trials** for a newcomer's first class.
- **Appointments** with a price for each length.
- **Courses**, **products** and **gift cards** in your shop.

Members buy plans in your [shop](/public/shop/). You can also send someone a direct link: on **Payments**, choose **Create payment link**.

**Payment methods** come from your Stripe account: switch on the ones you want, such as TWINT, Apple Pay or Google Pay, in your Stripe dashboard. Online payments are in Swiss francs (CHF).

## Memberships that renew

Stripe charges the member automatically on each renewal date.

If a renewal fails, the membership shows as **Past due**. You'll find it under **Payments → Subscriptions → Needs attention**. To follow up automatically, set up an [automation](/messaging/automations/) on **Subscription payment failed**.

To stop or pause a member's billing, open the contact, then **Plans & Payments → Current**. Under **Stripe billing**:

- **Cancel billing**: the member keeps access until the end of the period they have paid for.
- **Freeze billing**: billing pauses and the member keeps full access. **Resume billing** starts it again.

Members can see their payment history in their [member space](/public/member-space/).

## Fees

Two fees come out of each online payment, before the money reaches your bank:

- **Linyup's fee**, a percentage of the payment. Your rate is shown under **What you pay** in **Settings → Payments**.
- **Stripe's processing fee**, from Stripe's own pricing.

To see exactly what you received for a payment, hover over its amount on **Payments**. With the Finance & Accounting plugin, the breakdown shows what was charged, each fee, and what you received.

When you refund a payment, Linyup's fee is returned in proportion, but Stripe keeps its processing fee.

## Refunds

On **Payments**, or on a contact's **Plans & Payments → Payments**, choose **Refund** on the payment. You can refund the full amount, or choose **Refund a different amount** for part of it.

- **Products, drop-ins and appointments** can be refunded in part.
- **Memberships, courses and class packs** are refunded in full. Linyup then takes back what the payment gave: the membership and its unused classes, or the course in the member's space.
- **A class pack that has been used**, or a **gift card that has been partly spent**, can't be refunded in Linyup. You can still refund it in your Stripe dashboard, but nothing is then taken back automatically.

## Cash, bank transfer and other payments

Not everyone pays online. To record a payment made another way, choose **Record payment** on **Payments** or on the contact. Enter the amount, the date and the method, and pick **What was paid**. Recording a membership, a course or a class pack gives it to the member, exactly like an online purchase. Tick **Send the buyer a receipt** to email them one.

Your methods (Cash, Bank transfer and TWINT to start with) are listed under **Settings → Payments → Manual payment modes**, where you can add your own.

If you recorded something by mistake, choose **Void**. The record stays in the list, crossed out, and what it gave the member is taken back. No money moves.

Appointments that were booked without paying online appear under **Awaiting payment**. Choose **Mark paid** once they have paid you.

## Gift cards

With the **Gift Cards** plugin, you can:

- sell gift cards in your shop, in the amounts you choose; the buyer receives the code by email;
- issue one at the desk with **Issue gift card**, either as paid (cash, bank or TWINT) or as complimentary;
- let people pay with a gift card code in the shop and when they book a drop-in.

Gift cards can't be used for memberships or appointments.

## The Payments screen

- **Payments**: every payment, with its contact, what it was for, where it came from (Linyup, Stripe, Payrexx or Manual) and its status. Filter by time, search, or show **Unassigned** payments that aren't linked to a contact yet.
- **Subscriptions**: everyone holding a plan, including members you don't bill through Linyup, with their next renewal. **Needs attention** shows failed payments and cancellations.
- **Gift cards**: when the plugin is on.

Members automatically get a receipt by email, in your studio's name, when they buy in your shop or pay for a booking.

## For your accountant

The **Finance & Accounting** plugin adds a monthly report, and **Export CSV** on the Payments screen. It lists your payments, Stripe fees, payouts and refunds, month by month. See [Plugins](/plugins/).
