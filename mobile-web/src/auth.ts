import { ApiError, api } from "./api";

const DB = "eldrun-mobile-auth";
const STORE = "keys";
const DEVICE = "device";

interface AuthRecord { deviceId: string; privateKey: CryptoKey }

function b64url(bytes: ArrayBuffer): string {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function load(): Promise<AuthRecord | null> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(DEVICE);
    request.onsuccess = () => resolve((request.result as AuthRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function save(record: AuthRecord): Promise<void> {
  const database = await db();
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

export type ResumeResult = "paired" | "unpaired" | "unavailable";

export async function resumeAuth(): Promise<ResumeResult> {
  const record = await load();
  if (!record) return "unpaired";
  try {
    await login(record);
    return "paired";
  } catch (reason) {
    return reason instanceof ApiError && reason.status < 500 ? "unpaired" : "unavailable";
  }
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
  await login(record);
}
