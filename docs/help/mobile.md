---
id: mobile
title: Eldrun Mobile (phone companion)
keywords: [mobile, phone, tailscale, tailnet, pair, pairing, remote control, pwa, revoke]
---

Eldrun Mobile is a small companion web app for your phone. It shows the
projects you opted in, their agent and shell tabs, and one tab at a time as a
live terminal you can type into — plus a to-do board, read-only mail and a
calendar. It is a remote control, not a phone-sized Eldrun: no file viewer,
editor, git, browser or settings.

## Requirements

- Tailscale on this computer and on the phone. The app is reachable only over
  your own private tailnet, never from the public internet.
- A Tailscale Serve HTTPS root handler proxying to Eldrun's loopback port, with
  Funnel off. Eldrun checks this and refuses to start otherwise, saying what is
  wrong.

## Set it up

1. Open **Settings → Remote & mobile → Mobile** and start the host.
2. Under **Project access**, switch on the projects the phone may reach. All
   start off. Only local, non-container projects are eligible.
3. Click **New pairing code**. The code is valid for five minutes.
4. On the phone, open the displayed `https://…ts.net` address and finish
   pairing there. Never send the code by chat, e-mail or screenshot.

An agent tab that was already running becomes reachable after its next normal
reopen, because the phone attaches to its terminal session.

## Using it

- Attaching to a running tab keeps working while the desktop Eldrun is closed
  or restarting.
- Creating a new tab from the phone goes through the running desktop, so
  Eldrun must be up.
- A paired phone types into a terminal exactly like your keyboard: keep agent
  approval modes conservative while Mobile is on.

## If a phone goes missing

The header's Mobile button shows the host status. **Revoke** drops one device;
**Lock down** forgets every paired device and stops the host. Also remove the
device from your Tailscale machines.
