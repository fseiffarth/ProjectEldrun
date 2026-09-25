//! **The mail client's address book** — cards, mailing lists, the addresses
//! collected from sent mail, and vCard in and out.
//!
//! Pure: no I/O, no clock, no `AppHandle`. The caller (`commands::mail`) owns
//! the sealed `contacts.json`, hands the time in, and mints ids; everything a
//! user could complain about ("why did it collect that?", "why did the import
//! make two of her?") is answerable by a unit test here.
//!
//! # Three rules
//!
//! 1. **An address in the book is a bare addr-spec** that passed
//!    `mail_engine::validate_recipient` — the same check `RCPT TO` gets. The
//!    autocomplete splices book addresses into a draft verbatim, so a card must
//!    never be how a display-name form or a line break reaches the envelope. On
//!    a save from the editor an invalid address is an error (the user typed
//!    it); on an import it is dropped (a stranger's file wrote it).
//! 2. **One address, one card, across the two books.** Collecting skips any
//!    address a card already holds, and saving a Personal card that claims an
//!    address from a *Collected* one absorbs that collected card (keeping its
//!    popularity) — so promoting someone never leaves a twin behind.
//! 3. **Imported text is untrusted.** A `.vcf` is as likely to have arrived as
//!    a mail attachment as to have come from the user's old phone, so every
//!    field goes through [`clean_line`] / [`clean_block`] (controls and bidi
//!    overrides out, length capped) and the file and card counts are bounded.

use std::collections::HashSet;

use crate::schema::mail::{
    MailContact, MailContactBook, MailContactList, MailContactPhone, MailContacts,
    MailContactsImportReport,
};
use crate::services::mail_engine::validate_recipient;
use crate::services::web_safety::is_format_char;

/// Most cards one book holds. Collecting stops quietly at the cap (a send never
/// fails over the address book); an import reports the rest as skipped.
pub const MAX_CONTACTS: usize = 20_000;
/// Most lists, and most members per list.
pub const MAX_LISTS: usize = 1_000;
pub const MAX_LIST_MEMBERS: usize = 2_000;
/// Largest `.vcf` an import will read.
pub const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LINE: usize = 512;
const MAX_BLOCK: usize = 16 * 1024;
const MAX_EMAILS: usize = 50;
const MAX_PHONES: usize = 50;

// ── Text hygiene ────────────────────────────────────────────────────────────

