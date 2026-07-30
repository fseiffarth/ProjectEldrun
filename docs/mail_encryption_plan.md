# Mail Encryption — Final Plan

**Status: BUILT (2026-07-28), never live-tested.** Every phase in §7 is
implemented and unit-tested; nothing has run against a real server, a real
correspondent, or a real keychain prompt. The §7 table now carries per-phase
outcomes, and the deviations from this document are recorded in §12 rather than
left for a reader to discover by diffing. Tracking item: `todo/group-j-mail.md` #66.
Design rationale that outlived the plan lives in `docs/context/mail_encryption.md`.
**Supersedes:** nothing. **Merges:** `docs/mail_encryption_plan_a.md` (OpenPGP-first,
1796 lines) and `docs/mail_encryption_plan_b.md` (S/MIME-first, 1967 lines), which
remain as the source material and hold the long derivations this document
compresses. Where this file and A/B disagree, **this file wins** — the
disagreements are recorded in §1.3 rather than silently resolved.

Two independent planning passes were run against the same brief. This document
is the review and reconciliation of both: it keeps the stronger treatment of each
shared concern, records which plan won and why, and marks the one question that
genuinely cannot be answered without the user.

---

## 0. Scope

Two separate features, deliberately sequenced, that the brief asked for together:

1. **The local mail store, encrypted at rest** (§3). Applies to *every* account,
   independent of what any correspondent supports. Ships alone, benefits everyone,
   and is testable with no mail server.
2. **End-to-end message encryption** (§4–§6) for the accounts that need it (the
   motivating case: work mail). **The format is OpenPGP** — settled 2026-07-28,
   see §1.3. S/MIME is costed and deferred at §5.

They are sequenced in that order for a reason that is not scheduling
preference. Both plans reached it independently: **the E2E track wants to cache
decrypted bodies, and caching decrypted bodies into a plaintext store makes the
store key cryptographically equivalent to the mail key.** Store encryption is
therefore a precondition for the E2E track, not a companion to it. See §3.8.

---

## 1. Decision record

### 1.1 Settled, with evidence verified against the tree (2026-07-28)

Each of these was checked directly — registry manifests, crate sources, and
`Cargo.lock` — rather than taken from either plan's summary.

| Decision | Evidence |
|---|---|
| **No OpenSSL, no C toolchain.** Unchanged. | The invariant is documented in three `Cargo.toml` comment blocks and `mail_engine.rs`'s header. It rules out SQLCipher (OpenSSL-backed) and `sequoia-openpgp`'s default Nettle backend. |
| **OpenPGP crate, if OpenPGP is built: `pgp` (rPGP) 0.20, `default-features = false`.** | Verified: `pgp 0.20.0` is `MIT OR Apache-2.0` with **zero** occurrences of `openssl`/`nettle`/`gmp` in its manifest. `sequoia-openpgp 2.4.1` is **LGPL-2.0-or-later** — a real constraint for a statically linked, publicly redistributed binary — and its pure-Rust backend is gated behind `allow-experimental-crypto` + `allow-variable-time-crypto`, both of which exist as opt-in features. Not close. |
| **`cms` and `x509-cert` are ASN.1 type libraries, not an S/MIME implementation.** | Verified: `cms 0.2.3`'s source contains **zero** `fn decrypt` / `fn verify` / `fn open`. Anyone assuming "RustCrypto has CMS" is assuming a codec is an implementation. |
| **X.509 path validation is a solved problem here — `rustls-webpki` does it, and it is already in the binary.** | Verified: `rustls-webpki 0.103.13` exposes `EndEntityCert::verify_for_usage` and `KeyUsage::required(oid)`; it is locked transitively via **both** `rustls` and `rustls-platform-verifier`. Using it directly costs one `Cargo.toml` line and **zero new compiled code**. |
| **At-rest primitive: XChaCha20-Poly1305** (`chacha20poly1305 0.11`), one `seal`/`open` pair, versioned envelope. | Both plans, independently, for the same reason: the 192-bit random nonce removes the counter that AES-GCM's 96-bit nonce needs — a counter that must survive both a crash and a restore-from-backup, which is exactly how GCM nonce reuse happens in practice. |
| **Store encryption precedes E2E.** | §3.8. Both plans. |
| **No IMAP APPEND exists today**, so there is no Sent copy at all. | Verified: no `APPEND` in `mail_engine.rs`. This is accidentally the most private behaviour available, and adding APPEND *without* encrypt-to-self is precisely how a plaintext Sent copy of an encrypted message ships. |

