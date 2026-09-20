// The untested register's command line — `npm run untested -- <cmd>`.
//
// `src/lib/untested.ts` is the register: one row per `UntestedTag` pill in the
// app. This script is how a row gets found, stamped and finally swept out:
//
//   list [prefix]     every row, grouped by area, with its live call sites
//   tested <prefix…>  stamp rows verified — the pills stop rendering at once
//   again <prefix…>   undo that (a feature that turned out broken after all)
//   sweep [prefix]    delete the markup and the rows of everything stamped
//   check             the invariants the registry test enforces
//
// A prefix matches by string prefix on the id, so `tested mail.` clears the
// whole mail client and `tested settings.mailClient` clears the one row.
//
// Scanning, not bookkeeping: the sites are found by reading the source every
// run, so nothing here goes stale when code moves between files.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "src/lib/untested.ts";
const ROOTS = ["src", "mobile-web/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "mobile-dist", "target", "__tests__"]);

/** One row of `UNTESTED`, as it is written in the register. */
const ROW = /^\s*"([^"]+)":\s*\{\s*area:\s*"([^"]+)",\s*what:\s*("(?:[^"\\]|\\.)*")\s*(?:,\s*tested:\s*"([^"]+)"\s*)?\},?\s*$/;

/** The four shapes a call site takes. `gate` is the phone's, which has no
 *  component to hang a prop on and tests the register inline instead. */
const SITE_PATTERNS = [
  { kind: "tag", re: /<UntestedTag id="([^"]+)"\s*\/>/g },
  { kind: "flag", re: /\buntested:\s*"([^"]+)"/g },
  { kind: "dom", re: /untestedTag\("([^"]+)"\)/g },
  { kind: "gate", re: /isUntested\("([^"]+)"\)/g },
];

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel);
      } else if (/\.tsx?$/.test(e.name) && rel !== REGISTRY) out.push(rel);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

/** The register, in file order, with the line each row sits on. */
export function readRegistry() {
  const lines = fs.readFileSync(path.join(ROOT, REGISTRY), "utf8").split("\n");
  const rows = [];
  lines.forEach((line, i) => {
    const m = line.match(ROW);
    if (m) rows.push({ id: m[1], area: m[2], what: JSON.parse(m[3]), tested: m[4], line: i });
  });
  return { lines, rows };
}

/** Every place an id is referenced, by id. */
export function scanSites() {
  const byId = new Map();
  for (const rel of sourceFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { kind, re } of SITE_PATTERNS) {
        for (const m of line.matchAll(re)) {
          if (!byId.has(m[1])) byId.set(m[1], []);
          byId.get(m[1]).push({ file: rel, line: i + 1, kind, text: line });
        }
      }
    });
  }
  return byId;
}

/** Pills that pass an id from data rather than a literal — they are covered by
 *  their `untested: "…"` flag, so an unannotated one is a real omission. */
export function unregisteredTags() {
  const bad = [];
  for (const rel of sourceFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line) || line.includes("`<UntestedTag")) return;
      if (/<UntestedTag\s*\/>/.test(line)) bad.push({ file: rel, line: i + 1, text: line.trim() });
    });
  }
  return bad;
}

/** What `check` and the registry test both ask of the tree. */
export function audit() {
  const { rows } = readRegistry();
  const sites = scanSites();
  const ids = new Set(rows.map((r) => r.id));
  const orphans = rows.filter((r) => !sites.has(r.id)).map((r) => r.id);
  const unknown = [...sites.keys()].filter((id) => !ids.has(id));
  const dupes = rows.map((r) => r.id).filter((id, i, all) => all.indexOf(id) !== i);
  return { rows, sites, orphans, unknown, dupes, bare: unregisteredTags() };
}

// ---------------------------------------------------------------- commands

function matches(id, prefixes) {
  return prefixes.length === 0 || prefixes.some((p) => id === p || id.startsWith(p));
}

function list(prefixes) {
  const { rows } = readRegistry();
  const sites = scanSites();
  let area = null;
  let open = 0;
  let done = 0;
  for (const r of rows) {
    if (!matches(r.id, prefixes)) continue;
    if (r.area !== area) {
      area = r.area;
      console.log(`\n${area}`);
    }
    const where = (sites.get(r.id) ?? []).map((s) => `${s.file}:${s.line}`);
    const mark = r.tested ? `✔ ${r.tested}` : "·";
    if (r.tested) done++; else open++;
    console.log(`  ${mark} ${r.id}`);
    console.log(`      ${r.what}`);
    console.log(`      ${where.length ? where.join(", ") : "NO CALL SITE — sweep it"}`);
  }
  console.log(`\n${open} still tagged, ${done} stamped tested and waiting for a sweep.`);
}

