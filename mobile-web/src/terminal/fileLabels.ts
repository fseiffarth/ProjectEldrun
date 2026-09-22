/** How a file's age and size read on the phone: the same words wherever a
 * file is listed — the composer's desktop pictures and the agent's gallery. */

export function ageLabel(seconds: number) {
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
