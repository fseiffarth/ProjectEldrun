/**
 * Device auth for Eldrun Mobile (`mobile-web/src/auth.ts`): a non-exportable
 * signing key in IndexedDB, a challenge/response sign-in on every open, and —
 * the part worth pinning — the split between "this device was rejected, pair
 * again" and "the host could not be reached, say which machine to fix". The
 * latter used to be collapsed into the former by `status < 500`, sending a
 * phone with a bad signal to the pairing screen.
 *
 * jsdom has neither IndexedDB nor a usable Web Crypto, so both are faked here:
 * the store is an in-memory map behind the same request/onsuccess protocol,
 * and `subtle` returns fixed bytes so the encoded signature is checkable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../mobile-web/src/api";
import { hasPairedDevice, logoutAuth, pair, resumeAuth } from "../../mobile-web/src/auth";

// ── A minimal IndexedDB: one database, named stores, get/put by key ─────────
type Req<T> = { result: T; error: unknown; onsuccess: null | (() => void); onerror: null | (() => void) };
const stores = new Map<string, Map<string, unknown>>();

function settle<T>(result: T): Req<T> {
  const request: Req<T> = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}

function fakeDatabase() {
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => { stores.set(name, new Map()); },
    transaction: () => ({
      objectStore: (store: string) => ({
        get: (key: string) => settle(stores.get(store)?.get(key)),
        put: (value: unknown, key: string) => {
          stores.get(store)?.set(key, value);
          return settle(undefined);
        },
      }),
    }),
  };
}

const fakeIndexedDB = {
  open: () => {
    const database = fakeDatabase();
    const request = {
      result: database,
      error: null,
      onupgradeneeded: null as null | (() => void),
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  },
};

// ── Fixed-byte Web Crypto ───────────────────────────────────────────────────
const SIGNATURE = Uint8Array.from([0xfb, 0xff, 0xfe]).buffer; // → "-__-" in base64url
const SPKI = Uint8Array.from([0x00, 0x10, 0x83]).buffer; // → "ABCD"
const privateKey = { type: "private" } as unknown as CryptoKey;
const publicKey = { type: "public" } as unknown as CryptoKey;
const subtle = {
  sign: vi.fn(async () => SIGNATURE),
  generateKey: vi.fn(async () => ({ privateKey, publicKey })),
  exportKey: vi.fn(async () => SPKI),
};

function fetchAnswering(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const body = (fetchMock: ReturnType<typeof vi.fn>, method: string, url: string) => {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input) === url && (init as RequestInit | undefined)?.method === method);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

async function seedDevice(deviceId = "dev-1") {
  stores.set("keys", new Map([["device", { deviceId, privateKey }]]));
}

beforeEach(() => {
  stores.clear();
  vi.stubGlobal("indexedDB", fakeIndexedDB);
  vi.stubGlobal("crypto", { subtle, getRandomValues: (bytes: Uint8Array) => bytes });
});

afterEach(() => {
  vi.unstubAllGlobals();
  subtle.sign.mockClear();
  subtle.generateKey.mockClear();
  subtle.exportKey.mockClear();
});

describe("Eldrun Mobile auth — resume", () => {
  it("is unpaired when no device record exists, without touching the network", async () => {
    const fetchMock = fetchAnswering({});
    await expect(resumeAuth()).resolves.toEqual({ kind: "unpaired" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(hasPairedDevice()).resolves.toBe(false);
  });

  it("signs the challenge payload and posts the base64url signature with the nonce", async () => {
    await seedDevice();
    const fetchMock = fetchAnswering({
      "POST /api/v1/auth/challenge": json({ nonce: "n-42", payload: "sign me" }),
      "POST /api/v1/auth/session": json({ ok: true }),
    });
    await expect(resumeAuth()).resolves.toEqual({ kind: "paired" });
    expect(body(fetchMock, "POST", "/api/v1/auth/challenge")).toEqual({ device_id: "dev-1" });
    expect(subtle.sign).toHaveBeenCalledWith(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode("sign me"),
    );
    // No `+`, `/` or `=` padding: the wire form is base64url.
    expect(body(fetchMock, "POST", "/api/v1/auth/session")).toEqual({
      device_id: "dev-1",
      nonce: "n-42",
      signature: "-__-",
    });
    await expect(hasPairedDevice()).resolves.toBe(true);
  });

  it.each([
    ["a 403", 403, "forbidden"],
    ["unknown_device", 401, "unknown_device"],
    ["invalid_signature", 401, "invalid_signature"],
  ])("sends the reader back to pairing when the host rejects this device (%s)", async (_label, status, code) => {
    await seedDevice();
    fetchAnswering({ "POST /api/v1/auth/challenge": json({ error: code }, status) });
    await expect(resumeAuth()).resolves.toEqual({ kind: "unpaired" });
  });

  it("does not re-pair for a rejected origin, which is a 403 that pairing cannot fix", async () => {
    await seedDevice();
    fetchAnswering({ "POST /api/v1/auth/challenge": json({ error: "invalid_origin" }, 403) });
    await expect(resumeAuth()).resolves.toMatchObject({ kind: "unavailable", reason: "blocked_origin" });
  });

  it("reports a transport failure as unavailable rather than unpaired", async () => {
    await seedDevice();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const result = await resumeAuth();
    expect(result.kind).toBe("unavailable");
    expect(["unreachable", "phone_offline"]).toContain((result as { reason: string }).reason);
  });

  it("reports the sidecar's rate limiter as busy, with the detail carried along", async () => {
    await seedDevice();
    fetchAnswering({ "POST /api/v1/auth/challenge": json({ error: "too_many_attempts" }, 400) });
    const result = await resumeAuth();
    expect(result).toMatchObject({ kind: "unavailable", reason: "busy" });
    expect(typeof (result as { detail?: string }).detail).toBe("string");
  });

  it("names a closed desktop app as desktop_down when the sidecar says so", async () => {
    await seedDevice();
    fetchAnswering({
      "POST /api/v1/auth/challenge": json({ nonce: "n", payload: "p" }),
      "POST /api/v1/auth/session": json({ error: "desktop_unavailable" }, 503),
    });
    await expect(resumeAuth()).resolves.toMatchObject({ kind: "unavailable", reason: "desktop_down" });
  });

  it("lets a blocked key store surface as its own failure instead of reading as an unpaired phone", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("blocked"); } });
    fetchAnswering({});
    await expect(resumeAuth()).rejects.toThrow("blocked");
  });
});

describe("Eldrun Mobile auth — pair and logout", () => {
  it("pairs with the code, the device name and the public key, then remembers the device", async () => {
    const fetchMock = fetchAnswering({ "POST /api/v1/pair": json({ device_id: "dev-9" }) });
    await pair("123456", "Pixel");
    expect(subtle.generateKey).toHaveBeenCalledWith({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    expect(subtle.exportKey).toHaveBeenCalledWith("spki", publicKey);
    expect(body(fetchMock, "POST", "/api/v1/pair")).toEqual({ code: "123456", device_name: "Pixel", public_key: "ABCD" });
    expect(stores.get("keys")?.get("device")).toEqual({ deviceId: "dev-9", privateKey });
    await expect(hasPairedDevice()).resolves.toBe(true);
  });

  it("saves nothing when the host refuses the code", async () => {
    fetchAnswering({ "POST /api/v1/pair": json({ error: "invalid_code" }, 400) });
    await expect(pair("000000", "Pixel")).rejects.toBeInstanceOf(ApiError);
    await expect(hasPairedDevice()).resolves.toBe(false);
  });

  it("ends the server session on logout and keeps the device key for a later unlock", async () => {
    await seedDevice();
    const fetchMock = fetchAnswering({ "DELETE /api/v1/auth/session": json({ ok: true }) });
    await logoutAuth();
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(hasPairedDevice()).resolves.toBe(true);
  });
});