### 1.2 Where the two plans converged independently

Identical conclusions from separately-briefed agents — treat these as
high-confidence rather than one agent's opinion:

- Field-level AEAD **inside** SQLite + whole-file AEAD for blobs; **not**
  whole-file DB encryption, **not** SQLCipher.
- **AAD binds every ciphertext to its row identity.** Without it, an attacker with
  disk *write* access relocates message A's body onto message B's row and the
  client renders it as B — no key required. One string concatenation; closes a
  class of attack at-rest encryption is famous for leaving open.
- Structural columns (`id`, `account_id`, `folder_id`, `uid`, `date`, `seen`,
  `flagged`, `size`, `priority`) stay cleartext, because they are what paging,
  ordering and unread counts run on — **and the resulting metadata leak is stated
  plainly rather than buried** (§3.4).
- Blob ids move from `SHA-256(plaintext)` to `HMAC-SHA256(k_addr, plaintext)`:
  keeps dedupe, removes a known-file confirmation oracle against a directory
  listing.
- **Blind indexes rejected** — a deterministic per-token fingerprint leaks word
  frequency and answers "does this mailbox contain word X", which is most of what
  the encryption was for.
- **Decrypted plaintext is never written to disk** (§3.8).
- Signature-status UI must copy `MailAuthPanel`'s existing vocabulary and must
  never derive "verified" chrome from message-controlled content.

### 1.3 Where they disagreed, and the ruling

**Disagreement 1 — can S/MIME ever legitimately report "Verified"?**
Plan A concluded no: "there is no pure-Rust RFC 5280 path validator for email
certs", so its §10.3 checks chain/validity/EKU/SAN but not revocation, and never
reports `Verified` without a human. **Plan B is right and A's premise is false.**
`rustls-webpki`'s `verify_for_usage` performs chain building, validity,
`basicConstraints`, name constraints and CRL checking; `KeyUsage::required(oid)`
with the `emailProtection` OID turns it into an email-certificate validator;
hostname verification is a separate call that simply isn't made. It is already
compiled into the bundle. **Ruling: adopt B's validator.** A's S/MIME pessimism
is withdrawn.

**Disagreement 2 — which format first?**
A: OpenPGP first *even though* the motivating case is work mail, because rPGP is
unambiguous and its primitives are the ones S/MIME needs anyway.
B: S/MIME first, gated on a Phase 0 spike, because it is what work mail actually
deploys.
**Ruling: OpenPGP. Settled by the user on 2026-07-28** — no institutional
certificate is issued, so there is no `.p12` to import and no smartcard to drive.
B's entire S/MIME apparatus is therefore **deferred, not deleted** (§5): the
webpki finding remains correct and valuable, and if a work certificate ever
appears the track is pre-costed and drops in behind the §4 seam. A's format
recommendation wins on the merits it argued *and* on the fact it could not know.

**Disagreement 3 — how bad is the S/MIME dependency situation?**
B costed it honestly and A under-weighted it. Recorded at §5.1, including one item
**neither plan surfaced**: `pkcs12` is also pre-release (**0.2.0-pre.0**,
verified), so the S/MIME path depends on *two* pre-1.0 crates
(`cms 0.3.0-pre.2`, `pkcs12 0.2.0-pre.0`), not one. Moot for now given the ruling
above; retained because it is the cost of ever un-deferring §5.

**Correction to both plans — the `rsa` advisory is not an S/MIME problem, it is
everyone's problem.** B framed RUSTSEC-2023-0071 (Marvin timing oracle,
`patched = []`) as a cost specific to the S/MIME decrypt path, and A's summary
implied the OpenPGP track was clean. **Neither is right: `pgp 0.20.0` depends on
`rsa 0.9.10` unconditionally** — verified, not optional, no feature gate. Choosing
OpenPGP does not escape the advisory; it inherits it, and the `cargo audit`
finding is permanent either way.

What *does* escape it is a key-algorithm choice rather than a crate choice. The
Marvin oracle is in RSA PKCS#1 v1.5 decryption, so **generating Curve25519 keys
by default** (rPGP supports Ed25519 signing + X25519 encryption) means the
vulnerable code path is never exercised for the user's own mail, even though the
crate is compiled in. Incoming mail encrypted *to* an RSA key of ours is the only
way in, and if our key is Curve25519 there is none. This makes B's structural
mitigations — decrypt only on explicit open, one indistinguishable failure state,
no oracle observable over the wire — a second layer rather than the only one.

