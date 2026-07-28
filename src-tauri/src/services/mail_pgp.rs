//! The OpenPGP keyring (`docs/mail_encryption_plan.md` §6, Phase 4).
//!
//! rPGP (`pgp` 0.20) rather than `sequoia-openpgp`, for two reasons that both
//! survived checking: sequoia is **LGPL-2.0-or-later**, which is a real
//! constraint for a statically linked binary this project redistributes, and its
//! pure-Rust backend sits behind `allow-experimental-crypto` +
//! `allow-variable-time-crypto` while its default backend is Nettle — a C
//! library, which the no-OpenSSL/no-C-toolchain invariant rules out.
//!
//! # Curve25519 by default, and why that is a security decision
//!
//! `pgp` depends on `rsa` unconditionally, and `rsa` is under
//! **RUSTSEC-2023-0071** (Marvin timing oracle) with `patched = []`. No version
//! escapes it and no feature gates it out; the `cargo audit` finding is
//! permanent. What *can* be avoided is ever running the vulnerable code.
//!
//! The oracle is in RSA PKCS#1 v1.5 **decryption**. Nobody can encrypt to a key
//! we do not have — so if our own key is Curve25519, that path is never
//! exercised for our mail, even though the crate is compiled in. Hence
//! [`PgpKeyring::generate`] offers no RSA option at all. RSA keys stay
//! *importable*, because a correspondent's key is only ever used to **verify**,
//! which is signature checking and not the vulnerable operation.
//!
//! The v4 (`Ed25519Legacy` + `ECDH(Curve25519Legacy)`) forms are generated
//! rather than the RFC 9580 v6 ones, deliberately: interoperating with
//! Thunderbird, GnuPG and Outlook is the whole point of using a standard, and v6
//! support is not yet where v4 support is.
//!
//! # Verified vs merely known
//!
//! OpenPGP has **no certificate authority**. There is no `webpki` to lean on and
//! nothing asserting that a key belongs to a person — trust comes from the user
//! having compared a fingerprint out of band, and from nothing else. So every
//! entry carries a [`SignerTrust`], it starts at `Known`, and only an explicit
//! "I checked this fingerprint" click promotes it. A good signature from a
//! `Known` key is a statement about bytes; the UI is not allowed to dress it as
//! a statement about a person.
//!
//! # The keyring requires the store to be encrypted
//!
//! [`PgpKeyring::open`] takes `MailKeys` and there is no path that does not.
//! Writing a private key into a plaintext file would make the whole exercise
//! theatre — and it is exactly the coupling the plan sequences the phases
//! around. Secret material is sealed under `k_wrap`, deliberately *not*
//! `k_field`, so the mail index and the private keys are not one compromise.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, SecretKeyParamsBuilder, SignedPublicKey,
    SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::ser::Serialize as _;
use pgp::types::KeyDetails as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::services::mail_crypt::{self, MailKeys};
use crate::services::mail_crypto::SignerTrust;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// `<mail dir>/pgp.json`, one sealed file.
///
/// One file rather than a directory of keys: the whole ring is a few kilobytes,
/// it is written rarely, and a single atomic write cannot leave the metadata and
/// the material disagreeing about which keys exist.
const KEYRING_FILE: &str = "pgp.json";
const KEYRING_AAD: &[u8] = b"file:pgp.json";
const KEYRING_VERSION: u32 = 1;

// ── The stored shape ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeyringFile {
    version: u32,
    #[serde(default)]
    entries: Vec<StoredKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKey {
    fingerprint: String,
    #[serde(default)]
    identities: Vec<String>,
    /// Whether `material` is a transferable *secret* key.
    secret: bool,
    /// `true` once the user has confirmed the fingerprint out of band.
    #[serde(default)]
    verified: bool,
    /// Mail account ids this key is the identity for. Only meaningful for a
    /// secret key.
    #[serde(default)]
    accounts: Vec<String>,
    #[serde(default)]
    algorithm: String,
    /// Base64 of the binary OpenPGP key packet stream.
    material: String,
}

