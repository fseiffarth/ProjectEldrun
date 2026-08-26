import { openAuthDatabase } from "./auth";

const STORE = "keys";
const KEY = "local-unlock-v1";
const ITERATIONS = 210_000;
const PIN_PATTERN = /^\d{4,12}$/;
/** New PINs only. A 4-digit verifier sitting in the same IndexedDB store as the
 * key it gates is ~10,000 offline guesses; existing records keep working. */
export const MIN_NEW_PIN = 6;
/** Guessing is free without this: the verifier is local, so nothing rate-limits
 * an attacker holding the phone. Escalates, caps, and never wipes anything. */
const LOCKOUT_AFTER = 5;
const LOCKOUT_STEP = 15_000;
const LOCKOUT_CAP = 15 * 60_000;

interface LocalUnlockRecord {
  version: 1;
  salt: string;
  verifier: string;
  /** The PIN itself is never stored; its length lets the UI submit once. */
  pinLength?: number;
  /** A WebAuthn credential bound to this exact Serve origin. */
  biometricCredentialId?: string;
  failedAttempts?: number;
  lockedUntil?: number;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const raw = String.fromCharCode(...view);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// TypeScript's DOM declarations distinguish a normal ArrayBuffer from a
// SharedArrayBuffer-backed view. These values are freshly copied browser input,
// so give Web Crypto/WebAuthn the ordinary, non-shared form they require.
function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}

async function pinDigest(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: arrayBuffer(salt),
    iterations: ITERATIONS,
  }, key, 256);
  return new Uint8Array(bits);
}

async function readRecord(): Promise<LocalUnlockRecord | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => {
      const record = request.result as Partial<LocalUnlockRecord> | undefined;
      resolve(record?.version === 1 && typeof record.salt === "string" && typeof record.verifier === "string" ? record as LocalUnlockRecord : null);
    };
    request.onerror = () => reject(request.error);
  });
}

async function saveRecord(record: LocalUnlockRecord): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(record, KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function validPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export async function hasLocalUnlock(): Promise<boolean> {
  return !!await readRecord();
}

/** The configured length is not secret and avoids trying every 4–12 digit
 * prefix while the user enters a PIN. Older records simply return null. */
export async function localUnlockPinLength(): Promise<number | null> {
  const length = (await readRecord())?.pinLength;
  return typeof length === "number" && length >= 4 && length <= 12 ? length : null;
}

export async function platformBiometricAvailable(): Promise<boolean> {
  return typeof PublicKeyCredential !== "undefined"
    && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

async function enrollBiometric(): Promise<string | null> {
  if (!await platformBiometricAvailable()) return null;
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: arrayBuffer(randomBytes(32)),
      rp: { name: "Eldrun Mobile", id: location.hostname },
      user: {
        id: arrayBuffer(randomBytes(32)),
        name: "eldrun-mobile",
        displayName: "Eldrun Mobile local unlock",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Device biometric enrollment was cancelled.");
  return b64url(credential.rawId);
}

async function verifyBiometric(credentialId: string): Promise<void> {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: arrayBuffer(randomBytes(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: arrayBuffer(fromB64url(credentialId)) }],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!assertion) throw new Error("Device biometric verification was cancelled.");
}

export interface LocalUnlockSetup {
  biometricRequired: boolean;
}

/** Configure the app-local lock after pairing. The PIN is never persisted;
 * only a per-device PBKDF2 verifier is stored. WebAuthn itself performs the
 * platform biometric/device-lock check and keeps its private credential in the
 * phone's authenticator. */
export async function configureLocalUnlock(pin: string): Promise<LocalUnlockSetup> {
  if (!validPin(pin) || pin.length < MIN_NEW_PIN) throw new Error(`Choose a ${MIN_NEW_PIN}–12 digit PIN.`);
  const salt = randomBytes(16);
  const verifier = await pinDigest(pin, salt);
  const biometricCredentialId = await enrollBiometric();
  await saveRecord({ version: 1, salt: b64url(salt), verifier: b64url(verifier), pinLength: pin.length, biometricCredentialId: biometricCredentialId ?? undefined });
  return { biometricRequired: !!biometricCredentialId };
}

/** Exponential backoff after `LOCKOUT_AFTER` misses, capped. Exported so the
 * escalation is testable without a browser keystore. */
export function nextLockout(failedAttempts: number, now: number): number | undefined {
  const over = failedAttempts - LOCKOUT_AFTER;
  return over > 0 ? now + Math.min(LOCKOUT_STEP * 2 ** (over - 1), LOCKOUT_CAP) : undefined;
}

function describeWait(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Verify both local factors before the caller resumes the Eldrun session. */
export async function unlockLocal(pin: string, now = Date.now()): Promise<void> {
  const record = await readRecord();
  if (!record) throw new Error("Set up the app lock before unlocking Eldrun Mobile.");
  if (typeof record.lockedUntil === "number" && record.lockedUntil > now) {
    throw new Error(`Too many attempts. Try again in ${describeWait(record.lockedUntil - now)}.`);
  }
  if (!validPin(pin)) throw new Error("Enter your 4–12 digit PIN.");
  const expected = fromB64url(record.verifier);
  const actual = await pinDigest(pin, fromB64url(record.salt));
  if (!sameBytes(expected, actual)) {
    const failedAttempts = (record.failedAttempts ?? 0) + 1;
    const lockedUntil = nextLockout(failedAttempts, now);
    await saveRecord({ ...record, failedAttempts, lockedUntil });
    throw new Error(lockedUntil
      ? `Incorrect PIN. Try again in ${describeWait(lockedUntil - now)}.`
      : "Incorrect PIN.");
  }
  if (record.biometricCredentialId) await verifyBiometric(record.biometricCredentialId);
  if (record.failedAttempts || record.lockedUntil) {
    await saveRecord({ ...record, failedAttempts: 0, lockedUntil: undefined });
  }
}
