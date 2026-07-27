/**
 * Event categories — the colored tags Thunderbird puts on an event.
 *
 * A category is stored on the event as a plain key string; the color it renders
 * in is looked up here. Keeping the palette in code (rather than on disk) means
 * an imported ICS with an unknown `CATEGORIES:` value still round-trips — it just
 * falls back to the calendar's own color instead of gaining a swatch.
 */

import type { TranslationKey } from "./i18n";

export interface Category {
  key: string;
  label: string;
  /** Key to resolve the translated label through — `label` is the English
   *  fallback used wherever a translator isn't in scope (e.g. an ICS round-trip
   *  that only ever compares `key`). */
  labelKey: TranslationKey;
  /** CSS custom property holding the color, defined in `themes.css`. */
  color: string;
}

/** The built-in category set, in menu order. */
export const CATEGORIES: Category[] = [
  { key: "work", label: "Work", labelKey: "category.work", color: "var(--cal-cat-work)" },
  { key: "personal", label: "Personal", labelKey: "category.personal", color: "var(--cal-cat-personal)" },
  { key: "meeting", label: "Meeting", labelKey: "category.meeting", color: "var(--cal-cat-meeting)" },
  { key: "travel", label: "Travel", labelKey: "category.travel", color: "var(--cal-cat-travel)" },
  { key: "birthday", label: "Birthday", labelKey: "category.birthday", color: "var(--cal-cat-birthday)" },
  { key: "holiday", label: "Holiday", labelKey: "category.holiday", color: "var(--cal-cat-holiday)" },
  { key: "important", label: "Important", labelKey: "category.important", color: "var(--cal-cat-important)" },
];

/** Resolve a {@link Category}'s translated display label. */
export function categoryLabel(category: Category, t: (key: TranslationKey) => string): string {
  return t(category.labelKey);
}

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
