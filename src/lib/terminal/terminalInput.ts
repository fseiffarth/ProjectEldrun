import { invoke } from "@tauri-apps/api/core";

const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

interface Request {
  remaining: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Segment {
  data: Uint8Array;
  request: Request;
}

class PtyInputPump {
  private queue: Segment[] = [];
  private backlogBytes = 0;
  private running = false;
  private closed = false;

  constructor(private readonly id: string) {}

  enqueue(data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`terminal '${this.id}' input is closed`));
    if (data.byteLength === 0) return Promise.resolve();
    if (this.backlogBytes + data.byteLength > MAX_BACKLOG_BYTES) {
      return Promise.reject(
        new Error(`terminal input backlog exceeded ${MAX_BACKLOG_BYTES / 1024 / 1024} MiB`),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const count = Math.ceil(data.byteLength / MAX_CHUNK_BYTES);
      const request: Request = { remaining: count, resolve, reject };
      for (let offset = 0; offset < data.byteLength; offset += MAX_CHUNK_BYTES) {
        this.queue.push({
          data: data.slice(offset, Math.min(offset + MAX_CHUNK_BYTES, data.byteLength)),
          request,
        });
      }
      this.backlogBytes += data.byteLength;
      if (!this.running) void this.drain();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error(`terminal '${this.id}' input was closed`);
    const requests = new Set(this.queue.map((segment) => segment.request));
    this.queue = [];
    this.backlogBytes = 0;
    requests.forEach((request) => request.reject(error));
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (!this.closed && this.queue.length > 0) {
      const batch: Segment[] = [];
      let bytes = 0;
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (bytes > 0 && bytes + next.data.byteLength > MAX_CHUNK_BYTES) break;
        batch.push(this.queue.shift()!);
        bytes += next.data.byteLength;
      }
      const data = new Uint8Array(bytes);
      let offset = 0;
      for (const segment of batch) {
        data.set(segment.data, offset);
        offset += segment.data.byteLength;
      }

      try {
        await invoke("pty_write", { id: this.id, data });
        this.backlogBytes -= bytes;
        for (const segment of batch) {
          segment.request.remaining -= 1;
          if (segment.request.remaining === 0) segment.request.resolve();
        }
      } catch (error) {
        const requests = new Set([
          ...batch.map((segment) => segment.request),
          ...this.queue.map((segment) => segment.request),
        ]);
        this.queue = [];
        this.backlogBytes = 0;
        requests.forEach((request) => request.reject(error));
        break;
      }
    }
    this.running = false;
  }
}

const pumps = new Map<string, PtyInputPump>();

/** FIFO, bounded input path shared by typing, paste, and synthesized input. */
export function writePtyInput(id: string, data: Uint8Array): Promise<void> {
  let pump = pumps.get(id);
  if (!pump) {
    pump = new PtyInputPump(id);
    pumps.set(id, pump);
  }
  return pump.enqueue(data);
}

/** Forget queued input for a PTY generation during unmount/respawn. */
export function clearPtyInput(id: string): void {
  const pump = pumps.get(id);
  if (!pump) return;
  pumps.delete(id);
  pump.close();
}

/** Test-only reset for the module-level per-PTY pumps. */
export function _clearAllPtyInputsForTest(): void {
  for (const pump of pumps.values()) pump.close();
  pumps.clear();
}
