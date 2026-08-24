const WINDOW_MS = 1000;

interface Sample {
  at: number;
  chars: number;
}

/**
 * The development footer's terminal-throughput meter. Samples stay keyed by
 * the full PTY id (`<scope>:<tabKey>`). Callers query with the exact ids from
 * the tab store rather than splitting the composed id: box scopes contain a
 * colon themselves, so delimiter-based attribution is ambiguous.
 *
 * This counts the raw JavaScript string delivered by `terminal-output` — ANSI
 * and other terminal control sequences included. That is the useful number for
 * diagnosing renderer/IPC pressure, and avoids doing a second parse of every
 * hot output chunk just for a debug display.
 */
export class TerminalOutputRateMeter {
  private readonly byPty = new Map<string, Sample[]>();

  note(ptyId: string, chars: number, at = performance.now()): void {
    if (chars <= 0) return;
    const samples = this.byPty.get(ptyId) ?? [];
    const last = samples[samples.length - 1];
    if (last?.at === at) last.chars += chars;
    else samples.push({ at, chars });
    this.byPty.set(ptyId, samples);
    this.prune(samples, at);
  }

  charsPerSecond(ptyIds: readonly string[], at = performance.now()): number {
    let chars = 0;
    for (const ptyId of ptyIds) {
      const samples = this.byPty.get(ptyId);
      if (!samples) continue;
      this.prune(samples, at);
      if (samples.length === 0) {
        this.byPty.delete(ptyId);
        continue;
      }
      for (const sample of samples) chars += sample.chars;
    }
    return Math.round((chars * 1000) / WINDOW_MS);
  }

  private prune(samples: Sample[], at: number): void {
    const cutoff = at - WINDOW_MS;
    let firstLive = 0;
    while (firstLive < samples.length && samples[firstLive].at <= cutoff) firstLive += 1;
    if (firstLive > 0) samples.splice(0, firstLive);
  }
}

const terminalOutputRate = new TerminalOutputRateMeter();

export function noteTerminalOutputChars(ptyId: string, chars: number): void {
  terminalOutputRate.note(ptyId, chars);
}

export function terminalCharsPerSecond(ptyIds: readonly string[]): number {
  return terminalOutputRate.charsPerSecond(ptyIds);
}
