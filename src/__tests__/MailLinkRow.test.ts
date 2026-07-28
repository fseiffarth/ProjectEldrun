/**
 * How a links-panel row names itself, and when it raises an alarm.
 *
 * Found in live QA: a phone number in an ordinary email signature rendered as
 * the bare word `tel`, flagged amber, with a second `tel` chip beside it — and,
 * because any scheme warning auto-expands the collapsed panel, it force-opened
 * the links panel on nearly every business email. Three separate ways of being
 * wrong about a signature.
 *
 * The two rules here:
 *
 *  1. **A row names its target.** For a web link that is the host, the only part
 *     that decides where a click goes. For a hostless scheme (`tel:`, `mailto:`,
 *     `sms:`) the backend's `display_host` falls back to the scheme word, which
 *     names nothing — so the row shows the number or address instead.
 *  2. **Unopenable is not the same as suspicious.** `tel:`/`sms:`/`mailto:` are
 *     signature furniture. They stay copy-only — that part is untouched — but
 *     they no longer look like a threat.
 */
import { describe, it, expect } from "vitest";
import { linkIsOpenable, mailLinkLabel, mailLinkNeedsAttention } from "../lib/mail";
import type { MailLink } from "../types/mail";

const link = (over: Partial<MailLink> = {}): MailLink => ({
  lid: 0,
  href: "https://news.example/story",
  display_host: "news.example",
  mismatch: false,
  ...over,
});

describe("a row names its target", () => {
  it("shows the host for a web link", () => {
    expect(mailLinkLabel(link())).toBe("news.example");
  });

  it("shows the number for a tel link, not the word 'tel'", () => {
    const tel = link({
      href: "tel:+492281234567",
      display_host: "tel",
      scheme_warning: "tel",
    });
    expect(mailLinkLabel(tel)).toBe("+492281234567");
  });

  it("shows the address for a mailto link, without its query", () => {
    const mailto = link({
      href: "mailto:support@example.com?subject=Order%20123",
      display_host: "mailto",
    });
    expect(mailLinkLabel(mailto)).toBe("support@example.com");
  });

  it("percent-decodes, and survives a malformed escape", () => {
    expect(mailLinkLabel(link({ href: "tel:+49%20228%201234", display_host: "tel" }))).toBe(
      "+49 228 1234",
    );
    // A lone `%` is not a valid escape; the row must still render.
    expect(mailLinkLabel(link({ href: "tel:+49%2", display_host: "tel" }))).toBe("+49%2");
  });

  it("strips bidi controls from what it shows", () => {
    // The target is sender-controlled text, like a subject or a filename.
    const sneaky = link({ href: "tel:+49‮1234", display_host: "tel" });
    expect(mailLinkLabel(sneaky)).not.toContain("‮");
  });

  it("never truncates", () => {
    const long = `tel:+${"1".repeat(200)}`;
    expect(mailLinkLabel(link({ href: long, display_host: "tel" }))).toHaveLength(201);
  });

  it("falls back to the href when there is nothing else to show", () => {
    expect(mailLinkLabel({ href: "tel:", display_host: "tel" })).toBe("tel");
    expect(mailLinkLabel({ href: "ftp://files.example/x", display_host: "" })).toBe(
      "ftp://files.example/x",
    );
  });
});

describe("unopenable is not the same as suspicious", () => {
  it("does not flag a signature phone number or address", () => {
    expect(
      mailLinkNeedsAttention(link({ href: "tel:+4922812345", scheme_warning: "tel" })),
    ).toBe(false);
    expect(
      mailLinkNeedsAttention(link({ href: "sms:+4922812345", scheme_warning: "sms" })),
    ).toBe(false);
    expect(mailLinkNeedsAttention(link({ href: "mailto:a@example.com" }))).toBe(false);
  });

  it("still flags a scheme that is neither web nor signature furniture", () => {
    expect(
      mailLinkNeedsAttention(link({ href: "ftp://files.example/x", scheme_warning: "ftp" })),
    ).toBe(true);
    expect(
      mailLinkNeedsAttention(link({ href: "xmpp:a@b.example", scheme_warning: "xmpp" })),
    ).toBe(true);
  });

  it("always flags a display-text-vs-host mismatch, whatever the scheme", () => {
    expect(
      mailLinkNeedsAttention(
        link({ href: "tel:+4922812345", scheme_warning: "tel", mismatch: true }),
      ),
    ).toBe(true);
    expect(mailLinkNeedsAttention(link({ mismatch: true }))).toBe(true);
  });

  /// The part that must not have changed: these are still copy-only. Dropping
  /// the alarm must not have granted them an Open button.
  it("leaves the refusal to open them untouched", () => {
    for (const href of ["tel:+4922812345", "sms:+4922812345", "ftp://files.example/x"]) {
      expect(linkIsOpenable({ href, scheme_warning: "x" }), href).toBe(false);
    }
    // `mailto:` has no scheme warning and is handled by the internal composer,
    // never by the OS handler — so it is not "openable" either.
    expect(linkIsOpenable({ href: "mailto:a@example.com" })).toBe(false);
    expect(linkIsOpenable({ href: "https://ok.example/" })).toBe(true);
  });
});
