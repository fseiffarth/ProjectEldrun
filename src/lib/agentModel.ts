/**
 * The model tag beside an agent tab: the transcript's model id, shortened for
 * a pill. `claude-opus-4-1-20250805` → `opus-4-1`; a name with no vendor
 * prefix or date (`gpt-5-codex`, `o3`) is shown as it is. Nothing is mapped
 * through a table — a model this file has never heard of still gets an honest
 * tag, which is the point of reading the transcript instead of guessing.
 */
export function shortModelName(id: string): string {
  const trimmed = id.trim();
  const short = trimmed.replace(/-\d{8}$/, "").replace(/^claude-/, "");
  return short || trimmed;
}