fn cap(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// One-line field: every control (CR/LF included) becomes a space, bidi/format
/// controls go, runs of whitespace collapse.
pub fn clean_line(s: &str) -> String {
    let mapped: String = s
        .chars()
        .filter(|c| !is_format_char(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cap(mapped.split_whitespace().collect::<Vec<_>>().join(" "), MAX_LINE)
}

/// Multi-line field (notes, postal address): newlines survive, other controls
/// and bidi/format controls do not.
pub fn clean_block(s: &str) -> String {
    let unified = s.replace("\r\n", "\n").replace('\r', "\n");
    let kept: String = unified
        .chars()
        .filter(|c| !is_format_char(*c) && (*c == '\n' || *c == '\t' || !c.is_control()))
        .collect();
    let lines: Vec<&str> = kept.lines().map(str::trim_end).collect();
    cap(lines.join("\n").trim().to_string(), MAX_BLOCK)
}

/// `Some(addr)` when `raw` is one valid address (a `mailto:` prefix tolerated).
pub fn clean_email(raw: &str) -> Option<String> {
    let t = raw.trim();
    let t = t
        .strip_prefix("mailto:")
        .or_else(|| t.strip_prefix("MAILTO:"))
        .unwrap_or(t);
    validate_recipient(t).ok()
}

/// `YYYY-MM-DD` or `--MM-DD` from any of vCard's spellings (`19850412`,
/// `1985-04-12`, `--0412`, a trailing time), or `None`.
pub fn clean_birthday(raw: &str) -> Option<String> {
    let t = raw.trim();
    let t = t.split('T').next().unwrap_or("");
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let valid = |m: &str, d: &str| {
        let (m, d) = (m.parse::<u32>().unwrap_or(0), d.parse::<u32>().unwrap_or(0));
        (1..=12).contains(&m) && (1..=31).contains(&d)
    };
    if let Some(rest) = t.strip_prefix("--") {
        let md: String = rest.chars().filter(|c| *c != '-').collect();
        if md.len() == 4 && digits(&md) && valid(&md[..2], &md[2..]) {
            return Some(format!("--{}-{}", &md[..2], &md[2..]));
        }
        return None;
    }
    let ymd: String = t.chars().filter(|c| *c != '-').collect();
    if ymd.len() == 8 && digits(&ymd) && valid(&ymd[4..6], &ymd[6..]) {
        return Some(format!("{}-{}-{}", &ymd[..4], &ymd[4..6], &ymd[6..]));
    }
    None
}

fn lower_set(emails: &[String]) -> HashSet<String> {
    emails.iter().map(|e| e.to_lowercase()).collect()
}

/// The card holding `address` (case-insensitive), if any.
pub fn find_by_email<'a>(book: &'a MailContacts, address: &str) -> Option<&'a MailContact> {
    let needle = address.to_lowercase();
    book.contacts
        .iter()
        .find(|c| c.emails.iter().any(|e| e.to_lowercase() == needle))
}

// ── Cards ───────────────────────────────────────────────────────────────────

/// Normalize a card the user saved. `strict`: an invalid address or birthday is
/// an error (the editor); otherwise it is dropped (an import).
pub fn normalize_contact(mut c: MailContact, strict: bool) -> Result<MailContact, String> {
    c.display_name = clean_line(&c.display_name);
    c.first_name = clean_line(&c.first_name);
    c.last_name = clean_line(&c.last_name);
    c.nickname = clean_line(&c.nickname);
    c.organization = clean_line(&c.organization);
    c.job_title = clean_line(&c.job_title);
    c.website = clean_line(&c.website);
    c.address = clean_block(&c.address);
    c.notes = clean_block(&c.notes);

    let mut seen = HashSet::new();
    let mut emails = Vec::new();
    for raw in &c.emails {
        if raw.trim().is_empty() {
            continue;
        }
        match clean_email(raw) {
            Some(e) => {
                if seen.insert(e.to_lowercase()) && emails.len() < MAX_EMAILS {
                    emails.push(e);
                }
            }
            None if strict => {
                return Err(format!("'{}' is not a single e-mail address", clean_line(raw)))
            }
            None => {}
        }
    }
    c.emails = emails;

    c.phones = c
        .phones
        .into_iter()
        .map(|p| MailContactPhone {
            kind: clean_line(&p.kind).to_lowercase(),
            number: clean_line(&p.number),
        })
        .filter(|p| !p.number.is_empty())
        .take(MAX_PHONES)
        .collect();

    let bday = c.birthday.trim().to_string();
    c.birthday = if bday.is_empty() {
        String::new()
    } else {
        match clean_birthday(&bday) {
            Some(b) => b,
            None if strict => return Err(format!("'{bday}' is not a date (YYYY-MM-DD)")),
            None => String::new(),
        }
    };

    if c.emails.is_empty()
        && c.display_name.is_empty()
        && c.first_name.is_empty()
        && c.last_name.is_empty()
        && c.nickname.is_empty()
        && c.organization.is_empty()
    {
        return Err("a contact needs a name or an e-mail address".into());
    }
    Ok(c)
}

/// Insert or replace one card. Returns the stored card.
///
/// The counters (`popularity`, `last_used`, `created`) are the store's, not the
/// editor's: a send can bump them while the card is open, and the editor's copy
/// must not roll that back. A Personal card claiming an address held by a
/// Collected card absorbs it (rule 2).
pub fn upsert_contact(
    book: &mut MailContacts,
    contact: MailContact,
    now: i64,
    new_id: &mut dyn FnMut() -> String,
) -> Result<MailContact, String> {
    let mut c = normalize_contact(contact, true)?;
    let existing = if c.id.trim().is_empty() {
        None
    } else {
        book.contacts.iter().position(|x| x.id == c.id)
    };
    if existing.is_none() && book.contacts.len() >= MAX_CONTACTS {
        return Err(format!("the address book is full ({MAX_CONTACTS} contacts)"));
    }
    if c.id.trim().is_empty() {
        c.id = new_id();
    }
    if let Some(i) = existing {
        let old = &book.contacts[i];
        c.popularity = old.popularity;
        c.last_used = old.last_used;
        c.created = old.created;
    } else {
        c.popularity = 0;
        c.last_used = 0;
        c.created = now;
    }
    c.updated = now;

    if c.book == MailContactBook::Personal {
        let mine = lower_set(&c.emails);
        let id = c.id.clone();
        let mut absorbed_pop = 0u32;
        let mut absorbed_used = 0i64;
        book.contacts.retain(|x| {
            let twin = x.id != id
                && x.book == MailContactBook::Collected
                && x.emails.iter().any(|e| mine.contains(&e.to_lowercase()));
            if twin {
                absorbed_pop = absorbed_pop.saturating_add(x.popularity);
                absorbed_used = absorbed_used.max(x.last_used);
            }
            !twin
        });
        c.popularity = c.popularity.saturating_add(absorbed_pop);
        c.last_used = c.last_used.max(absorbed_used);
    }

    match book.contacts.iter().position(|x| x.id == c.id) {
        Some(i) => book.contacts[i] = c.clone(),
        None => book.contacts.push(c.clone()),
    }
    Ok(c)
}

/// Remove cards by id; returns how many went.
pub fn delete_contacts(book: &mut MailContacts, ids: &[String]) -> usize {
    let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let before = book.contacts.len();
    book.contacts.retain(|c| !ids.contains(c.id.as_str()));
    before - book.contacts.len()
}

// ── Lists ───────────────────────────────────────────────────────────────────

pub fn upsert_list(
    book: &mut MailContacts,
    list: MailContactList,
    new_id: &mut dyn FnMut() -> String,
) -> Result<MailContactList, String> {
    let mut l = list;
    l.name = clean_line(&l.name);
    l.nickname = clean_line(&l.nickname);
    l.description = clean_block(&l.description);
    if l.name.is_empty() {
        return Err("a list needs a name".into());
    }
    let mut seen = HashSet::new();
    let mut members = Vec::new();
    for raw in &l.members {
        if raw.trim().is_empty() {
            continue;
        }
        let e = clean_email(raw)
            .ok_or_else(|| format!("'{}' is not a single e-mail address", clean_line(raw)))?;
        if seen.insert(e.to_lowercase()) {
            members.push(e);
        }
    }
    if members.len() > MAX_LIST_MEMBERS {
        return Err(format!("a list holds at most {MAX_LIST_MEMBERS} addresses"));
    }
    l.members = members;
    let existing = (!l.id.trim().is_empty())
        .then(|| book.lists.iter().position(|x| x.id == l.id))
        .flatten();
    match existing {
        Some(i) => book.lists[i] = l.clone(),
        None => {
            if book.lists.len() >= MAX_LISTS {
                return Err(format!("at most {MAX_LISTS} lists"));
            }
            if l.id.trim().is_empty() {
                l.id = new_id();
            }
            book.lists.push(l.clone());
        }
    }
    Ok(l)
}

pub fn delete_list(book: &mut MailContacts, id: &str) -> bool {
    let before = book.lists.len();
    book.lists.retain(|l| l.id != id);
    before != book.lists.len()
}

// ── Collecting from sent mail ───────────────────────────────────────────────

/// Record one sent message's recipients. Every address a card holds bumps that
/// card's popularity (once per send, however many of its addresses were on
/// it); an address no card holds becomes a Collected card — unless collecting
/// is off or the book is full. Returns how many cards were added.
///
/// Called only after the SMTP server accepted the message: an address typed
/// into a draft that never went out is not someone the user writes to.
pub fn collect(
    book: &mut MailContacts,
    sent_to: &[String],
    now: i64,
    new_id: &mut dyn FnMut() -> String,
) -> usize {
    let mut addresses: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for raw in sent_to {
        if let Some(e) = clean_email(raw) {
            if seen.insert(e.to_lowercase()) {
                addresses.push(e);
            }
        }
    }
    let mut bumped: HashSet<String> = HashSet::new();
    let mut added = 0usize;
    for addr in addresses {
        let needle = addr.to_lowercase();
        if let Some(card) = book
            .contacts
            .iter_mut()
            .find(|c| c.emails.iter().any(|e| e.to_lowercase() == needle))
        {
            if bumped.insert(card.id.clone()) {
                card.popularity = card.popularity.saturating_add(1);
                card.last_used = now;
            }
            continue;
        }
        if book.collect_disabled || book.contacts.len() >= MAX_CONTACTS {
            continue;
        }
        book.contacts.push(MailContact {
            id: new_id(),
            book: MailContactBook::Collected,
            emails: vec![addr],
            popularity: 1,
            last_used: now,
            created: now,
            updated: now,
            ..Default::default()
        });
        added += 1;
    }
    added
}

// ── vCard in ────────────────────────────────────────────────────────────────

/// Decode a file's bytes: UTF-8 (BOM tolerated), else Windows-1252 — what old
/// Outlook and phone exports without a `CHARSET` actually are.
pub fn decode_file(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

/// Split a vCard's text into logical lines: RFC 6350 folding (a line starting
/// with space or tab continues the previous one) and vCard 2.1's
/// quoted-printable soft breaks (a QP value line ending in `=`).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut qp_open = false;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if qp_open {
            if let Some(last) = out.last_mut() {
                last.pop(); // the soft-break '='
                last.push_str(line);
                qp_open = last.ends_with('=');
                continue;
            }
        }
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&line[1..]);
        } else {
            out.push(line.to_string());
        }
        let last = out.last().unwrap();
        qp_open = last.ends_with('=') && last.to_ascii_uppercase().contains("QUOTED-PRINTABLE");
    }
    out
}

