# Mail Encryption — Plan A: OpenPGP first, S/MIME second, and an encrypted local store

Scope: end-to-end message encryption and signing for Eldrun's embedded mail
client, plus **encryption at rest for the local mail store**. Two separate
concerns that are constantly confused, so they are separated here on purpose:

- **End-to-end (§§3–10)** protects a message *in transit and on the server*.
  The counterparty is the sender/recipient; the adversary is anyone between,
  including the mail provider.
- **At rest (§2)** protects the *cache this client wrote to your disk*. The
  counterparty is nobody; the adversary is whoever gets the disk. It applies to
  **all** mail, not only the E2E-encrypted subset, and it ships independently.

This plan owns the crypto. It does **not** re-litigate anything in
`docs/mail_client_plan_a.md` (tab surface, the path-free IPC boundary,
persistence, credentials) or `docs/mail_client_plan_b.md` (IMAP/SMTP, MIME
parsing, sanitization, transport TLS, the threat table). Both remain binding;
this plan is additive and is written to fit inside them without loosening one
rule.

The single hardest constraint, restated because everything in §0 follows from
it: **there is no OpenSSL anywhere in the bundle.** The whole TLS stack is
rustls + `ring` (`src-tauri/Cargo.toml` "Mail" and "In-app browser" blocks;
`services::mail_engine::install_crypto_provider`), and the browser's `reqwest`
is pinned to `rustls-no-provider` precisely so a second `CryptoProvider` can
never be compiled in. A crypto library that drags in `openssl-sys`, `nettle`,
`gmp` or `botan` is not "one more dependency" here — it is a new C toolchain
requirement on three packaging targets, one of which (Windows) is CI-verified
only and cannot be debugged locally.

> **Status of every claim in §0:** verified on 2026-07-28 against the crate
> manifests in the local registry cache (`pgp` 0.20.0, `sequoia-openpgp` 2.4.1,
> `cms` 0.3.0-pre.2, `x509-cert` 0.3.0, `chacha20poly1305` 0.11.0, `argon2`
> 0.5.3, `hkdf` 0.12.4, `aes-gcm` 0.11.0), not from memory. Re-check versions
> with `cargo search` before landing Phase 0 — the *arguments* below are about
> licences, backends and maturity, and those move slowly; the version numbers do
> not.

---

## 0. Crate selection

### 0.1 What is already in the tree (reuse, do not duplicate)

| Already present | Where | What it means for this plan |
|---|---|---|
| `mail-parser` 0.11 | mail | Parses the *outer* MIME of an encrypted message and, after decryption, the inner one. No second parser is introduced. |
| `mail-builder` 0.4 | mail | Builds the `multipart/encrypted` and `multipart/signed` envelopes. No hand-rolled MIME. |
| `ammonia` 4 | mail/browser | The sanitizer. Decrypted HTML goes through **the same** function, at the same layer. |
| `sha2` 0.10, `base64` 0.22, `zeroize` 1 (+`derive`), `tempfile` 3 | mail | Digests, armor, secret buffers. |
| `rusqlite` 0.40 (`bundled`) | mail store | The store §2 encrypts. Its `sqlcipher` feature is **not** usable — see §2.3. |
| `reqwest` 0.13 (`rustls-no-provider`) | browser | The only outbound HTTP client. WKD (§4) reuses it and its SSRF gate; no new HTTP stack. |
| `rustls-native-certs`/`rustls-platform-verifier` | mail/browser | The OS root store. Reused as the *trust-anchor source* for S/MIME (§10) — not as a verifier, because it verifies TLS server certs, which is a different job. |
| `services::web_safety` + `services::browser_engine::resolve_hop` | browser | Hop-0-vs-later-hop SSRF policy, DNS pinning. WKD fetches ride it verbatim. |

### 0.2 OpenPGP: `pgp` (rPGP) vs `sequoia-openpgp`

| | **`pgp` (rPGP) 0.20** | **`sequoia-openpgp` 2.4** |
|---|---|---|
| Licence | **MIT OR Apache-2.0** — matches the repo's posture for a public, redistributable desktop bundle. | **LGPL-2.0-or-later**. Workable for a dynamically-linkable app, but this is a statically-linked Rust binary shipped as deb/AppImage/NSIS/dmg; LGPL §6 relinking obligations on a static link are a licensing question a side feature should not create. |
| Default crypto backend | **RustCrypto, pure Rust, no default C dependency.** Its dependency list is `aes aes-gcm aes-kw argon2 cfb-mode curve25519-dalek ed25519-dalek rsa p256 p384 p521 k256 dsa ecdsa sha1-checked sha2 sha3 hkdf ocb3 eax rand zeroize …` — zero occurrences of `openssl`, `nettle` or `gmp` in the manifest. | **`default = ["compression", "crypto-nettle"]`.** Nettle is a C library and pulls GMP. Building it on the Windows runner means msys2/vcpkg; on macOS it means Homebrew nettle in CI. |
| Escaping that backend | n/a | `crypto-openssl` → `openssl-sys` (**disqualified**). `crypto-botan` → Botan, a C++ library (**disqualified**). `crypto-cng` → Windows-only, ≥Win10 (so it can only ever be a third of the answer). `crypto-rust` → RustCrypto, but the crate's own README says *"the RustCrypto crates are not recommended for general use as they cannot offer the same security guarantees as more mature cryptographic libraries"* and gates it behind **`allow-experimental-crypto`** *and* **`allow-variable-time-crypto`**, the latter documented as *"may leak secret keys in some settings"*. |
| Feature-unification hazard | none | Sequoia's README states plainly that **exactly one** backend must be selected and that backends are *not* additive, which breaks Cargo's feature-unification assumption. Any future crate in the tree that also depends on sequoia can silently re-enable `crypto-nettle`. That is the same class of bug as rustls's two-`CryptoProvider` panic that already bit this repo — and there is no `install_default()` equivalent to paper over it. |
| Cross-platform build | One `cargo build`, no system packages, on all three targets. Windows is CI-only here, which makes "no C toolchain" worth more than it usually is. | Per-OS backend selection, per-OS system packages, and a Windows path (`crypto-cng`) that is *different code* from the one Linux/macOS run — i.e. a whole platform whose crypto cannot be exercised by the Linux test run. |
| RFC coverage | RFC 4880 + RFC 9580 (v6 keys, SEIPDv2/AEAD), plus draft PQC behind a feature. Covers everything a mail client meets. | Same, and arguably the better-specified implementation. |
| Maturity / provenance | Ships in Delta Chat (a widely deployed OpenPGP mail client) — i.e. it is battle-tested *at exactly this job*. Continuously fuzzed. | The reference-grade implementation, used by `sq`/`sequoia-sqv` and by distribution tooling. Genuinely excellent — with a C backend. |
| MSRV | `rust-version = "1.88"` (check the toolchain the CI runners pin before landing). | `1.85`. |
| Compile-time cost | Large but bounded; it is the biggest single crate this plan adds. Measure it in Phase 0 and record the number. | Comparable, plus the C build. |

**Recommendation: `pgp` (rPGP), `default-features = false`.**

The decision is not close. The licence is right, the backend needs no C
toolchain on any of the three targets, and the alternative's pure-Rust escape
hatch is one its own maintainers tell you not to use in production. Dropping
default features removes `bzip2` — which is both a compression backend we do not
need and one more attacker-controlled decompression channel of exactly the kind
plan B §3.6 spent a section closing (`COMPRESS=DEFLATE` is off for the same
reason). If a real message turns up compressed with bzip2, the right response is
a "this message uses a compression algorithm Eldrun does not support" banner, not
a silently enabled decompressor.

**What we do *not* get from rPGP and must build ourselves**, stated so nobody
budgets for it twice: PGP/MIME framing (RFC 3156) is *ours*; key storage,
keyring management, trust decisions, discovery, expiry policy and the entire UI
are *ours*. rPGP gives packets, keys and primitives. That split is the same one
`mail-parser` gives us — it parses MIME, it does not decide what is safe.

### 0.3 S/MIME crates (the secondary track)

| Need | Crate | State |
|---|---|---|
| CMS / PKCS#7 (RFC 5652): `SignedData`, `EnvelopedData` | `cms` | **0.3.0-pre.2 — a pre-release.** RustCrypto formats, Apache-2.0/MIT, pure Rust. Usable, but the version string is itself an argument for putting S/MIME second and keeping its first phase read-only. |
| X.509 parsing | `x509-cert` 0.3 | Solid, pure Rust, Apache-2.0/MIT. **Parses; does not do RFC 5280 path validation.** |
| RSA key transport, ECDH (`p256`/`p384`), AES-CBC/GCM content decryption, SHA-2 | `rsa`, `p256`, `p384`, `aes`, `cbc`, `aes-gcm`, `sha2` | **Already compiled in by `pgp`.** S/MIME's primitives cost nothing extra once the OpenPGP track has landed — which is a genuine reason to do OpenPGP first even for a user whose motivating case is S/MIME. |
| Trust anchors | `rustls-native-certs` (in tree) | Gives root DER blobs. We supply our own minimal path check (§10.3). |

**There is no pure-Rust RFC 5280 path validator in this ecosystem** that
validates *email* certificates. `rustls-webpki` validates TLS server certs — it
requires the `serverAuth` EKU and matches DNS names, neither of which an S/MIME
cert has. This is the single biggest honest gap in the S/MIME track and §10.3
says what we do instead rather than pretending otherwise.

### 0.4 At-rest AEAD and KDF (§2)

| | **XChaCha20-Poly1305** (`chacha20poly1305` 0.11) | **AES-256-GCM** (`aes-gcm` 0.11) |
|---|---|---|
| New dependency | One small pure-Rust crate (RustCrypto, Apache-2.0/MIT). | **None** — `pgp` already compiles `aes-gcm`. |
| Nonce | **192-bit.** A random nonce per record is unconditionally safe; there is nothing to count and no counter to persist or resynchronise after a crash. | 96-bit. Random nonces are safe only up to a budget (~2³² records per key before collision probability stops being negligible). |
| Consequence for this store | None. Encrypt, store the nonce in the envelope, forget about it. | Either persist a monotone counter (a new failure mode: a rolled-back DB replays nonces) **or** derive a per-record subkey with HKDF so each key sees one nonce. The latter is fine but is extra machinery whose absence is silently fatal. |
| Software performance without AES-NI | Fast by construction. | The RustCrypto `aes` soft backend is fixsliced/constant-time, so this is a speed question, not a safety one. |

**Recommendation: XChaCha20-Poly1305.** One small crate buys the removal of an
entire class of "did anyone remember the nonce budget?" obligation from a store
that is rewritten on every flag change, every `SANITIZER_VERSION` bump and every
re-sync. If the one-crate cost is judged too high, AES-256-GCM is acceptable
**only** with per-record HKDF subkey derivation, and that must be written down
next to the code, not assumed.

KDFs: `hkdf` 0.12 (subkey derivation) and `argon2` 0.5 (passphrase mode) — both
**already pulled in by `pgp`**, so neither is a new dependency once Phase 2
lands. `rand` (CSPRNG) likewise.

### 0.5 Prescribed `Cargo.toml` additions

Landed in Phase 0, in one commit, with the comment block written in the house
style — every non-obvious flag explains itself at the site:

```toml
# ── Mail encryption (see docs/mail_encryption_plan_a.md) ─────────────────────
# OpenPGP (RFC 4880 + RFC 9580), pure Rust. Chosen over `sequoia-openpgp`
# because sequoia's DEFAULT crypto backend is Nettle — a C library plus GMP, on
# three packaging targets one of which is CI-only — and its pure-Rust backend is
# gated behind `allow-experimental-crypto` + `allow-variable-time-crypto`, which
# its own README describes as unsuitable for general use. rPGP's whole backend is
# RustCrypto: no openssl, no nettle, no gmp anywhere in its manifest, which is
# the constraint the entire bundle is built around. Licence MIT/Apache-2.0
# (sequoia is LGPL, and this binary is statically linked).
#
# `default-features = false` drops `bzip2`: we need no compression to READ mail
# (the sender's choice of algorithm is attacker-controlled), and a decompressor
# we did not ask for is the same decompression-bomb channel that keeps
# COMPRESS=DEFLATE off in `async-imap` (mail plan B §3.6). An unsupported
# algorithm is a banner, not a silently enabled codec.
pgp = { version = "0.20", default-features = false }

# AEAD for the local store at rest (plan §2). XChaCha20-Poly1305 rather than the
# AES-GCM `pgp` already compiles, for one reason: a 192-bit nonce may be random
# per record, so a store that is rewritten on every flag change and every
# sanitizer bump carries no nonce budget, no counter, and no rollback hazard.
chacha20poly1305 = { version = "0.11", default-features = false, features = ["alloc", "getrandom"] }

# Subkey derivation (one master key, several purposes — never one key doing
# three jobs) and the passphrase KDF for the store's passphrase mode. BOTH are
# already in the tree transitively via `pgp`; named directly so the store's
# crypto does not silently change when rPGP changes its S2K dependencies.
hkdf = "0.12"
argon2 = "0.5"
sha2 = "0.10"    # already present
rand = "0.9"     # already present transitively; named for the CSPRNG
```

S/MIME (Phase 6 only, added in its own commit so it can be reverted alone):

```toml
# ── S/MIME (plan §10) ───────────────────────────────────────────────────────
# CMS/PKCS#7 (RFC 5652) and X.509 parsing. Pure Rust, Apache-2.0/MIT. `cms` is a
# PRE-RELEASE, which is exactly why the S/MIME track ships verify-only first.
# Every primitive underneath (rsa, p256, p384, aes, cbc, aes-gcm, sha2) is
# ALREADY compiled in by `pgp` — S/MIME adds format parsing, not cryptography.
cms = "0.3.0-pre.2"
x509-cert = "0.3"
const-oid = "0.10"
```

### 0.6 Build hazards to check first, each in its own commit

1. **Compile time and binary size.** rPGP is the largest crate this plan adds.
   Measure `cargo build --release` wall time and the stripped binary delta before
   and after Phase 0 and record both in the commit message. If the CI budget is
   exceeded, the fallback is not a different crate — it is `codegen-units`/`lto`
   tuning on the release profile.
