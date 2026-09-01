//! Dictionary-backed spell checking for the native editors — the deterministic,
//! model-free provider beside `commands::ollama::check_grammar`'s LLM one.
//!
//! Built on `spellbook` (helix's pure-Rust Hunspell-compatible checker), reading
//! the system's own dictionaries (`/usr/share/hunspell` on Linux) plus any
//! `.aff`/`.dic` pair dropped into `<state_dir>/dictionaries/`. LOCAL ONLY and
//! opt-in per viewer type, like the model provider — but unlike it this one
//! needs no resident model, answers in milliseconds, and is deterministic, which
//! is what makes it the always-on-able default.
//!
//! The one hard problem is that most bytes of a `.tex` or `.md` buffer are not
//! prose: a checker fed `\includegraphics` flags the command name on every page.
//! So the document is MASKED first — commands, math, code fences, URLs and
//! reference keys are overwritten with spaces, character for character, so the
//! line structure survives and every surviving token sits at its original spot.
//! Issues are reported as `(line, bad substring)` — the same shape the LLM
//! provider uses — so the frontend resolver (`resolveGrammarRanges`) serves both
//! without knowing which produced an issue.
//!
//! A "personal dictionary" is an append-only word list at
//! `<state_dir>/dictionaries/personal.dic`, folded into every loaded dictionary
//! (an added word applies across languages — a name is a name in all of them).
//! Everything except the cache/personal-file plumbing is pure and unit-tested.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use spellbook::Dictionary;

/// One misspelling. `line` is 1-based in the submitted text; `bad` is the exact
/// token as it appears there (the frontend locates it by substring search).
#[derive(Debug, Clone, PartialEq)]
pub struct SpellIssue {
    pub line: u32,
    pub bad: String,
    /// Best correction the dictionary offers ("" when it has none).
    pub suggestion: String,
}

/// Largest document (bytes) submitted for a check. Far above the LLM provider's
/// cap — a dictionary lookup is O(word) — but still bounded so a pathological
/// buffer can't stall the blocking task. The cap drops a trailing slice only,
/// so line numbers before it stay valid.
const MAX_SPELL_BYTES: usize = 400_000;

/// Most issues one check reports. A code file full of identifiers that slip the
/// heuristics would otherwise paint thousands of marks and pay a suggestion
/// lookup for each.
const MAX_SPELL_ISSUES: usize = 200;

/// Longest token worth checking — anything longer is machine output, not a word.
const MAX_TOKEN_CHARS: usize = 40;

// ── Dictionary discovery ─────────────────────────────────────────────────────

/// Directories searched for `.aff`/`.dic` pairs, in priority order (first hit
/// for a language code wins). The state-dir folder comes first so a user-dropped
/// dictionary overrides a system one; it is also the only writable location and
/// where `personal.dic` lives.
pub fn dict_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![crate::storage::state_dir().join("dictionaries")];
    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/usr/share/hunspell"));
        dirs.push(PathBuf::from("/usr/share/myspell/dicts"));
        dirs.push(PathBuf::from("/usr/local/share/hunspell"));
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(home).join("Library").join("Spelling"));
        }
        dirs.push(PathBuf::from("/Library/Spelling"));
    }
    dirs
}

/// Language codes (file stems, e.g. `en_US`) with BOTH halves of a Hunspell
/// dictionary present, first-dir-wins, sorted. Pure over the given dirs.
pub fn available_languages_in(dirs: &[PathBuf]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for dir in dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dic") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            // The personal word list is not a language.
            if stem == "personal" {
                continue;
            }
            if !path.with_extension("aff").is_file() {
                continue;
            }
            if !seen.iter().any(|s| s == stem) {
                seen.push(stem.to_string());
            }
        }
    }
    seen.sort();
    seen
}

/// The `.aff`/`.dic` pair for `code`, searched across `dict_dirs()`.
fn find_dict_files(code: &str) -> Option<(PathBuf, PathBuf)> {
    for dir in dict_dirs() {
        let dic = dir.join(format!("{code}.dic"));
        let aff = dir.join(format!("{code}.aff"));
        if dic.is_file() && aff.is_file() {
            return Some((aff, dic));
        }
    }
    None
}

