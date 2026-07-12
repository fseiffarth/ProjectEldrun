/**
 * Event categories — the colored tags Thunderbird puts on an event.
 *
 * A category is stored on the event as a plain key string; the color it renders
 * in is looked up here. Keeping the palette in code (rather than on disk) means
 * an imported ICS with an unknown `CATEGORIES:` value still round-trips — it just
 * falls back to the calendar's own color instead of gaining a swatch.
 */

export interface Category {
  key: string;
  label: string;
  /** CSS custom property holding the color, defined in `themes.css`. */
  color: string;
}

/** The built-in category set, in menu order. */
export const CATEGORIES: Category[] = [
  { key: "work", label: "Work", color: "var(--cal-cat-work)" },
  { key: "personal", label: "Personal", color: "var(--cal-cat-personal)" },
  { key: "meeting", label: "Meeting", color: "var(--cal-cat-meeting)" },
  { key: "travel", label: "Travel", color: "var(--cal-cat-travel)" },
  { key: "birthday", label: "Birthday", color: "var(--cal-cat-birthday)" },
  { key: "holiday", label: "Holiday", color: "var(--cal-cat-holiday)" },
  { key: "important", label: "Important", color: "var(--cal-cat-important)" },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** The category for a key, or null when unset/unknown. */
export function categoryFor(key: string | undefined): Category | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

/**
 * The color an event should render in: its category's color when it has a known
 * one, otherwise its calendar's color.
 */
export function eventColor(category: string | undefined, calendarColor: string): string {
  return categoryFor(category)?.color ?? calendarColor;
}