2. **MSRV.** `pgp` 0.20 declares `rust-version = "1.88"`. Confirm the toolchain
   pinned by `.github/workflows/ci-cd.yml` on **all three** runners satisfies it
   *before* the dependency lands, not when Windows goes red.
3. **No second `CryptoProvider`.** rPGP does not use rustls, so it cannot
   introduce one — but assert it: extend the existing provider test in
   `services::mail_engine` to also assert `CryptoProvider::get_default()` is
   still `Some` after a `pgp` operation, so a future transitive `aws-lc-rs`
   arrival fails a test instead of panicking at a user's first handshake.
4. **Windows/macOS.** Nothing here is `cfg`-gated, which is the point — the same
   code compiles on all three. Verify by the existing route: the RC-shim +
   `cargo check --target x86_64-pc-windows-msvc` trick for Windows, and CI for
   macOS (which cannot be compile-checked on this machine).
5. **`getrandom`.** `chacha20poly1305`'s `getrandom` feature and `rand`'s must
   resolve to the same `getrandom` major; a mismatch is a link error, not a
   subtle bug, so it surfaces immediately.

---

## 1. Threat model delta

Plan B's table T1–T20 stands unchanged. Encryption adds threats of its own, and
the important half of them are threats *created by* the feature rather than
solved by it. A crypto UI is the one place in this app where a half
implementation is strictly worse than none: a tick that reads "this is really
from your bank" while meaning "some key signed some bytes" is a new attack, not
a mitigation. That sentence is already in plan B §6's deferral row; it is the
governing rule of this plan.

