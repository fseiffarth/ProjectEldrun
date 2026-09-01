import { ApiError } from "./api";

/**
 * Why Eldrun Mobile could not reach the workspace, at the granularity the
 * *reader* can act on.
 *
 * The screen behind this used to say "Host unavailable" for every one of these
 * and offer a Retry button, which is the least useful thing it could say: the
 * phone being off the tailnet, the sidecar not running, and the desktop app
 * being closed are three different problems with three different fixes, and
 * pressing Retry helps with none of them. They are all distinguishable from
 * here — the difference is whether an HTTP response came back at all, and if
 * one did, whether it came from our own sidecar or from the proxy in front of
 * it — so the app should distinguish them rather than make the user guess.
 */
export type UnavailableReason =
  /** The phone has no network at all. */
  | "phone_offline"
  /** No HTTP response came back, but the phone believes it is online: nothing
   * is answering at the host's address. */
  | "unreachable"
  /** Something accepted the connection but did not answer in time. */
  | "timeout"
  /** An HTTP error that did not come from the sidecar — a proxy (Tailscale
   * serve) reached the desktop and found nothing listening on the port. */
  | "host_down"
  /** The sidecar answered, and said the desktop app is not connected to it. */
  | "desktop_down"
  /** The sidecar's rate limiter is refusing sign-ins. */
  | "busy"
  /** The sidecar rejected the address the app was opened from. */
  | "blocked_origin"
  /** The sidecar answered with something we cannot place. */
  | "server_error"
  /** Not a host problem at all: this browser refused the local key store. */
  | "storage_blocked";

function phoneIsOffline(): boolean {
  // `onLine === true` means only "an interface is up" — it says nothing about
  // whether the tailnet is reachable, so it can only ever prove the negative.
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Place a failed request on the taxonomy above.
 *
 * `api()` reports a transport failure as status 0, which is the whole basis of
 * the first split: status 0 means no server was heard from, so the fault is
 * between the phone and the desktop. Anything else means something answered,
 * and then the question is only who.
 */
export function classifyUnavailable(error: unknown): UnavailableReason {
  if (!(error instanceof ApiError)) return "server_error";
  if (error.status === 0) {
    if (error.code === "timeout") return "timeout";
    return phoneIsOffline() ? "phone_offline" : "unreachable";
  }
  // Checked before the proxy branch below: this is also a 5xx, but it is one
  // our own sidecar sent, and it means the opposite thing.
  if (error.code === "desktop_unavailable") return "desktop_down";
  if (error.status === 429) return "busy";
  if (error.status === 403 && error.code === "invalid_origin") return "blocked_origin";
  // Every error the sidecar itself sends carries a JSON `error` code, so a
  // bare `request_failed` on a gateway status is the tell that the body came
  // from a proxy instead — i.e. the tailnet reached the machine, but the
  // sidecar behind it is not listening.
  if (error.status >= 502 && error.code === "request_failed") return "host_down";
  return "server_error";
}

export interface UnavailableCopy {
  /** One line naming what is wrong. */
  title: string;
  /** What to actually do about it. */
  hint: string;
}

/**
 * Deliberately names the *suspects* rather than asserting a single cause where
 * the phone cannot tell them apart. "unreachable" is the honest example: from
 * inside the browser, a phone that dropped off the tailnet and a desktop that
 * went to sleep look identical, and claiming either one would send half the
 * readers to fix the wrong machine.
 */
export function describeUnavailable(reason: UnavailableReason): UnavailableCopy {
  switch (reason) {
    case "phone_offline":
      return {
        title: "This phone is offline.",
        hint: "There is no network connection at all. Turn on Wi‑Fi or mobile data, then retry.",
      };
    case "unreachable":
      return {
        title: "Can't reach your desktop.",
        hint: "Nothing answered at your desktop's address. Either this phone is disconnected from Tailscale, or the desktop is asleep or shut down. Open the Tailscale app and check it is connected.",
      };
    case "timeout":
      return {
        title: "Your desktop didn't answer in time.",
        hint: "The connection reached the desktop but stalled. This is usually a weak signal — retry when you have a better connection.",
      };
    case "host_down":
      return {
        title: "Eldrun Mobile isn't running on your desktop.",
        hint: "The desktop is reachable, but nothing is serving Eldrun Mobile on it. Start Eldrun on the desktop, or switch Eldrun Mobile back on in its settings.",
      };
    case "desktop_down":
      return {
        title: "Eldrun isn't running on your desktop.",
        hint: "Eldrun Mobile is up and answering, but the Eldrun app itself is not connected to it. Start Eldrun on the desktop.",
      };
    case "busy":
      return {
        title: "Too many sign-in attempts.",
        hint: "Eldrun Mobile is rate-limiting sign-ins from this device. Wait a moment before retrying.",
      };
    case "blocked_origin":
      return {
        title: "This isn't the address your desktop expects.",
        hint: "Eldrun Mobile only answers on the exact address configured on the desktop. Open it from the address shown in the desktop's Eldrun Mobile settings — renaming your tailnet changes it.",
      };
    case "storage_blocked":
      return {
        title: "This browser blocked Eldrun Mobile's key store.",
        hint: "The paired device key lives in this browser's storage. Leave private browsing, or allow site data for this address, then retry.",
      };
    case "server_error":
      return {
        title: "Your desktop reported an error.",
        hint: "Eldrun Mobile answered but could not complete the request. Retry — if it keeps failing, check Eldrun Mobile on the desktop.",
      };
  }
}

/**
 * The raw shape of the failure, for a bug report. Kept next to the human copy
 * because diagnosing the outage this screen exists for came down to exactly
 * these two numbers, and the phone is often the only place they are visible.
 */
export function unavailableDetail(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.status === 0 ? error.code : `${error.status} ${error.code}`;
}