function stamp(prefixes, date) {
  if (prefixes.length === 0) fail("tested <id-or-prefix>… — nothing to stamp");
  const { lines, rows } = readRegistry();
  const sites = scanSites();
  let hit = 0;
  let pills = 0;
  for (const r of rows) {
    if (!matches(r.id, prefixes) || r.tested) continue;
    lines[r.line] = lines[r.line].replace(/\s*\},?\s*$/, (tail) =>
      `, tested: "${date}" }${tail.trimEnd().endsWith(",") ? "," : ""}`);
    hit++;
    pills += (sites.get(r.id) ?? []).length;
    console.log(`✔ ${r.id} — ${r.what}`);
  }
  if (!hit) return console.log("Nothing matched — `list` shows what is still open.");
  fs.writeFileSync(path.join(ROOT, REGISTRY), lines.join("\n"));
  console.log(`\n${hit} row(s) stamped ${date}; ${pills} pill(s) stop rendering.`);
  console.log("Run `npm run untested -- sweep` when you want the markup gone too.");
}

function unstamp(prefixes) {
  if (prefixes.length === 0) fail("again <id-or-prefix>… — nothing to reopen");
  const { lines, rows } = readRegistry();
  let hit = 0;
  for (const r of rows) {
    if (!matches(r.id, prefixes) || !r.tested) continue;
    lines[r.line] = lines[r.line].replace(/,\s*tested:\s*"[^"]+"\s*\}/, " }");
    hit++;
    console.log(`· ${r.id} — back to untested`);
  }
  if (hit) fs.writeFileSync(path.join(ROOT, REGISTRY), lines.join("\n"));
  console.log(`${hit} row(s) reopened.`);
}

/** A space that only separated a label from its pill is, with the pill gone,
 *  a stray space inside the element. */
function tidyGaps(line) {
  return line.replace(/ +(<\/[A-Za-z])/g, "$1").replace(/\s+$/, "");
}

/** Take one site's markup out of a line. Returns the new line, `null` to drop
 *  the line entirely, or `undefined` when the shape is not one we rewrite. */
function stripSite(line, id, kind) {
  if (kind === "flag") {
    // Its own line in every object literal today, but a neighbour's line is
    // not ours to delete.
    const cut = line.replace(new RegExp(`\\buntested:\\s*"${id}",?\\s*`), "");
    return cut.trim() === "" ? null : tidyGaps(cut);
  }
  if (kind === "dom") {
    const cleaned = line
      .replace(new RegExp(`,\\s*\\.\\.\\.untestedTag\\("${id}"\\)`), "")
      .replace(new RegExp(`\\.\\.\\.untestedTag\\("${id}"\\),\\s*`), "");
    return cleaned === line ? undefined : cleaned;
  }
  const call = kind === "tag" ? `<UntestedTag id="${id}" />` : `isUntested("${id}")`;
  const at = line.indexOf(call);
  if (at < 0) return undefined;
  // `{… && <tag/>}` / `{isUntested(…) && …}` — the whole expression goes.
  let start = line.lastIndexOf("{", at);
  while (start >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = start; i < line.length; i++) {
      if (line[i] === "{") depth++;
      else if (line[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    const expr = line.slice(start, end + 1);
    if (end > at && /&&/.test(expr) && expr.includes(call)) {
      const cut = (line.slice(0, start) + line.slice(end + 1));
      return cut.trim() === "" ? null : tidyGaps(cut);
    }
    if (end > at) break;
    start = line.lastIndexOf("{", start - 1);
  }
  if (kind !== "tag") return undefined; // a bare `isUntested()` call is code
  const before = line.slice(0, at);
  const after = line.slice(at + call.length);
  // The space in `{label} <tag/>` separated two things; with one of them gone
  // it is either a trailing space inside the element or a doubled one.
  const keepGap = before.trim() !== "" && /^\s*\S/.test(after) && !after.trimStart().startsWith("<");
  const cut = before.trim() === ""
    ? before + after.replace(/^\s+/, "")
    : before.replace(/\s+$/, keepGap ? " " : "") + after.replace(/^\s+/, keepGap ? "" : " ").replace(/^\s+$/, "");
  if (cut.trim() === "") return null;
  return tidyGaps(cut.replace(/<>\s*<\/>/g, "").replace(/\{" "\}\s*$/, ""));
}

/** A `.context-menu` button lays its label and pill out in a row via the
 *  `untested` class; with the pill gone the class is noise. */
function dropUntestedClass(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/className="untested"/.test(lines[i])) continue;
    let open = -1;
    for (let j = i; j >= Math.max(0, i - 6); j--) if (lines[j].includes("<button")) { open = j; break; }
    if (open < 0) continue;
    let close = -1;
    for (let j = i; j < Math.min(lines.length, i + 40); j++) if (lines[j].includes("</button>")) { close = j; break; }
    if (close < 0) continue;
    if (lines.slice(open, close + 1).some((l) => l.includes("<UntestedTag"))) continue;
    const cleaned = lines[i].replace(/\s*className="untested"/, "");
    lines[i] = cleaned.trim() === "" ? null : cleaned;
  }
  return lines.filter((l) => l !== null);
}