| # | Threat | Mitigation |
|---|---|---|
| **E1** | **EFAIL direct exfiltration** — the attacker wraps captured ciphertext in HTML so the decrypted plaintext is emitted into an attribute the renderer then fetches (`<img src="http://evil/?…`). | Structurally dead here, and it was dead before this plan: the sanitizer removes **every** URL-bearing attribute, the frame is `sandbox=""` with `default-src 'none'`, and the **app CSP has no `https:` in any fetch directive**. Decrypted content is sanitized by the *same* function on the *same* side of the IPC boundary as any other body. The one new rule: **decrypt before sanitize, never after** (§6.2) — and never render a fragment of a message that failed to decrypt whole. |
| **E2** | **EFAIL CBC/CFB gadget attacks** — malleability of an unauthenticated symmetric mode used to inject a gadget into the plaintext. | Refuse legacy unprotected packets. A `SymmetricallyEncryptedData` packet without MDC (SEIPDv1's integrity check) or AEAD (SEIPDv2) is **not decrypted at all**; the message renders as "encrypted with an obsolete, unauthenticated format Eldrun refuses to open" with no override. An MDC failure is a hard error, never a warning next to rendered content. |
| **E3** | **Decryption oracle** — an attacker mails crafted ciphertext repeatedly and learns from timing, from error text, or from an automatic reply. | Nothing is decrypted without an explicit user action opening that message (no decrypt-on-sync, no decrypt-in-preview, no decrypt-for-search-index). Failure reports one of a **closed set of coarse reasons** (`no-key`, `bad-mac`, `malformed`, `unsupported`) — never the library's error string, never a distinction between "padding wrong" and "MAC wrong". Plan B's T19 already forbids any automatic outbound message, which closes the reply channel. |
| **E4** | **Signature spoofing in the UI** — a message body that draws its own green "Verified — signed by your bank" banner, or a `From` display name containing a tick. | The verification chrome is rendered **only** from a backend-computed `MailCrypto` struct, never from anything message-derived, and the body cannot draw it: the frame is a separate document, the sanitizer's tag allowlist has no `svg`/`style`/`position`, and the CSS property allowlist excludes `position`, `z-index` and `content` (plan B T14). Additionally: **subject and display name are stripped of format controls and are never part of the crypto verdict**, because in PGP/MIME the headers are *outside* the signature (§9.2). |
| **E5** | **Signature-scope confusion** — a valid signature over a small inner part, presented as covering the whole message; or a `multipart/signed` whose displayed body is not the signed part. | Verify the canonical bytes of the signed part exactly as RFC 3156 §5 requires, and render **only** the part that was verified. If the message has other parts outside the signature, the UI says so in words ("part of this message is not covered by the signature") rather than downgrading the badge silently. A `multipart/signed` whose micalg/protocol parameters disagree with the actual packets is treated as unsigned. |
| **E6** | **Key substitution** — the attacker supplies a key for the sender's address (via an Autocrypt header, an attached key, or a keyserver) and gets their forgery verified. | TOFU with an explicit, visible first-contact event and a **loud, blocking change notice** when a known address's key changes (§4.3). Automatic key *adoption* from network sources is off by default. A verified signature by a key we accepted five seconds ago is displayed as *"signed by a key first seen just now"*, not as "verified". |
| **E7** | **Encrypting to the wrong key** — a compose-time substitution sends the plaintext to the attacker. | The recipient key shown in the composer names the fingerprint and where the key came from, per recipient. A recipient whose key changed since the last message to them **blocks the send** until acknowledged. Encryption to an *expired* or *revoked* key is refused outright, never downgraded to plaintext silently (§7.2). |
| **E8** | **Silent downgrade** — "encrypt" was on, one recipient has no key, and the message goes out in clear to everybody. | The refusal is the default (§7.2). There is no "send unencrypted" button inside the failure path; the user must turn encryption off explicitly, at which point the composer visibly changes state. Downgrade must cost a deliberate gesture, not a dismissal. |
| **E9** | **Plaintext leaking into the local store** — the whole point of E2E defeated by our own cache. | §2.10: decrypted bodies are **never** written to disk by default; the raw *ciphertext* is cached as usual (the server has it anyway); the preview column is empty for encrypted mail; the `bodies_cache` row is not written at all. |
| **E10** | **Plaintext leaking into the Sent copy** — the classic: you encrypt to them and APPEND a cleartext copy to `Sent`. | The Sent copy is the *same encrypted blob*, additionally encrypted to the sender's own key (§7.4). If the sender has no usable own key, the message is **not copied to Sent** and the composer says so, rather than uploading plaintext to the provider you just encrypted around. |
| **E11** | **Plaintext leaking into drafts** — autosaved drafts of a message you are encrypting. | Drafts of an encrypt-enabled compose are held in memory and, if saved, saved through the §2 store envelope *and* marked `sensitive` so they never sync to the server's Drafts folder. Draft-to-server sync is already out of scope (plan B §6). |
| **E12** | **Private key exfiltration** — the key file, its passphrase, or the unlocked key in a Tauri event payload / log / crash dump. | Same discipline as the IMAP password, reusing the same type: secret key material lives in `Zeroizing` buffers behind a `Debug` that prints a placeholder, is never serialized, never returned across IPC, never interpolated into an error. A tripwire test asserts no `mail_*` command returns a type whose name contains `Secret`/`Private`. |
| **E13** | **Attacker-controlled "key" files** — a message attaches `key.asc`, and importing it is one click. | An attached key is *parsed* and *displayed*; it is never imported without a click that shows the fingerprint and the addresses it claims. The project rule that **any message-derived file is attacker-controlled** applies verbatim: it goes through the normal blob path, is never written under a sender-supplied name, and importing it grants no filesystem access. |
| **E14** | **Denial of service via crypto** — a 100 MB compressed literal packet, a certificate with 10⁶ user-IDs, a key with an absurd RSA modulus. | The same posture as `mail_engine`'s structural caps: bounds *above* the library. Max armored/binary key size 1 MiB, max user-IDs per key 64, max recipients per encrypted message 256, max decrypted plaintext = `MAX_MESSAGE_BYTES` (50 MiB, already defined), max signature-verification wall clock 5 s, all crypto on `spawn_blocking`. `large-rsa` is **not** enabled. |
| **E15** | **Metadata is not protected, and users think it is.** | Subject, participants, timing and size are cleartext in every OpenPGP and S/MIME mail. The UI never implies otherwise: the encrypted badge's tooltip states in one sentence that the subject and recipients are visible to the mail provider. (Protected headers / "memory hole" — §7.6 — is a later, opt-in improvement, not a default.) |

---

## 2. The local mail store, encrypted at rest

This section stands alone. It applies to **every** account and every message,
E2E or not, and it can ship before a single line of OpenPGP code exists.

It also **reverses a decision** — plan B §5.2 argued "deliberately none in v1",
and `services/mail_store.rs`'s module header repeats the argument. That
reasoning was not wrong, and it is worth restating fairly before overriding it:
the threat is offline disk access, FDE is the correct and complete answer to
that, and putting the key in a keychain whose locked state Eldrun has been
burned by makes the whole mailbox unreadable at exactly the wrong moment. What
changes the balance is the third failure mode nobody weighted: **`~/.local/share`
is a directory that gets backed up, synced and copied**, by the user's own
backup tool, by a cloud sync client, by an `rsync` to a NAS, by a
`tar` handed to support. FDE protects a powered-off laptop; it does not protect
a copy of the directory that left the laptop. That is a real, common,
non-hypothetical leak of the *entire mailbox*, and it is what this section
closes. The availability objection is answered by making a missing key
**degrade**, not fail (§2.5) — which is the part plan B did not have a design
for and therefore correctly declined to ship.

### 2.1 What is on disk today, and how sensitive each piece is

From `services::mail_store` and `commands::mail::mail_dir()`
(`~/.local/share/eldrun/mail/`, `0700`; files `0600`):

| Path / table | Contents | Sensitivity |
|---|---|---|
| `accounts.json` | label, address, display name, IMAP/SMTP host+port+**username**, security, `save_password`, signature, `check_interval_min`, `authserv_id`. No secrets. | **Medium.** Identity and provider, plus a login name. A signature block often carries a real name, employer and phone number. |
| `mail.db` → `messages` | `subject`, `from_json`, `to_json`, `cc_json`, `date`, `preview` (240 chars of body text), flags, `size`, `rfc_message_id`, `authres_json`, `priority`. | **High.** `subject` + `preview` + participants is most of the content of most mail. This is the single most valuable table on disk. |
| `mail.db` → `bodies_cache` | `html` (sanitized), `text`, `links_json`, `raw_blob` pointer. | **Highest.** Full message bodies. |
| `mail.db` → `attachments` | sender-supplied `filename`, `mime`, `size`, `mismatch`, `blob` digest. | **High.** Filenames alone are often the story. |
| `mail.db` → `drafts` | the whole `MailDraft` as JSON — recipients, subject, body text. | **Highest.** Unsent mail, including things never sent. |
| `mail.db` → `folders`, `staged`, `mail_remote_allow` | folder paths/counts; staged attachment names/sizes; addresses allowed remote content. | **Medium.** Folder names leak structure; `mail_remote_allow` is a correspondent list. |
| `mail.db-wal`, `mail.db-shm` | **Anything the DB recently wrote**, including rows already deleted. WAL is on (`journal_mode = WAL`). | **Highest, and the most often forgotten.** |
| `blobs/<sha256>` | raw MIME of messages over `INLINE_BODY_LIMIT` (256 KiB) and **every attachment payload**. | **Highest.** Also: the filename *is* the SHA-256 of the plaintext, so possession of the directory listing lets anyone confirm whether a known file (a leaked document, a specific PDF) is in your mailbox — without reading a byte. |
| `outbox/<draft-id>/<staged-id>` | verbatim copies of files the user attached. | **Highest.** |

The structural properties worth keeping while encrypting: blob names are
content-addressed and opaque (so a sender-supplied filename never reaches a
syscall), and the store takes no path from the frontend. Neither is negotiable.

### 2.2 Non-goals, stated first

This does **not** aim to make the mailbox unreadable to an attacker who is
running code as your user while Eldrun is running. It cannot: the key is in the
process. Anything that promises otherwise is theatre. §2.9 is the honest table.

### 2.3 Why not SQLCipher, and why not whole-file encryption

**SQLCipher is disqualified by the bundle's founding constraint.** `rusqlite`'s
`sqlcipher` feature links against a SQLCipher build, and SQLCipher's crypto
provider is **OpenSSL** (or CommonCrypto on Apple, or LibTomCrypt). The
`bundled-sqlcipher-vendored-openssl` feature does exactly what its name says.
There is no rustls/RustCrypto provider for SQLCipher. Adopting it would put
libcrypto into a bundle that has been kept free of it deliberately, on three
platforms, for one cache file. Rejected, and the reason is worth a comment in
`Cargo.toml` so it is not re-proposed every year.

**Whole-file encryption of `mail.db` is worse than doing nothing.** It requires
decrypting to somewhere before SQLite can mmap it — which means either a
plaintext temp file (the exact leak §2.8 exists to prevent, now with the whole
database in it) or holding the entire mailbox in RAM and losing WAL durability.
Both trade a diffuse risk for an acute one.

**Page-level encryption implemented by hand** (a custom VFS) is a serious piece
of work with a serious failure mode: get the page/IV mapping wrong and you have
an encrypted database that silently corrupts. Not for a side feature.

### 2.4 The design: envelope AEAD per value, per blob

Encrypt **values**, not the container. Structural columns stay cleartext so
SQLite keeps doing what it is good at; sensitive columns and every blob payload
become opaque envelopes.

**The envelope** (a single format, used everywhere, versioned in byte 0):

```
byte  0        : format version (0x01)
bytes 1..25    : nonce (24 bytes, XChaCha20-Poly1305, from the OS CSPRNG)
bytes 25..     : ciphertext || Poly1305 tag
AAD (not stored, recomputed on read):
    b"eldrun-mail-v1" || 0x00 || <purpose> || 0x00 || <record identity>
```

In SQLite the envelope is stored as a `BLOB` in the same column (SQLite is
dynamically typed, so `subject BLOB` and `subject TEXT` coexist during
migration — which is what makes the migration in §2.7 restartable).

**The AAD is the load-bearing part, and it is free.** Binding each ciphertext to
its own row identity — `messages:<message_id>:subject`,
`bodies_cache:<message_id>:html`, `blob:<name>` — means an attacker with *write*
access to the disk cannot relocate a ciphertext: they cannot move message A's
body into message B's row, cannot swap two attachments, cannot replay a deleted
row into a live one. Without AAD, all of those decrypt cleanly and the UI shows
the attacker's chosen content under someone else's name. This costs one string
concatenation and closes a class of attack that at-rest encryption is otherwise
famous for leaving open.

**Which columns are encrypted:**

| Table | Encrypted | Left cleartext, and why |
|---|---|---|
| `messages` | `subject`, `from_json`, `to_json`, `cc_json`, `preview`, `malformed`, `rfc_message_id`, `authres_json` | `id`, `account_id`, `folder_id`, `uid`, `date`, `seen`, `flagged`, `answered`, `deleted`, `has_attachments`, `size`, `priority` — every one of these is either a join key or an `ORDER BY`/`WHERE` target (`messages_by_folder`, `messages_by_priority`). Encrypting them means giving up paging, sorting and the priority badges. |
| `bodies_cache` | `html`, `text`, `links_json` | `message_id`, `version`, `remote_refs`, `truncated`, `raw_blob` (the blob *name*, which is already keyed — see below). |
| `attachments` | `filename`, `mime`, `mismatch` | `message_id`, `part_id`, `size`, `inline`, `blob`. |
| `drafts` | `json` (the whole draft) | `id`, `account_id`. |
| `staged` | `filename`, `mime` | `draft_id`, `staged_id`, `size`. |
| `folders` | `path`, `name` | `id`, `account_id`, `kind`, `unread`, `total`. (`UNIQUE(account_id, path)` must move to a keyed digest of the path — see below.) |
| `mail_remote_allow` | — | the whole table is one column of addresses; replace the primary key with `HMAC(k_name, addr)` and store the address as an envelope beside it. |
| `accounts.json` | The whole file becomes `accounts.json.enc` (one envelope over the serialized `MailAccounts`), written through `storage::write_json_atomic`'s replacement `write_bytes_atomic`. | Nothing. It is small, it is read whole, and it has no query surface. |
| `blobs/` | Payloads, per file | See below. |

**Uniqueness constraints over encrypted columns.** `folders` has
`UNIQUE(account_id, path)` and `put_blob` dedupes by digest. Randomized AEAD
destroys both. The fix is one keyed digest per identity:
`path_key = HMAC-SHA256(k_name, account_id || 0x00 || path)`, stored as a new
cleartext column carrying the `UNIQUE`, with the readable `path` stored as an
envelope beside it. This leaks *equality* only (two folders with the same name in
the same account are the same folder — which the schema already asserts) and
leaks nothing to someone without `k_name`.

**Blobs.** `put_blob` currently names a file by `SHA-256(plaintext)`. Two
problems at once: the name leaks the content (a known-file confirmation oracle
against a directory listing), and encrypting under a random nonce breaks
dedupe. Both are solved by one change: name the file
`HMAC-SHA256(k_name, plaintext)` and store the AEAD envelope inside it, with AAD
`blob:<name>`. Dedupe survives (the name is deterministic in the plaintext),
the name is meaningless without `k_name`, and the AAD stops file-swapping.
`get_blob`'s existing 64-hex-digit validation is unchanged — the name is still
64 hex characters, it simply means something different.

`outbox/<draft-id>/<staged-id>` gets the same envelope with AAD
`staged:<draft_id>:<staged_id>`; `staged_bytes` decrypts on read. The file is
consumed by `build_outgoing` in memory and never handed to another process.

**WAL and freelist.** Because we encrypt *values*, the WAL and the freelist only
ever contain envelopes. That is a real advantage of value-level encryption over
"encrypt the file after the fact": there is no window in which SQLite writes
plaintext anywhere. The one exception is the **migration** of an existing
plaintext store, which is why §2.7 ends with `VACUUM INTO` a new file rather
than an in-place rewrite.

### 2.5 The key, and what happens when it is not there

**Key hierarchy.** One 32-byte **store master key** (SMK) from the OS CSPRNG,
generated once. Everything else is derived, so no key ever does two jobs:

```
k_db    = HKDF-SHA256(SMK, salt, info = b"eldrun/mail/v1/db")
k_blob  = HKDF-SHA256(SMK, salt, info = b"eldrun/mail/v1/blob")
k_name  = HKDF-SHA256(SMK, salt, info = b"eldrun/mail/v1/name")
k_acct  = HKDF-SHA256(SMK, salt, info = b"eldrun/mail/v1/accounts")
```

`mail/store.key` (0600) holds a small JSON header — **never the raw SMK**:
`{ version, mode, key_id, salt, kdf: {…}, wrapped_smk?, verifier }`. `verifier`
is an envelope over a fixed plaintext, so a wrong or rotated key is reported as
*"this store was encrypted with a different key"* rather than surfacing as
database corruption. `key_id` is a HKDF-derived public identifier, safe to log.

**Three modes** (`Settings.mail_store_encryption`: `"keychain" | "passphrase" | "off"`):

| Mode | SMK lives | Locked-keyring behaviour | Cost to the user |
|---|---|---|---|
| **`keychain` — recommended default for new stores** | OS keychain, via `services::remote_credentials` under a new account key `mail:store-key` (backend-minted, alongside `mail_account(…)` at `remote_credentials.rs:79`). | Degrades to **memory-only** (below). | None while the keyring is unlocked. |
| **`passphrase`** | Nowhere. `store.key` holds `wrapped_smk` = AEAD(Argon2id(passphrase, salt), SMK). Prompted once per app start; the derived key is held in a `Zeroizing` buffer for the session. | Irrelevant — no keychain involved. | A prompt at every launch. Stated up front, in those words, before the mode is chosen. |
| **`off`** | Nowhere; the store is plaintext, exactly as today. | n/a | None. Kept because a store you cannot open is worse than one somebody else could read, and because an existing user must be able to say no. |

**Argon2id parameters** for the passphrase mode: `m = 64 MiB, t = 3, p = 1` as
the floor, stored in `store.key` so raising them later does not orphan existing
stores. Not the RFC 9106 low-memory profile — this runs once per launch on a
developer workstation, not per request on a server.

**Does the "secrets are never persisted by default" rule forbid this?** No, and
the distinction matters. That rule is about **secrets the user supplied** — an
SSH password, a VPN credential, an IMAP password — where persisting one without
being asked is taking a decision on the user's behalf about their account
security elsewhere. The SMK is a machine-generated key that exists only to
protect data this app already wrote to disk on the user's instruction; not
storing it does not make the user safer, it makes the cache plaintext. The rule
that *does* apply, and applies verbatim, is the mechanical one:

- Writes go through `remote_credentials::remember_secret` (`:494`) and surface
  `RememberOutcome { saved, error }` — never `let _ = set(…)`.
- Reads go through `get` (`:200`), which is `read_timed`-bounded and consults
  `cached_keyring_state()` first, so **a locked collection is never dispatched
  to**. This is the entire locked-keyring lesson and mail must inherit it, not
  reinvent it.
- **`false` is unrepresentable.** Nothing clears the store key implicitly. There
  is exactly one destructive path, an explicit *"Forget the mail store key
  (deletes the local cache)"* action that says what it destroys before it does
  it.
- **No keychain read on a launch path.** `MailStore::open` must not prompt.

**The degrade — the answer plan B §5.2 was missing.** When the SMK cannot be
obtained (keyring locked, keyring unavailable, passphrase not yet entered), the
mail subsystem enters **memory-only mode**:

- The existing encrypted store is **not** opened for reading; the pane shows
  *"Local mail is locked"* with an **Unlock keyring** button wired to the
  existing `keyring_unlock` command (`commands/credentials.rs`) — reachable
  **only from a click**, never from a launch or poll path, because those paths
  promise not to prompt.
- Sync, if the user starts one, **still works**. Headers and bodies are held in
  a bounded in-memory store for the session (the same LRU §2.10 defines) and
  nothing is written to disk. Mail is readable; it is simply not cached.
- Nothing is ever written in plaintext as a fallback. That is the rule that
  makes the whole section mean something: a degrade that quietly writes cleartext
  is not a degrade, it is an off switch nobody sees.
- The account list still loads: `accounts.json.enc` is encrypted under `k_acct`
  and therefore also locked, so a locked store shows *"locked"* rather than *"no
  accounts"* — the exact distinction `docs/context/remote_credentials.md` insists
  on, applied one level up.

This is strictly better than both alternatives plan B weighed: it is not the
"whole mailbox unreadable" failure it feared, and it is not the plaintext cache
it settled for.

### 2.6 Consequences for search, sorting and paging

`MailStore::headers_page` (`mail_store.rs:398`) currently filters with
`subject LIKE ?2 OR from_json LIKE ?2 OR preview LIKE ?2` and counts with the
same predicate. All three columns become opaque. Options:

1. **Decrypt-and-filter in Rust** (**recommended**). Drop the `LIKE` clauses from
   SQL; select the folder's rows ordered by the existing `order_clause`, decrypt
   `subject`/`from_json`/`preview` per row, match case-insensitively in Rust,
   and page the *filtered* sequence. Cost: a query with a search term becomes
   O(folder) AEAD opens instead of an index-free `LIKE` scan — which is what it
   already was, since `LIKE '%x%'` uses no index either. XChaCha20-Poly1305 opens
   a 240-byte preview in well under a microsecond; ten thousand rows is a few
   milliseconds, on `spawn_blocking`, where every store call already runs. An
   empty query (the common case) skips decryption entirely for rows outside the
   page.
2. **Blind index** — store `HMAC(k_name, token)` per subject token and match
   exact tokens. Faster, but it leaks token equality across the whole mailbox to
   anyone with the file, turns substring search into token search, and needs a
   tokenizer that then becomes a security-relevant component. **Rejected.**
3. **SQLite FTS5 over plaintext** — defeats the entire section. Rejected.

Sorting is unaffected: `date`, `flagged`, `has_attachments`, `size` and
`priority` all stay cleartext, so `order_clause`'s fixed literals and both
indexes are untouched. `total` for a query is computed from the same filtered
pass rather than a second `COUNT(*)`.

Guard rail: cap the decrypt-and-filter pass (e.g. 50 000 rows) and report
*"showing matches from the most recent N messages"* rather than blocking. A
search that silently truncates is worse than one that says it did.

### 2.7 Migrating an existing plaintext store

The mail client shipped on 2026-07-26, so plaintext stores exist. Migration runs
inside `MailStore::open` (`mail_store.rs:59`), after `migrate()`, and must be
**restartable** — it can be interrupted by a crash, a laptop lid, or a `SIGKILL`.

1. Bump `SCHEMA_VERSION` (`:40`) to 2 and add a `meta` key
   `store_encryption = "v1"`, written **last**.
2. Generate the SMK, write `store.key`, store/wrap per the chosen mode. If this
   fails, abort the migration and leave the store plaintext (no data loss).
3. For each table, in batches inside a transaction: read the row, encrypt the
   sensitive columns, write them back. **Idempotence** comes from the envelope's
   magic byte — a value that already starts with `0x01` and parses as an envelope
   is skipped. An interrupted run therefore resumes correctly.
4. For each blob: read, compute the new HMAC name, write the envelope under it,
   `remove_file` the old SHA-named file. Same idempotence rule.
5. `accounts.json` → `accounts.json.enc`, then remove the plaintext file.
6. **`VACUUM INTO 'mail.db.new'`, then swap and delete the old files.** This is
   the step that is easy to skip and cannot be: an in-place `UPDATE` leaves the
   old plaintext in freelist pages and in the WAL. `VACUUM INTO` writes a fresh,
   compact database containing only live pages. Delete `mail.db`, `mail.db-wal`
   and `mail.db-shm` afterwards — all three.
7. Write `store_encryption = "v1"`.

**Secure deletion: say what is true.** Overwrite-then-unlink is *best effort and
mostly theatre* on the filesystems this app runs on. ext4 with `data=ordered`,
btrfs and APFS (copy-on-write), NTFS, and every SSD's wear-levelling FTL all
retain the old blocks; the filesystem may never rewrite the sectors you think you
overwrote. So:

- We do one best-effort overwrite pass on the old plaintext files before
  unlinking. It costs nothing and helps on a plain overwrite-in-place filesystem.
- The migration report tells the user, in one sentence, that **previously written
  plaintext may survive in unallocated disk space, and that only full-disk
  encryption or a filesystem-level secure erase removes it.** That is the
  honest statement, and it is also the strongest argument for FDE remaining the
  primary recommendation rather than being displaced by this feature.
- A **"Delete local mail and re-sync"** action (a superset of the existing
  `clear_cached_mail`, `mail_store.rs:952`) is offered as the clean-slate option:
  a store that is created encrypted from the first byte never had a plaintext
  generation to leak.

**Downgrade.** Turning encryption off decrypts in place and then requires the
same warning in the other direction. It is offered (the user owns their disk) but
it is a deliberate, confirmed action, not a toggle that silently rewrites 4 GB.

### 2.8 Attachments, previews, and temp files

Temp-file leakage is the classic hole in an encrypted mail store, and Eldrun's
existing design has already closed most of it — the value here is in *keeping* it
closed and adding a tripwire so it stays closed.

- **Preview** (`mail_attachment_preview`, `commands/mail.rs:1491`) returns
  bounded base64 bytes over IPC and the pane renders them from a `data:` URI.
  **Nothing touches the filesystem.** No change needed; the decrypted bytes exist
  in the backend heap and the webview heap and nowhere else.
- **Save** (`mail_attachment_save`, `:1441`) writes plaintext to wherever the
  user's native save dialog said. That is correct and must not change — the user
  asked for the file. But it *is* a plaintext exit from the encrypted store, so
  the save toast should say where it went (it already does) and the account
  dialog's help text should note that saved attachments are ordinary files.
- **Staged outbound attachments** (`stage_attachment`, `mail_store.rs:869`)
  currently land as verbatim copies in `outbox/<draft-id>/`. These become
  envelopes (§2.4). This is the one place the existing code writes plaintext
  user files into the mail dir, and it is easy to miss.
- **No temp files anywhere in the mail path.** `tempfile` is a dependency of the
  crate (used by tests and other subsystems). Add a tripwire test that scans
  `services/mail_*.rs` and `commands/mail.rs` for `tempfile::`,
  `std::env::temp_dir`, `NamedTempFile` and `TempDir` outside `#[cfg(test)]`, and
  fails. It is a mechanically-checkable statement of "decrypted mail never
  becomes a file", which is exactly the kind of invariant the repo already
  enforces this way (`no_command_takes_a_path`, `commands/mail.rs:1551`).
- **Crash dumps.** `crash.rs` receives renderer crash reports; ensure no mail
  body ever reaches it. Bodies live in the message pane's iframe, whose document
  is not part of the app document — but assert it rather than assume it.

### 2.9 What this defends against, and what it does not

| Scenario | Covered? | Notes |
|---|---|---|
| Laptop stolen, powered off, FDE on | Already covered by FDE | This adds nothing. Say so. |
| Laptop stolen, powered off, **no FDE** | **Yes** | The main case for a user who never set up LUKS/BitLocker/FileVault. |
| Laptop stolen while suspended, screen locked, **keychain relocked on lock** | **Yes, partially** | The SMK may still be resident in Eldrun's RAM. A cold-boot/DMA attacker gets it. A thief who reboots does not. |
| `~/.local/share` copied into a backup, a cloud sync folder, a NAS, a support tarball | **Yes — this is the strongest case** | FDE protects the disk, not the copy. This is the leak nobody plans for. |
| Another local user reads the file because a permission bit was wrong | **Yes** | Belt to the existing `0700`/`0600` braces. |
| Disk sent for RMA / resold without wipe | **Yes** for newly-written data; **no** for pre-migration plaintext (§2.7). | Be explicit about the asymmetry. |
| Malware running as your user, **while Eldrun runs** | **No** | It can read the process, read the keychain (which is unlocked for the session), or simply drive the app. |
| Malware running as your user, Eldrun **not** running, keychain locked | **Yes** | It gets envelopes. |
| Forensic RAM image / hibernation file | **No** | The SMK and any open plaintext are in memory. `zeroize` reduces the window; it does not close it. Hibernation writes RAM to disk — note it. |
| A compromised mail provider | **No** — that is §§3–10's job | The at-rest and E2E tracks answer different questions and neither substitutes for the other. |

**The recommendation stays: use full-disk encryption.** This feature is defence
in depth for the cases FDE structurally cannot reach — copies that leave the
machine — and a reasonable default for a user who has not set FDE up. The
account dialog's wording changes from plan B §5.2's *"Messages are stored
unencrypted… use your operating system's disk encryption"* to a two-line
statement that names both layers and what each one does.

### 2.10 Interaction with the E2E track: never cache decrypted plaintext

The tempting shortcut is to decrypt a PGP message once, run it through the
sanitizer, and put the result in `bodies_cache` under the store envelope. **Do
not.** It would make the store key cryptographically equivalent to the PGP
private key for every message ever opened — silently downgrading an end-to-end
guarantee to an at-rest one, in a place the user cannot see. An adversary who
compromises the keychain then reads years of "end-to-end encrypted" mail without
ever touching the PGP key.

**Policy, and it is the default:**

| Artifact of an E2E-encrypted message | Where it goes |
|---|---|
| Raw ciphertext MIME | Cached exactly as today (blob or inline). It is already ciphertext, and the server has it anyway. |
| Decrypted, sanitized HTML/text | **Memory only.** A bounded LRU on `MailRuntime` (`commands/mail.rs`): cap 32 messages / 32 MiB, evicted on overlay close, on account switch, and at `RunEvent::Exit`. Never a `bodies_cache` row. |
| `preview` column | **Empty string** for an encrypted message. The header list shows an 🔒 marker instead. A 240-character preview of a decrypted body written into the most-read table on disk is the leak in miniature. |
| `subject` | Whatever the cleartext headers said — encrypted at rest like any other subject, and **not** part of any signature (§9.2). |
| Decrypted attachments | Streamed to preview/save on demand from the cached ciphertext. Never a decrypted blob. |
| Verification result (`MailCrypto`) | **Recomputed on every read**, never persisted — the same rule and the same reason as `MailAuthResults.state` (`schema/mail.rs:335`): a stored verdict goes stale when a key is revoked, expires, or is re-verified, and a stale green tick is the worst artifact this feature can produce. |

There is one **opt-in per account**, default **off**: *"Keep decrypted copies of
encrypted mail in the local cache (protected by the store key)"*, for a user who
wants offline search of their encrypted mail and understands the trade. Its help
text states the downgrade in one sentence. It carries `<UntestedTag />` and it
is the sort of switch that should stay hard to find.

Consequence to accept: **encrypted mail is not searchable offline** unless that
switch is on, and re-opening an encrypted message after a restart re-runs the
decryption (and re-prompts for the key passphrase if the cache expired). Both are
correct.

---

## 3. Key management (OpenPGP private keys)

### 3.1 Where private keys live

**Not in the OS keychain.** A keychain entry is a small string store; an OpenPGP
transferable secret key with several subkeys and photo UIDs is not small, and
more importantly the keychain's locked state would then gate the *keys*
themselves, reintroducing exactly the failure §2.5 works to avoid — but this time
with no memory-only degrade available (you cannot "run without a key" and still
decrypt).

**Private keys live in the mail directory, encrypted at rest by two independent
layers:**

```
~/.local/share/eldrun/mail/
  keys/
    secret/<fingerprint>.pgp      # rPGP's own passphrase-encrypted (S2K) form,
                                  # then wrapped in the §2 store envelope
    public/<fingerprint>.pgp      # the local keyring (§4), store envelope only
    keys.db                       # metadata index: fpr, uids, addrs, created,
                                  # expires, revoked, trust, first_seen, source
```

The two layers are deliberately different in kind: the **inner** layer is
OpenPGP's own S2K passphrase encryption, which is what makes the file safe to
copy elsewhere and is the format every other client understands; the **outer**
layer is the store envelope, which means a stolen `mail/` directory yields
nothing at all rather than "a key file to brute-force at leisure". A key imported
without a passphrase (some people generate them that way) is **still** wrapped by
the store envelope — and the import flow says, in plain words, that an
unprotected key is protected only by the store key and offers to set a
passphrase.

`keys.db` is a separate SQLite file rather than tables in `mail.db` for one
practical reason: **"Clear cached mail" and "Delete local mail for this account"
must never be able to delete a private key.** Separate files make that
structural instead of a careful `DELETE` clause.

### 3.2 Passphrase handling and caching policy

- The passphrase is entered in a dialog, sent to the backend once, and lives
  there in a `Zeroizing<String>` behind the same `Debug`-redacting discipline as
  `mail_engine::Password` (`mail_engine.rs:102`). **It never enters the frontend
  and is never returned.** Reuse the type; do not write a second one.
- **Caching is opt-in and time-boxed.** Default: **not cached** — every decrypt
  or sign asks. The account dialog offers *"Remember for this session"*
  (in-memory, dies with the process) and *"Remember for N minutes"* (default
  15 when enabled, sliding on use, wiped on a timer, on overlay close, and at
  exit). There is deliberately **no "remember forever"**, and there is no
  keychain option: a passphrase in the keychain is a passphrase whose protection
  is the keychain, which is the thing the passphrase exists to be independent of.
- The cache is keyed by fingerprint, so unlocking a signing key does not unlock a
  different decryption key.
- Failed unlocks are rate-limited (exponential backoff after 3, capped) — not
  because a local attacker is bounded by it, but because it stops a UI bug from
  becoming a passphrase-guessing loop.

### 3.3 Import, export and generation

**Import** (`mail_key_import`) accepts armored or binary key material from
exactly two sources, both explicit:

1. A file the user picks — through a **backend-raised** native open dialog,
   exactly as `mail_attach_pick` does (`commands/mail.rs:1363`). The command takes
   no path. This is not negotiable: it is the whole §3 of plan A.
2. A key **attached to or embedded in a message** the user is reading. The bytes
   come from the store's blob, not from the filesystem, so no new path appears.

The import dialog shows, before anything is written: fingerprint (grouped, in a
monospace face), every user-ID and its address, creation and expiry, algorithm
and size, whether it is a secret key, whether it is revoked, and whether a key
for any of these addresses is already known — with a **diff** if so. Nothing is
imported implicitly. A key claiming an address that already has a *different*
key is the E6 case and gets the loud treatment in §4.3.

**Export** (`mail_key_export`) writes armored **public** keys through a
backend-raised save dialog. Exporting a **secret** key is a separate, confirmed
action that (a) requires the passphrase, (b) refuses to export a key that has no
passphrase without first setting one, and (c) states plainly that the file is a
copy of the key and is only as safe as where it is put.

**Generation** (`mail_key_generate`): Ed25519 signing primary + X25519
encryption subkey (v6 keys per RFC 9580 if the counterpart ecosystem supports
them — offer v4 as the compatibility default and say why in one line, because a
v6 key is unreadable to a lot of deployed software). Mandatory passphrase; the
dialog refuses an empty one. Default expiry **2 years**, renewable — a
non-expiring key is a key that can never be retired, and the failure mode of an
expiring key (a renewal prompt) is far better than the failure mode of a
compromised eternal one. A revocation certificate is generated at the same time
and the user is walked through exporting it *before* the key is used, because
generating it later requires the key you may have lost.

Backup: an explicit *"Back up this key"* action, never automatic, never into the
project tree, never into a synced folder without saying so.

### 3.4 The locked-keyring bug class, addressed head on

Private keys are not in the keychain (§3.1), so the classic
`read_timed`/hang/`false`-clears-it triple applies only to the **store key**
(§2.5) — where it applies verbatim, through the existing module, with the 4 s
bound and the `cached_keyring_state()` short-circuit. Restating the four rules
because they are cheap to get wrong and expensive to debug:

1. Every keychain read goes through `remote_credentials::get` (`:200`). Never a
   raw `keyring::Entry`. Never on a launch path.
2. A locked collection renders as **"Keyring locked — unlock to use the saved
   key"** with an **Unlock keyring** button, **never** as "no key saved".
3. `remember: true | null` — never `false`. Deleting a stored key happens only
   through an explicit, named, confirmed action.
4. A failed write surfaces `{ saved, save_error }` and the dialog renders what
   the keychain actually did.

### 3.5 Hardware tokens: explicitly out of scope, with the reason

YubiKey/OpenPGP-card support means PC/SC (`pcsc` → the platform smartcard
service), a card-application state machine, PIN handling with retry counters
that *brick the card* when exhausted, and a per-OS driver story. It is a
separate project with a hardware-dependent test matrix that CI cannot run. If it
is ever added, the seam is already right: §11's `MailCrypto` trait puts every
private-key operation behind `sign()`/`decrypt()`, so a card backend is a second
implementor, not a rewrite.

---

## 4. Public key and certificate discovery

### 4.1 The options

| Source | What it costs | What it leaks | Verdict |
|---|---|---|---|
| **Key attached to a message** (`application/pgp-keys`) | Nothing — the bytes are already in the store. | Nothing. | **On, but never automatic**: parsed, shown, imported on a click. |
| **Autocrypt header** (`Autocrypt: addr=…; keydata=…`) | A header parse. Widely deployed (Delta Chat, Thunderbird, K-9/Thunderbird for Android). | Nothing — no network. | **On by default for *display*; opt-in for automatic adoption** (§4.2). |
| **Autocrypt Gossip** (`Autocrypt-Gossip` inside an encrypted message) | A parse of an *already decrypted* part. | Nothing. | **Read, stored as a weak hint, never auto-adopted.** A gossip key is asserted by a third party. |
| **WKD** (Web Key Directory, `https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<zbase32>`) | An HTTPS GET per address. | **The queried address, to the recipient's own domain** — i.e. to the organisation you are already mailing. Much better than a keyserver. | **Off by default, one click per address**, with the query visible (§4.2). |
| **Keyservers** (HKP/`keys.openpgp.org`) | An HTTPS GET. | **Your entire correspondent graph to a third party**, over time, correlated with your IP. | **Off, and not offered as an automatic mode at all.** A manual "look up this address on a keyserver" action exists behind the same one-click-per-address gate; it is not a background process. |
| **DANE/OPENPGPKEY DNS records** | A DNSSEC-validating resolver. | The query, to your resolver. | **Not implemented.** No DNSSEC resolver in the tree, and without DNSSEC validation the record is worthless. Say so rather than shipping an unvalidated lookup. |
| **Manual import** | A click. | Nothing. | Always available; the fallback that always works. |

### 4.2 Recommended defaults, and the argument

**Default: no network lookup happens without a click.** This is not caution for
its own sake — it follows from a property this app already has and has spent real
design effort keeping: *nothing in the mail feature reaches the network on its
own* (`MailIndicator`'s interval timer is the sole exception, and it is gated on
a flag that is off for non-debug users). A background key-discovery process would
be a second exception, driven entirely by **attacker-controlled addresses**: a
spam message from `<anything>@attacker.example` would make Eldrun issue an
HTTPS request to a host of the attacker's choosing, confirming the address is
live and revealing the user's IP. That is the tracking-pixel problem with a
different transport, and this app blocks tracking pixels structurally.

So the shape is:

- **Passive sources** (attached keys, Autocrypt headers, gossip) are parsed on
  message open, cost nothing, and populate a *"keys offered by this message"*
  affordance in the message pane. Nothing is adopted.
- **Active sources** (WKD, keyserver) run **only** from a click, on **one**
  address, in a UI that shows the exact URL before it is fetched and the result
  before it is trusted.
- The fetch reuses `reqwest` (already in the tree, `rustls-no-provider`) and
  **must go through the browser's SSRF gate** — `web_safety::navigation_decision`
  plus `browser_engine::resolve_hop`'s hop-0-vs-later-hop rule and address
  pinning. A WKD URL is derived from an attacker-supplied domain; without the
  gate, `openpgpkey.169-254-169-254.<wildcard-resolver>` is one DNS answer away
  from the metadata endpoint. Caps: 5 s, 512 KiB, 2 redirects, no cookies, no
  auth headers, no `Referer`, fixed generic UA — the reader-mode fetch's
  parameters, reused rather than re-chosen.
- **Autocrypt automatic adoption** is a per-account opt-in (default off) because
  it is the one passive source that is *designed* to be adopted automatically and
  is therefore the one whose off-by-default costs the most usability. Turning it
  on adopts a key **only** for an address that has no key yet (first contact),
  never as a replacement — a replacement is always §4.3's blocking event.

### 4.3 Trust model: TOFU, visible, and loud on change

There is no Web of Trust in this plan, and that is deliberate: signature chains
and trust-signature arithmetic are a large design surface whose output the user
has to interpret, and misinterpreting it is the failure mode. What ships is
**TOFU with an honest vocabulary**, three states and no fourth:

| State | Meaning | Rendered as |
|---|---|---|
| `verified` | The user explicitly confirmed this fingerprint for this address (compared out of band, or imported deliberately from a file). | Full-strength positive chrome, with the address. |
| `accepted` | Seen and used, but never confirmed out of band (TOFU). | Neutral chrome with the words *"first seen <date>"*. **Not green.** |
| `unknown` / `none` | No key, or a key we have never used for this address. | No crypto chrome at all. |

A key's `first_seen` and `source` (attached / autocrypt / wkd / keyserver /
file / generated) are stored in `keys.db` and **shown**, because "where did this
key come from" is the question that decides whether a signature means anything.