/// Decode a dictionary file's bytes: UTF-8 when valid, else Latin-1 (many
/// distro-shipped dictionaries still declare `SET ISO8859-1`). Latin-1 maps
/// byte→codepoint 1:1, so this can't fail. Pure.
pub fn decode_dict_bytes(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    }
}

/// The default language when the setting is unset: prefer an English variant
/// (the language most prose in a code project is written in), else the first
/// available. Pure.
pub fn default_language(available: &[String]) -> Option<String> {
    available
        .iter()
        .find(|l| l.starts_with("en"))
        .or_else(|| available.first())
        .cloned()
}

// ── Dictionary cache + personal words ────────────────────────────────────────

fn dict_cache() -> &'static Mutex<HashMap<String, Arc<Dictionary>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Dictionary>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn personal_dict_path() -> PathBuf {
    crate::storage::state_dir()
        .join("dictionaries")
        .join("personal.dic")
}

fn personal_words() -> Vec<String> {
    match std::fs::read_to_string(personal_dict_path()) {
        Ok(s) => s
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Append a word to the personal dictionary and drop the cache so the next
/// check picks it up. The word is validated: it feeds `Dictionary::add`, whose
/// input grammar treats `/` as a flag separator, and a "word" with whitespace
/// or slashes in it is not something a spell checker flagged.
pub fn add_personal_word(word: &str) -> Result<(), String> {
    let w = word.trim();
    if w.is_empty() || w.chars().count() > 64 {
        return Err("invalid word".into());
    }
    if !w
        .chars()
        .all(|c| c.is_alphabetic() || c == '\'' || c == '\u{2019}' || c == '-')
    {
        return Err("invalid word".into());
    }
    let path = personal_dict_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    // Skip an exact duplicate rather than appending it forever.
    if personal_words().iter().any(|p| p == w) {
        return Ok(());
    }
    use std::io::Write as _;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open personal dictionary: {e}"))?;
    writeln!(f, "{w}").map_err(|e| format!("write personal dictionary: {e}"))?;
    dict_cache().lock().unwrap().clear();
    Ok(())
}

/// Load (or fetch cached) the dictionary for `code`, with the personal word
/// list folded in. Errors are strings for the command layer; `no_dictionary` is
/// the token the frontend recognises as "nothing installed".
fn load_dict(code: &str) -> Result<Arc<Dictionary>, String> {
    if let Some(d) = dict_cache().lock().unwrap().get(code) {
        return Ok(d.clone());
    }
    let (aff_path, dic_path) = find_dict_files(code).ok_or("no_dictionary")?;
    let aff = decode_dict_bytes(std::fs::read(&aff_path).map_err(|e| format!("read aff: {e}"))?);
    let dic = decode_dict_bytes(std::fs::read(&dic_path).map_err(|e| format!("read dic: {e}"))?);
    let mut dict = Dictionary::new(&aff, &dic).map_err(|e| format!("parse dictionary: {e}"))?;
    for w in personal_words() {
        // A personal word that fails the flag parser is skipped, never fatal.
        let _ = dict.add(&w);
    }
    let arc = Arc::new(dict);
    dict_cache()
        .lock()
        .unwrap()
        .insert(code.to_string(), arc.clone());
    Ok(arc)
}

/// The whole check: resolve the language (empty → default), load the
/// dictionary, mask, tokenize, look up. `doc` is the editor's highlight
/// language (`"tex"`/`"latex"`/`"markdown"`/anything else) and only selects the
/// masking.
pub fn check(text: &str, language: &str, doc: &str) -> Result<Vec<SpellIssue>, String> {
    let code = if language.is_empty() {
        default_language(&available_languages_in(&dict_dirs())).ok_or("no_dictionary")?
    } else {
        language.to_string()
    };
    let dict = load_dict(&code)?;
    Ok(check_text(&dict, text, doc))
}

// ── The pure check ───────────────────────────────────────────────────────────

/// Check `text` against `dict` after masking for `doc`. Pure given the
/// dictionary; exported for tests.
pub fn check_text(dict: &Dictionary, text: &str, doc: &str) -> Vec<SpellIssue> {
    let capped = cap_bytes(text, MAX_SPELL_BYTES);
    let masked = mask_document(capped, doc);
    let mut out = Vec::new();
    let mut suggestions: Vec<String> = Vec::new();
    for (line, word) in spell_tokens(&masked) {
        if dict.check(&word) {
            continue;
        }
        suggestions.clear();
        dict.suggest(&word, &mut suggestions);
        out.push(SpellIssue {
            line,
            bad: word,
            suggestion: suggestions.first().cloned().unwrap_or_default(),
        });
        if out.len() >= MAX_SPELL_ISSUES {
            break;
        }
    }
    out
}

/// Truncate to at most `max` bytes on a char boundary. Pure.
fn cap_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── Masking ──────────────────────────────────────────────────────────────────

/// Overwrite everything that is not prose with spaces — never removing a
/// character and never touching a newline, so line numbers and every surviving
/// token's position are identical to the input. Pure; exported for tests.
pub fn mask_document(text: &str, doc: &str) -> String {
    let mut chars: Vec<char> = text.chars().collect();
    match doc {
        "tex" | "latex" => mask_latex(&mut chars),
        "markdown" => mask_markdown(&mut chars),
        _ => {}
    }
    mask_urls_and_emails(&mut chars);
    chars.into_iter().collect()
}

/// Blank `chars[from..to]` (clamped), keeping newlines so lines never merge.
fn blank(chars: &mut [char], from: usize, to: usize) {
    let to = to.min(chars.len());
    for c in chars.iter_mut().take(to).skip(from) {
        if *c != '\n' {
            *c = ' ';
        }
    }
}

/// LaTeX commands whose FIRST brace group is a key/path/name, not prose (the
/// count after each name is how many groups to mask). Prose arguments —
/// `\textbf{...}`, `\caption{...}`, `\href{url}{text}`'s second group — are
/// deliberately left alone: they are exactly what should be checked.
fn latex_arg_mask_count(name: &str) -> usize {
    match name {
        // Referencing / citing: keys.
        "label" | "ref" | "eqref" | "pageref" | "autoref" | "cref" | "Cref" | "vref"
        | "nameref" | "cite" | "citep" | "citet" | "citeauthor" | "citeyear" | "parencite"
        | "textcite" | "footcite" | "autocite" | "Autocite" | "smartcite" | "supercite" => 1,
        // Files / packages / classes: paths and names.
        "input" | "include" | "includeonly" | "includegraphics" | "usepackage"
        | "documentclass" | "usetikzlibrary" | "graphicspath" | "bibliography"
        | "bibliographystyle" | "addbibresource" | "pagestyle" | "thispagestyle"
        | "bibliographystyleoverride" => 1,
        // URLs (for `\href` only the address; the link text stays prose).
        "url" | "path" | "href" => 1,
        // Definitions: the defined name.
        "newcommand" | "renewcommand" | "providecommand" | "newenvironment"
        | "renewenvironment" | "DeclareMathOperator" | "newtheorem" | "setlength"
        | "definecolor" | "textcolor" | "color" | "colorlet" => 1,
        _ => 0,
    }
}

/// Environments whose whole body is not prose (code, math, drawings).
fn latex_masked_env(name: &str) -> bool {
    matches!(
        name,
        "verbatim"
            | "verbatim*"
            | "Verbatim"
            | "lstlisting"
            | "minted"
            | "tikzpicture"
            | "equation"
            | "equation*"
            | "align"
            | "align*"
            | "alignat"
            | "alignat*"
            | "gather"
            | "gather*"
            | "multline"
            | "multline*"
            | "eqnarray"
            | "eqnarray*"
            | "math"
            | "displaymath"
            | "split"
            | "cases"
    )
}

/// Read the `{...}` group starting at `i` (which must be `{`), returning the
/// index one past its matching `}` (or the end). Nesting-aware.
fn brace_group_end(chars: &[char], i: usize) -> usize {
    let mut depth = 0usize;
    let mut j = i;
    while j < chars.len() {
        match chars[j] {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return j + 1;
                }
            }
            _ => {}
        }
        j += 1;
    }
    j
}