### 1.4 The precondition both plans flagged, which outranks all of the above

**The mail client itself has never been runtime-verified.** It is code-complete
and shipped to `develop` on 2026-07-26 with zero live QA. Building encryption on
top of an unverified client compounds untested surface, and a crypto bug found
underneath an IMAP bug is two bugs wearing one trenchcoat.

**Recommendation: live-QA the existing mail client first**, then build Phase 1
(at-rest), which is testable with no mail server and no correspondent, then
re-assess before committing to a format. This is A's Q13 and it is the single
most useful sentence in either document.

---

## 2. Threat model, and what this does not do

**Defended:** a stolen or lost laptop; offline access to the disk or a copy of
`~/.local/share/eldrun/`; a leaked or synced backup; another local account
reading files that survive a `harden()` mode change; ciphertext relocation by
someone with disk write access.

**Not defended, stated plainly:** a live process with the store unlocked; an
attacker who can run code as the user; memory scraping; a compromised mail
server (E2E defends the message body there, not the metadata); and traffic
analysis. Full-disk encryption already covers the stolen-laptop case for most
users — the marginal value here is backups, copies, sync services, and multi-user
machines, where FDE is not in play. Say so in the UI rather than implying more.

**Metadata that remains readable on disk by design** (§3.4): message counts, folder
structure, arrival dates, sizes, read/starred/priority flags. Anyone who needs
that hidden needs FDE, which hides filenames too.

---

## 3. Part I — The local store at rest

Format-independent. Ships alone. This is the part to build first.

### 3.1 What is on disk today

`MailStore::open` (`mail_store.rs:59`), `SCHEMA_VERSION = 1` (`:40`). Sensitive
today and in cleartext: `messages.{subject, from_json, to_json, cc_json, preview,
rfc_message_id, authres_json}`, `bodies_cache.{html, text, links_json}`,
`attachments.filename`, `drafts.json`, `folders.{path, name}`, every file under
`blobs/` and `outbox/`, and `accounts.json`.

### 3.2 The sealing primitive

One envelope shape, one version byte, in a new `services/mail_crypt.rs`. Take
**B's API** (magic + algorithm byte + `Zeroizing` return) with **A's AAD
construction** made granular:

```rust
/// [ b"ELMC" | u8 version | u8 alg | [u8; 24] nonce | ciphertext‖tag ]
pub fn seal(key: &Key, aad: &[u8], plaintext: &[u8]) -> Vec<u8>;
pub fn open(key: &Key, aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptError>;
```

- **XChaCha20-Poly1305**, `chacha20poly1305 0.11`. The `alg` byte keeps `aes-gcm`
  a swap rather than a rewrite if a hardware-AES argument ever wins.
- **AAD, SQLite field:** `account_id ‖ 0x00 ‖ table ‖ 0x00 ‖ column ‖ 0x00 ‖ row_key`.
  **AAD, blob:** `blob:<id>`. **AAD, staged file:** `staged:<draft_id>:<staged_id>`.
- Envelopes are stored as `BLOB` in the same column. SQLite's dynamic typing lets
  `subject BLOB` and `subject TEXT` coexist during migration, which is what makes
  §3.7 restartable.

### 3.3 What is sealed

Union of both plans' tables — A's is more complete and its extra entries are
correct:

| Table | Sealed |
|---|---|
| `messages` | `subject`, `from_json`, `to_json`, `cc_json`, `preview`, `malformed`, `rfc_message_id`, `authres_json` |
| `bodies_cache` | `html`, `text`, `links_json` |
| `attachments` | `filename`, `mime`, `mismatch` |
| `drafts` | `json` (whole draft) |
| `staged` | `filename`, `mime` |
| `folders` | `path`, `name` |
| `mail_remote_allow` | address column (see below) |
| `accounts.json` | whole file → `accounts.json.enc`, one envelope, via a `write_bytes_atomic` alongside `storage::write_json_atomic` |
| `blobs/`, `outbox/` | payloads, per file |