**Key change is an event, not a state transition.** If a message from an address
with a known key is signed by, or offers, a *different* key, the message pane
raises a blocking, non-dismissible-by-accident notice naming both fingerprints,
the dates, and the sources — and the signature verdict for that message is
**suppressed** until the user decides. Silently rolling forward is precisely
E6. A revoked or expired key is likewise a named state, never an absence.

### 4.4 S/MIME certificate discovery

S/MIME has one discovery mechanism that actually works in practice and it is
free: **certificates ride along inside `SignedData`**. Every signed S/MIME
message carries the signer's certificate and usually its chain. So:

- Harvest the signer certificate from any verified `application/pkcs7-signature`
  and store it in `keys.db` keyed by its `rfc822Name` SAN, with the same
  TOFU vocabulary as §4.3 plus, additionally, whether the chain reached an OS
  trust anchor.
- To *encrypt* to someone with S/MIME you need their certificate, which means
  they must have signed something to you first — this is exactly how every
  S/MIME deployment works, and the composer should say so in those words when a
  recipient has no certificate, rather than showing a generic failure.
- **No LDAP directory lookup**, no corporate GAL integration: it is a second
  network protocol, a second auth surface, and (crucially) it is
  site-specific — and this repo does not ship institution-specific
  configuration.

---

