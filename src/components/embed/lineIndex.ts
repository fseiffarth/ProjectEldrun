export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** One-based line; a newline belongs to the preceding line. */
export function indexedLine(starts: readonly number[], offset: number): number {
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}
