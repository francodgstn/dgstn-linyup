---
title: Embed booking on your website
description: Open the Linyup booking flow as a pop-up on your own website, with one script tag.
sidebar:
  order: 3
---

If your studio already has a website, you don't need to send visitors away to book. Add one script and your "Book now" links open the Linyup booking flow in a pop-up over your own page.

## Add a booking button

```html
<a href="https://app.linyup.com/public/YOUR-STUDIO/booking" data-linyup-book>Book now</a>

<script src="https://app.linyup.com/embed.js" async></script>
```

Replace `YOUR-STUDIO` with your studio's public address. Include the script **once** per page, anywhere. It is safe to load more than once.

- **The link always works.** Until the script has loaded, or if it is blocked, the link simply opens your booking page in the normal way.
- On wide screens the flow opens as a centered dialog, and on phones as a bottom sheet. Escape, a click outside and the browser's Back button all close it.
- Payment happens inside the same flow.

## Embed a section of your Linyup website

You can also place individual sections (a schedule, a pricing table…) in an iframe. The script resizes them to fit their content, and any Book button inside them opens the same pop-up.

```html
<iframe src="https://app.linyup.com/embed/YOUR-STUDIO/WIDGET-ID"
        data-linyup-embed style="width:100%;border:0"></iframe>

<script src="https://app.linyup.com/embed.js" async></script>
```

:::note[Draft]
TODO before publishing: where to find YOUR-STUDIO and WIDGET-ID in the app, with a screenshot; a WordPress / Squarespace / Wix note.
:::