/// Split at `sep` where it is not backslash-escaped.
fn split_unescaped(s: &str, sep: char) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            let last = parts.last_mut().unwrap();
            last.push('\\');
            last.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == sep {
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(c);
        }
    }
    if escaped {
        parts.last_mut().unwrap().push('\\');
    }
    parts
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

fn decode_qp(s: &str, charset: Option<&str>) -> String {
    let b = s.as_bytes();
    let mut bytes = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'=' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                bytes.push(v);
                i += 3;
                continue;
            }
        }
        bytes.push(b[i]);
        i += 1;
    }
    let enc = charset
        .and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    if enc == encoding_rs::UTF_8 {
        decode_file(&bytes)
    } else {
        enc.decode(&bytes).0.into_owned()
    }
}

struct Prop {
    name: String,
    types: Vec<String>,
    value: String,
}

/// Parse one content line into its name, its `TYPE`s (vCard 2.1's bare
/// parameters count as types) and its value, with QP already decoded but vCard
/// escapes left in (structured properties split before unescaping).
fn parse_prop(line: &str) -> Option<Prop> {
    // The value starts at the first ':' outside a quoted parameter value.
    let mut in_quote = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ':' if !in_quote => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim();
    // `item1.EMAIL` — Apple's grouping prefix.
    let name = name.rsplit('.').next().unwrap_or(name).to_ascii_uppercase();
    let mut types = Vec::new();
    let mut qp = false;
    let mut charset = None;
    for p in parts {
        let (k, v) = match p.split_once('=') {
            Some((k, v)) => (k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string()),
            None => ("TYPE".to_string(), p.trim().to_string()),
        };
        match k.as_str() {
            "TYPE" => types.extend(
                v.split(',')
                    .map(|t| t.trim().to_ascii_lowercase())
                    .filter(|t| !t.is_empty()),
            ),
            "ENCODING" if v.eq_ignore_ascii_case("QUOTED-PRINTABLE") => qp = true,
            "CHARSET" => charset = Some(v),
            _ => {}
        }
    }
    let value = if qp {
        decode_qp(value, charset.as_deref())
    } else {
        value.to_string()
    };
    Some(Prop { name, types, value })
}