## 5. Per-account configuration

Encryption is per account, because the identity that owns a key is an email
address. Additions to `schema::mail::MailAccount` (`schema/mail.rs:61`), each
`#[serde(default, skip_serializing_if = …)]` so an older build round-trips them
through the existing `#[serde(flatten)] extra`:

```rust
/// End-to-end encryption for this account. `None`/absent = disabled, which is
/// what every existing account deserializes to.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub crypto: Option<MailAccountCrypto>,
```

```rust
pub struct MailAccountCrypto {
    /// Which schemes are active. Both may be on: a mailbox can receive OpenPGP
    /// from one correspondent and S/MIME from another, and refusing to verify
    /// one because the other is configured would be an arbitrary limitation.
    pub openpgp: bool,
    pub smime: bool,
    /// Fingerprint (OpenPGP) / SHA-256 of the DER cert (S/MIME) of the key this
    /// account signs and decrypts with. A *reference into `keys.db`*, never key
    /// material — this struct is written to `accounts.json`, which by rule
    /// carries no secret of any kind.
    pub openpgp_key: Option<String>,
    pub smime_cert: Option<String>,
    /// Sign every outgoing message by default. Default false.
    pub sign_by_default: bool,
    /// Encrypt by default *when every recipient has a usable key*. Default
    /// false. Never means "encrypt if possible, else send in clear" — see §7.2.
    pub encrypt_by_default: bool,
    /// Reply to an encrypted message with encryption on, regardless of the
    /// default. **Default true**, and it is the single most useful setting
    /// here: it is what stops a thread from silently falling back to plaintext
    /// on the reply, which is how most real-world leaks of encrypted threads
    /// happen.
    pub encrypt_replies_to_encrypted: bool,
    /// Adopt an Autocrypt key automatically on FIRST contact only. Default false.
    pub autocrypt_adopt: bool,
    /// Send an `Autocrypt:` header on outgoing mail. Default false — it is an
    /// outbound disclosure of your key on every message, including to people
    /// you did not choose to tell.
    pub autocrypt_send: bool,
    /// Keep decrypted bodies in the local cache (§2.10). Default false.
    pub cache_decrypted: bool,
    /// Passphrase cache policy: none | session | minutes(u32). Default none.
    pub passphrase_cache: MailPassphraseCache,
}
```

`Settings` (`schema/settings.rs`) gains exactly one field, because store
encryption is machine-level and not per account:

```rust
/// Mail: how the local mail store is protected at rest (plan §2).
/// `None` = "not yet chosen" for an existing installation, which is what makes
/// the one-time migration prompt possible; a fresh install writes "keychain".
#[serde(default, skip_serializing_if = "Option::is_none")]
pub mail_store_encryption: Option<String>, // "keychain" | "passphrase" | "off"
```

**`MailAccountDialog.tsx` changes** — a new *Encryption* section, using the
canonical dialog chrome already established in that file, carrying
`<UntestedTag />` on the section header until the user confirms it live:

- Scheme toggles (OpenPGP / S/MIME), each disabled with a reason when no key is
  configured — an enabled toggle that cannot work is the OAuth-preset mistake
  plan B §0.4 refused to repeat.
- A key picker listing keys from `keys.db` whose UIDs include this account's
  address, showing fingerprint + expiry; plus **Import…**, **Generate…** and
  **Export public key…** buttons.
- The four behaviour switches, in the order above, with the reply-encryption one
  visually first among the defaults because it is the one that prevents the most
  real leakage.
- The passphrase-cache selector, with the "never" default and one line saying
  what each option means.
- A one-line honesty note: *"Subject lines, recipients and timing are not
  encrypted by OpenPGP or S/MIME and remain visible to your mail provider."*

A **separate machine-level panel** in `SettingsPanel.tsx`, beside the existing
mail block, owns store encryption (§2): mode, status (`encrypted` /
`locked` / `plaintext` / `migrating`), the **Unlock keyring** button, *"Encrypt
the local mail store…"*, *"Delete local mail and re-sync"*, and the key-id for
support. It is separate because it is not a property of any one account, and
folding it into the account dialog would imply it is.

---

## 6. Receiving

### 6.1 Detection

Done on the parsed *outer* structure in `services::mail_engine`, in a new
`mail_crypto::classify(&Message) -> MailCryptoKind`:

| Structure | Kind |
|---|---|
| `multipart/encrypted; protocol="application/pgp-encrypted"` with a `version` part (`Version: 1`) and an `application/octet-stream` part | `PgpMime` (RFC 3156 §4) |
| `multipart/signed; protocol="application/pgp-signature"; micalg=…` with exactly two parts, the second `application/pgp-signature` | `PgpMimeSigned` (RFC 3156 §5) |
| A `text/plain` body whose content begins with `-----BEGIN PGP MESSAGE-----` | `PgpInline` — supported for **reading only**, never produced (§7.5) |
| `-----BEGIN PGP SIGNED MESSAGE-----` cleartext framing | `PgpInlineSigned` — read-only, and treated with extra suspicion (§9.2) |
| `application/pkcs7-mime; smime-type=enveloped-data` (or `application/x-pkcs7-mime`) | `SmimeEnveloped` |
| `application/pkcs7-mime; smime-type=signed-data` (opaque signing) | `SmimeOpaqueSigned` |
| `multipart/signed; protocol="application/pkcs7-signature"` | `SmimeDetachedSigned` |
| anything else | `None` |

Rules that are easy to get wrong and are therefore written down:

- **Detect on structure, not on filename.** An attachment called
  `smime.p7s` proves nothing; the Content-Type parameter set is what matters.
- **Nesting is normal** — `multipart/encrypted` whose plaintext is
  `multipart/signed` is the standard sign-then-encrypt shape. Depth is bounded by
  `MAX_MIME_DEPTH` (32) and each crypto layer counts toward it, with an
  additional hard cap of **3 crypto layers** so a nested-encryption bomb
  terminates.
- A `multipart/encrypted` whose `protocol` parameter and actual packets disagree
  is malformed, not "try both".

### 6.2 The pipeline, and the ordering that matters

```
IMAP FETCH (TLS)
  └─ raw RFC 5322 bytes                          [backend, untrusted]
      └─ mail-parser → outer structure           [safe Rust, fuzzed, bounded]
          └─ mail_crypto::classify
              ├─ None → today's path, unchanged
              └─ Pgp*/Smime*
                  ├─ 1. DECRYPT   (bounded, spawn_blocking, no plaintext to disk)
                  ├─ 2. VERIFY    (over the canonical signed bytes)
                  ├─ 3. PARSE     the decrypted bytes with mail-parser again,
                  │               under the SAME structural caps — the inner
                  │               message is a fresh untrusted document
                  ├─ 4. SANITIZE  with the SAME sanitize_message_html()
                  └─ 5. RENDER    into the SAME sandbox="" iframe
                      └─ MailBody { …, crypto: MailCrypto }
```

Five ordering rules, each of which is a bug if reversed:

1. **Decrypt before parse.** The inner message is a complete RFC 5322 document
   and must be parsed as one — including its own `Content-Type`, its own charset,
   its own nesting. Treating decrypted bytes as "the body" skips every structural
   cap.
2. **Parse before sanitize.** Unchanged from today; stated because the temptation
   with decrypted content is to shortcut straight to the renderer.
3. **Sanitize with the same function.** No "it was encrypted, so it is safe"
   exemption. Encryption says *who* wrote it, never *what* they wrote — and the
   worst case is precisely a hostile payload from a correspondent whose key you
   trust, which is the one message that would bypass a two-tier sanitizer.
4. **Verify over the exact bytes RFC 3156 specifies** — the signed part's
   canonical form with CRLF line endings and the MIME headers included,
   byte-for-byte as received. Re-serializing the parsed tree and verifying that
   is a signature-scope bug (E5): what you verified is not what you will render.
   `mail-parser` must therefore expose the raw span of the signed part; if it
   does not, keep the raw message bytes and slice them by offset — do not
   reconstruct.
5. **Render only the verified/decrypted whole.** A message that fails to decrypt
   renders as a status card, never as "here is the part that worked". Partial
   rendering of a partially-failing crypto message is how gadget attacks get their
   oracle.

Everything runs in `spawn_blocking` with a wall-clock bound, per
`commands/mail.rs`'s rule 1. `mail_body`'s cache lookup (`commands/mail.rs:889`)
gains one guard: **an encrypted message never consults or writes `bodies_cache`**
unless `cache_decrypted` is on (§2.10).

### 6.3 The signature-status UI

New wire type in `schema::mail`, mirrored in `src/types/mail.ts`, deliberately
shaped after `MailAuthResults` (`schema/mail.rs:284`) because the display problem
is the same one and the existing solution is good:

```rust
pub struct MailCrypto {
    pub encrypted: Option<MailEncryptionInfo>,  // scheme, algorithm, key id used
    pub signature: Option<MailSignatureInfo>,
    /// A closed set of coarse failure reasons. NEVER the library's error text
    /// (E3) and never anything an attacker chose the wording of.
    pub problems: Vec<MailCryptoProblem>,
}

pub struct MailSignatureInfo {
    pub state: MailSigState,        // Good | BadSignature | KeyUnknown | KeyExpired
                                    // | KeyRevoked | Unsupported | ScopeMismatch
    pub key_id: String,             // fingerprint, formatted by the frontend
    pub signer_uid: Option<String>, // stripped of format controls, backend-side
    /// Does a UID address of the signing key match the visible `From` addr-spec?
    /// The direct analogue of MailAuthMethod::aligned, and for the same reason:
    /// "signed by evil.example" is a *genuine* good signature by the wrong party.
    pub signer_matches_from: bool,
    pub trust: MailKeyTrust,        // Verified | Accepted | Unknown
    pub first_seen: Option<String>,
    pub source: MailKeySource,
    /// Did the signature cover the whole rendered body? (E5)
    pub covers_body: bool,
}
```

Rendered by a new `MailCryptoPanel` in `MailMessageView.tsx`, sitting beside
`MailAuthPanel` (`MailMessageView.tsx:226`) and following its rules verbatim,
because those rules were derived from exactly this problem:

- **Positive chrome only in the strongest state**, and the strongest state is
  narrow: `state == Good` **and** `signer_matches_from` **and**
  `trust == Verified`. A good signature by an `Accepted` (TOFU) key is neutral
  chrome plus the words *"first seen <date>"*. A good signature whose key's
  addresses do not include the `From` address is a **warning**, exactly as an
  unaligned `dkim=pass` is today.
- **Absence is not failure.** An unsigned message renders no crypto chrome at
  all. It must not render a grey "not signed" badge on every ordinary mail — that
  trains the user to ignore the row where the badge lives, which is the row that
  matters.
- **A frontend second refusal.** `lib/mail.ts` gains `mailCryptoShown(crypto)`,
  the analogue of `mailAuthShown`, which returns nothing outside the states that
  may be shown positively — a second gate on top of the backend's, for the same
  stated reason: the failure mode here is not showing too little, it is teaching
  the user to trust a tick an attacker drew.
- **Nothing message-derived reaches the chrome.** `signer_uid` is stripped of
  bidi/format controls in Rust (`mail_engine::strip_controls` already exists,
  `:609`) and rendered as a plain text node. The fingerprint is rendered
  monospace and **never ellipsis-truncated** — the same rule the link-confirm
  dialog already applies to URLs, for the same reason.
- Failures are cards with a plain sentence and, where relevant, exactly one
  action (*"Import the key offered by this message"*, *"Unlock your key"*), never
  a raw error and never "retry with less checking".

### 6.4 The header list

`MailList.tsx` gains a lock/pen marker per row, driven by a **cheap** structural
flag persisted on `MailHeader` (`encrypted: bool`, `signed: bool` — computed from
the outer MIME during sync, no crypto involved). Verification state is **not** in
the list: verifying every visible row would mean decrypting on scroll, which is
E3's oracle and §2.10's plaintext problem at once. The list says *"this is
encrypted"*; only the open message says *"and here is who signed it"*.