**Left cleartext:** `id`, `account_id`, `folder_id`, `uid`, `date`, `seen`,
`flagged`, `answered`, `deleted`, `has_attachments`, `size`, `priority`, blob
references, all indexes.

**Uniqueness over sealed columns — A's catch, and B missed it.** `folders` carries
`UNIQUE(account_id, path)` and `put_blob` (`:211`) dedupes by digest. Randomized
AEAD destroys both. Fix: one keyed digest per identity —
`path_key = HMAC-SHA256(k_name, account_id ‖ 0x00 ‖ path)` as a new cleartext
column carrying the `UNIQUE`, with the readable `path` sealed beside it. Leaks
equality only, which the schema already asserts. Same mechanism replaces
`mail_remote_allow`'s primary key.

**Blobs.** `put_blob` names files `SHA-256(plaintext)` today (`:211`), which both
leaks content via a directory listing and breaks dedupe once nonces are random.
One change fixes both: name the file `HMAC-SHA256(k_addr, plaintext)` and store
the envelope inside it. `get_blob`'s existing 64-hex validation (`:224`) is
unchanged — still 64 hex characters, now meaning something different.

**WAL and freelist.** Because *values* are sealed, the WAL and freelist only ever
contain envelopes — there is no window where SQLite writes plaintext. This is the
concrete advantage of value-level over encrypt-the-file-afterwards. The single
exception is migrating an existing plaintext store, which is why §3.7 ends in
`VACUUM INTO` rather than an in-place rewrite.

### 3.4 Search under encryption

`headers_page`'s `LIKE` (`:400`) cannot run over ciphertext. Take B's treatment:

- **Decrypt-on-scan, bounded.** No query → nothing changes; only visible rows are
  opened. With a query, scan the folder in `date DESC`, opening
  `subject`/`preview`/`from_json` per row until `limit` matches or
  `MAX_SEARCH_SCAN = 50_000` rows, then report *"searched the most recent N
  messages"* — never silently truncate. XChaCha20 runs ~1 GB/s; this is
  milliseconds, in `spawn_blocking` like the rest.
- `total` becomes matches-found-within-scan, not `COUNT(*)`. The pager stops
  claiming a page count it cannot know.
- Blind indexes rejected (§1.2).

### 3.5 The key, and what happens when it isn't there

One master key, purpose-bound subkeys via HKDF (`k_field`, `k_blob`, `k_addr`,
`k_wrap`) — compromise of one does not hand over the others, and a purpose string
is cheaper than a second key file. Two unlock modes:

- **Passphrase**, Argon2id (pin to the **0.5 stable line**; 0.6 is an rc —
  verified: the local registry has `argon2-0.6.0-rc.8`). Parameters recorded *in*
  the key file so they can be raised later without stranding an existing store.
  Starting point 64 MiB / t=3 / p=1, tuned by measurement.
- **Keychain**, via `remote_credentials.rs`, silent.

**The locked-keyring failure class is mandatory reading here.** A locked Secret
Service collection blocks reads forever; the codebase already carries a bounded
`read_timed` (4s) because of it. The key path must use it. **On unavailable key,
degrade to memory-only** — sync works, nothing persists — rather than rendering
the mailbox unreadable. This is A's resolution and it is better than B's feared
failure mode.

Per project rule, **secrets are not persisted by default**: keychain storage is an
explicit opt-in, consistent with the existing "Save password" checkbox.

### 3.6 Attachments and temp files — the classic hole

`stage_attachment` and any view-an-attachment path write plaintext outside the
sealed store. Seal `outbox/` payloads; consume staged bytes in memory in
`build_outgoing`; and note that **`PRAGMA temp_store` is unset today** (B's
catch) — set it to `MEMORY` so SQLite spills nothing to `/tmp`.

### 3.7 Migrating an existing plaintext store

Resumable, per-table, driven off `SCHEMA_VERSION` (`:40`) and `migrate` (`:88`).
Ends with **`VACUUM INTO` a new file**, because in-place `UPDATE` leaves plaintext
in the WAL and the freelist. Then remove the old file.

**Say the honest thing in the UI:** secure deletion is mostly a lie on SSD and
copy-on-write filesystems. Offer "delete and re-sync" beside "migrate" — it is
slower but generates no plaintext to leak, and it is the right recommendation for
anyone who actually cares.

### 3.8 The decrypted-body invariant