fn phone_kind(types: &[String]) -> String {
    for (t, kind) in [
        ("cell", "mobile"),
        ("mobile", "mobile"),
        ("iphone", "mobile"),
        ("fax", "fax"),
        ("pager", "pager"),
        ("work", "work"),
        ("home", "home"),
    ] {
        if types.iter().any(|x| x == t) {
            return kind.to_string();
        }
    }
    String::new()
}

/// Every card in a `.vcf`, raw — not yet normalized, no ids. Tolerant: an
/// unknown property is ignored, a line that is not `name:value` is skipped,
/// and a card with no `END:VCARD` at end of file still counts.
pub fn parse_vcards(text: &str) -> Vec<MailContact> {
    let mut cards = Vec::new();
    let mut cur: Option<MailContact> = None;
    for line in unfold(text) {
        if line.trim().is_empty() {
            continue;
        }
        let Some(p) = parse_prop(&line) else { continue };
        match p.name.as_str() {
            "BEGIN" if p.value.trim().eq_ignore_ascii_case("VCARD") => {
                if let Some(c) = cur.take() {
                    cards.push(c);
                }
                cur = Some(MailContact::default());
            }
            "END" if p.value.trim().eq_ignore_ascii_case("VCARD") => {
                if let Some(c) = cur.take() {
                    cards.push(c);
                }
            }
            _ => {
                let Some(c) = cur.as_mut() else { continue };
                apply_prop(c, &p);
            }
        }
        if cards.len() >= MAX_CONTACTS {
            return cards;
        }
    }
    if let Some(c) = cur {
        cards.push(c);
    }
    cards
}