---

## 7. Sending

### 7.1 Compose UI

`MailComposeDialog.tsx` gains a crypto row above the action buttons: two toggles
(🔒 Encrypt, ✍ Sign) seeded from the account defaults and from §5's
`encrypt_replies_to_encrypted`, plus a **per-recipient key status strip** that
updates as recipients are typed:

```
alice@example.com   🔑 key verified (fingerprint …)
bob@example.org     🔑 key accepted — first seen 2026-05-02
carol@example.net   ⚠ no key
```

The strip is the feature. A single "encrypt" checkbox with no per-recipient
truth is how people send encrypted mail they think went to three people and went
usably to two. Recipients resolve against `keys.db` only — no network lookup
happens while typing (§4.2); each keyless recipient gets a **Find key…** button
that runs the one-address WKD/keyserver flow from a click.

### 7.2 When a recipient has no key

**Block. Do not send plaintext. Do not offer a one-click downgrade.**

The dialog explains which recipients are missing keys and offers exactly three
routes: find/import a key for them, remove them from the message, or **turn
encryption off** — which is a deliberate flip of the visible toggle, after which
the composer's whole crypto row changes appearance. There is deliberately no
"Send unencrypted anyway" button inside the error, because a button inside an
error is a button people click to make the error go away.

Same posture for a recipient whose key is **expired** or **revoked**: refused,
named, with no override. An expired key may still technically encrypt; using it
means encrypting to a key its owner has said is finished.

**Bcc + encryption** is its own trap: encrypting to a Bcc recipient's key puts
that key's id in the message's public recipient list, disclosing the Bcc. The
options are hidden recipients (`--throw-keyids`, which breaks decryption
performance and some clients) or sending a separate copy per Bcc recipient.
**Recommendation: refuse Bcc on an encrypted message in v1**, with the reason
stated in the dialog. It is an honest dead end, and it is far better than the
alternative, which is silently telling everyone who was Bcc'd.

### 7.3 Construction

Extend `mail_engine::build_outgoing` (`mail_engine.rs:1473`) rather than
replacing it — every header-injection guard (`reject_header_injection` `:1438`,
`validate_recipient` `:1448`) and the `MAX_OUTBOUND_BYTES` cap must still apply
to the *inner* message before it is encrypted. Order:

1. Build the inner message exactly as today, attachments included.
2. **Sign** (if signing): produce `multipart/signed` with the detached
   `application/pgp-signature` part and the correct `micalg`, over the inner
   part's canonical CRLF bytes.
3. **Encrypt** (if encrypting): wrap in `multipart/encrypted;
   protocol="application/pgp-encrypted"` with the `Version: 1` control part and
   the ciphertext part. Sign-then-encrypt, not the reverse: encrypt-then-sign
   lets a third party strip your signature and re-sign the ciphertext.
4. Outer headers: `From`, `To`, `Cc`, `Subject`, `Date`, `Message-ID`,
   `In-Reply-To`, `References` — cleartext, as the protocol requires. **The
   subject is not encrypted** (§7.6).

**Attachments are inside the encryption automatically** because they are part of
the inner message. This is the right answer and it is free; the failure mode to
avoid is any code path that attaches something to the *outer* message.

### 7.4 The Sent copy

The classic leak: encrypt to them, then `APPEND` the cleartext to `Sent`.

**Rule: encrypt to self, always.** The recipient set for encryption is
`recipients ∪ {own key}`, and the *same* encrypted blob is appended to Sent. If
the account has no usable own key, the message **is not copied to Sent**, and the
composer says so before sending — refusing to upload a plaintext copy of a
message you just encrypted, to the provider you encrypted around. (Eldrun does
not currently APPEND to Sent at all — plan B left it out of v1 — so this is a
rule for when that lands, and it must land with the rule, not before it.)

### 7.5 Inline PGP is read-only

Eldrun **produces** PGP/MIME only. Inline PGP (`-----BEGIN PGP MESSAGE-----` in a
`text/plain` body) is parsed for compatibility with old senders but never
generated: it cannot carry attachments, it has no clean way to express which
bytes are covered, and the cleartext-signed variant's dash-escaping and
whitespace canonicalisation are a persistent source of scope confusion (§9.2).
Reading it is compatibility; writing it would be shipping a worse format.

### 7.6 Encrypted subjects (protected headers): later, opt-in

RFC 8551bis / the "protected headers" convention puts a copy of the headers
inside the encrypted part and shows `Subject: ...` (or `[...]`) outside. It is
genuinely valuable — the subject is usually the most sensitive metadata — but
interoperability is uneven and a client that does not understand it shows the
literal placeholder to your correspondent. **Deferred**, opt-in when it lands,
and until then §1's E15 rule holds: the UI states plainly that subjects are not
protected.

---

## 8. Search and indexing

Two independent effects, often conflated:

1. **At-rest encryption (§2)** changes *how* search runs, not *what* is
   searchable: decrypt-and-filter in Rust over the folder's rows, everything
   still findable (§2.6).
2. **E2E encryption (§§6–7)** changes *what exists to search*. An encrypted
   message's body is not in the store in any readable form, and by §2.10 it never
   will be by default. Therefore:
   - Encrypted mail is findable by **cleartext headers** — subject, sender,
     recipients, date — and **not** by body text.
   - `preview` is empty for encrypted messages, so the list shows a lock marker
     where the snippet would be, not a misleading blank.
   - The search box states the limitation **in place, once**, when a folder
     containing encrypted mail is searched: *"N encrypted messages were not
     searched (their contents are not stored on this device)"*. Silent omission
     from search results is a correctness bug the user cannot detect.
   - Turning on `cache_decrypted` (§2.10) makes those bodies searchable and says
     so in its own help text, which is the honest way to sell the trade.

There is no plan to build a searchable encrypted index (blind indexes, encrypted
inverted indexes): every scheme in that family leaks query and token equality,
and the leak is against exactly the adversary this whole section exists for.

---

## 9. Security analysis

### 9.1 EFAIL, and why this codebase starts from an unusually good place

EFAIL had two halves. **Direct exfiltration** wrapped ciphertext in HTML so that
the decrypted plaintext landed inside an attribute the client then fetched —
which required (a) the client to render attacker HTML, (b) that HTML to be able
to cause a network fetch, and (c) the decrypted plaintext to be concatenated into
it. In Eldrun, (b) is structurally impossible: the app CSP contains no `https:`
in any fetch directive, the message frame is `sandbox=""` with its own
`default-src 'none'; img-src data:` policy, and the sanitizer removes every
URL-bearing attribute before the HTML crosses IPC. Remote content is not merely
blocked by default — **there is no mechanism to load it**, which
`MailMessageView.tsx` is explicit about. This is the strongest mitigation in
the whole plan and it already exists; the obligation is to *not erode it*:

- Do not add `https:` to any CSP directive to implement key discovery, avatars,
  or anything else. WKD is a **backend** fetch (§4.2).
- Do not add a "load remote content" path that relaxes the frame CSP rather than
  inlining `data:` from the backend.
- Do not add a second render path for decrypted content.

The **second** half — CBC/CFB gadget attacks — is a property of the crypto
format, not the renderer, and is answered in the format: refuse SEIPD packets
without an integrity check, treat an MDC/AEAD failure as a hard error, and never
render partial plaintext (§1 E2, §6.2 rule 5). For S/MIME, the same logic
refuses unauthenticated CBC content-encryption where the message shape makes
gadget insertion possible; prefer AES-GCM `EnvelopedData` and treat CBC as
best-effort with the "render only the whole" rule doing the heavy lifting.

### 9.2 Signature scope and header spoofing — the misreading to design against

In both OpenPGP/MIME and S/MIME, **the headers are outside the signature**. A
message can carry a perfectly valid signature over the body while `From`,
`Subject` and `Date` are entirely attacker-chosen. Two rules follow:

- The verdict chrome **never** says "this message is from X". It says *"the body
  was signed by <key>, whose addresses include x@example.com"*, plus the
  `signer_matches_from` flag when they do not. This is the identical distinction
  `MailAuthPanel` already draws between `dkim=pass` and *aligned*
  `dkim=pass` — reuse the vocabulary and the tone functions, do not invent a
  second one.
- The **subject is never rendered inside the verified region**. A layout that
  puts the subject inside a green-bordered "verified" box asserts something about
  the subject that is false.

Cleartext-signed inline PGP is worse still: dash-escaping and trailing-whitespace
canonicalisation mean the bytes a naive implementation verifies and the bytes it
displays can differ, and text before/after the signed block is not covered at
all. Handling: verify strictly, render **only** the covered region, and mark any
surrounding text as *not covered by the signature*.

### 9.3 Decryption oracles

Beyond §1 E3: the *timing* channel is bounded by the fact that decryption only
happens on an explicit open (no loop to time), and the *error* channel by the
closed problem set. The remaining channel is **user behaviour** — an attacker
learns something from whether you reply. Nothing technical fixes that, and plan
B's absolute rule (no outbound message without an explicit click; MDN requests
ignored permanently and not a setting) is what keeps it from becoming automatic.

### 9.4 Key substitution and the fingerprint UI

E6/E7's mitigation is only as good as the fingerprint display. Rules:

- Fingerprints are shown **in full**, monospace, grouped in fours or fives, and
  **never truncated with an ellipsis**. Short key IDs (32-bit, and even 64-bit)
  are forgeable and must not appear anywhere in the UI, including in tooltips.
- The comparison affordance is *"compare this with the one your correspondent
  read to you"*, not a checkbox labelled "trusted".
- A key change is a blocking event (§4.3), not a diff buried in a key manager
  nobody opens.

### 9.5 Every message-derived byte is attacker-controlled

The project's standing rule (`docs/context/` sandbox findings; the
`no_command_takes_a_path` tripwire) applies to every new artifact here:

- An attached key file is attacker-controlled: it is stored as an opaque blob,
  never under its sender-supplied name, never auto-imported.
- An Autocrypt header is attacker-controlled: it is a hint, adopted only on
  first contact and only with the opt-in on.
- A WKD response is attacker-controlled: it is served by a host the *attacker's
  address* chose, which is why it goes through the SSRF gate and why the result
  is shown before it is trusted.
- **No new `mail_*` command may take a path.** Key import and export raise the
  OS dialog inside Rust. The existing `no_command_takes_a_path` test
  (`commands/mail.rs:1551`) covers the new commands for free — which is exactly
  why it was written that way, and why it must not be weakened to accommodate a
  "key file path" parameter.

### 9.6 What this plan does not defend against

Stated so nobody has to infer it: a compromised endpoint (malware as your user),
a coerced or careless correspondent, traffic analysis, metadata (§1 E15), a
backdoored key you were handed and verified, and a private key you have exported
to somewhere else. Encryption moves the trust boundary; it does not remove one.

---

## 10. S/MIME — the secondary track

Motivating case: institutional mail often ships an X.509 certificate to every
user, and the counterparty's client already understands S/MIME. Where OpenPGP
requires both ends to opt in, S/MIME frequently only requires *your* end to
catch up.

### 10.1 What is shared with the OpenPGP track (most of it)

Everything above the crypto: detection and classification (§6.1), the
decrypt→parse→sanitize→render ordering (§6.2), `MailCrypto` and the display
rules (§6.3), the composer's per-recipient status strip (§7.1), the
no-plaintext-fallback rule (§7.2), the Sent-copy rule (§7.4), the at-rest store
(§2), the search consequences (§8), and the whole of §9. The `MailCryptoEngine`
trait (§11) has two implementors and the pipeline never learns which one ran.

Also shared: every primitive. `rsa`, `p256`, `p384`, `aes`, `cbc`, `aes-gcm`,
`sha2` are already compiled in by `pgp`. S/MIME adds *format* crates only.

### 10.2 What differs

| | OpenPGP | S/MIME |
|---|---|---|
| Key object | Transferable key, self-signed UIDs, subkeys, expiry, revocation certs | X.509 certificate + chain, issued by a CA, with `notBefore`/`notAfter`, EKU and CRL/OCSP pointers |
| Identity binding | UID strings the key owner wrote | `rfc822Name` in the SAN, asserted by a CA |
| Discovery | Attached keys, Autocrypt, WKD, keyservers | **Certificates ride inside every `SignedData`** (§4.4) |
| Private key format | rPGP secret key, S2K-protected | PKCS#12 (`.p12`/`.pfx`) — password-protected, and the format the user will actually be handed |
| Trust | TOFU + explicit verification | CA chain **plus** TOFU, and we are honest that our chain check is partial (§10.3) |
| MIME | `multipart/encrypted`, `multipart/signed` | `application/pkcs7-mime` (enveloped **or** opaque-signed) and `multipart/signed` with `application/pkcs7-signature` |
| Message shape gotcha | — | **Opaque signing** (`smime-type=signed-data`) hides the whole message inside a PKCS#7 blob; a client that does not understand it shows an unreadable attachment. Eldrun must handle it on receive; on send, always use `multipart/signed` (detached), which degrades gracefully. |

### 10.3 Chain validation: the honest position

There is no pure-Rust RFC 5280 path validator for email certificates in this
ecosystem (§0.3). What Phase 6 implements, explicitly and in these words in the
module header:

- Signature verification of the certificate chain up to a trust anchor from the
  OS root store (`rustls-native-certs`).
- Validity window (`notBefore`/`notAfter`) at the **message's** date as well as
  now — a message signed before the cert expired is a different statement from
  one signed after.
- `basicConstraints` (CA-ness and path length) on every intermediate.
- Extended Key Usage containing `emailProtection`; Key Usage consistent with the
  operation.
- SAN `rfc822Name` matching the `From` addr-spec, case-insensitively on the
  domain — with `signer_matches_from` set from this, exactly as OpenPGP's is.

What it **does not** do, and the UI must not imply otherwise:

- **No revocation checking.** No CRL fetch, no OCSP, no OCSP stapling. A revoked
  certificate will verify. This is a real gap; it is disclosed in the module
  header and the trust state for a chained-but-unrevocation-checked certificate
  is `Accepted`, **never** `Verified`. `Verified` requires the user to have
  confirmed the certificate explicitly, same as OpenPGP.
