/**
 * The display rules for `Authentication-Results`.
 *
 * The backend decides *whether* a verdict may be believed (`mail_authres.rs`);
 * these are the two rules the frontend adds on top, and both exist because the
 * failure mode of this feature is not "shows too little" — it is teaching the
 * user to trust a green tick that an attacker drew:
 *
 *  1. Nothing is ever shown outside the `verified` state, a second time, after
 *     the backend already cleared it.
 *  2. A `pass` is only good news when it is also *aligned*. A signature by
 *     `evil.example` on a mail claiming to be a bank passes genuinely and means
 *     nothing.
 */
import { describe, it, expect } from "vitest";
import {
  mailAuthDmarcCarried,
  mailAuthPanelTone,
  mailAuthShown,
  mailAuthSummary,
  mailAuthTone,
} from "../lib/mail";
import type { MailAuthMethod, MailAuthResults, MailAuthState } from "../types/mail";

const method = (over: Partial<MailAuthMethod> = {}): MailAuthMethod => ({
  method: "dmarc",
  result: "pass",
  identifier: "bank.example",
  aligned: true,
  ...over,
});

const results = (over: Partial<MailAuthResults> = {}): MailAuthResults => ({
  state: "verified",
  authserv_id: "mx.example.net",
  methods: [method()],
  header_count: 1,
  ...over,
});

describe("nothing is shown unless the header was checked", () => {
  for (const state of ["foreign", "unconfigured"] as MailAuthState[]) {
    it(`shows no verdict in the ${state} state, even if methods somehow arrived`, () => {
      // The backend clears `methods` in these states. This asserts the frontend
      // does not depend on that being true — two independent layers.
      const auth = results({ state, methods: [method(), method({ method: "spf" })] });
      expect(mailAuthShown(auth)).toEqual([]);
    });
  }

  it("shows the verdicts in the verified state", () => {
    expect(mailAuthShown(results())).toHaveLength(1);
  });

  it("says nothing at all when the message carried no header", () => {
    expect(mailAuthSummary(undefined)).toBeNull();
  });
});

describe("a pass is only good news when it is aligned", () => {
  it("tones an aligned pass as good", () => {
    expect(mailAuthTone(method({ result: "pass", aligned: true }))).toBe("good");
  });

  it("tones a pass by another domain as a warning, not as good", () => {
    expect(
      mailAuthTone(method({ result: "pass", identifier: "evil.example", aligned: false })),
    ).toBe("warn");
  });

  it("tones a pass that named no domain as a warning", () => {
    // Nothing to attribute the pass to is not the same as a clean result.
    expect(mailAuthTone(method({ result: "pass", identifier: undefined, aligned: undefined }))).toBe(
      "warn",
    );
  });

  it("tones failures as bad and unknown results as neutral", () => {
    expect(mailAuthTone(method({ result: "fail" }))).toBe("bad");
    expect(mailAuthTone(method({ result: "permerror" }))).toBe("bad");
    expect(mailAuthTone(method({ result: "softfail" }))).toBe("warn");
    expect(mailAuthTone(method({ result: "policy" }))).toBe("warn");
    for (const r of ["neutral", "none", "temperror", "unknown"] as const) {
      expect(mailAuthTone(method({ result: r })), r).toBe("neutral");
    }
  });

  it("never tones an unrecognized result as good", () => {
    // A result token from a future RFC revision must not inherit a pass's look.
    const odd = method({ result: "something-new" as MailAuthMethod["result"] });
    expect(mailAuthTone(odd)).not.toBe("good");
  });
});

describe("the summary line", () => {
  const key = (auth: MailAuthResults) => mailAuthSummary(auth)?.key;

  it("names the foreign server so the user can see whose results these are", () => {
    const s = mailAuthSummary(results({ state: "foreign", authserv_id: "evil.example" }));
    expect(s?.key).toBe("mail.authForeign");
    expect(s?.values).toEqual({ server: "evil.example" });
  });

  it("has a separate wording when the foreign header named no server", () => {
    expect(key(results({ state: "foreign", authserv_id: undefined }))).toBe(
      "mail.authForeignAnonymous",
    );
  });

  it("reports unconfigured rather than implying anything about the sender", () => {
    expect(key(results({ state: "unconfigured" }))).toBe("mail.authUnconfigured");
  });

  /// With **no DMARC clause** there is no authoritative answer, so the worst
  /// individual signal is the summary. (When DMARC *is* present it overrides
  /// this — see the ESP block below, which is the common real-world case.)
  it("reports the worst verdict present when DMARC did not answer", () => {
    const spfOnly = (over: Partial<MailAuthMethod>) =>
      key(results({ methods: [method({ method: "spf", ...over })] }));

    expect(spfOnly({ result: "fail" })).toBe("mail.authFailed");
    expect(spfOnly({ aligned: false, identifier: "x.example" })).toBe("mail.authPartial");
    expect(spfOnly({})).toBe("mail.authPassed");
  });

  /// An aligned DMARC pass beside a failing SPF is the **forwarded mail** case:
  /// forwarding breaks SPF, DKIM survives it, and DMARC passing on the DKIM
  /// alignment is the whole reason DMARC accepts either signal. Reporting that
  /// as a failure would flag every forwarded message.
  it("does not report a failure that DMARC already accounted for", () => {
    expect(
      key(results({ methods: [method(), method({ method: "spf", result: "fail" })] })),
    ).toBe("mail.authPassed");
  });

  it("distinguishes 'your server checked nothing' from 'everything passed'", () => {
    expect(key(results({ methods: [] }))).toBe("mail.authNothingChecked");
  });
});