fn apply_prop(c: &mut MailContact, p: &Prop) {
    let first = |v: &str| unescape(split_unescaped(v, ';').first().map(String::as_str).unwrap_or(""));
    match p.name.as_str() {
        "FN" => c.display_name = unescape(&p.value),
        "N" => {
            let parts = split_unescaped(&p.value, ';');
            c.last_name = unescape(parts.first().map(String::as_str).unwrap_or(""));
            c.first_name = unescape(parts.get(1).map(String::as_str).unwrap_or(""));
        }
        "NICKNAME" if c.nickname.is_empty() => {
            c.nickname = unescape(split_unescaped(&p.value, ',').first().map(String::as_str).unwrap_or(""))
        }
        "EMAIL" => {
            let e = unescape(&p.value);
            // A `PREF` address is the primary one.
            if p.types.iter().any(|t| t == "pref") {
                c.emails.insert(0, e);
            } else {
                c.emails.push(e);
            }
        }
        "TEL" => {
            let v = unescape(&p.value);
            let number = v.strip_prefix("tel:").unwrap_or(&v).to_string();
            c.phones.push(MailContactPhone { kind: phone_kind(&p.types), number });
        }
        "ORG" if c.organization.is_empty() => {
            let parts: Vec<String> = split_unescaped(&p.value, ';')
                .iter()
                .map(|s| unescape(s).trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            c.organization = parts.join(", ");
        }
        "TITLE" if c.job_title.is_empty() => c.job_title = unescape(&p.value),
        "NOTE" => {
            let n = unescape(&p.value);
            if c.notes.is_empty() {
                c.notes = n;
            } else {
                c.notes = format!("{}\n{n}", c.notes);
            }
        }
        "BDAY" if c.birthday.is_empty() => c.birthday = first(&p.value),
        "URL" if c.website.is_empty() => c.website = unescape(&p.value),
        "ADR" if c.address.is_empty() => {
            // pobox; ext; street; locality; region; code; country
            let f: Vec<String> = split_unescaped(&p.value, ';').iter().map(|s| unescape(s)).collect();
            let get = |i: usize| f.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
            let city = [get(5), get(3)]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            c.address = [get(0), get(1), get(2), city, get(4), get(6)]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
        }
        _ => {}
    }
}

/// Fold imported cards into the book (rule 2): a card sharing an address with
/// one already there fills that card's empty fields and adds its missing
/// addresses and numbers; anything else is a new Personal card.
pub fn merge_import(
    book: &mut MailContacts,
    imported: Vec<MailContact>,
    now: i64,
    new_id: &mut dyn FnMut() -> String,
) -> MailContactsImportReport {
    let mut report = MailContactsImportReport::default();
    for raw in imported {
        let Ok(mut card) = normalize_contact(raw, false) else {
            report.skipped += 1;
            continue;
        };
        let mine = lower_set(&card.emails);
        let hit = if mine.is_empty() {
            // No address: match a card with the same name and no address, so
            // importing the same phone book twice does not double it.
            let key = display_key(&card);
            book.contacts
                .iter()
                .position(|x| x.emails.is_empty() && display_key(x) == key)
        } else {
            book.contacts
                .iter()
                .position(|x| x.emails.iter().any(|e| mine.contains(&e.to_lowercase())))
        };
        match hit {
            Some(i) => {
                merge_into(&mut book.contacts[i], card, now);
                report.merged += 1;
            }
            None if book.contacts.len() >= MAX_CONTACTS => report.skipped += 1,
            None => {
                card.id = new_id();
                card.book = MailContactBook::Personal;
                card.popularity = 0;
                card.last_used = 0;
                card.created = now;
                card.updated = now;
                card.extra.clear();
                book.contacts.push(card);
                report.added += 1;
            }
        }
    }
    report
}

fn display_key(c: &MailContact) -> String {
    let name = if c.display_name.is_empty() {
        format!("{} {}", c.first_name, c.last_name)
    } else {
        c.display_name.clone()
    };
    name.trim().to_lowercase()
}

fn merge_into(into: &mut MailContact, from: MailContact, now: i64) {
    fn fill(slot: &mut String, v: String) {
        if slot.is_empty() {
            *slot = v;
        }
    }
    fill(&mut into.display_name, from.display_name);
    fill(&mut into.first_name, from.first_name);
    fill(&mut into.last_name, from.last_name);
    fill(&mut into.nickname, from.nickname);
    fill(&mut into.organization, from.organization);
    fill(&mut into.job_title, from.job_title);
    fill(&mut into.address, from.address);
    fill(&mut into.website, from.website);
    fill(&mut into.birthday, from.birthday);
    fill(&mut into.notes, from.notes);
    let have = lower_set(&into.emails);
    for e in from.emails {
        if !have.contains(&e.to_lowercase()) && into.emails.len() < MAX_EMAILS {
            into.emails.push(e);
        }
    }
    for p in from.phones {
        if !into.phones.iter().any(|x| x.number == p.number) && into.phones.len() < MAX_PHONES {
            into.phones.push(p);
        }
    }
    // The user chose to import this person: they are no longer just collected.
    into.book = MailContactBook::Personal;
    into.updated = now;
}

// ── vCard out ───────────────────────────────────────────────────────────────

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ',' => out.push_str("\\,"),
            ';' => out.push_str("\\;"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// Fold one content line at 75 octets without splitting a UTF-8 sequence.
fn fold(line: &str, out: &mut String) {
    let mut width = 0usize;
    for c in line.chars() {
        let n = c.len_utf8();
        if width + n > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += n;
    }
    out.push_str("\r\n");
}

/// Serialize cards as vCard 3.0 — the version every address book (Thunderbird,
/// Apple, Google, Outlook) imports.
pub fn to_vcards(cards: &[MailContact]) -> String {
    let mut out = String::new();
    for c in cards {
        let mut lines: Vec<String> = vec!["BEGIN:VCARD".into(), "VERSION:3.0".into()];
        let full = if !c.display_name.is_empty() {
            c.display_name.clone()
        } else {
            let n = format!("{} {}", c.first_name, c.last_name).trim().to_string();
            if n.is_empty() {
                c.emails.first().cloned().unwrap_or_default()
            } else {
                n
            }
        };
        lines.push(format!("FN:{}", escape(&full)));
        lines.push(format!("N:{};{};;;", escape(&c.last_name), escape(&c.first_name)));
        if !c.nickname.is_empty() {
            lines.push(format!("NICKNAME:{}", escape(&c.nickname)));
        }
        for (i, e) in c.emails.iter().enumerate() {
            let pref = if i == 0 { ",PREF" } else { "" };
            lines.push(format!("EMAIL;TYPE=INTERNET{pref}:{}", escape(e)));
        }
        for p in &c.phones {
            let t = match p.kind.as_str() {
                "mobile" => "CELL",
                "work" => "WORK",
                "home" => "HOME",
                "fax" => "FAX",
                "pager" => "PAGER",
                _ => "VOICE",
            };
            lines.push(format!("TEL;TYPE={t}:{}", escape(&p.number)));
        }
        if !c.organization.is_empty() {
            lines.push(format!("ORG:{}", escape(&c.organization)));
        }
        if !c.job_title.is_empty() {
            lines.push(format!("TITLE:{}", escape(&c.job_title)));
        }
        if !c.address.is_empty() {
            // Free text has no structure to recover; it all goes in `street`.
            lines.push(format!("ADR:;;{};;;;", escape(&c.address)));
        }
        if !c.website.is_empty() {
            lines.push(format!("URL:{}", escape(&c.website)));
        }
        if !c.birthday.is_empty() {
            lines.push(format!("BDAY:{}", c.birthday));
        }
        if !c.notes.is_empty() {
            lines.push(format!("NOTE:{}", escape(&c.notes)));
        }
        if !c.id.is_empty() {
            lines.push(format!("UID:{}", escape(&c.id)));
        }
        lines.push("END:VCARD".into());
        for l in lines {
            fold(&l, &mut out);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("id{n}")
        }
    }

    fn card(name: &str, emails: &[&str]) -> MailContact {
        MailContact {
            display_name: name.into(),
            emails: emails.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn an_editor_save_refuses_a_bad_address_and_an_import_drops_it() {
        let c = card("Ann", &["ann@example.org", "Ann <ann@x.test>"]);
        assert!(normalize_contact(c.clone(), true).is_err());
        let n = normalize_contact(c, false).unwrap();
        assert_eq!(n.emails, vec!["ann@example.org"]);
    }

    #[test]
    fn a_line_break_or_bidi_override_never_survives_a_name() {
        let c = card("Ann\r\nBcc: evil@x.test\u{202e}", &[]);
        let n = normalize_contact(c, true).unwrap();
        assert_eq!(n.display_name, "Ann Bcc: evil@x.test");
    }

    #[test]
    fn duplicate_addresses_collapse_case_insensitively() {
        let n = normalize_contact(card("A", &["A@X.test", "a@x.test", "mailto:b@x.test"]), true).unwrap();
        assert_eq!(n.emails, vec!["A@X.test", "b@x.test"]);
    }

    #[test]
    fn an_empty_card_is_refused() {
        assert!(normalize_contact(MailContact::default(), true).is_err());
    }

    #[test]
    fn birthdays_accept_every_vcard_spelling() {
        assert_eq!(clean_birthday("19850412").as_deref(), Some("1985-04-12"));
        assert_eq!(clean_birthday("1985-04-12T00:00:00Z").as_deref(), Some("1985-04-12"));
        assert_eq!(clean_birthday("--0412").as_deref(), Some("--04-12"));
        assert_eq!(clean_birthday("1985-13-01"), None);
        assert_eq!(clean_birthday("soon"), None);
    }

    #[test]
    fn collecting_adds_strangers_and_bumps_known_cards_once() {
        let mut book = MailContacts::default();
        let mut next = ids();
        upsert_contact(&mut book, card("Bo", &["bo@x.test", "bo@work.test"]), 1, &mut next).unwrap();
        let added = collect(
            &mut book,
            &["bo@x.test".into(), "BO@work.test".into(), "new@x.test".into(), "new@x.test".into()],
            50,
            &mut next,
        );
        assert_eq!(added, 1);
        assert_eq!(book.contacts.len(), 2);
        let bo = find_by_email(&book, "bo@x.test").unwrap();
        assert_eq!((bo.popularity, bo.last_used), (1, 50));
        let new = find_by_email(&book, "new@x.test").unwrap();
        assert_eq!(new.book, MailContactBook::Collected);
        assert_eq!(new.popularity, 1);
    }

    #[test]
    fn collecting_off_still_bumps_but_adds_nothing() {
        let mut book = MailContacts { collect_disabled: true, ..Default::default() };
        let mut next = ids();
        upsert_contact(&mut book, card("Bo", &["bo@x.test"]), 1, &mut next).unwrap();
        assert_eq!(collect(&mut book, &["bo@x.test".into(), "c@x.test".into()], 2, &mut next), 0);
        assert_eq!(book.contacts.len(), 1);
        assert_eq!(book.contacts[0].popularity, 1);
    }

    #[test]
    fn a_personal_card_absorbs_its_collected_twin() {
        let mut book = MailContacts::default();
        let mut next = ids();
        collect(&mut book, &["cy@x.test".into()], 10, &mut next);
        collect(&mut book, &["cy@x.test".into()], 20, &mut next);
        let saved = upsert_contact(&mut book, card("Cy", &["CY@x.test"]), 30, &mut next).unwrap();
        assert_eq!(book.contacts.len(), 1);
        assert_eq!(saved.popularity, 2);
        assert_eq!(saved.last_used, 20);
        assert_eq!(book.contacts[0].book, MailContactBook::Personal);
    }

    #[test]
    fn promoting_a_collected_card_keeps_its_counters() {
        let mut book = MailContacts::default();
        let mut next = ids();
        collect(&mut book, &["d@x.test".into()], 10, &mut next);
        let mut c = book.contacts[0].clone();
        c.book = MailContactBook::Personal;
        c.display_name = "Dee".into();
        c.popularity = 0; // a stale editor copy must not roll the counter back
        let saved = upsert_contact(&mut book, c, 40, &mut next).unwrap();
        assert_eq!(saved.popularity, 1);
        assert_eq!(saved.created, 10);
        assert_eq!(saved.updated, 40);
        assert_eq!(book.contacts.len(), 1);
    }

    #[test]
    fn lists_validate_and_dedupe_members() {
        let mut book = MailContacts::default();
        let mut next = ids();
        let l = MailContactList {
            name: "Team".into(),
            members: vec!["a@x.test".into(), "A@x.test".into(), " ".into()],
            ..Default::default()
        };
        let saved = upsert_list(&mut book, l, &mut next).unwrap();
        assert_eq!(saved.members, vec!["a@x.test"]);
        let bad = MailContactList {
            name: "Bad".into(),
            members: vec!["x>@y".into()],
            ..Default::default()
        };
        assert!(upsert_list(&mut book, bad, &mut next).is_err());
        assert!(upsert_list(&mut book, MailContactList::default(), &mut next).is_err());
        assert!(delete_list(&mut book, &saved.id));
    }

    const THUNDERBIRD: &str = "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Jane Q. Doe\r\nN:Doe;Jane;Q.;;\r\n\
EMAIL;PREF=1:jane@example.org\r\nEMAIL:jd@work.example\r\nTEL;TYPE=cell;VALUE=TEXT:+49 170 1\r\n\
TEL;VALUE=uri:tel:+49-228-2\r\nORG:ACME;Research\r\nTITLE:Chief\\, Research\r\n\
NOTE:line one\\nline two with a very long tail that gets folded at seventy-five oc\r\n tets\r\n\
BDAY:--0412\r\nADR;TYPE=work:;;Main St 1;Bonn;;53113;Germany\r\nEND:VCARD\r\n";

    #[test]
    fn a_thunderbird_vcard_4_reads_back_whole() {
        let cards = parse_vcards(THUNDERBIRD);
        assert_eq!(cards.len(), 1);
        let c = normalize_contact(cards[0].clone(), false).unwrap();
        assert_eq!(c.display_name, "Jane Q. Doe");
        assert_eq!((c.first_name.as_str(), c.last_name.as_str()), ("Jane", "Doe"));
        assert_eq!(c.emails, vec!["jane@example.org", "jd@work.example"]);
        assert_eq!(c.phones[0], MailContactPhone { kind: "mobile".into(), number: "+49 170 1".into() });
        assert_eq!(c.phones[1].number, "+49-228-2");
        assert_eq!(c.organization, "ACME, Research");
        assert_eq!(c.job_title, "Chief, Research");
        assert!(c.notes.ends_with("seventy-five octets"));
        assert!(c.notes.starts_with("line one\nline two"));
        assert_eq!(c.birthday, "--04-12");
        assert_eq!(c.address, "Main St 1\n53113 Bonn\nGermany");
    }

    #[test]
    fn a_vcard_2_1_with_quoted_printable_and_bare_types_reads() {
        let v = "BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=\n=BCrgen\n\
TEL;CELL:0170\nitem1.EMAIL;INTERNET:jm@x.test\nEND:VCARD\n";
        let c = normalize_contact(parse_vcards(v)[0].clone(), false).unwrap();
        assert_eq!(c.last_name, "Müller");
        assert_eq!(c.first_name, "Jürgen");
        assert_eq!(c.phones[0].kind, "mobile");
        assert_eq!(c.emails, vec!["jm@x.test"]);
    }

    #[test]
    fn a_pref_address_becomes_primary() {
        let v = "BEGIN:VCARD\nEMAIL:b@x.test\nEMAIL;TYPE=INTERNET,PREF:a@x.test\nFN:A\nEND:VCARD";
        assert_eq!(parse_vcards(v)[0].emails, vec!["a@x.test", "b@x.test"]);
    }

    #[test]
    fn export_then_import_round_trips() {
        let c = MailContact {
            id: "u1".into(),
            display_name: "Zoë; \"Z\", Test".into(),
            first_name: "Zoë".into(),
            last_name: "Test".into(),
            nickname: "zt".into(),
            emails: vec!["z@x.test".into(), "zt@y.test".into()],
            phones: vec![MailContactPhone { kind: "work".into(), number: "+1 2".into() }],
            organization: "Org".into(),
            job_title: "Dev".into(),
            address: "Street 1\n12345 Town".into(),
            website: "https://z.example".into(),
            birthday: "1990-01-31".into(),
            notes: "a\\b\nsecond line ".repeat(10).trim().into(),
            ..Default::default()
        };
        let text = to_vcards(std::slice::from_ref(&c));
        assert!(text.lines().all(|l| l.len() <= 76), "folded at 75 octets");
        let back = normalize_contact(parse_vcards(&text)[0].clone(), false).unwrap();
        for (a, b) in [
            (&back.display_name, &c.display_name),
            (&back.first_name, &c.first_name),
            (&back.last_name, &c.last_name),
            (&back.nickname, &c.nickname),
            (&back.organization, &c.organization),
            (&back.job_title, &c.job_title),
            (&back.address, &c.address),
            (&back.website, &c.website),
            (&back.birthday, &c.birthday),
            (&back.notes, &c.notes),
        ] {
            assert_eq!(a, b);
        }
        assert_eq!(back.emails, c.emails);
        assert_eq!(back.phones, c.phones);
    }

    #[test]
    fn folding_never_splits_a_multibyte_character() {
        let c = card(&"ü".repeat(100), &[]);
        let text = to_vcards(&[c]);
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
        let back = parse_vcards(&text);
        assert_eq!(back[0].display_name, "ü".repeat(100));
    }

    #[test]
    fn import_merges_by_address_and_by_name_for_addressless_cards() {
        let mut book = MailContacts::default();
        let mut next = ids();
        collect(&mut book, &["e@x.test".into()], 1, &mut next);
        let imported = parse_vcards(
            "BEGIN:VCARD\nFN:Eve\nEMAIL:E@x.test\nTEL:1\nEND:VCARD\n\
             BEGIN:VCARD\nFN:Phone Only\nTEL:2\nEND:VCARD\n\
             BEGIN:VCARD\nFN:Phone Only\nTEL:3\nEND:VCARD\n\
             BEGIN:VCARD\nEMAIL:not an address\nEND:VCARD\n\
             BEGIN:VCARD\nFN:New\nEMAIL:n@x.test\nEND:VCARD",
        );
        let r = merge_import(&mut book, imported, 5, &mut next);
        assert_eq!((r.added, r.merged, r.skipped), (2, 2, 1));
        let eve = find_by_email(&book, "e@x.test").unwrap();
        assert_eq!(eve.display_name, "Eve");
        assert_eq!(eve.book, MailContactBook::Personal);
        assert_eq!(eve.popularity, 1);
        let phone = book.contacts.iter().find(|c| c.display_name == "Phone Only").unwrap();
        assert_eq!(phone.phones.len(), 2);
    }

    #[test]
    fn a_hostile_vcard_cannot_smuggle_a_header_through_an_address() {
        let v = "BEGIN:VCARD\nFN:x\nEMAIL:a@x.test>NOTIFY=SUCCESS\nEMAIL:a@x.test\\nBcc: e@y.test\nEND:VCARD";
        let c = normalize_contact(parse_vcards(v)[0].clone(), false).unwrap();
        assert!(c.emails.is_empty());
    }

    #[test]
    fn latin1_files_decode() {
        assert_eq!(decode_file(b"FN:M\xfcller"), "FN:Müller");
        assert_eq!(decode_file("\u{feff}FN:A".as_bytes()), "FN:A");
    }

    #[test]
    fn a_book_written_before_the_collect_option_collects() {
        let book: MailContacts = serde_json::from_str(r#"{"version":1,"contacts":[]}"#).unwrap();
        assert!(!book.collect_disabled);
        let json = serde_json::to_string(&book).unwrap();
        assert!(!json.contains("collect_disabled"));
    }
}
