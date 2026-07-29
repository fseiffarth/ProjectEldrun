import type { TranslationKey } from "./i18n";
import type { MailFilterField, MailFilterRule } from "../types/mail";

/**
 * **The pure half of the mail filter dialog** — building, editing and checking a
 * rule, with no store, no `invoke` and no React.
 *
 * What is deliberately *not* here is the matcher. Whether a rule matches a
 * message is answered in exactly one place (`services::mail_filters` in Rust),
 * and a TypeScript copy of it for a live preview would be a second
 * implementation of the one thing this feature must never be ambiguous about:
 * two matchers that disagree would make "why was this marked?" unanswerable.
 * The dialog's preview is therefore a **dry run of the real thing**
 * (`mailFiltersApply({ dryRun: true })`), which costs one local command and
 * cannot drift.
 *
 * The two rules encoded below are the ones the backend also enforces, mirrored
 * here so the dialog can *say* them rather than letting a save silently produce
 * a rule that matches nothing: a rule with no terms, and a rule with no fields,
 * both match **nothing** — never everything.
 */

/** Every field a rule can search, in the order the dialog lists them. */
export const FILTER_FIELDS: MailFilterField[] = ["subject", "sender", "recipients", "preview"];

/**
 * Field → i18n key, as a **map rather than a template string**. `t()` takes a
 * `TranslationKey`, and a built key would have to be cast — which is exactly how
 * a renamed key becomes a raw `mail.filters.field.sender` on screen instead of a
 * compile error.
 */
export const FIELD_LABEL_KEY: Record<MailFilterField, TranslationKey> = {
  subject: "mail.filters.field.subject",
  sender: "mail.filters.field.sender",
  recipients: "mail.filters.field.recipients",
  preview: "mail.filters.field.preview",
};

/** Problem token → i18n key, for the same reason. */
export const PROBLEM_KEY: Record<string, TranslationKey> = {
  noTerms: "mail.filters.problem.noTerms",
  noFields: "mail.filters.problem.noFields",
};

/**
 * What a new rule starts as: subject + sender, marked Urgent.
 *
 * Those two fields because they are what a keyword rule is nearly always about
 * ("anything from the registrar", "anything saying outage"), and *not* the
 * preview: a term matched against a body snippet is the one field that fires on
 * mail merely *mentioning* the word, which is the fastest way to a rule the user
 * switches off. Urgent because a rule the user bothered to write is a rule about
 * something they want to see; Important is one click away.
 */
export function blankRule(): MailFilterRule {
  return {
    id: "",
    name: "",
    terms: [],
    fields: ["subject", "sender"],
    mark: "urgent",
    match_all: false,
    whole_word: false,
    enabled: true,
  };
}

/**
 * Split typed text into terms.
 *
 * Commas and newlines separate; **spaces do not**, so `board meeting` is one
 * phrase rather than two words that would each fire on their own. That is the
 * whole reason this is not a `split(/\s+/)`: the failure mode of the other
 * choice is a rule the user reads as narrow behaving as broad.
 */
export function parseTermInput(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Case-insensitive membership — the same comparison the matcher makes, so the
 *  dialog cannot accept `Invoice` beside `invoice` as two different terms. */
export function hasTerm(terms: string[], term: string): boolean {
  const needle = term.trim().toLowerCase();
  return terms.some((t) => t.trim().toLowerCase() === needle);
}

/** Add typed text as one or more terms, dropping duplicates and blanks. Returns
 *  the same array when nothing was added, so a caller can skip a write. */
export function addTerms(terms: string[], text: string): string[] {
  const additions = parseTermInput(text).filter(
    (t, i, all) => !hasTerm(terms, t) && all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i,
  );
  return additions.length === 0 ? terms : [...terms, ...additions];
}

export function removeTerm(terms: string[], term: string): string[] {
  return terms.filter((t) => t !== term);
}

/** Toggle one searched field, keeping `FILTER_FIELDS` order so the chip row
 *  never reshuffles as it is edited. */
export function toggleField(fields: MailFilterField[], field: MailFilterField): MailFilterField[] {
  const next = fields.includes(field)
    ? fields.filter((f) => f !== field)
    : [...fields, field];
  return FILTER_FIELDS.filter((f) => next.includes(f));
}

/** Move a rule within the list. Order is data — the first matching rule wins —
 *  so this is a real edit and not a display preference. */
export function moveRule(rules: MailFilterRule[], from: number, to: number): MailFilterRule[] {
  if (from === to || from < 0 || from >= rules.length || to < 0 || to >= rules.length) return rules;
  const next = rules.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * What is wrong with this rule, as i18n key suffixes — never as sentences, so
 * the wording lives in `i18n` ×5 like every other user-facing string here.
 *
 * `noTerms` and `noFields` are the two that make a rule inert, and they are
 * *errors* rather than warnings: the backend will save such a rule quite happily
 * and it will simply never fire, which from the user's side is indistinguishable
 * from the feature being broken.
 */
export function ruleProblems(rule: MailFilterRule): string[] {
  const problems: string[] = [];
  if (rule.terms.filter((t) => t.trim().length > 0).length === 0) problems.push("noTerms");
  if (rule.fields.length === 0) problems.push("noFields");
  return problems;
}

export function ruleIsUsable(rule: MailFilterRule): boolean {
  return ruleProblems(rule).length === 0;
}

/** The name to show for a rule that has none — its first few terms, which is
 *  what the user would have typed anyway. Never an id: an unnamed rule still has
 *  to be recognizable in a list of them. */
export function ruleLabel(rule: MailFilterRule, fallback: string): string {
  const name = rule.name.trim();
  if (name) return name;
  const terms = rule.terms.filter((t) => t.trim().length > 0);
  if (terms.length === 0) return fallback;
  return terms.slice(0, 3).join(", ") + (terms.length > 3 ? " …" : "");
}
