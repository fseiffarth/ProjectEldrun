/**
 * Pure, dependency-free CSV/TSV parsing and sorting for the table viewer (#40).
 * No DOM, no React — unit-tested in isolation (`src/__tests__/table.test.ts`).
 */

/** A leading UTF-8 BOM that some editors prepend; stripped before parsing. */
const BOM = "﻿";

/**
 * Parse `text` as RFC 4180 delimited data with the given single-character
 * `delimiter` (`,` for CSV, `\t` for TSV). Returns an array of rows, each an
 * array of string cells.
 *
 * Handles:
 *  - quoted fields (`"…"`) that may contain the delimiter, CR, LF, or CRLF;
 *  - the `""` escape for a literal double-quote inside a quoted field;
 *  - CRLF and bare-LF (and bare-CR) line endings;
 *  - a leading BOM, stripped up front;
 *  - a single trailing newline — it does NOT emit a trailing empty row.
 *
 * A quote that appears mid-field in an unquoted context is treated as a literal
 * character (lenient, like most spreadsheet importers), so malformed input still
 * yields cells rather than throwing.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Tracks whether the current row has seen any content, so we can decide
  // whether a final dangling row (after a trailing newline) should be emitted.
  let rowStarted = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    rowStarted = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      rowStarted = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      rowStarted = true;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF as one line ending; a bare CR also ends the line.
      if (src[i + 1] === "\n") i++;
      pushRow();
      continue;
    }
    if (ch === "\n") {
      pushRow();
      continue;
    }
    field += ch;
    rowStarted = true;
  }

  // Flush the final field/row unless the input ended exactly on a row terminator
  // (a single trailing newline must not produce a trailing empty row).
  if (rowStarted || field !== "" || row.length > 0 || inQuotes) {
    pushRow();
  }

  return rows;
}

/** Detect the delimiter for a file path by extension: `.tsv` → tab, else comma. */
export function delimiterForPath(path: string): string {
  return /\.tsv$/i.test(path) ? "\t" : ",";
}

/**
 * Whether every cell in `values` parses as a finite number (so the column should
 * sort numerically). An empty input or an empty/blank cell makes it non-numeric,
 * since a blank can't be ordered numerically against real numbers.
 */
function allNumeric(values: string[]): boolean {
  if (values.length === 0) return false;
  for (const v of values) {
    const t = v.trim();
    if (t === "") return false;
    const n = Number(t);
    if (!Number.isFinite(n)) return false;
  }
  return true;
}

/**
 * Return a new copy of `rows` sorted by column `col` in direction `dir`. Numeric
 * comparison is used when every cell in that column (across `rows`) parses as a
 * finite number; otherwise `localeCompare`. Missing cells (ragged rows) are
 * treated as empty strings. Does not mutate the input. Stable for equal keys.
 */
export function sortRows(
  rows: string[][],
  col: number,
  dir: "asc" | "desc",
): string[][] {
  const cells = rows.map((r) => r[col] ?? "");
  const numeric = allNumeric(cells);
  // Decorate with the original index for a stable sort across engines.
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const av = a.r[col] ?? "";
    const bv = b.r[col] ?? "";
    let cmp: number;
    if (numeric) {
      cmp = Number(av.trim()) - Number(bv.trim());
    } else {
      cmp = av.localeCompare(bv);
    }
    if (cmp === 0) cmp = a.i - b.i; // keep stable order for ties
    return dir === "asc" ? cmp : -cmp;
  });
  return indexed.map((x) => x.r);
}
