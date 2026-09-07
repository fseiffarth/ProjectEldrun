/** Viewer-owned URLs and a bounded queue, shared by successive preview DOMs. */
export class PreviewImages {
  private urls = new Map<string, string>();
  private pending = new Map<string, Promise<string | null>>();
  private wanted = new Set<string>();
  private queue: (() => void)[] = [];
  private active = 0;
  private disposed = false;
  private paused = false;
  pause(paused: boolean) {
    this.paused = paused;
    if (!paused) { this.disposed = false; this.pump(); }
  }
  constructor(private read: (path: string) => Promise<Uint8Array>, private mime: (path: string) => string) {}
  retain(paths: Set<string>) {
    this.wanted = paths;
    for (const [path, url] of this.urls) {
      if (!paths.has(path)) { URL.revokeObjectURL(url); this.urls.delete(path); }
    }
  }
  load(path: string): Promise<string | null> {
    const url = this.urls.get(path);
    if (url) return Promise.resolve(url);
    const pending = this.pending.get(path);
    if (pending) return pending;
    const promise = new Promise<string | null>((resolve) => {
      this.queue.push(() => {
        if (this.disposed || !this.wanted.has(path)) { resolve(null); return; }
        this.active++;
        void this.read(path).then((bytes) => {
          if (this.disposed || !this.wanted.has(path)) return null;
          const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: this.mime(path) }));
          this.urls.set(path, url);
          return url;
        }).catch(() => null).then(resolve).finally(() => {
          this.active--;
          this.pump();
        });
      });
    });
    this.pending.set(path, promise);
    void promise.then(() => this.pending.delete(path));
    this.pump();
    return promise;
  }
  private pump() {
    while (!this.paused && this.active < 4 && this.queue.length) this.queue.shift()!();
  }
  dispose() {
    this.disposed = true;
    this.paused = false;
    this.retain(new Set());
    this.pump();
  }
}
