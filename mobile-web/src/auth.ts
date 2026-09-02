import { ApiError, api } from "./api";
import { classifyUnavailable, unavailableDetail, type UnavailableReason } from "./connection";

const DB = "eldrun-mobile-auth";
const STORE = "keys";
const DEVICE = "device";

interface AuthRecord { deviceId: string; privateKey: CryptoKey }

function b64url(bytes: ArrayBuffer): string {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function openAuthDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function load(): Promise<AuthRecord | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(DEVICE);
    request.onsuccess = () => resolve((request.result as AuthRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function save(record: AuthRecord): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(record, DEVICE);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

async function login(record: AuthRecord): Promise<void> {
  const challenge = await api<{ nonce: string; payload: string }>("/api/v1/auth/challenge", {
    method: "POST", body: JSON.stringify({ device_id: record.deviceId }),
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.privateKey,
    new TextEncoder().encode(challenge.payload),
  );
  await api("/api/v1/auth/session", {
    method: "POST",
    body: JSON.stringify({ device_id: record.deviceId, nonce: challenge.nonce, signature: b64url(signature) }),
  });
}

export type ResumeResult =
  | { kind: "paired" }
  | { kind: "unpaired" }
  /** Carries *why*, so the splash can say which machine to go and fix rather
   * than showing one "Host unavailable" for every possible cause. */
  | { kind: "unavailable"; reason: UnavailableReason; detail?: string };

export async function resumeAuth(): Promise<ResumeResult> {
  const record = await load();
  if (!record) return { kind: "unpaired" };
  try {
    await login(record);
    return { kind: "paired" };
  } catch (reason) {
    // Only a rejection of *this device's identity* means "re-pair". A timeout,
    // an offline phone, or a 429 from the rate limiter must not send the user
    // to the pairing screen, which is what `status < 500` used to do.
    //
    // `invalid_origin` is a 403 but is emphatically *not* a rejected device —
    // it is the host refusing the address the app was opened from, and
    // re-pairing cannot fix it. It was swept in by the blanket `status === 403`
    // and sent the reader to a pairing screen that could only fail again.
    const rejected = reason instanceof ApiError
      && reason.code !== "invalid_origin"
      && (reason.status === 403 || reason.code === "unknown_device" || reason.code === "invalid_signature");
    if (rejected) return { kind: "unpaired" };
    return {
      kind: "unavailable",
      reason: classifyUnavailable(reason),
      detail: unavailableDetail(reason),
    };
  }
}

export async function hasPairedDevice(): Promise<boolean> {
  return !!await load();
}

/** End the server-side session when the local app is locked. The paired
 * non-exportable signing key stays in IndexedDB, so a verified local unlock
 * can obtain a fresh session without making the user pair again. */
export async function logoutAuth(): Promise<void> {
  await api("/api/v1/auth/session", { method: "DELETE" });
}

export async function pair(code: string, deviceName: string): Promise<void> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", keys.publicKey);
  const paired = await api<{ device_id: string }>("/api/v1/pair", {
    method: "POST",
    body: JSON.stringify({ code, device_name: deviceName, public_key: b64url(spki) }),
  });
  const record = { deviceId: paired.device_id, privateKey: keys.privateKey };
  await save(record);
}