**Decrypted E2E plaintext is never written to disk.** Not to `bodies_cache`, not
to `preview`, not to a blob. If it were, the store key would become
cryptographically equivalent to the mail private key and the E2E guarantee would
reduce to the at-rest guarantee. Decrypted bodies live in a memory-only LRU with
`Zeroizing`, `preview` stays empty for encrypted messages, and no `bodies_cache`
row is written.

A proposed `cache_decrypted` opt-in (A's §2.10) may ship **off, buried, and with
help text stating the downgrade** — offline search of encrypted mail is a real
need and the alternative is people not using encryption. It must never default on.

---

## 4. Part II — The format-agnostic seam

Both formats reduce to the same four operations. Define them once so the format
decision (§8 Q1) does not fork the codebase:

```rust
trait MailCrypto {
    fn detect(part: &MimePart) -> Option<CryptoKind>;
    fn verify(&self, signed: &[u8]) -> VerifyOutcome;
    fn decrypt(&self, enveloped: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError>;
    fn seal_outgoing(&self, msg: &Mime, to: &[Recipient], opts: SealOpts) -> Result<Mime, CryptoError>;
}
```

**The mandatory ordering, from both plans and non-negotiable:**

```
decrypt → parse → sanitize → render
```

Decrypted content goes through `sanitize_message_html`
(`mail_sanitize.rs:259`, `SANITIZER_VERSION = 2` at `:52`) exactly as
server-delivered content does. Decryption does not confer trust: a decrypted body
is still attacker-controlled, and the project rule that anything message-derived
is hostile applies unchanged. The existing `sandbox=""` frame in
`MailMessageView.tsx` is what makes EFAIL-class exfiltration hard, and it is
load-bearing here.

**UI:** a `MailCryptoPanel` beside the existing `MailAuthPanel`, copying its
`state`/`identifier`/`aligned` vocabulary. Positive chrome only for
good-signature **and** address-aligned. Headers sit outside the signature in
*both* formats — a signed message does not authenticate its own `From`, and the
panel must not imply otherwise. Every new surface carries `UntestedTag`
(`src/components/common/UntestedTag.tsx`, confirmed present) until the user says
it is verified.

---

## 5. Part III — S/MIME track (DEFERRED)

> **Not being built.** No certificate is issued to the user (§1.3), so this track
> has no credential to load. It is kept fully costed and ready behind the §4 seam
> in case that changes — un-deferring it is Phase 8, not a rewrite.
> **The track being built is §6.**

### 5.1 The dependency situation, stated fully

- `cms 0.2.3` stable is **types and builders only** — no open, no verify
  (verified). Opening `EnvelopedData` and verifying `SignedData` is code we write
  against the ASN.1 types.
- `cms 0.3.0-pre.2` and `pkcs12 0.2.0-pre.0` are both **pre-release** (verified).
- **Path validation is free**: `rustls-webpki`, already in the bundle (§1.1).
- **Verification needs no new asymmetric crate and carries no advisory** —
  `EndEntityCert::verify_signature` plus the installed `ring` provider covers the
  S/MIME signature algorithms. This makes *verify-only* a genuinely cheap early
  win.
- **Decryption needs `rsa`**, which is under **RUSTSEC-2023-0071 (Marvin timing
  oracle), `patched = []`** on both the 0.9 and 0.10 lines. This is a real,
  unfixed advisory and a permanent `cargo audit` finding. Structural mitigations
  — decrypt only on explicit user open, single indistinguishable failure state,
  no oracle observable over the wire — are the actual defence, not polish.

### 5.2 Phase 0 spike, the go/no-go

Feed a **real** issued personal certificate to `webpki::verify_for_usage` with
`KeyUsage::required(emailProtection)` against the platform roots. Pass → S/MIME
proceeds. Fail → do not add the S/MIME block at all; ship OpenPGP (§6). Deciding
the failure branch *in advance* is what keeps this a spike rather than a
commitment.

### 5.3 The rest

Certificate import via PKCS#12; trust outcomes surfaced per §4; recipient certs
harvested from received signed mail plus manual import. **LDAP directory lookup:
not built** until asked for twice — and if ever built, **no institution hostnames
or presets may ship** (privacy rule; the repo is public). Revocation via CRL as
webpki supports it; any network-fetching revocation check is opt-in, because it
tells a third party who you correspond with.

---

## 6. Part IV — OpenPGP track (**the chosen track**)

`pgp` (rPGP) 0.20, `default-features = false` — which also drops `bzip2`, and
that is deliberate: a decompressor nobody asked for is the same decompression-bomb
channel that keeps `COMPRESS=DEFLATE` off in `async-imap`. An unsupported
algorithm should be a banner, not a silently enabled codec.

rPGP is a complete implementation: sign, verify, encrypt, decrypt, key
generation, all present today, all pure RustCrypto. It is materially simpler than
S/MIME — **no hand-written CMS** (the single largest saving; `cms` would have
meant writing `SignedData` verification and `EnvelopedData` opening by hand
against ASN.1 types) and **no pre-release crates**. It does *not* avoid the `rsa`
advisory (§1.3) — nothing does.

**Key generation defaults to Curve25519** (Ed25519 signing, X25519 encryption).
This is the mitigation that actually matters: it keeps rPGP's compiled-in
RSA PKCS#1 v1.5 decryption path unexercised for our own mail, since nobody can
encrypt to an RSA key we do not have. RSA keys remain *importable* — a
correspondent's RSA key is fine, we only verify with it — but we never generate
one.

**Trust model, and the thing to be honest about in the UI.** OpenPGP has no CA:
trust comes from the user having verified a fingerprint out of band. There is no
`webpki` equivalent to lean on here, which inverts §5's situation — S/MIME had a
free validator and no credential; PGP has a credential and no validator. The
panel must therefore distinguish *"good signature from a key you verified"* from
*"good signature from a key we picked up somewhere"*, and only the former gets
positive chrome. A good signature from an unverified key is a statement about
bytes, not about a person.

Key discovery: keys attached to incoming mail, manual import, WKD (which leaks the
query only to the recipient's own domain — one you are already mailing), and
keyservers manual-only, one address per click, never a background mode. Any
network lookup **must reuse the existing SSRF gate** in `web_safety.rs` rather
than re-implement it. Autocrypt: off by default, per-account, first-contact-only
— it is simultaneously the thing that makes PGP usable for a non-expert
correspondent and the cleanest key-substitution vector, so it is the user's call,
made once, with the trade stated.

---

## 7. Unified phasing

Every phase ships and is testable alone. Phases 0–2 are **format-independent** —
start them without answering §8 Q1.

| # | Phase | Depends on | Notes |
|---|---|---|---|
| **—** | **Live QA of the existing mail client** | — | §1.4. Not optional, and not encryption work. **Still outstanding** — the build went ahead without it on the user's instruction, so the compounding-untested-surface risk this row names is now real rather than hypothetical. |
| **1** | `mail_crypt.rs`: `seal`/`open`, HKDF key hierarchy, unlock modes, memory-only degrade | — | Pure unit-testable. No mail server, no correspondent, no keys. |
| **2** | Store at rest: sealed columns, HMAC blob ids, `UNIQUE` digests, bounded search, migration + `VACUUM INTO`, `temp_store=MEMORY` | 1 | The whole of Part I. **Ships as a user-visible feature on its own** and is worth having even if the E2E track never happens. |
| **3** | `MailCrypto` seam + `MailCryptoPanel` + detection of encrypted/signed MIME shapes | 2 | Format-agnostic; the S/MIME shapes are detected here too even though nothing handles them. Detection and UI with no crypto behind them yet. |
| **4** | PGP keyring: generate Curve25519, import, fingerprint verification, per-account binding | 3 | Where "verified vs merely known" is established (§6) — the distinction the panel depends on. |
| **5** | **Verify** incoming signatures | 4 | Read-only, no private key touched, no `rsa` decrypt path. Most of the perceived value, least of the risk. |
| **6** | Decrypt on explicit open | 5 | Memory-only bodies (§3.8). Structural mitigations for RUSTSEC-2023-0071 (§1.3). |
| **7** | Sign + encrypt outgoing | 6 | Missing-key behaviour: warn and refuse to silently downgrade to plaintext. |
| **8** | IMAP APPEND + Sent copies, **with mandatory encrypt-to-self** | 7 | Never before 7 (§1.1) — APPEND added alone is how a plaintext Sent copy ships. |
| **9** | Un-defer S/MIME | 8 | Only if a certificate ever appears. Pre-costed at §5; the seam already exists, so it is additive. |

---

## 8. Open questions

Answers change the work. Recommendations included so silence is still a decision.

1. ~~**What does your work mail actually issue you?**~~ **Answered 2026-07-28:
   nothing is issued — OpenPGP instead.** This settles the format (§1.3), defers
   all of §5, and removes the webpki spike from the critical path. The rest of
   this list is unaffected.
2. **Store unlock default** — passphrase per session, or keychain? → *Recommend
   keychain with the memory-only degrade for silent operation, passphrase
   available.* (A and B split on this; A's degrade path is what makes keychain
   safe to default.)
3. **Store encryption on by default for new installs?** → *Yes* — a new store has
   nothing to migrate, so the cost is one checkbox. Existing installs asked once.
4. **Migrate the existing plaintext store, or delete and re-sync?** → *Offer both,
   default migrate*, with §3.7's honest note about SSD deletion.
5. **Render decrypted HTML at all, or plain-text only?** → *Plain-text default
   with a per-message opt-in click.* Permanent refusal is tempting and probably
   too strict for real work mail.
6. **Accept `rsa` under RUSTSEC-2023-0071?** Not really optional any more — rPGP
   depends on it unconditionally (§1.3), so the permanent `cargo audit` finding
   arrives with the OpenPGP track whether or not decryption is built. → *Accept,
   documented in `Cargo.toml` beside the existing constraint comments*, and rely
   on Curve25519-by-default (§6) to keep the vulnerable path unexercised. Phase 5
   (verify) never touches it at all.
9. **Do we generate a keypair for the user, or import an existing one?** → *Offer
   both at Phase 4*, defaulting to generate-Curve25519, since the answer to Q1
   implies there may be no existing key to import.
10. **What happens to mail already sitting in the store when encryption is
    enabled?** → It is re-sealed by the §3.7 migration like everything else; it
    was received in plaintext and no retroactive E2E guarantee is implied or
    claimed.
7. **Accept weak ciphers on receipt?** → *Accept 3DES on receipt with a "weak
   cipher" marker; never produce it.* Needs a real-world answer.
8. **Hardware tokens** (YubiKey / OpenPGP card) — out of scope, seam left in
   place. Confirm nobody is counting on it.

---

## 9. Test strategy

- **Unit** (`cargo test --manifest-path src-tauri/Cargo.toml`): `seal`/`open`
  round-trip; **AAD relocation must fail** — move a sealed body between rows and
  assert the open errors; envelope version/alg rejection; HMAC blob dedupe;
  Argon2id parameters round-tripping through the key file; the memory-only
  degrade path.
- **Migration**: plaintext store → sealed store → readable; interrupt mid-way and
  restart; assert no plaintext survives in the vacuumed file.
- **Hostile fixtures** (`src-tauri/tests/fixtures/mail`, alongside
  `mail_hostile_message.rs`): malformed CMS/PGP, signature-over-different-body,
  header/signature mismatch, decompression bombs, EFAIL-shaped exfil attempts —
  each asserting the sanitizer still runs after decryption.
- **Frontend** (vitest): `MailCryptoPanel` never shows positive chrome for
  unaligned or unverified input; `UntestedTag` present on new surfaces.
- **Manual only, and cannot be automated:** interop with Thunderbird and Outlook;
  real certificate acceptance (Phase 0); unlock latency on the slowest machine;
  keychain-locked behaviour. **These are the user's to run — I cannot launch
  Eldrun.**

---

## 10. TODO entries

Both plans proposed numbering that collides (A: #153–#160; B: 65a–65i). The tree
uses per-group files, so these belong in `todo/group-j-mail.md` (verified present)
renumbered from its current tail — to be assigned when the group file is opened,
not guessed here.

Proposed items: at-rest sealing primitive; store migration; bounded search;
`MailCrypto` seam + panel; Phase 0 spike; verify-only; decrypt; sign+encrypt;
APPEND with encrypt-to-self; second format.

---

## 11. Critical files

- `src-tauri/Cargo.toml` — the mail/TLS block; origin of every §1.1 decision.
- `src-tauri/src/services/mail_store.rs` — `SCHEMA_VERSION` (:40), `open` (:59),
  `migrate` (:88), `put_blob` (:211), `get_blob` (:224), `headers_page` (:400),
  `cached_body` (:678), `cache_body` (:702), `harden` (:1064).
- `src-tauri/src/services/mail_sanitize.rs` — `SANITIZER_VERSION` (:52),
  `sanitize_message_html` (:259). Decrypted content goes through **this**.
- `src-tauri/src/services/mail_engine.rs` — parsing, structural caps,
  `build_outgoing`, the `MailEngine` trait.
- `src-tauri/src/services/mail_authres.rs` + `schema/mail.rs` — the display
  vocabulary `MailCryptoPanel` copies.
- `src-tauri/src/services/remote_credentials.rs` — keychain access and the
  bounded `read_timed` that the key path must use.
- `src-tauri/src/services/web_safety.rs` — the SSRF gate any key lookup reuses.
- `src-tauri/src/commands/mail.rs` — including the `no_command_takes_a_path`
  tripwire, which the new commands must not break.
- `src/components/mail/MailMessageView.tsx` — the `sandbox=""` frame and
  `MailAuthPanel`, the template for `MailCryptoPanel`.
- `src/components/common/UntestedTag.tsx`.
- `docs/mail_encryption_plan_a.md`, `docs/mail_encryption_plan_b.md` — the long
  derivations behind every compressed argument above.

---

*Crate versions, feature lists and API signatures cited as "verified" were checked
on 2026-07-28 against the local registry sources, crate sources and `Cargo.lock`,
and are recorded so they can be re-checked rather than believed. The ones that
gate a decision — `pgp`'s unconditional `rsa 0.9.10` dependency, `rsa`'s
unpatched advisory, `sequoia`'s LGPL and Nettle default, `cms`'s missing
open/verify, `webpki::KeyUsage::required`, and `pkcs12`'s pre-release status —
are the ones to verify again before Phase 1.*

---

## 12. What was built, and where it departed from this plan

Recorded here rather than left to a diff. Every phase in §7 shipped; the
departures are all in the same direction — a place where the plan under-specified
something and the implementation had to decide.

**§7 phase 1–2 (at rest).** As specified. Schema went to v2, which the plan did
not name: moving `UNIQUE` off a sealed column is a *constraint* change, and
SQLite cannot `ALTER` one, so `folders` and `mail_remote_allow` are rebuilt.

**A leak the plan did not list.** A folder id is an unkeyed `sha256(path)[..8]`
(`commands::mail::folder_id_for`), so a wordlist recovers folder names. This is
inside the §2 threat model ("folder structure" stays readable) but is sharper
than that phrase suggests. Not fixed: every message id derives from the folder
id, and message ids are the AAD row keys, so keying it is a second migration of
its own. Pinned by
`mail_store::tests::encrypted::the_metadata_that_stays_readable_is_the_metadata_we_said_would`.

**§3.5 unlock.** Q2's recommendation taken: keychain by default with the
memory-only degrade, passphrase available, mode switchable without re-encrypting
the store (the master key is wrapped, so a mode change is a key-file rewrite).

**§3.8 `cache_decrypted`.** **Not built.** The plan permitted it "off, buried,
and with help text stating the downgrade"; nothing was added, so the invariant
holds unconditionally and there is no setting that can weaken it. Worth
reconsidering only if offline search of encrypted mail turns out to be a real
need in practice.

**§6 key generation.** v4 `Ed25519Legacy` + `ECDH(Curve25519Legacy)` rather than
the RFC 9580 v6 forms the plan's wording implies. Interoperating with
Thunderbird, GnuPG and Outlook is the point of using a standard, and v6 support
in the wild is not yet where v4's is.

**§6 key discovery.** WKD, keyservers and Autocrypt are **not built**. What
exists is: keys attached to or pasted from mail, and file import through the OS
dialog raised in Rust. Every one of the missing three is a network path driven by
attacker-influenced input and deserves its own pass; the SSRF gate in
`web_safety.rs` is where it would go.

**§8 Q7 (weak ciphers).** Not applicable as written — rPGP decides its own
symmetric algorithm acceptance, and there is no 3DES-on-receipt decision for this
codebase to make.

**Inline (pre-MIME) signatures** are detected and reported but **not verified**.
The cleartext-signature framework has its own dash-escaping and canonicalization
rules, and a verifier that got them subtly wrong would report passes over text
nobody signed. Named honestly beats checked badly; §5's own reasoning, applied to
a different gap.

**The keyring requires the store to be encrypted**, enforced by
`PgpKeyring::open` taking `MailKeys` with no alternative constructor. The plan
sequenced the phases on this argument without making it a type-level rule.