fn mask_latex(chars: &mut [char]) {
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let next = chars.get(i + 1).copied();
            match next {
                // `\\` line break, `\%` `\$` … escaped punctuation: mask both.
                Some(n) if !n.is_alphabetic() && n != '[' && n != '(' => {
                    blank(chars, i, i + 2);
                    i += 2;
                }
                // Display / inline math `\[...\]`, `\(...\)`.
                Some('[') | Some('(') => {
                    let close = if next == Some('[') { ']' } else { ')' };
                    let mut j = i + 2;
                    while j + 1 < chars.len() && !(chars[j] == '\\' && chars[j + 1] == close) {
                        j += 1;
                    }
                    let end = (j + 2).min(chars.len());
                    blank(chars, i, end);
                    i = end;
                }
                // `\command` — mask the name; maybe its argument groups too.
                Some(n) if n.is_alphabetic() => {
                    let mut j = i + 1;
                    while j < chars.len() && chars[j].is_alphabetic() {
                        j += 1;
                    }
                    if j < chars.len() && chars[j] == '*' {
                        j += 1;
                    }
                    let name: String = chars[i + 1..j].iter().collect();
                    blank(chars, i, j);
                    i = j;
                    if name == "begin" || name == "end" {
                        // Mask the `{env}` name group; a masked env's whole body.
                        if i < chars.len() && chars[i] == '{' {
                            let gend = brace_group_end(chars, i);
                            let env: String = chars[i + 1..gend.saturating_sub(1)].iter().collect();
                            blank(chars, i, gend);
                            i = gend;
                            if name == "begin" && latex_masked_env(&env) {
                                let closing: Vec<char> =
                                    format!("\\end{{{env}}}").chars().collect();
                                let mut k = i;
                                while k < chars.len() {
                                    if chars[k..].starts_with(&closing[..]) {
                                        k += closing.len();
                                        break;
                                    }
                                    k += 1;
                                }
                                blank(chars, i, k);
                                i = k;
                            }
                        }
                    } else {
                        // Optional `[...]` then the masked brace groups.
                        let mut remaining = latex_arg_mask_count(&name);
                        if remaining > 0 {
                            if i < chars.len() && chars[i] == '[' {
                                let mut k = i;
                                while k < chars.len() && chars[k] != ']' && chars[k] != '\n' {
                                    k += 1;
                                }
                                let end = (k + 1).min(chars.len());
                                blank(chars, i, end);
                                i = end;
                            }
                            while remaining > 0 && i < chars.len() && chars[i] == '{' {
                                let gend = brace_group_end(chars, i);
                                blank(chars, i, gend);
                                i = gend;
                                remaining -= 1;
                            }
                        }
                    }
                }
                _ => i += 1,
            }
        } else if c == '%' {
            // Comment to end of line (`\%` was consumed above).
            let mut j = i;
            while j < chars.len() && chars[j] != '\n' {
                j += 1;
            }
            blank(chars, i, j);
            i = j;
        } else if c == '$' {
            // `$...$` / `$$...$$` math. Opening delimiter length 1 or 2.
            let dd = chars.get(i + 1) == Some(&'$');
            let start = i;
            let mut j = i + if dd { 2 } else { 1 };
            while j < chars.len() {
                if chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                if chars[j] == '$' {
                    j += if dd && chars.get(j + 1) == Some(&'$') { 2 } else { 1 };
                    break;
                }
                j += 1;
            }
            let end = j.min(chars.len());
            blank(chars, start, end);
            i = end;
        } else {
            i += 1;
        }
    }
}

