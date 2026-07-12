/**
 * Deterministic per-category colors. A project's category tags (e.g. "work",
 * "research", "client-x") group projects in both the 3D project cloud and the
 * pill bar; each tag is colored by a stable hue derived from its name so the
 * same category always reads as the same color across the app — no color-picker
 * UI or stored palette to keep in sync.
 */

/** Normalize a category label for storage/compare: trim, collapse, drop blanks. */
export function normalizeCategory(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Merge a list of category labels into a clean, de-duplicated set (case-
 * insensitive dedupe, first spelling wins), with blanks removed and order
 * preserved. Used both before persisting and when offering toggle chips.
 */
export function cleanCategories(raw: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const c = normalizeCategory(r);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Read a project's category tags from its (extra-flattened) `categories` field. */
export function projectCategories(project: { categories?: unknown }): string[] {
  return Array.isArray(project.categories)
    ? cleanCategories(project.categories.filter((c): c is string => typeof c === "string"))
    : [];
}

/** djb2 string hash → 32-bit unsigned, for a stable hue per category name. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/**
 * A stable, theme-agnostic color for a category. The hue is hashed from the
 * (lower-cased) name and spread around the wheel; saturation/lightness are
 * fixed at values that stay legible on both light and dark panels.
 */
export function categoryColor(name: string): string {
  const hue = hashString(normalizeCategory(name).toLowerCase()) % 360;
  return `hsl(${hue} 62% 58%)`;
}

/** Primary (first) category's color, or null when the project has no tags. */
export function primaryCategoryColor(categories: string[]): string | null {
  return categories.length > 0 ? categoryColor(categories[0]) : null;
}