- No name constraints, no policy mapping, no cross-certificate path building
  beyond the chain the message supplied.

That posture — chain checked, revocation not, therefore never fully green
without a human — is defensible and honest. Silently rendering a green tick from
a partial validation would be exactly the failure this whole plan is written
against.

### 10.4 PKCS#12 import

The user's institution hands them a `.p12`. Import goes through the same
backend-raised dialog, asks for the file password, extracts the key and chain,
re-protects the private key under §3.1's two layers, and stores the certificate
chain in `keys.db`. The `.p12` file itself is **never copied into the mail
directory** — it is read, used, and forgotten, so a compromised `mail/` never
yields the original transportable bundle.

### 10.5 The `rsa` crate's timing advisory

RSA PKCS#1 v1.5 decryption (still the dominant S/MIME key-transport mechanism)
has a documented timing side-channel advisory against the `rsa` crate (the
"Marvin" class). It matters here far less than in a server, because the
attacker has no oracle: decryption happens only on an explicit user open (E3),
there is no automatic reply, and error reporting is a closed coarse set. Note it
in the module header, prefer RSA-OAEP and ECDH recipients where the sender
offered them, and re-check the advisory status when the S/MIME phase is
actually scheduled.

---

## 11. Phased implementation

Every phase is independently shippable, independently testable, and gated behind
the existing `mail_client` experimental flag (off for non-debug users). New
surfaces carry `<UntestedTag />` until the user reports each one live-verified;
they are removed **per item**, only on the user's explicit say-so.

### Phase 0 — Contract and dependencies (no behaviour)

The frozen contract lands first, exactly as plan A §6 did it, so the frontend and
backend can proceed in parallel from minute one.

**Files:** `src-tauri/Cargo.toml` (§0.5) · `src-tauri/src/schema/mail.rs`
(`MailCrypto`, `MailSignatureInfo`, `MailEncryptionInfo`, `MailCryptoProblem`,
`MailKeyTrust`, `MailKeySource`, `MailAccountCrypto`, `MailPassphraseCache`;
`MailHeader.encrypted`/`signed`; `MailBody.crypto`) · `src/types/mail.ts` (the
mirror) · `src-tauri/src/services/mail_crypto.rs` (new: the `MailCryptoEngine`
trait and `classify`, everything else `unimplemented!()`) ·
`src-tauri/src/services/mod.rs` · `src-tauri/src/commands/mail.rs` (the new
commands, registered, returning `Err("not implemented")`) · `src-tauri/src/lib.rs`
(`generate_handler!`) · `src/lib/mail.ts` (typed wrappers).

**New command surface** — all `pub async fn`, all `Result<T, String>`, **none
takes a path**:

```
mail_crypto_status(account_id)                    -> MailAccountCryptoStatus
mail_keys_list(filter: Option<String>)            -> Vec<MailKeyInfo>
mail_key_import()                                 -> Vec<MailKeyInfo>   # backend raises the OS open dialog
mail_key_import_from_message(message_id, part_id) -> Vec<MailKeyInfo>   # from a store blob
mail_key_export(fingerprint, secret: bool)        -> Option<String>     # backend raises the OS save dialog
mail_key_generate(account_id, params)             -> MailKeyInfo
mail_key_delete(fingerprint)                      -> ()
mail_key_set_trust(fingerprint, trust)            -> MailKeyInfo
mail_key_unlock(fingerprint, passphrase, cache)   -> ()                 # passphrase in, nothing out
mail_key_lock(fingerprint)                        -> ()
mail_key_discover(address, source)                -> Vec<MailKeyInfo>   # WKD/keyserver, ONE address, from a click
mail_recipient_keys(account_id, addresses)        -> Vec<MailRecipientKey>
mail_store_encryption_status()                    -> MailStoreCryptoStatus
mail_store_encryption_enable(mode, passphrase?)   -> MailStoreCryptoStatus
mail_store_unlock(passphrase?)                    -> MailStoreCryptoStatus
mail_store_encryption_disable()                   -> MailStoreCryptoStatus
```

**Gate:** `cargo test` + `npx tsc --noEmit` green; the compile-time/binary-size
delta recorded; MSRV confirmed on all three runners.

### Phase 1 — The local store, encrypted at rest (§2)

Independently valuable, independently shippable, and the only phase every user
benefits from regardless of whether anyone they know uses PGP.

**Files:** `src-tauri/src/services/mail_store_crypto.rs` (new: envelope, key
hierarchy, HKDF, key file, modes) · `src-tauri/src/services/mail_store.rs`
(`open`, `migrate`, `SCHEMA_VERSION` → 2, the encrypted-column accessors,
`put_blob`/`get_blob` renaming, `headers_page`'s decrypt-and-filter,
`stage_attachment`/`staged_bytes`, `clear_cached_mail`, the `VACUUM INTO`
migration) · `src-tauri/src/commands/mail.rs` (the four `mail_store_*` commands,
the memory-only degrade in `store_of`) · `src-tauri/src/schema/settings.rs`
(`mail_store_encryption`) · `src-tauri/src/services/remote_credentials.rs` (the
`mail:store-key` account key beside `mail_account`, `:79`) ·
`src/components/layout/SettingsPanel.tsx` (the store panel) ·
`src/components/mail/MailPane.tsx` (the "locked" state + Unlock button) ·
`src/stores/mail.ts` · `src/lib/mail.ts` · `src/lib/i18n.ts` (×5).