/**
 * The shape of real commercial mail, taken from a live booking confirmation:
 * DMARC aligned pass, an SPF pass for the ESP's bounce domain (unaligned), and
 * **two** DKIM signatures — the brand's (aligned) and the sending service's
 * (not). This read as "Passed only in part", which is true of the clauses and
 * wrong about the message.
 */
describe("DMARC is authoritative when it has an answer", () => {
  const esp = (): MailAuthResults =>
    results({
      methods: [
        method({ method: "dmarc", result: "pass", identifier: "fewo.example", aligned: true }),
        method({
          method: "spf",
          result: "pass",
          identifier: "bounce.mailer.example",
          aligned: false,
        }),
        method({ method: "dkim", result: "pass", identifier: "fewo.example", aligned: true }),
        method({
          method: "dkim",
          result: "pass",
          identifier: "mailer.example",
          aligned: false,
        }),
      ],
    });

  it("summarizes an aligned DMARC pass as passed, not partial", () => {
    expect(mailAuthSummary(esp())?.key).toBe("mail.authPassed");
  });

  it("tones the panel green while the detail chips stay honest", () => {
    expect(mailAuthPanelTone(esp())).toBe("good");
    // The chips themselves are unchanged — the unaligned ones are still amber.
    const tones = mailAuthShown(esp()).map(mailAuthTone);
    expect(tones).toContain("warn");
    expect(tones).toContain("good");
  });

  it("explains the mismatch so green-over-amber does not read as a contradiction", () => {
    expect(mailAuthDmarcCarried(esp())).toBe(true);
    // …and says nothing when there is nothing to explain.
    expect(mailAuthDmarcCarried(results())).toBe(false);
  });

  it("keeps both DKIM signatures rather than collapsing them", () => {
    const dkim = mailAuthShown(esp()).filter((m) => m.method === "dkim");
    expect(dkim).toHaveLength(2);
    expect(dkim.map((m) => m.identifier)).toEqual(["fewo.example", "mailer.example"]);
  });

  it("collapses only byte-identical clauses", () => {
    const dupes = results({
      methods: [method({ method: "dkim" }), method({ method: "dkim" })],
    });
    expect(mailAuthShown(dupes)).toHaveLength(1);
  });

  it("still reports a DMARC failure as failed, whatever else passed", () => {
    const failing = results({
      methods: [
        method({ method: "dmarc", result: "fail" }),
        method({ method: "spf", result: "pass" }),
        method({ method: "dkim", result: "pass" }),
      ],
    });
    expect(mailAuthSummary(failing)?.key).toBe("mail.authFailed");
    expect(mailAuthPanelTone(failing)).toBe("bad");
  });

  it("does not let an unaligned DMARC pass carry the message", () => {
    // DMARC is defined on the From domain, so an unaligned one is malformed;
    // it must not short-circuit to "passed".
    const odd = results({
      methods: [
        method({ method: "dmarc", result: "pass", identifier: "other.example", aligned: false }),
        method({ method: "spf", result: "pass", identifier: "other.example", aligned: false }),
      ],
    });
    expect(mailAuthSummary(odd)?.key).toBe("mail.authPartial");
  });

  it("falls back to the individual signals when there is no DMARC clause", () => {
    const noDmarc = results({
      methods: [
        method({ method: "spf", result: "pass", identifier: "x.example", aligned: false }),
        method({ method: "dkim", result: "pass", aligned: true }),
      ],
    });
    expect(mailAuthSummary(noDmarc)?.key).toBe("mail.authPartial");
  });
});

describe("which methods are rendered", () => {
  it("keeps the three the UI can explain and orders them consistently", () => {
    const auth = results({
      methods: [
        method({ method: "dkim" }),
        method({ method: "arc" }),
        method({ method: "spf" }),
        method({ method: "iprev" }),
        method({ method: "dmarc" }),
      ],
    });
    expect(mailAuthShown(auth).map((m) => m.method)).toEqual(["dmarc", "spf", "dkim"]);
  });
});
