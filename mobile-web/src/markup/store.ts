/**
 * Where a markup layer waits between strokes: the phone's own IndexedDB,
 * never the desktop (`docs/mobile_pdf_markup_plan.md` §2.7). Handwriting is
 * many points, and Safari allows `localStorage` only a few MB for the whole
 * app. One record per source; saved as each stroke ends, so a closed app or
 * a reload loses at most the stroke in progress; cleared after a Submit.
 *
 * Every access may fail — a private window, evicted or blocked storage — and
 * then the layer still works, unsaved, and the view says so: every function
 * here resolves rather than throws.
 */

import { isLayer, LIMITS, markCount, type Layer } from "./layer";
import { LEGACY_NAMES, NAMES } from "../../../src/lib/brand";
import { adoptLegacyDatabase, databaseHost, databasePort } from "../../../src/lib/brandMigration";

/** What a layer was drawn against: the file's size and modified time. A
 * different file under the same name is told apart by them. */
export type Fingerprint = { size: number; modified: number };
export type StoredLayer = { layer: Layer; fingerprint: Fingerprint; saved: number };

/** The record store behind the functions below — IndexedDB in the app, a
 * map or a broken one in tests. */
export interface LayerBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB = NAMES.mobileMarkupDb;
/** The database an older build of the phone app kept unsaved markup in. */
const LEGACY_DB = LEGACY_NAMES.mobileMarkupDb;
const STORE = "layers";

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  // Unsaved markup an older build stored under the app's old name is copied
  // over once, before the database is first used.
  database ??= (
    LEGACY_DB === DB
      ? openCurrent()
      : adoptLegacyDatabase(databaseHost(indexedDB), LEGACY_DB, DB, async () => databasePort(await openCurrent()))
          .catch(() => undefined)
          .then(openCurrent)
  ).catch((error: unknown) => {
    database = null;
    throw error;
  });
  return database;
}

function openCurrent(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

/** The app's backend: one object store in its own database. */
export const indexedDbBackend: LayerBackend = {
  async get(key) {
    return promised((await open()).transaction(STORE).objectStore(STORE).get(key));
  },
  async put(key, value) {
    await promised((await open()).transaction(STORE, "readwrite").objectStore(STORE).put(value, key));
  },
  async delete(key) {
    await promised((await open()).transaction(STORE, "readwrite").objectStore(STORE).delete(key));
  },
};

/** The record key: the project and the file, as the phone names them. A file
 * browser token is sealed afresh with every listing, so a project file is
 * keyed by its folder trail and name instead — a key that never leaves the
 * phone. */
export function layerKey(projectId: string, source: { files: string } | { outbox: string }): string {
  return "files" in source ? `${projectId}:files:${source.files}` : `${projectId}:outbox:${source.outbox}`;
}

/** Whether a layer is one the desktop would accept — never store one it
 * would refuse at Submit. */
export function withinLimits(layer: Layer): boolean {
  const { marks, points } = markCount(layer);
  return marks <= LIMITS.marks && points <= LIMITS.points;
}

/** The saved layer, `null` when there is none, or `"unavailable"` when the
 * storage could not be read at all. */
export async function loadLayer(key: string, backend: LayerBackend = indexedDbBackend): Promise<StoredLayer | null | "unavailable"> {
  let value: unknown;
  try {
    value = await backend.get(key);
  } catch {
    return "unavailable";
  }
  if (!value || typeof value !== "object") return null;
  const { layer, fingerprint, saved } = value as Partial<StoredLayer>;
  if (!isLayer(layer) || !fingerprint || typeof fingerprint.size !== "number" || typeof fingerprint.modified !== "number") return null;
  return { layer, fingerprint: { size: fingerprint.size, modified: fingerprint.modified }, saved: typeof saved === "number" ? saved : 0 };
}

/** Saves the layer; `false` when it could not be. An empty layer is a
 * removal, so a cleared file leaves nothing behind. */
export async function saveLayer(key: string, layer: Layer, fingerprint: Fingerprint, backend: LayerBackend = indexedDbBackend): Promise<boolean> {
  if (!withinLimits(layer)) return false;
  try {
    if (Object.values(layer.pages).every((page) => page.marks.length === 0)) await backend.delete(key);
    else await backend.put(key, { layer, fingerprint, saved: Date.now() } satisfies StoredLayer);
    return true;
  } catch {
    return false;
  }
}

export async function clearLayer(key: string, backend: LayerBackend = indexedDbBackend): Promise<boolean> {
  try {
    await backend.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** Whether the file changed since its layer was drawn. */
export function stale(stored: StoredLayer, current: Fingerprint): boolean {
  return stored.fingerprint.size !== current.size || stored.fingerprint.modified !== current.modified;
}
