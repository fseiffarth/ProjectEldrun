/**
 * The video-call link on an event: where it comes from, whether it can be
 * joined, and what to call it.
 *
 * All pure, for the reason the rest of the calendar's math is (`calendarTime`,
 * `recurrence`): this is the half worth unit-testing, and every surface that
 * offers a **Join** button — the header's 🗓 dropdown, the event dialog, the
 * agenda rail — must reach the same verdict about the same event. One
 * implementation is what makes that true.
 *
 * Two rules run through the whole file.
 *
 * **The field is exact; a sniffed link is a guess, and the guess is deliberately
 * narrow.** Almost no real invitation arrives with the link in a dedicated
 * field: Zoom, Teams, Meet and Webex put it in `LOCATION` or bury it in the
 * middle of `DESCRIPTION`, so a Join button that only ever honoured
 * `event.conference` would be absent from precisely the events people are trying
 * to join. So a link is derived from those two fields as well — but only when
 * the URL is a **recognized meeting host**, or when the location is nothing but
 * a URL. The alternative (the first `https://` anywhere in the notes) turns the
 * agenda's minutes document, the ticket link and the shared drive folder into
 * "Join" buttons, and a button that joins the wrong thing is worse than no
 * button: it is clicked in the ten seconds before a meeting, without reading.
 *
 * **Only `http(s)` is ever joinable.** The desktop clients advertise their own
 * schemes (`zoommtg:`, `msteams:`), and every one of them is a request to launch
 * a local application with attacker-controlled arguments out of a file anybody
 * can mail you. The web URL is what all of them also publish, `routeUri` refuses
 * everything else anyway, and this check is the independent second one.
 */

/** Where the link was found — the dialog says so, because it changes trust. */
export type ConferenceSource = "field" | "location" | "notes";

export interface ConferenceLink {
  url: string;
  /** A display name for the service: "Zoom", "Microsoft Teams", … or the host. */
  provider: string;
  /** `true` when it was recognized as a known meeting service, not just a URL. */
  known: boolean;
  source: ConferenceSource;
}

/** The subset of an event/occurrence this module reads. */
export interface ConferenceSubject {
  conference?: string;
  location?: string;
  notes?: string;
}

/**
 * Hosts we are willing to call a meeting service, longest-suffix style: a host
 * matches when it *is* one of these or ends in `"." + entry`, so `evil.com/zoom.us`
 * and `zoom.us.evil.com` both miss. Kept small and boring on purpose — every
 * entry is a service whose links are only ever meeting links.
 */
const PROVIDERS: ReadonlyArray<{ host: string; name: string }> = [
  { host: "zoom.us", name: "Zoom" },
  { host: "teams.microsoft.com", name: "Microsoft Teams" },
  { host: "teams.live.com", name: "Microsoft Teams" },
  { host: "meet.google.com", name: "Google Meet" },
  { host: "meet.jit.si", name: "Jitsi Meet" },
  { host: "webex.com", name: "Webex" },
  { host: "whereby.com", name: "Whereby" },
  { host: "gotomeeting.com", name: "GoToMeeting" },
  { host: "bigbluebutton.org", name: "BigBlueButton" },
  { host: "meet.ffmuc.net", name: "Jitsi Meet" },
];

/** A self-hosted deployment names itself in the path, not the host. */
const PATH_PROVIDERS: ReadonlyArray<{ needle: string; name: string }> = [
  { needle: "/bigbluebutton/", name: "BigBlueButton" },
  { needle: "/call/", name: "Nextcloud Talk" },
];

/** Parse, or `null`. Never throws — this runs inside render paths. */
function parseUrl(raw: string): URL | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    // The scheme gate, and the only one this module has: see the file's note on
    // `zoommtg:`/`msteams:`.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** Whether a string is something a Join button may hand to the OS at all. */
export function isJoinableUrl(raw: string): boolean {
  return parseUrl(raw) !== null;
}

/** A host matched against `PROVIDERS`' suffix rule. */
function providerOfHost(host: string): string | null {
  const h = host.toLowerCase();
  for (const p of PROVIDERS) {
    if (h === p.host || h.endsWith(`.${p.host}`)) return p.name;
  }
  return null;
}

/**
 * What to call the service behind a URL. A host we do not recognize comes back
 * as **the host itself** rather than a generic word: "meet.example.org" tells
 * the user where the button is about to send them, and "Video call" does not.
 */
export function conferenceProvider(raw: string): string {
  const url = parseUrl(raw);
  if (!url) return "";
  const byHost = providerOfHost(url.hostname);
  if (byHost) return byHost;
  const path = url.pathname.toLowerCase();
  for (const p of PATH_PROVIDERS) {
    if (path.includes(p.needle)) return p.name;
  }
  return url.hostname;
}

/** Whether a URL is one of the services we are prepared to recognize unasked. */
export function isKnownConferenceUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (providerOfHost(url.hostname)) return true;
  const path = url.pathname.toLowerCase();
  return PATH_PROVIDERS.some((p) => path.includes(p.needle));
}

/**
 * The first *recognized* meeting URL in a block of free text.
 *
 * Deliberately not "the first URL": see the file's second rule. Trailing
 * punctuation is trimmed because a link at the end of a sentence in a
 * DESCRIPTION ends in `.` or `)` far more often than a real URL does.
 */
export function findMeetingUrl(text: string): string | null {
  if (!text) return null;
  const matches = text.match(/https?:\/\/[^\s<>"']+/g);
  if (!matches) return null;
  for (const raw of matches) {
    const trimmed = raw.replace(/[.,;:)\]}>]+$/, "");
    if (isKnownConferenceUrl(trimmed)) return trimmed;
  }
  return null;
}

/**
 * The event's video call, or `null`.
 *
 * The order is the order of confidence — the explicit field, then a location
 * that is a link, then a recognized link in the notes — and it is also the order
 * in which the answer stops being the user's own statement. Only the first is
 * one; the other two are why the button exists at all for imported invitations,
 * which is where nearly every meeting link in a real calendar comes from.
 */
export function conferenceLink(subject: ConferenceSubject): ConferenceLink | null {
  const field = (subject.conference ?? "").trim();
  if (isJoinableUrl(field)) {
    return {
      url: field,
      provider: conferenceProvider(field),
      known: isKnownConferenceUrl(field),
      source: "field",
    };
  }

  // A location holding nothing but a URL is the meeting link — that is what a
  // "location" means for an online meeting, and it is what Zoom and Webex write
  // there. A location with a URL *inside* prose ("Room 3, or join at …") is
  // handled by the recognized-host rule, like the notes.
  const location = (subject.location ?? "").trim();
  const locationUrl = isJoinableUrl(location) ? location : findMeetingUrl(location);
  if (locationUrl) {
    return {
      url: locationUrl,
      provider: conferenceProvider(locationUrl),
      known: isKnownConferenceUrl(locationUrl),
      source: "location",
    };
  }

  const inNotes = findMeetingUrl(subject.notes ?? "");
  if (inNotes) {
    return {
      url: inNotes,
      provider: conferenceProvider(inNotes),
      known: true,
      source: "notes",
    };
  }
  return null;
}
