/**
 * Remote images in the markdown preview, fetched only on request.
 *
 * The renderer emits a `span.md-img-remote[data-md-remote]` placeholder for
 * every `http(s)` image, and the app CSP blocks remote images anyway, so a
 * document cannot reach the network by being opened. The viewer calls
 * `fetchRemoteImage` only after the user presses Load. The backend
 * (`commands::markdown`) does the fetch under document-origin rules: https
 * only, nothing on this machine or the local network, type and size capped.
 */
import { invoke } from "@tauri-apps/api/core";

export interface RemoteImage {
  mime: string;
  bytes: Uint8Array;
}

export async function fetchRemoteImage(url: string): Promise<RemoteImage> {
  const r = await invoke<{ mime: string; dataBase64: string }>("markdown_remote_image", { url });
  return { mime: r.mime, bytes: decodeBase64(r.dataBase64) };
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Distinct hosts behind a list of image URLs, in first-seen order. */
export function remoteImageHosts(urls: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** `a.com, b.com, c.com +2` — the banner names where a Load would connect. */
export function hostsLabel(hosts: readonly string[], max = 3): string {
  const shown = hosts.slice(0, max).join(", ");
  return hosts.length > max ? `${shown} +${hosts.length - max}` : shown;
}