fn mask_markdown(chars: &mut [char]) {
    let mut i = 0usize;
    let mut at_line_start = true;
    while i < chars.len() {
        let c = chars[i];
        if at_line_start && is_fence_at(chars, i) {
            // Mask the whole fenced block, closing fence line included.
            let fence = chars[i];
            let mut j = line_end(chars, i);
            loop {
                if j >= chars.len() {
                    break;
                }
                let ls = j + 1; // char after the '\n'
                if ls >= chars.len() {
                    j = chars.len();
                    break;
                }
                if is_fence_of(chars, ls, fence) {
                    j = line_end(chars, ls);
                    break;
                }
                j = line_end(chars, ls);
            }
            blank(chars, i, j);
            i = j;
            at_line_start = false;
            continue;
        }
        if at_line_start && c == '[' {
            // Reference definition `[id]: target` — mask the whole line.
            let le = line_end(chars, i);
            let line: String = chars[i..le].iter().collect();
            if let Some(close) = line.find(']') {
                if line[close + 1..].starts_with(':') {
                    blank(chars, i, le);
                    i = le;
                    at_line_start = false;
                    continue;
                }
            }
        }
        match c {
            '\n' => {
                at_line_start = true;
                i += 1;
                continue;
            }
            '`' => {
                // Inline code span: one or two backticks to the matching close.
                let double = chars.get(i + 1) == Some(&'`');
                let ticks = if double { 2 } else { 1 };
                let mut j = i + ticks;
                while j < chars.len() && chars[j] != '\n' {
                    if chars[j] == '`' && (!double || chars.get(j + 1) == Some(&'`')) {
                        j += ticks;
                        break;
                    }
                    j += 1;
                }
                let end = j.min(chars.len());
                blank(chars, i, end);
                i = end;
            }
            ']' if chars.get(i + 1) == Some(&'(') => {
                // Link/image target `](...)` — mask inside the parens.
                let mut j = i + 2;
                while j < chars.len() && chars[j] != ')' && chars[j] != '\n' {
                    j += 1;
                }
                blank(chars, i + 2, j);
                i = j;
            }
            '<' => {
                // HTML tag or autolink: mask to `>` on the same line.
                let mut j = i + 1;
                while j < chars.len() && chars[j] != '>' && chars[j] != '\n' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '>' {
                    blank(chars, i, j + 1);
                    i = j + 1;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
        at_line_start = false;
    }
}

fn line_end(chars: &[char], from: usize) -> usize {
    let mut j = from;
    while j < chars.len() && chars[j] != '\n' {
        j += 1;
    }
    j
}

/// Is position `i` (a line start) an opening code fence (``` or ~~~)?
fn is_fence_at(chars: &[char], i: usize) -> bool {
    is_fence_of(chars, i, '`') || is_fence_of(chars, i, '~')
}

fn is_fence_of(chars: &[char], i: usize, fence: char) -> bool {
    chars.get(i) == Some(&fence)
        && chars.get(i + 1) == Some(&fence)
        && chars.get(i + 2) == Some(&fence)
}

/// Mask URLs (`scheme://…`, `www.…`) and email addresses in any document type.
fn mask_urls_and_emails(chars: &mut [char]) {
    let n = chars.len();
    let mut i = 0usize;
    while i < n {
        // scheme:// — walk back over the scheme, forward to whitespace.
        if chars[i] == ':' && chars.get(i + 1) == Some(&'/') && chars.get(i + 2) == Some(&'/') {
            let mut start = i;
            while start > 0 && (chars[start - 1].is_ascii_alphanumeric() || chars[start - 1] == '+' || chars[start - 1] == '-' || chars[start - 1] == '.') {
                start -= 1;
            }
            let mut j = i + 3;
            while j < n && !chars[j].is_whitespace() && chars[j] != '"' && chars[j] != '\'' && chars[j] != '>' && chars[j] != ')' {
                j += 1;
            }
            blank(chars, start, j);
            i = j;
            continue;
        }
        // www. at a word start.
        if chars[i] == 'w'
            && chars.get(i + 1) == Some(&'w')
            && chars.get(i + 2) == Some(&'w')
            && chars.get(i + 3) == Some(&'.')
            && (i == 0 || !chars[i - 1].is_alphanumeric())
        {
            let mut j = i + 4;
            while j < n && !chars[j].is_whitespace() {
                j += 1;
            }
            blank(chars, i, j);
            i = j;
            continue;
        }
        // Email: '@' with word chars on both sides.
        if chars[i] == '@'
            && i > 0
            && is_email_char(chars[i - 1])
            && chars.get(i + 1).is_some_and(|&c| is_email_char(c))
        {
            let mut start = i;
            while start > 0 && is_email_char(chars[start - 1]) {
                start -= 1;
            }
            let mut j = i + 1;
            while j < n && (is_email_char(chars[j]) || chars[j] == '.') {
                j += 1;
            }
            blank(chars, start, j);
            i = j;
            continue;
        }
        i += 1;
    }
}

fn is_email_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

// ── Tokenizing ───────────────────────────────────────────────────────────────

/// Words worth checking, with their 1-based line: maximal runs of alphabetic
/// characters (internal apostrophes allowed), skipping anything that reads as
/// an identifier rather than prose — a token glued to digits or underscores
/// (`word2vec`, `snake_case` halves), interior capitals (`CamelCase`, `TeX`,
/// acronyms), and single letters. Pure; exported for tests.
pub fn spell_tokens(masked: &str) -> Vec<(u32, String)> {
    let chars: Vec<char> = masked.chars().collect();
    let mut out = Vec::new();
    let mut line: u32 = 1;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '\n' {
            line += 1;
            i += 1;
            continue;
        }
        if !c.is_alphabetic() {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        while j < chars.len() {
            let cj = chars[j];
            // A letter continues the word; so does an apostrophe with a letter
            // right after it ("don't"), never a trailing one ("dogs'").
            let continues = cj.is_alphabetic()
                || ((cj == '\'' || cj == '\u{2019}')
                    && j > start
                    && chars.get(j + 1).is_some_and(|&n| n.is_alphabetic()));
            if !continues {
                break;
            }
            j += 1;
        }
        i = j;
        let len = j - start;
        if !(2..=MAX_TOKEN_CHARS).contains(&len) {
            continue;
        }
        // Glued to an identifier: `word2vec`, `foo_bar`, `x86`.
        let before = start.checked_sub(1).map(|k| chars[k]);
        let after = chars.get(j).copied();
        let glued = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        if glued(before) || glued(after) {
            continue;
        }
        // Interior capitals: CamelCase interiors, acronyms, `TeX`.
        if chars[start + 1..j].iter().any(|c| c.is_uppercase()) {
            continue;
        }
        out.push((line, chars[start..j].iter().collect()));
    }
    out
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny in-memory dictionary: enough Hunspell to exercise the check.
    fn tiny_dict() -> Dictionary {
        let aff = "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz\n";
        let dic = "6\nhello\nworld\nthe\nquick\nbrown\nfox\n";
        Dictionary::new(aff, dic).expect("tiny dictionary parses")
    }

    #[test]
    fn flags_a_misspelling_with_its_line() {
        let d = tiny_dict();
        let issues = check_text(&d, "hello world\nthe quikc brown fox", "");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, 2);
        assert_eq!(issues[0].bad, "quikc");
    }

    #[test]
    fn suggests_a_correction_when_the_dictionary_has_one_close_by() {
        let d = tiny_dict();
        let issues = check_text(&d, "teh fox", "");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].bad, "teh");
        // "the" is one transposition away; the suggester should find it.
        assert_eq!(issues[0].suggestion, "the");
    }

    #[test]
    fn accepts_sentence_case_of_a_lowercase_dictionary_word() {
        let d = tiny_dict();
        let issues = check_text(&d, "Hello world", "");
        assert!(issues.is_empty(), "got {issues:?}");
    }

    #[test]
    fn skips_identifiers_camelcase_and_single_letters() {
        let d = tiny_dict();
        // None of these is prose; none may be flagged.
        let text = "word2vec snake_case CamelCase NASA TeX a x86ish";
        let issues = check_text(&d, text, "");
        assert!(issues.is_empty(), "got {issues:?}");
    }

    #[test]
    fn keeps_apostrophe_words_together() {
        let toks = spell_tokens("don't stop");
        assert_eq!(
            toks,
            vec![(1, "don't".to_string()), (1, "stop".to_string())]
        );
    }

    #[test]
    fn masking_never_changes_length_or_lines() {
        let tex = "\\section{Intro} % note\nText $x^2$ here\\\\\n\\label{sec:a} done\n";
        let masked = mask_document(tex, "tex");
        assert_eq!(masked.chars().count(), tex.chars().count());
        assert_eq!(
            masked.matches('\n').count(),
            tex.matches('\n').count()
        );
    }

    #[test]
    fn latex_masks_commands_math_comments_and_keys_but_keeps_prose() {
        let tex = "\\textbf{grate prose} $E=mc^2$ % commentz\n\\ref{eq:speling} and \\cite{knuth1984} more";
        let masked = mask_document(tex, "tex");
        // Prose argument survives; everything key-like is gone.
        assert!(masked.contains("grate prose"));
        assert!(masked.contains("and"));
        assert!(masked.contains("more"));
        assert!(!masked.contains("textbf"));
        assert!(!masked.contains("mc"));
        assert!(!masked.contains("commentz"));
        assert!(!masked.contains("speling"));
        assert!(!masked.contains("knuth"));
    }

    #[test]
    fn latex_masks_a_math_environment_body_and_keeps_text_after_it() {
        let tex = "before\n\\begin{align}\nx &= wrng\n\\end{align}\nafter";
        let masked = mask_document(tex, "tex");
        assert!(masked.contains("before"));
        assert!(masked.contains("after"));
        assert!(!masked.contains("wrng"));
        assert!(!masked.contains("align"));
    }

    #[test]
    fn latex_keeps_href_link_text_and_masks_its_address() {
        let tex = "\\href{https://example.test/pth}{reed me}";
        let masked = mask_document(tex, "tex");
        assert!(masked.contains("reed me"));
        assert!(!masked.contains("example"));
        assert!(!masked.contains("pth"));
    }

    #[test]
    fn markdown_masks_fences_inline_code_and_link_targets() {
        let md = "Some prose\n```rust\nlet wrng = 1;\n```\nmore `inlinecode` text [label](https://a.test/pg) end";
        let masked = mask_document(md, "markdown");
        assert!(masked.contains("Some prose"));
        assert!(masked.contains("more"));
        assert!(masked.contains("label"));
        assert!(masked.contains("end"));
        assert!(!masked.contains("wrng"));
        assert!(!masked.contains("inlinecode"));
        assert!(!masked.contains("a.test"));
    }

    #[test]
    fn urls_and_emails_are_masked_in_plain_text() {
        let text = "see https://sitez.test/pagez and mail nam.persn@example.test now www.sitez.test too";
        let masked = mask_document(text, "");
        assert!(masked.contains("see"));
        assert!(masked.contains("and mail"));
        assert!(masked.contains("now"));
        assert!(masked.contains("too"));
        assert!(!masked.contains("sitez"));
        assert!(!masked.contains("persn"));
    }

    #[test]
    fn discovery_pairs_aff_and_dic_and_skips_orphans_and_personal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("en_US.aff"), "SET UTF-8\n").unwrap();
        std::fs::write(p.join("en_US.dic"), "1\nhello\n").unwrap();
        std::fs::write(p.join("de_DE.dic"), "1\nhallo\n").unwrap(); // orphan
        std::fs::write(p.join("personal.dic"), "myword\n").unwrap();
        std::fs::write(p.join("personal.aff"), "SET UTF-8\n").unwrap();
        let langs = available_languages_in(&[p.to_path_buf()]);
        assert_eq!(langs, vec!["en_US".to_string()]);
    }

    #[test]
    fn default_language_prefers_english() {
        let langs = vec!["de_DE".to_string(), "en_GB".to_string(), "fr_FR".to_string()];
        assert_eq!(default_language(&langs), Some("en_GB".to_string()));
        let langs = vec!["de_DE".to_string()];
        assert_eq!(default_language(&langs), Some("de_DE".to_string()));
        assert_eq!(default_language(&[]), None);
    }

    #[test]
    fn latin1_bytes_decode_without_loss() {
        // "straße" in Latin-1: ß is 0xDF.
        let bytes = vec![b's', b't', b'r', b'a', 0xDF, b'e'];
        assert_eq!(decode_dict_bytes(bytes), "stra\u{00df}e");
        assert_eq!(decode_dict_bytes("utf-8 ✓".as_bytes().to_vec()), "utf-8 ✓");
    }

    #[test]
    fn issue_cap_bounds_a_pathological_document() {
        let d = tiny_dict();
        let text = "zzqx ".repeat(1000);
        let issues = check_text(&d, &text, "");
        assert_eq!(issues.len(), MAX_SPELL_ISSUES);
    }
}