**Gate:** a tempdir round-trip test per table; the migration test (plaintext
store → encrypted, restartable, idempotent); the wrong-key test (reports "wrong
key", not corruption); the AAD test (a relocated ciphertext fails to open); the
memory-only degrade test; the no-temp-file tripwire.

### Phase 2 — OpenPGP verification only (read, no keys of our own)

The smallest phase with real user value and the lowest possible risk: no private
keys, no passphrases, no decryption, no sending. It teaches the whole pipeline.

**Files:** `services/mail_crypto.rs` (`classify`, PGP/MIME signature
verification, the public keyring in `keys.db`) ·
`services/mail_keystore.rs` (new: `keys.db`, import/list/trust, all public) ·
`commands/mail.rs` (`mail_body` computes `MailCrypto`; `mail_keys_list`,
`mail_key_import`, `mail_key_import_from_message`, `mail_key_set_trust`) ·
`services/mail_engine.rs` (raw-span access for canonical verification;
`ParsedMessage` gains the crypto part references) ·
`src/components/mail/MailMessageView.tsx` (`MailCryptoPanel`) ·
`src/components/mail/MailList.tsx` (the row marker) · `src/lib/mail.ts`
(`mailCryptoShown`, tone helpers) · `src/lib/i18n.ts` (×5).

**Gate:** fixture-driven verification tests including a *good signature by the
wrong key* and a *signature covering only part of the message*; the frontend
display-rule tests.

### Phase 3 — OpenPGP decryption (private keys enter the picture)

**Files:** `services/mail_keystore.rs` (secret keys, the two-layer at-rest
wrapping, unlock/lock, the passphrase cache with its timer) ·
`services/mail_crypto.rs` (PGP/MIME decrypt; the MDC/AEAD refusal;
sign-inside-encrypt) · `commands/mail.rs` (`mail_key_unlock`/`mail_key_lock`;
`mail_body`'s decrypt branch; the memory-only decrypted-body LRU on
`MailRuntime`; the `bodies_cache` bypass) · `schema/mail.rs`
(`MailAccountCrypto`) · `src/components/mail/MailAccountDialog.tsx` (the
Encryption section) · a new `src/components/mail/MailKeyDialog.tsx` (import,
fingerprints, trust) · `src/lib/i18n.ts` (×5).

**Gate:** decrypt a fixture generated by an independent implementation (GnuPG),
not by rPGP — a round-trip against yourself proves compatibility with yourself.
The no-MDC refusal test. The "decrypted body never reaches `bodies_cache`"
tripwire.

### Phase 4 — Key discovery

**Files:** `services/mail_keydiscovery.rs` (new: Autocrypt header parsing,
attached-key extraction, WKD URL construction incl. the zbase32 local-part hash,
the keyserver client) · `services/mail_crypto.rs` (gossip from decrypted parts) ·
`commands/mail.rs` (`mail_key_discover`) · reuse of `services/web_safety.rs` +
`services/browser_engine.rs`'s hop gate · `src/components/mail/MailMessageView.tsx`
("keys offered by this message") · `MailAccountDialog.tsx` (the two Autocrypt
opt-ins).

**Gate:** WKD URL-construction vectors (the zbase32 hash is easy to get wrong and
has published test vectors); the SSRF tests, reusing the browser's; an
Autocrypt-header parse suite including a header whose key claims someone else's
address.

### Phase 5 — OpenPGP signing and encrypting outbound

**Files:** `services/mail_engine.rs` (`build_outgoing` gains the sign/encrypt
wrap) · `services/mail_crypto.rs` (sign, encrypt, encrypt-to-self) ·
`commands/mail.rs` (`mail_recipient_keys`; `mail_draft_send`'s crypto branch;
the Bcc refusal; the Sent-copy rule) · `src/components/mail/MailComposeDialog.tsx`
(the crypto row, the per-recipient strip, the block-don't-downgrade dialog) ·
`src/lib/i18n.ts` (×5).

**Gate:** the header-injection guards still fire on the *inner* message; an
encrypted message's recipient set always contains the sender's own key; a
missing-key send is refused with no code path that sends plaintext (assert by
source scan, not only by behaviour).

### Phase 6 — S/MIME

Verify → decrypt → sign/encrypt, in that order, each landing separately, reusing
everything from Phases 2/3/5.

**Files:** `Cargo.toml` (`cms`, `x509-cert`, `const-oid`) ·
`services/mail_smime.rs` (new: the second `MailCryptoEngine` implementor, the
partial path check of §10.3) · `services/mail_keystore.rs` (certificates,
PKCS#12 import) · `MailAccountDialog.tsx` (the S/MIME half of the section).

**Gate:** fixtures from an independent implementation (OpenSSL-generated, used as
*test data* — the constraint is about the bundle, not about how fixtures were
made); an expired-cert test; a wrong-`rfc822Name` test; an EKU-mismatch test; a
proof that a chained-but-unrevocation-checked cert never reports `Verified`.

### Phase 7 — Key lifecycle and hardening

Generation, expiry warnings, revocation import, key rotation, the key manager UI,
protected headers (§7.6) if it is still wanted by then, and the smartcard seam if
it is ever taken.

---

## 12. Test strategy

Two acceptance gates, unchanged: `cargo test --manifest-path src-tauri/Cargo.toml`
and `npx tsc --noEmit`. The vitest suite is expected to pass but is not a gate.

### 12.1 Rust unit tests

- `services::mail_store_crypto` — envelope round-trip; tamper detection (flip one
  ciphertext bit → open fails); **AAD relocation** (message A's body ciphertext
  placed in message B's row → fails); wrong-key detection via `verifier`; HKDF
  subkey separation (three purposes never produce the same key); nonce
  uniqueness over 10⁶ encryptions.
- `services::mail_store` — migration from a plaintext fixture store; migration
  interrupted and resumed (idempotence); `headers_page` search over encrypted
  columns matches the plaintext behaviour exactly (drive both and compare);
  `UNIQUE(account_id, path_key)` still rejects a duplicate folder; blob dedupe
  still dedupes; `clear_cached_mail` cannot touch `keys.db`.
- `services::mail_crypto` — `classify` over every structure in §6.1 plus
  malformed variants (protocol/packet mismatch, missing version part, three
  parts where two are required, 4 nested crypto layers); MDC-absent refusal;
  bad-MAC → `BadSignature`, never a partial render; signature-scope mismatch
  detection.
- `services::mail_keystore` — import/export round-trip; secret key never
  serializes (`serde_json::to_string` must not compile / must be absent);
  `format!("{:?}", key)` contains no key material and no substring of the
  passphrase; passphrase cache expiry; a locked key refuses to sign.
- `services::mail_keydiscovery` — WKD zbase32 vectors; Autocrypt header parsing
  incl. unknown attributes (must be ignored per spec), a `keydata` that is not a
  key, and a header claiming an address other than `From`.
- `commands::mail` — the existing `no_command_takes_a_path` covers the new
  commands automatically; add the **no-secret-return** scan (no command's return
  type names `Secret`/`Private`/`Passphrase`), the **no-temp-file** scan over the
  mail modules, and the "every `mail_*` is `pub async fn`" check the file already
  performs.

### 12.2 Hostile fixtures — `src-tauri/tests/fixtures/mail/`

Extending the existing set (`hostile_kitchen_sink.eml` and friends), generated by
a script beside them for the same reason the existing generator exists — the
bytes must survive byte-for-byte. Every fixture uses `example.com` /
`example.org` / `evil.example` domains only; no real provider or institution
hostnames.

| Fixture | Attacks |
|---|---|
| `pgp_encrypted_hostile.eml` | Decrypts to the existing kitchen-sink HTML. Proves the sanitizer runs on decrypted content with identical output — assert **byte-identical** to the plaintext case's checked-in fragment, the same technique `mail_hostile_message.rs` already uses. |
| `pgp_signed_wrong_key.eml` | Cryptographically valid signature by a key whose UID is `evil.example`. Must never render positive chrome. |
| `pgp_signed_partial.eml` | Signature covers one part; another part carries the payload. `covers_body` false; the uncovered region marked. |
| `pgp_no_mdc.eml` | Legacy `SymmetricallyEncryptedData` without integrity protection. Must refuse. |
| `pgp_nested_bomb.eml` | Four nested `multipart/encrypted` layers. Must terminate at the cap. |
| `pgp_key_flood.eml` | An attached key with 10 000 user-IDs and a 32 KiB UID string. Must refuse at the E14 bound. |
| `pgp_inline_cleartext_trap.eml` | Cleartext-signed block with text before and after it. Only the covered region may render as covered. |
| `autocrypt_impostor.eml` | `Autocrypt:` header whose `addr` is not the `From` address, plus a second header. Must be ignored (Autocrypt: exactly one header, matching `From`). |
| `smime_expired.eml`, `smime_wrong_san.eml`, `smime_opaque_signed.eml` | Phase 6. |
| `pgp_encrypted_efail_shape.eml` | The EFAIL direct-exfil construction. Must produce a body with no URL-bearing attribute at all — asserted against the existing `FORBIDDEN_IN_ANY_OUTPUT` list. |

### 12.3 Frontend (vitest)

- `MailCryptoDisplay.test.ts` — the analogue of the existing
  `MailAuthDisplay.test.ts`: positive chrome **only** in the narrow state; a good
  signature by an `Accepted` key is neutral; `signer_matches_from == false` is a
  warning whatever the state; an unknown `state` token never inherits a good
  state's appearance; a fingerprint is never truncated.
- `MailComposeCrypto.test.ts` — the per-recipient strip; the missing-key block
  has no code path that sends; the Bcc refusal; the reply-to-encrypted default.
- `MailStoreLocked.test.ts` — a locked store renders "locked" with an Unlock
  button and **never** "no accounts".
- `MailTripwire.test.ts` (existing, extended) — still no
  `dangerouslySetInnerHTML` anywhere under the mail feature; no component
  invokes `mail_*` directly; no new wrapper takes a path.

### 12.4 What only manual QA can establish

The user must do these; an agent cannot launch Eldrun, and `cargo test` cannot
see any of them:

1. **Real interoperability.** Send a signed+encrypted mail to a Thunderbird (and
   a GnuPG-CLI) recipient and back. Round-tripping against ourselves proves
   nothing about the format.
2. **The keychain, live.** Lock the Secret Service collection with the mail
   overlay open. The store must show "locked" with an Unlock button, sync must
   still work memory-only, and **nothing may be written to disk** — verify by
   `stat`ing `mail.db`'s mtime before and after.
3. **The migration, on a real store.** Migrate an existing plaintext store with
   real volume, interrupt it (kill the app mid-migration), reopen, and confirm it
   resumes and the result is complete. Then confirm the old plaintext files —
   including `mail.db-wal` — are gone.
4. **Passphrase timing.** Does the passphrase prompt appear at a sensible moment?
   Is the 15-minute cache the right default in practice?
5. **The composer under real recipients.** Does the per-recipient strip stay
   readable with 15 recipients? Does the block-don't-downgrade dialog read as
   helpful or as an obstacle?
6. **Performance.** Search a 50 000-message folder with encryption on and time
   it. If the decrypt-and-filter pass is not acceptable, that is a design signal,
   not a tuning one.
7. **Windows and macOS.** Both are CI-build-only here; the store, the keychain
   backend (Credential Manager / Keychain) and the file permissions all differ,
   and only a human on those machines can tell whether the degrade path behaves.

---

## 13. TODO entries

Group **J** (Web & Mail Surfaces) already owns the mail client (#65) and every
file this plan touches, so these belong there rather than in a new group;
they cross-reference Group **O** (Project Security & Permissions), whose
sandbox-audit posture §2 and §9.5 inherit. Numbering continues the global
sequence (highest in use today: #152).

Add to `todo/group-j.md`, and add a Group-J line to `TODO.md`'s Open-groups
table noting that mail encryption lives here. Each carries the two verification
boxes in the repo's standard form.

```markdown
153. **Encrypt the local mail store at rest.** (Plan: `docs/mail_encryption_plan_a.md` §2.)
     Value-level AEAD (XChaCha20-Poly1305) over the sensitive columns of
     `mail.db`, every blob, the staged outbox and `accounts.json`; AAD binds each
     ciphertext to its row so a relocated blob cannot be swapped in. Store master
     key in the OS keychain (`mail:store-key`, via `remote_credentials`, 4 s
     bounded read) or wrapped by an Argon2id passphrase; a locked keyring
     degrades to **memory-only sync**, never to a plaintext fallback and never to
     "no accounts". Includes the restartable migration of existing plaintext
     stores, ending in `VACUUM INTO` + deletion of `mail.db-wal`, and the honest
     statement that previously written plaintext may survive in unallocated space.
     SQLCipher is ruled out: its crypto provider is OpenSSL, which the bundle
     does not contain. Ships independently of #154–#159.
     - [ ] 🤖 Automated test — envelope tamper/relocation, migration idempotence,
       wrong-key detection, encrypted-column search parity, no-temp-file tripwire.
     - [ ] 🖐️ Manual test — lock the keyring with mail open: "locked" + Unlock,
       sync still works, `mail.db` mtime does not move.

154. **OpenPGP: verify inbound signatures.** (§§0, 6, 9.) `pgp` (rPGP,
     pure-Rust RustCrypto, MIT/Apache — sequoia's default backend is Nettle, a C
     library, and its pure-Rust backend is gated behind
     `allow-experimental-crypto`). Detect `multipart/signed` per RFC 3156,
     verify over the canonical signed bytes, and render a verdict beside the
     existing `MailAuthPanel` under the same rules: positive chrome only when the
     signature is good **and** the signing key's addresses include the visible
     `From` **and** the key is user-verified; a good signature by an unaligned or
     TOFU key is neutral or a warning, never green. No private keys yet.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test

155. **OpenPGP: private keys and decryption.** (§§3, 6.) Secret keys under
     `mail/keys/` protected by **two** layers (OpenPGP S2K + the #153 store
     envelope), never in the OS keychain. Passphrase in `Zeroizing`, never
     reaching the frontend; caching opt-in and time-boxed, with no "remember
     forever". PGP/MIME decrypt with a hard refusal of packets lacking MDC/AEAD.
     **Decrypted bodies are never written to disk** — memory-only LRU, empty
     `preview`, no `bodies_cache` row — because caching them under the store key
     would silently downgrade end-to-end to at-rest.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test

156. **OpenPGP: key discovery.** (§4.) Attached keys and Autocrypt headers are
     parsed and *offered*, never adopted; WKD and keyserver lookups are one click
     per address and ride the browser's SSRF gate (hop-0-vs-later-hop, DNS
     pinning) because a WKD host is derived from an attacker-chosen domain. No
     background lookups: that would be the tracking-pixel problem over a
     different transport. TOFU with a loud, blocking key-change event.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test

157. **OpenPGP: sign and encrypt outbound.** (§7.) Per-recipient key status in
     the composer; a recipient with no usable key **blocks** the send with no
     one-click downgrade; expired/revoked keys refused; sign-then-encrypt;
     attachments inside the encryption by construction; encrypt-to-self so the
     Sent copy is never plaintext; **Bcc refused on an encrypted message**
     (encrypting to a Bcc key discloses the Bcc). Inline PGP is read-only —
     Eldrun produces PGP/MIME.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test

158. **S/MIME (secondary track).** (§10.) `cms` + `x509-cert` (both pure Rust;
     every primitive already compiled in by #154). Verify → decrypt →
     sign/encrypt, in that order, reusing the whole pipeline and UI. Certificates
     are harvested from received signed mail; PKCS#12 import for the user's own.
     **Path validation is partial and says so**: chain signatures, validity
     window, basicConstraints, `emailProtection` EKU and SAN `rfc822Name` are
     checked; **revocation is not** (no CRL, no OCSP), so a chained certificate
     is `Accepted`, never `Verified`, without an explicit human confirmation.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test

159. **Key lifecycle: generation, expiry, revocation, rotation.** (§3.3, §11
     Phase 7.) Ed25519 + X25519 generation with a mandatory passphrase, a
     2-year default expiry, and a revocation certificate exported **before** the
     key is used; expiry warnings ahead of time; revocation import; a key manager
     showing fingerprint, source and first-seen for every key. Fingerprints are
     shown in full, monospace, never truncated; short key IDs appear nowhere.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test

160. **Protected headers (encrypted subjects).** (§7.6.) Deferred: the subject is
     the most sensitive metadata a message carries, but interoperability is
     uneven and a client that does not understand the convention shows the
     literal placeholder to your correspondent. Until it lands, the UI states
     plainly that subjects, recipients and timing are not encrypted.
     - [ ] 🤖 Automated test
     - [ ] 🖐️ Manual test
```

---

## 14. Open questions — decisions for the user

Each has a recommended default so the plan is executable if none is answered.

| # | Question | Recommended default |
|---|---|---|
| 1 | **Order of work.** At-rest (§2, #153) first, or E2E verification (#154) first? | **At-rest first.** It benefits every user regardless of correspondents, ships alone, and creates the envelope machinery the E2E track's key storage then reuses. |
| 2 | **Is store encryption on by default for new installs?** | **Yes, `keychain` mode**, with the memory-only degrade. An existing installation is asked once, at the next mail open, and can say no. |
| 3 | **Existing plaintext stores: migrate, or start fresh?** | **Offer both.** Migrate is the default (nobody wants to re-sync a mailbox); "delete and re-sync" is offered beside it as the option with no plaintext generation to leak, and is the honest recommendation for anyone who cares about §2.7's residual data. |
| 4 | **OpenPGP or S/MIME first**, given the motivating case is work mail? | **OpenPGP first even so.** Its crate story is unambiguous and its primitives are the same ones S/MIME needs, so OpenPGP-first makes S/MIME cheaper; S/MIME's own core crate is at a pre-release, and its trust model has a disclosed gap (revocation) that deserves to land onto an already-proven pipeline rather than alongside one. If work mail is the *only* case that matters, say so and Phase 6 moves up — but Phase 2's pipeline still has to exist first. |
| 5 | **Is the LGPL of `sequoia-openpgp` actually a blocker**, or a preference? | Treated as a blocker for a statically-linked, publicly-redistributed binary. If legal review says otherwise it changes nothing: sequoia's Nettle default and experimental pure-Rust backend are independently disqualifying under the no-OpenSSL/no-C-toolchain constraint. |
| 6 | **`chacha20poly1305` (one new crate) or `aes-gcm` (zero new crates)?** | **XChaCha20-Poly1305.** The 192-bit nonce removes a counting obligation from a store rewritten constantly. If the dependency is unwelcome, AES-256-GCM **with per-record HKDF subkeys** is acceptable; AES-GCM with random 96-bit nonces and a shared key is not. |
| 7 | **Passphrase cache default** — never, session, or 15 minutes? | **Never.** It is the safe default and the one people notice immediately, which means they will set it deliberately rather than discover it after a laptop is stolen. Revisit after live QA question 4. |
| 8 | **Is Autocrypt automatic adoption acceptable at all?** | Off by default, offered per account, first-contact-only. It is the one thing that would make PGP usable for a non-expert correspondent, and it is also the cleanest key-substitution vector — so it is the user's call, made once, with the trade stated. |
| 9 | **Do we ever want keyserver lookups?** | Manual-only, one address per click, never a background mode. If even that is unwanted, drop it and keep WKD — WKD leaks the query only to the recipient's own domain, which the user is already mailing. |
| 10 | **Does `cache_decrypted` (§2.10) ship at all?** | Ship it, off, buried. Offline search of encrypted mail is a genuine need for some workflows and the alternative is people not using encryption. But it must never be the default and its help text must state the downgrade. |
| 11 | **Sent-folder APPEND.** Eldrun does not upload to Sent today. Should #157 add it? | **Yes, and only together with the encrypt-to-self rule.** Adding APPEND later, separately, is exactly how a plaintext Sent copy of an encrypted message ships. |
| 12 | **Hardware tokens (YubiKey / OpenPGP card).** | Out of scope; the trait seam is there if it is ever wanted. Confirm nobody is counting on it. |
| 13 | **How much of this is worth building before the mail client has had any live QA at all?** | Worth asking out loud. The mail client is code-complete and **never runtime-verified**; encryption on top of an unverified client compounds the untested surface. Recommendation: do a live QA pass on the existing mail client, then #153 (which is testable independently of any mail server), then re-assess. |

---

## Critical files for implementation

- `src-tauri/Cargo.toml` — the mail/TLS block; the no-OpenSSL constraint is
  documented there and is the origin of every §0 decision.
- `src-tauri/src/services/mail_store.rs` — `open` (:59), `migrate` (:88),
  `put_blob`/`get_blob` (:209/:222), `headers_page` (:398), `cached_body`/
  `cache_body` (:676/:700), `stage_attachment` (:869), `clear_cached_mail`
  (:952), `harden` (:1062), `SCHEMA_VERSION` (:40).
- `src-tauri/src/services/mail_engine.rs` — `parse_message` (:340), the
  structural caps (:208-220), the `MailEngine` trait (:921), `build_outgoing`
  (:1473), `Password` (:102), `strip_controls` (:609).
- `src-tauri/src/services/mail_sanitize.rs` — `sanitize_message_html` (:259) and
  `SANITIZER_VERSION` (:52); decrypted content goes through **this** function.
- `src-tauri/src/services/mail_authres.rs` + `schema/mail.rs:284-296` — the
  display vocabulary (`state`, `identifier`, `aligned`) that `MailCrypto` copies.
- `src-tauri/src/services/remote_credentials.rs` — `mail_account` (:79), `get`
  (:200), `keyring_state` (:307), `remember_secret` (:494), `unlock_keyring`
  (:400).
- `src-tauri/src/services/web_safety.rs` + `services/browser_engine.rs` — the
  SSRF gate WKD must reuse rather than re-implement.
- `src-tauri/src/commands/mail.rs` — `mail_dir` (:67), `mail_body` (:877),
  `mail_draft_send` (:1269), `mail_attach_pick` (:1363), `mail_attachment_save`
  (:1441), and the `no_command_takes_a_path` tripwire (:1551).
- `src/components/mail/MailMessageView.tsx` — the `sandbox=""` frame (:177) and
  `MailAuthPanel` (:226), the template for `MailCryptoPanel`.
- `src/components/mail/MailComposeDialog.tsx`, `MailAccountDialog.tsx`,
  `MailList.tsx`, `src/stores/mail.ts`, `src/lib/mail.ts`, `src/types/mail.ts`.
- `src/components/common/UntestedTag.tsx` — on every new surface until the user
  says each one is verified.
- `docs/mail_client_plan_a.md` §§3–5 and `docs/mail_client_plan_b.md` §§2, 5, 7 —
  the rules this plan is not allowed to loosen.
