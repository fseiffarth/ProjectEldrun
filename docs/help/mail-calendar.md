---
id: mail-calendar
title: Mail, calendar, to-do board and browser
keywords: [mail, email, imap, smtp, address book, contacts, vcard, autocomplete, calendar, caldav, ics, event, reminder, todo, board, browser, web]
---

These surfaces are machine-wide, not per project. They open as overlays over
the whole window from their header indicator, or from the `+` menu.

## Mail

An IMAP/SMTP client with keyword rules, local-model help with drafts and
summaries, and encryption for what is stored on this machine. It is
experimental: switch it on in **Settings → System → Experimental** (Mail
client). The mail assistant runs only on a local Ollama model that you assign
to the **Mail** role in the Models & agents menu; nothing about your mail
leaves the machine. See `local-models`.

### Address book

**Address Book** in the mail toolbar opens your contacts in a tab of the mail
window. As in Thunderbird, there are two books. **Personal** holds the
contacts you add. **Collected Addresses** fills itself: after a send, each
recipient without a card is added (switch this off at the bottom of the
book's left column). A card holds a name, nickname, several addresses, phone
numbers, organization, postal address, birthday and notes. Mailing lists
group addresses under one name. **Import…** and **Export…** read and write
vCard (`.vcf`) files; an imported card whose address is already in the book
is merged into that card rather than duplicated.

While you type in To, Cc or Bcc, matching contacts and lists appear below the
field. Use ↑/↓ to move, Enter or Tab to pick, and Escape to close the list.
A list expands to its members' addresses. A contact's full nickname is
suggested first. The ☆ beside a message's sender adds them to the book, and
the ★ opens the card you already have. The address book stays on this
machine, encrypted with the rest of the local mail store.

## Calendar

Events, reminders, and `.ics` import and export, with CalDAV sync that merges
by resource instead of replacing what is already there. Open it from the
header's calendar indicator or `+` → Calendar. Drag in the grid to create an
event.

## To-do board

A board of cards in columns over the same to-dos the calendar keeps — steps,
tags and due dates included. Open it from the header's board indicator.

## Browser

A reader-mode browser tab: text and images, no scripts, with one deliberate
click out to the real page. It is experimental: switch on **In-app browser** in
Settings → System → Experimental, then use `+` → Browser.

## Agents and the calendar

Agents in the root console with the **MCP** chip on get Eldrun's root tools
(calendar, board, project list). See `tabs-and-panels`.
