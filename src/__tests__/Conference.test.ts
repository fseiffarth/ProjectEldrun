import { describe, expect, it } from "vitest";
import {
  conferenceLink,
  conferenceProvider,
  findMeetingUrl,
  isJoinableUrl,
  isKnownConferenceUrl,
} from "../lib/conference";

/**
 * The video-call link (`lib/conference.ts`).
 *
 * Two properties are worth more than the rest and most of this file is about
 * them: a Join button must never send anyone somewhere that is not the meeting
 * (so the sniffing is narrow, and a URL that merely appears in the notes is not
 * a call), and it must never hand the OS a non-`http(s)` URL out of a file
 * anybody can mail you.
 */

describe("what may be joined at all", () => {
  it("takes http and https", () => {
    expect(isJoinableUrl("https://zoom.us/j/123")).toBe(true);
    expect(isJoinableUrl("http://meet.example.org/room")).toBe(true);
  });

  it("refuses the desktop clients' own schemes and everything else", () => {
    // The whole reason the field is URL-typed: these launch a local application
    // with arguments out of an imported .ics.
    expect(isJoinableUrl("zoommtg://zoom.us/join?confno=123")).toBe(false);
    expect(isJoinableUrl("msteams:/l/meetup-join/x")).toBe(false);
    expect(isJoinableUrl("file:///etc/passwd")).toBe(false);
    expect(isJoinableUrl("javascript:alert(1)")).toBe(false);
    expect(isJoinableUrl("room 3.14")).toBe(false);
    expect(isJoinableUrl("")).toBe(false);
  });
});

describe("naming the service", () => {
  it("recognizes the usual hosts, including subdomains", () => {
    expect(conferenceProvider("https://company.zoom.us/j/999")).toBe("Zoom");
    expect(conferenceProvider("https://teams.microsoft.com/l/meetup-join/x")).toBe(
      "Microsoft Teams",
    );
    expect(conferenceProvider("https://meet.google.com/abc-defg-hij")).toBe("Google Meet");
  });

  it("does not fall for a host that merely contains a provider's name", () => {
    expect(isKnownConferenceUrl("https://zoom.us.evil.example/j/1")).toBe(false);
    expect(isKnownConferenceUrl("https://evil.example/zoom.us/j/1")).toBe(false);
  });

  it("names an unknown host by its host, not by a generic word", () => {
    // "Video call" would hide where the click is about to go; the host does not.
    expect(conferenceProvider("https://meet.example.org/standup")).toBe("meet.example.org");
  });

  it("recognizes a self-hosted deployment by its path", () => {
    expect(conferenceProvider("https://bbb.example.org/bigbluebutton/api/join")).toBe(
      "BigBlueButton",
    );
  });
});

describe("finding a link in free text", () => {
  it("picks the meeting link out of an invitation's prose", () => {
    const body = "Agenda: https://wiki.example.org/notes\nJoin: https://meet.google.com/abc-defg-hij";
    expect(findMeetingUrl(body)).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("ignores ordinary links entirely", () => {
    // The rule the whole module exists for: a Join button that opens the agenda
    // document is worse than no button, because it is clicked without reading.
    expect(findMeetingUrl("Notes: https://wiki.example.org/x and https://tickets.example/1")).toBe(
      null,
    );
  });

  it("drops the punctuation a sentence leaves on the end", () => {
    expect(findMeetingUrl("Join at https://meet.jit.si/standup.")).toBe(
      "https://meet.jit.si/standup",
    );
  });
});

describe("resolving an event's call", () => {
  it("prefers the field, and says the answer is the user's own", () => {
    const link = conferenceLink({
      conference: "https://meet.example.org/mine",
      location: "https://zoom.us/j/1",
      notes: "https://meet.google.com/abc-defg-hij",
    });
    expect(link?.url).toBe("https://meet.example.org/mine");
    expect(link?.source).toBe("field");
  });

  it("falls back to a location that is nothing but a link", () => {
    const link = conferenceLink({ location: "https://meet.example.org/room" });
    expect(link?.source).toBe("location");
    // Not a host we recognize — usable, but flagged as a guess.
    expect(link?.known).toBe(false);
  });

  it("reads a recognized link out of the notes", () => {
    const link = conferenceLink({
      location: "Room 3",
      notes: "Dial in: https://company.zoom.us/j/42",
    });
    expect(link?.url).toBe("https://company.zoom.us/j/42");
    expect(link?.source).toBe("notes");
    expect(link?.provider).toBe("Zoom");
  });

  it("offers nothing for an event that is merely in a room", () => {
    expect(conferenceLink({ location: "Room 3", notes: "Bring the slides." })).toBe(null);
  });

  it("ignores a field holding something unjoinable rather than trusting it", () => {
    const link = conferenceLink({
      conference: "zoommtg://zoom.us/join?confno=1",
      location: "Room 3",
    });
    expect(link).toBe(null);
  });
});