/** A file that has lost its last pill has lost the need for the import too,
 *  and `noUnusedLocals` would stop the build on it. */
function tidyImports(lines) {
  const isImport = (l) => /^import .*(UntestedTag|lib\/untested|"\.\.\/untested")/.test(l);
  const body = lines.filter((l) => !isImport(l)).join("\n");
  const out = [];
  for (const line of lines) {
    if (!isImport(line)) { out.push(line); continue; }
    let kept = line;
    for (const [name, used] of [
      ["UntestedTag", /<UntestedTag\b/.test(body)],
      ["isUntested", /\bisUntested\(/.test(body)],
      ["UntestedId", /\bUntestedId\b/.test(body)],
    ]) {
      if (used) continue;
      kept = kept
        .replace(new RegExp(`(type )?${name},\\s*`), "")
        .replace(new RegExp(`,\\s*(type )?${name}`), "")
        .replace(new RegExp(`\\{\\s*(type )?${name}\\s*\\}`), "{}");
    }
    if (!/\{\s*\}/.test(kept)) out.push(kept);
  }
  return out;
}

function sweep(prefixes) {
  const { lines, rows } = readRegistry();
  const sites = scanSites();
  const going = rows.filter((r) => r.tested && matches(r.id, prefixes));
  if (going.length === 0) return console.log("Nothing stamped tested is waiting to be swept.");

  const edits = new Map(); // file -> Set of line indexes handled
  const manual = [];
  let removed = 0;
  for (const r of going) {
    for (const s of sites.get(r.id) ?? []) {
      if (!edits.has(s.file)) edits.set(s.file, fs.readFileSync(path.join(ROOT, s.file), "utf8").split("\n"));
      const buf = edits.get(s.file);
      const next = stripSite(buf[s.line - 1], r.id, s.kind);
      if (next === undefined) { manual.push(`${s.file}:${s.line}  ${r.id}`); continue; }
      buf[s.line - 1] = next;
      removed++;
    }
  }
  for (const [file, buf] of edits) {
    const kept = tidyImports(dropUntestedClass(buf.filter((l) => l !== null)));
    fs.writeFileSync(path.join(ROOT, file), kept.join("\n"));
  }
  const gone = new Set(going.map((r) => r.id));
  fs.writeFileSync(
    path.join(ROOT, REGISTRY),
    lines.filter((l) => { const m = l.match(ROW); return !(m && gone.has(m[1])); }).join("\n"),
  );
  console.log(`Swept ${going.length} row(s) and ${removed} call site(s) across ${edits.size} file(s).`);
  if (manual.length) {
    console.log("\nLeft for you — the shape was not one this script rewrites:");
    for (const m of manual) console.log(`  ${m}`);
  }
  console.log("\nNow run `npm run build`, `npm test` and `npm run lint`.");
}

function check() {
  const { orphans, unknown, dupes, bare } = audit();
  let bad = false;
  const say = (title, items) => {
    if (!items.length) return;
    bad = true;
    console.log(`\n${title}`);
    for (const i of items) console.log(`  ${typeof i === "string" ? i : `${i.file}:${i.line}  ${i.text}`}`);
  };
  say("Rows nothing uses — sweep them:", orphans);
  say("Ids with no row in the register:", unknown);
  say("Ids written twice in the register:", dupes);
  say("Pills with no id at all:", bare);
  if (!bad) console.log("The register and the source agree.");
  return bad ? 1 : 0;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dateArg = rest.find((a) => a.startsWith("--date="));
  const prefixes = rest.filter((a) => !a.startsWith("--"));
  const date = dateArg ? dateArg.slice(7) : new Date().toISOString().slice(0, 10);
  switch (cmd) {
    case "list": case undefined: return list(prefixes);
    case "tested": return stamp(prefixes, date);
    case "again": return unstamp(prefixes);
    case "sweep": return sweep(prefixes);
    case "check": return process.exit(check());
    default: return fail(`unknown command "${cmd}" — list | tested | again | sweep | check`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