/// One key, as the UI sees it. Carries **no key material** — the panel and the
/// key list have no use for it, and a type that cannot leak a private key
/// through a serialization mistake is worth the extra struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgpKeyInfo {
    /// Uppercase hex, no spaces.
    pub fingerprint: String,
    /// The user ids as written on the key.
    pub identities: Vec<String>,
    /// Addresses extracted from those user ids, lowercased.
    pub addresses: Vec<String>,
    /// We hold the private half: this is one of the user's own keys.
    pub secret: bool,
    /// The user has compared this fingerprint out of band.
    pub verified: bool,
    pub accounts: Vec<String>,
    pub algorithm: String,
}

impl PgpKeyInfo {
    pub fn trust(&self) -> SignerTrust {
        if self.verified {
            SignerTrust::Verified
        } else {
            SignerTrust::Known
        }
    }
}

// ── The keyring ─────────────────────────────────────────────────────────────

pub struct PgpKeyring {
    path: PathBuf,
    wrap: mail_crypt::Key,
}

impl std::fmt::Debug for PgpKeyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgpKeyring").field("path", &self.path).finish()
    }
}

impl PgpKeyring {
    /// Open (or create) the keyring in `dir`, sealed under the store's `k_wrap`.
    pub fn open(dir: &Path, keys: &MailKeys) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(PgpKeyring {
            path: dir.join(KEYRING_FILE),
            wrap: keys.wrap.clone(),
        })
    }

    fn read(&self) -> Result<KeyringFile, String> {
        match std::fs::read(&self.path) {
            Ok(raw) => {
                let plain = mail_crypt::open(&self.wrap, KEYRING_AAD, &raw)
                    .map_err(|e| format!("the keyring could not be decrypted: {e}"))?;
                let file: KeyringFile =
                    serde_json::from_slice(&plain).map_err(|e| format!("the keyring is corrupt: {e}"))?;
                if file.version != KEYRING_VERSION {
                    return Err(format!(
                        "this keyring was written by a newer version of Eldrun (v{})",
                        file.version
                    ));
                }
                Ok(file)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KeyringFile {
                version: KEYRING_VERSION,
                entries: Vec::new(),
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, file: &KeyringFile) -> Result<(), String> {
        let json = Zeroizing::new(serde_json::to_vec(file).map_err(|e| e.to_string())?);
        let sealed = mail_crypt::seal(&self.wrap, KEYRING_AAD, &json);
        mail_crypt::write_bytes_atomic(&self.path, &sealed)
    }

    pub fn list(&self) -> Result<Vec<PgpKeyInfo>, String> {
        let file = self.read()?;
        Ok(file.entries.iter().map(info_of).collect())
    }

    pub fn get(&self, fingerprint: &str) -> Result<Option<PgpKeyInfo>, String> {
        let fp = normalize_fingerprint(fingerprint);
        Ok(self.read()?.entries.iter().find(|e| e.fingerprint == fp).map(info_of))
    }

    /// Generate a fresh Curve25519 key and bind it to `account_id`.
    ///
    /// No algorithm parameter, and that absence is the point — see the module
    /// header. RSA is importable, never generable.
    pub fn generate(
        &self,
        name: &str,
        address: &str,
        account_id: &str,
    ) -> Result<PgpKeyInfo, String> {
        let uid = user_id_for(name, address);
        let secret = generate_curve25519(&uid)?;

        let mut file = self.read()?;
        let fingerprint = fingerprint_hex(&secret.fingerprint());
        let material = secret
            .to_bytes()
            .map_err(|e| format!("could not serialize the new key: {e}"))?;
        let entry = StoredKey {
            fingerprint: fingerprint.clone(),
            identities: user_ids_of_details(&secret.details),
            secret: true,
            // A key we generated on this machine needs no out-of-band check: we
            // watched it being made. This is the one place `verified` is set
            // without a fingerprint comparison, and it is not a shortcut.
            verified: true,
            accounts: vec![account_id.to_string()],
            algorithm: "Curve25519".into(),
            material: B64.encode(&material),
        };
        // One key per account. Generating a replacement takes the binding over
        // rather than adding a second — two keys claiming one account makes
        // "which key signs this message" a question with two answers. The old
        // key is *kept*, only unbound: it is still the key that decrypts every
        // message already received under it.
        for e in file.entries.iter_mut() {
            e.accounts.retain(|a| a != account_id);
        }
        file.entries.retain(|e| e.fingerprint != fingerprint);
        file.entries.push(entry.clone());
        self.write(&file)?;
        Ok(info_of(&entry))
    }

    /// Import one or more keys from armored or binary OpenPGP data.
    ///
    /// Both halves are accepted, and a *secret* import replaces a public entry
    /// for the same fingerprint rather than sitting beside it: holding the
    /// private half strictly supersedes holding only the public one, and two
    /// entries with one fingerprint would make every lookup a coin flip.
    ///
    /// An imported public key is `Known`, never `Verified` — importing is not
    /// checking. Only [`PgpKeyring::set_verified`] promotes it, and only from an
    /// explicit "I compared this fingerprint" click.
    pub fn import(&self, data: &[u8]) -> Result<Vec<PgpKeyInfo>, String> {
        let mut file = self.read()?;
        let mut added = Vec::new();

        // Secret first: a transferable secret key also parses as a public one in
        // some readers, and the secret half is the more useful reading.
        let secrets = SignedSecretKey::from_reader_many(data)
            .ok()
            .map(|(iter, _)| iter.flatten().collect::<Vec<_>>())
            .unwrap_or_default();
        for key in secrets {
            key.verify_bindings()
                .map_err(|e| format!("this key's own self-signatures do not check out: {e}"))?;
            let fingerprint = fingerprint_hex(&key.fingerprint());
            let material = key.to_bytes().map_err(|e| e.to_string())?;
            let entry = StoredKey {
                fingerprint: fingerprint.clone(),
                identities: user_ids_of_details(&key.details),
                secret: true,
                // Importing a *private* key is possession, not a claim about
                // someone else, so it needs no out-of-band check either.
                verified: true,
                accounts: carry_accounts(&file, &fingerprint),
                algorithm: algorithm_label(key.algorithm()),
                material: B64.encode(&material),
            };
            file.entries.retain(|e| e.fingerprint != fingerprint);
            file.entries.push(entry.clone());
            added.push(info_of(&entry));
        }

        if added.is_empty() {
            let (publics, _) = SignedPublicKey::from_reader_many(data)
                .map_err(|_| "this does not look like an OpenPGP key".to_string())?;
            for key in publics.flatten() {
                key.verify_bindings()
                    .map_err(|e| format!("this key's own self-signatures do not check out: {e}"))?;
                let fingerprint = fingerprint_hex(&key.fingerprint());
                // Never downgrade: re-importing the public half of a key whose
                // private half we hold must not throw the private half away.
                if file.entries.iter().any(|e| e.fingerprint == fingerprint && e.secret) {
                    continue;
                }
                let material = key.to_bytes().map_err(|e| e.to_string())?;
                let entry = StoredKey {
                    fingerprint: fingerprint.clone(),
                    identities: user_ids_of_details(&key.details),
                    secret: false,
                    verified: was_verified(&file, &fingerprint),
                    accounts: Vec::new(),
                    algorithm: algorithm_label(key.algorithm()),
                    material: B64.encode(&material),
                };
                file.entries.retain(|e| e.fingerprint != fingerprint);
                file.entries.push(entry.clone());
                added.push(info_of(&entry));
            }
        }

        if added.is_empty() {
            return Err("no OpenPGP key was found in that data".into());
        }
        self.write(&file)?;
        Ok(added)
    }

    /// Record that the user compared this key's fingerprint out of band.
    ///
    /// The only way a key becomes `Verified`, and therefore the only way any
    /// message ever earns positive chrome. It is a deliberate, per-key,
    /// user-initiated act — there is no heuristic that can stand in for it,
    /// because there is no authority to ask.
    pub fn set_verified(&self, fingerprint: &str, verified: bool) -> Result<PgpKeyInfo, String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        let entry = file
            .entries
            .iter_mut()
            .find(|e| e.fingerprint == fp)
            .ok_or("no such key")?;
        entry.verified = verified;
        let info = info_of(entry);
        self.write(&file)?;
        Ok(info)
    }

    /// Bind (or with `None`, unbind) one of our own keys to a mail account.
    pub fn bind_account(&self, fingerprint: &str, account_id: &str, bind: bool) -> Result<(), String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        // One key per account: a second binding would make "which key signs this
        // message" a question with two answers.
        if bind {
            for e in file.entries.iter_mut() {
                e.accounts.retain(|a| a != account_id);
            }
        }
        let entry = file
            .entries
            .iter_mut()
            .find(|e| e.fingerprint == fp)
            .ok_or("no such key")?;
        if !entry.secret && bind {
            return Err("only a key you hold the private half of can be an account's identity".into());
        }
        entry.accounts.retain(|a| a != account_id);
        if bind {
            entry.accounts.push(account_id.to_string());
        }
        self.write(&file)
    }

    pub fn delete(&self, fingerprint: &str) -> Result<(), String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        let before = file.entries.len();
        file.entries.retain(|e| e.fingerprint != fp);
        if file.entries.len() == before {
            return Err("no such key".into());
        }
        self.write(&file)
    }

    /// The armored public half, for sending to a correspondent.
    ///
    /// Public only, always — there is no command in this module that exports a
    /// private key, and that is not an omission. "Export my key" typed by
    /// somebody who means the public half is the standard way a private key ends
    /// up in an email.
    pub fn export_public(&self, fingerprint: &str) -> Result<String, String> {
        let fp = normalize_fingerprint(fingerprint);
        let file = self.read()?;
        let entry = file.entries.iter().find(|e| e.fingerprint == fp).ok_or("no such key")?;
        let material = B64.decode(&entry.material).map_err(|e| e.to_string())?;
        let public = if entry.secret {
            SignedPublicKey::from(
                SignedSecretKey::from_bytes(&material[..]).map_err(|e| e.to_string())?,
            )
        } else {
            SignedPublicKey::from_bytes(&material[..]).map_err(|e| e.to_string())?
        };
        public
            .to_armored_string(Default::default())
            .map_err(|e| e.to_string())
    }

    // ── Lookups the crypto operations run on ────────────────────────────────

    /// The secret key bound to `account_id`, if any.
    pub fn secret_for_account(&self, account_id: &str) -> Result<Option<SignedSecretKey>, String> {
        let file = self.read()?;
        let Some(entry) = file
            .entries
            .iter()
            .find(|e| e.secret && e.accounts.iter().any(|a| a == account_id))
        else {
            return Ok(None);
        };
        Ok(Some(parse_secret(entry)?))
    }

    /// Every secret key we hold.
    ///
    /// Decryption tries all of them, because an OpenPGP message names its
    /// recipients by key id and a key id can be a wildcard (`0`, "hidden
    /// recipient"). Trying each is the only correct behaviour, and the failure
    /// is the same single indistinguishable one either way.
    pub fn secret_keys(&self) -> Result<Vec<SignedSecretKey>, String> {
        let file = self.read()?;
        file.entries
            .iter()
            .filter(|e| e.secret)
            .map(parse_secret)
            .collect()
    }

    /// A public key by fingerprint (accepts the spaced/lowercase forms users
    /// paste).
    pub fn public_by_fingerprint(&self, fingerprint: &str) -> Result<Option<SignedPublicKey>, String> {
        let fp = normalize_fingerprint(fingerprint);
        let file = self.read()?;
        match file.entries.iter().find(|e| e.fingerprint == fp) {
            Some(entry) => parse_public(entry).map(Some),
            None => Ok(None),
        }
    }

    /// Every key that could have produced a signature, with its trust.
    ///
    /// Returns candidates rather than one key because a detached signature names
    /// its issuer by **key id** (64 bits) or fingerprint, and a key id is short
    /// enough to collide — deliberately, historically, and cheaply. Picking "the"
    /// key by a 64-bit match and reporting a pass would let anyone who generated
    /// a colliding key id have their signature attributed to someone else. The
    /// caller checks the signature against each candidate instead, so the
    /// cryptography decides which key it was, not the label.
    pub fn candidates_for(&self, key_ids: &[String]) -> Result<Vec<(SignedPublicKey, PgpKeyInfo)>, String> {
        let file = self.read()?;
        let wanted: Vec<String> = key_ids.iter().map(|k| normalize_fingerprint(k)).collect();
        let mut out = Vec::new();
        for entry in &file.entries {
            let hit = wanted.is_empty()
                || wanted.iter().any(|w| {
                    entry.fingerprint.ends_with(w.as_str()) || w.ends_with(&entry.fingerprint)
                });
            if hit {
                out.push((parse_public(entry)?, info_of(entry)));
            }
        }
        Ok(out)
    }

    /// The public key to encrypt to for `address`, if we hold one.
    pub fn public_for_address(&self, address: &str) -> Result<Option<(SignedPublicKey, PgpKeyInfo)>, String> {
        let wanted = address.trim().to_ascii_lowercase();
        let file = self.read()?;
        // Prefer a verified key over a merely known one with the same address:
        // if the user has checked one of them, that is the one they meant.
        let mut best: Option<&StoredKey> = None;
        for entry in &file.entries {
            if !info_of(entry).addresses.iter().any(|a| *a == wanted) {
                continue;
            }
            if best.is_none_or(|b| !b.verified && entry.verified) {
                best = Some(entry);
            }
        }
        match best {
            Some(entry) => Ok(Some((parse_public(entry)?, info_of(entry)))),
            None => Ok(None),
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn parse_secret(entry: &StoredKey) -> Result<SignedSecretKey, String> {
    let material = B64.decode(&entry.material).map_err(|e| e.to_string())?;
    SignedSecretKey::from_bytes(&material[..]).map_err(|e| e.to_string())
}

fn parse_public(entry: &StoredKey) -> Result<SignedPublicKey, String> {
    let material = B64.decode(&entry.material).map_err(|e| e.to_string())?;
    if entry.secret {
        Ok(SignedPublicKey::from(
            SignedSecretKey::from_bytes(&material[..]).map_err(|e| e.to_string())?,
        ))
    } else {
        SignedPublicKey::from_bytes(&material[..]).map_err(|e| e.to_string())
    }
}

fn carry_accounts(file: &KeyringFile, fingerprint: &str) -> Vec<String> {
    file.entries
        .iter()
        .find(|e| e.fingerprint == fingerprint)
        .map(|e| e.accounts.clone())
        .unwrap_or_default()
}

fn was_verified(file: &KeyringFile, fingerprint: &str) -> bool {
    file.entries
        .iter()
        .find(|e| e.fingerprint == fingerprint)
        .map(|e| e.verified)
        .unwrap_or(false)
}

fn info_of(entry: &StoredKey) -> PgpKeyInfo {
    PgpKeyInfo {
        fingerprint: entry.fingerprint.clone(),
        addresses: entry.identities.iter().filter_map(|u| address_of(u)).collect(),
        identities: entry.identities.clone(),
        secret: entry.secret,
        verified: entry.verified,
        accounts: entry.accounts.clone(),
        algorithm: entry.algorithm.clone(),
    }
}

/// The address out of an OpenPGP user id (`Name <a@b>` or a bare address).
///
/// Lowercased, because the alignment check compares mailboxes and a key whose
/// uid spells the address in title case is the same person.
pub fn address_of(uid: &str) -> Option<String> {
    let uid = uid.trim();
    if let (Some(open), Some(close)) = (uid.rfind('<'), uid.rfind('>')) {
        if open < close {
            let inner = uid[open + 1..close].trim();
            if inner.contains('@') {
                return Some(inner.to_ascii_lowercase());
            }
        }
    }
    if uid.contains('@') && !uid.contains(' ') {
        return Some(uid.to_ascii_lowercase());
    }
    None
}

fn user_id_for(name: &str, address: &str) -> String {
    let name = name.trim();
    let address = address.trim();
    if name.is_empty() {
        address.to_string()
    } else {
        format!("{name} <{address}>")
    }
}

fn user_ids_of_details(details: &pgp::composed::SignedKeyDetails) -> Vec<String> {
    details
        .users
        .iter()
        .map(|u| String::from_utf8_lossy(u.id.id()).into_owned())
        .collect()
}

/// Uppercase hex, no spaces — one spelling everywhere, so a lookup by
/// fingerprint cannot miss because of formatting.
fn fingerprint_hex(fp: &pgp::types::Fingerprint) -> String {
    fp.as_bytes().iter().map(|b| format!("{b:02X}")).collect()
}

/// Accept the forms a user can paste: spaced, lowercase, `0x`-prefixed.
pub fn normalize_fingerprint(s: &str) -> String {
    let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    s.chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// A fingerprint in the form people actually compare: groups of four.
///
/// Reading 40 undifferentiated hex characters aloud is how a fingerprint check
/// becomes a fingerprint glance, so the display form is the grouped one.
pub fn format_fingerprint(fp: &str) -> String {
    let fp = normalize_fingerprint(fp);
    fp.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn algorithm_label(alg: pgp::crypto::public_key::PublicKeyAlgorithm) -> String {
    use pgp::crypto::public_key::PublicKeyAlgorithm as A;
    match alg {
        A::RSA | A::RSAEncrypt | A::RSASign => "RSA".into(),
        A::EdDSALegacy | A::Ed25519 => "Curve25519".into(),
        A::ECDH | A::X25519 => "Curve25519".into(),
        other => format!("{other:?}"),
    }
}

/// A v4 Curve25519 key: Ed25519 primary (certify), Ed25519 signing subkey,
/// Curve25519 ECDH encryption subkey.
///
/// The **legacy** v4 forms rather than the RFC 9580 v6 ones, because
/// interoperating with Thunderbird, GnuPG and Outlook is the point of using a
/// standard and v6 support in the wild is not yet there.
fn generate_curve25519(uid: &str) -> Result<SignedSecretKey, String> {
    let mut signing = SubkeyParamsBuilder::default();
    signing
        .key_type(KeyType::Ed25519Legacy)
        .can_sign(true)
        .can_encrypt(EncryptionCaps::None)
        .can_authenticate(false);
    let mut encryption = SubkeyParamsBuilder::default();
    encryption
        .key_type(KeyType::ECDH(ECCCurve::Curve25519Legacy))
        .can_sign(false)
        .can_encrypt(EncryptionCaps::All)
        .can_authenticate(false);

    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(false)
        .can_encrypt(EncryptionCaps::None)
        .primary_user_id(uid.to_string())
        .subkeys(vec![
            signing.build().map_err(|e| e.to_string())?,
            encryption.build().map_err(|e| e.to_string())?,
        ]);

    // No passphrase on the key itself. The material is already sealed at rest
    // under the store key, so a second passphrase would protect nothing new and
    // would mean prompting on every signature — which is how signing gets turned
    // off. The store's unlock *is* the keyring's unlock.
    params
        .build()
        .map_err(|e| e.to_string())?
        .generate(rand::rngs::OsRng)
        .map_err(|e| format!("could not generate a key: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::mail_crypt::Key;

    fn keyring() -> (tempfile::TempDir, PgpKeyring) {
        let dir = tempfile::tempdir().unwrap();
        let keys = MailKeys::derive(Key::from_bytes([11u8; 32]));
        let ring = PgpKeyring::open(dir.path(), &keys).unwrap();
        (dir, ring)
    }

    #[test]
    fn a_generated_key_is_curve25519_and_bound_to_its_account() {
        let (_d, ring) = keyring();
        let info = ring.generate("Alice", "alice@example.com", "acct-1").unwrap();
        assert_eq!(info.algorithm, "Curve25519", "RSA must never be generated");
        assert_eq!(info.addresses, vec!["alice@example.com"]);
        assert!(info.secret);
        assert!(info.verified, "a key we made ourselves needs no out-of-band check");
        assert_eq!(info.accounts, vec!["acct-1"]);
        assert_eq!(info.fingerprint.len(), 40, "v4 fingerprint, uppercase hex");

        assert!(ring.secret_for_account("acct-1").unwrap().is_some());
        assert!(ring.secret_for_account("acct-2").unwrap().is_none());
    }

    #[test]
    fn the_keyring_file_holds_no_readable_key_material() {
        let (dir, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "acct-1").unwrap();
        let raw = std::fs::read(dir.path().join(KEYRING_FILE)).unwrap();
        for probe in [&b"alice@example.com"[..], b"Alice", b"PRIVATE KEY", b"fingerprint"] {
            assert!(
                !raw.windows(probe.len()).any(|w| w == probe),
                "{:?} is readable in the keyring file",
                String::from_utf8_lossy(probe)
            );
        }
    }

    #[test]
    fn another_store_key_cannot_open_the_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let ring = PgpKeyring::open(
            dir.path(),
            &MailKeys::derive(Key::from_bytes([11u8; 32])),
        )
        .unwrap();
        ring.generate("Alice", "alice@example.com", "a").unwrap();

        let wrong =
            PgpKeyring::open(dir.path(), &MailKeys::derive(Key::from_bytes([12u8; 32]))).unwrap();
        assert!(wrong.list().is_err());
    }

    #[test]
    fn an_imported_public_key_is_known_and_not_verified() {
        // The single most important default in this module. Importing is not
        // checking, and a key that arrives claiming to be someone must not be
        // able to grant itself the chrome that says it is.
        let (_d, source) = keyring();
        source.generate("Bob", "bob@example.org", "acct-b").unwrap();
        let armored = source
            .export_public(&source.list().unwrap()[0].fingerprint)
            .unwrap();

        let (_d2, mine) = keyring();
        let added = mine.import(armored.as_bytes()).unwrap();
        assert_eq!(added.len(), 1);
        assert!(!added[0].secret, "only the public half travelled");
        assert!(!added[0].verified, "an imported key is Known, never Verified");
        assert_eq!(added[0].trust(), SignerTrust::Known);
        assert_eq!(added[0].addresses, vec!["bob@example.org"]);
    }

    #[test]
    fn verifying_a_fingerprint_is_the_only_promotion() {
        let (_d, source) = keyring();
        source.generate("Bob", "bob@example.org", "b").unwrap();
        let armored = source.export_public(&source.list().unwrap()[0].fingerprint).unwrap();

        let (_d2, mine) = keyring();
        let fp = mine.import(armored.as_bytes()).unwrap()[0].fingerprint.clone();
        assert_eq!(mine.get(&fp).unwrap().unwrap().trust(), SignerTrust::Known);
        let promoted = mine.set_verified(&fp, true).unwrap();
        assert_eq!(promoted.trust(), SignerTrust::Verified);
        // …and it is reversible, because "I checked this" can turn out to be wrong.
        assert_eq!(
            mine.set_verified(&fp, false).unwrap().trust(),
            SignerTrust::Known
        );
    }

    /// Re-importing the public half of a key whose private half we hold must not
    /// throw the private half away — that would silently disable signing and
    /// decryption for the user's own address.
    #[test]
    fn a_public_import_never_downgrades_a_secret_key() {
        let (_d, ring) = keyring();
        let mine = ring.generate("Alice", "alice@example.com", "acct-1").unwrap();
        let armored = ring.export_public(&mine.fingerprint).unwrap();
        ring.import(armored.as_bytes()).ok();

        let back = ring.get(&mine.fingerprint).unwrap().unwrap();
        assert!(back.secret, "the private half must survive a public re-import");
        assert_eq!(back.accounts, vec!["acct-1"], "and so must its account binding");
        assert!(ring.secret_for_account("acct-1").unwrap().is_some());
    }

    #[test]
    fn one_account_has_exactly_one_key() {
        let (_d, ring) = keyring();
        let a = ring.generate("Alice", "alice@example.com", "acct-1").unwrap();
        let b = ring.generate("Alice Work", "alice@work.example", "acct-1").unwrap();
        let list = ring.list().unwrap();
        let bound: Vec<&PgpKeyInfo> = list.iter().filter(|k| k.accounts.contains(&"acct-1".into())).collect();
        assert_eq!(bound.len(), 1, "a second binding would make signing ambiguous");
        assert_eq!(bound[0].fingerprint, b.fingerprint);
        assert!(ring.get(&a.fingerprint).unwrap().is_some(), "the old key is kept, just unbound");
    }

    #[test]
    fn only_a_key_we_hold_the_private_half_of_can_be_an_identity() {
        let (_d, source) = keyring();
        source.generate("Bob", "bob@example.org", "b").unwrap();
        let armored = source.export_public(&source.list().unwrap()[0].fingerprint).unwrap();
        let (_d2, mine) = keyring();
        let fp = mine.import(armored.as_bytes()).unwrap()[0].fingerprint.clone();
        assert!(mine.bind_account(&fp, "acct-1", true).is_err());
    }

    #[test]
    fn lookup_by_address_prefers_a_verified_key() {
        let (_d, source) = keyring();
        source.generate("Bob One", "bob@example.org", "b1").unwrap();
        source.generate("Bob Two", "bob@example.org", "b2").unwrap();
        let fps: Vec<String> = source.list().unwrap().iter().map(|k| k.fingerprint.clone()).collect();

        let (_d2, mine) = keyring();
        for fp in &fps {
            mine.import(source.export_public(fp).unwrap().as_bytes()).unwrap();
        }
        mine.set_verified(&fps[1], true).unwrap();
        let (_key, info) = mine.public_for_address("BOB@Example.ORG").unwrap().unwrap();
        assert_eq!(info.fingerprint, fps[1], "the checked key wins");
    }

    #[test]
    fn deleting_a_key_removes_it() {
        let (_d, ring) = keyring();
        let info = ring.generate("Alice", "alice@example.com", "a").unwrap();
        ring.delete(&info.fingerprint).unwrap();
        assert!(ring.list().unwrap().is_empty());
        assert!(ring.delete(&info.fingerprint).is_err(), "twice is an error, not a no-op");
    }

    #[test]
    fn fingerprints_normalize_from_every_form_a_user_can_paste() {
        let canonical = "ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234";
        for form in [
            "abcd1234abcd1234abcd1234abcd1234abcd1234",
            "0xABCD1234ABCD1234ABCD1234ABCD1234ABCD1234",
            "ABCD 1234 ABCD 1234  ABCD 1234 ABCD 1234 ABCD 1234",
        ] {
            assert_eq!(normalize_fingerprint(form), canonical);
        }
        assert_eq!(
            format_fingerprint(canonical),
            "ABCD 1234 ABCD 1234 ABCD 1234 ABCD 1234 ABCD 1234",
            "shown in groups, because 40 run-together hex characters do not get compared"
        );
    }

    #[test]
    fn addresses_come_out_of_every_user_id_shape() {
        assert_eq!(address_of("Alice <A@Example.com>").as_deref(), Some("a@example.com"));
        assert_eq!(address_of("a@example.com").as_deref(), Some("a@example.com"));
        assert_eq!(address_of("Alice"), None);
        assert_eq!(address_of("Alice (work) <a@b.example>").as_deref(), Some("a@b.example"));
    }
}
