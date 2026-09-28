---
id: mobile
title: Eldrun Mobile (phone companion)
keywords: [mobile, phone, files, browse, project files, read-only, tailscale, tailnet, pair, pairing, remote control, pwa, revoke, push, notifications, reminders, agent, question, connecting, not connecting, stuck, force stop, version]
---

Eldrun Mobile is a small companion web app for your phone. It shows the
projects you opted in, their agent and shell tabs, and one tab at a time as a
live terminal you can type into — plus a to-do board, read-only mail and a
calendar, and — if you allow it — a read-only look at your projects' files.
It is a remote control, not a phone-sized Eldrun: no editor, git, browser or
settings.

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

## Project files on the phone

Switch on **Project files on the phone** under **Project access** (off by
default) and a project's screen on the phone opens its files when you swipe
from left to right across it — a drawer slides in from the left edge (swipe
back, or tap beside it, to close it): walk its folders and open a file —
pictures and text full screen, PDFs in the browser, with Save and Share. It is
read-only: nothing can be changed, moved or deleted from there.

- It covers the projects switched on for Mobile, not boxes or the root
  console.
- `.git`, `.eldrun` and `.env…` are left out, symbolic links are not shown or
  followed, and a folder shows its first 500 entries.
- Files up to 24 MiB open; a longer text file shows its first 24 MiB.
- Switching it off closes the drawer within seconds, without restarting the host.

## Notifications on the phone

On the phone, open **This phone → Notifications** (or **Calendar → Reminders**)
and choose what reaches you, even with Eldrun Mobile closed:

- **Calendar reminders** — each reminder of the desktop calendar. A tap opens
  the Calendar.
- **Agents** — *When one needs your answer* (an agent tab waiting on a
  question or approval), or *Also when one finishes a turn*. A tap opens that
  tab. A tab you have open on the phone right then does not notify, and one
  tab notifies at most every 30 seconds.
- **What a notification shows** — *Names and details* (event title, time and
  place; project and tab), or *Only that something wants you*, for a lock
  screen others can see.

Eldrun must be running on the desktop: it is what notices the reminder or the
agent's turn.

- This is the one Mobile feature that leaves your tailnet: notifications travel
  through your phone browser's push service (Google, Apple, Mozilla or
  Microsoft). Each one is encrypted to your phone first, so the service cannot
  read it.
- On iPhone, add Eldrun Mobile to the Home Screen and open it from there;
  Safari tabs cannot receive notifications.
- A calendar whose alerts are switched off on the desktop stays silent on the
  phone too. Revoking a phone stops its notifications at once.
- Only agent tabs of projects (and boxes) the phone may reach notify.

## If the phone won't connect

"Connecting to your workspace…" that never finishes, or a splash saying the
desktop can't be reached or didn't answer, usually means the phone's own
Tailscale is not carrying traffic:

1. Open the Tailscale app on the phone (on Android the splash has an **Open
   Tailscale** link) and check it is connected.
2. If it already says connected, **force-stop** it — Android: Settings → Apps
   → Tailscale → Force stop — and open it again. After the phone changes
   networks Tailscale can stay "connected" while passing nothing, and its own
   off/on switch does not clear that; a force stop (or restarting the phone)
   does.
3. Only one VPN runs at a time on a phone: another VPN app switched on
   silently takes Tailscale's place.
4. Still stuck: check the desktop is awake and Eldrun is running on it.

To make it rarer on Android, set Tailscale's battery use to **Unrestricted**
and turn on **Always-on VPN** for it.

The splash also shows the phone app's version and build time (`v0.1.x ·
dd-mm hh:mm`), the same line as the home screen's header. After the desktop
updates, a build time older than the desktop's means the phone is still
running an old copy: close and reopen the app.

## If a phone goes missing

The header's Mobile button shows the host status. **Revoke** drops one device;
**Lock down** forgets every paired device and stops the host. Also remove the
device from your Tailscale machines.
