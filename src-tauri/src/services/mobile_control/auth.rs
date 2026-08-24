use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use p256::{
    ecdsa::{signature::Verifier, Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
    PublicKey,
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::{protocol::AdminDevice, store};

type HmacSha256 = Hmac<Sha256>;
const DEVICE_SCHEMA: u32 = 1;
const PAIR_TTL: u64 = 5 * 60;
const CHALLENGE_TTL: u64 = 60;
const SESSION_TTL: u64 = 12 * 60 * 60;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| format!("no system randomness: {e}"))?;
    Ok(bytes)
}

fn random_id<const N: usize>() -> Result<String, String> {
    Ok(Base64UrlUnpadded::encode_string(&random_bytes::<N>()?))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceFile {
    schema: u32,
    devices: Vec<Device>,
}

impl Default for DeviceFile {
    fn default() -> Self {
        Self {
            schema: DEVICE_SCHEMA,
            devices: vec![],
        }
    }
}

#[derive(Clone)]
struct PairCode {
    hash: [u8; 32],
    expires_at: u64,
}

#[derive(Clone)]
struct Challenge {
    device_id: String,
    payload: String,
    expires_at: u64,
}

#[derive(Clone)]
struct Session {
    device_id: String,
    expires_at: u64,
}

pub struct AuthStore {
    control_dir: PathBuf,
    origin: String,
    host_key: Vec<u8>,
    devices: DeviceFile,
    pairing: Option<PairCode>,
    challenges: HashMap<String, Challenge>,
    sessions: HashMap<String, Session>,
    attempts: VecDeque<u64>,
}

impl AuthStore {
    pub fn open(control_dir: &Path, origin: String) -> Result<Self, String> {
        store::ensure_private_dir(control_dir)?;
        let key_path = control_dir.join("host.key");
        let host_key = if key_path.exists() {
            store::ensure_private_file(&key_path)?;
            let key = fs::read(&key_path).map_err(|e| format!("read host key: {e}"))?;
            if key.len() != 32 {
                return Err("host.key has invalid length".into());
            }
            key
        } else {
            let key = random_bytes::<32>()?.to_vec();
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options
                .open(&key_path)
                .map_err(|e| format!("create host key: {e}"))?;
            file.write_all(&key)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            store::ensure_private_file(&key_path)?;
            key
        };
        let devices_path = control_dir.join("devices.json");
        let devices: DeviceFile = if devices_path.exists() {
            store::ensure_private_file(&devices_path)?;
            let file: DeviceFile = store::read_json(&devices_path)?;
            if file.schema != DEVICE_SCHEMA {
                return Err("devices.json has an unsupported schema".into());
            }
            file
        } else {
            DeviceFile::default()
        };
        Ok(Self {
            control_dir: control_dir.to_path_buf(),
            origin,
            host_key,
            devices,
            pairing: None,
            challenges: HashMap::new(),
            sessions: HashMap::new(),
            attempts: VecDeque::new(),
        })
    }

    pub fn host_key(&self) -> &[u8] {
        &self.host_key
    }

    fn rate_limit(&mut self) -> Result<(), String> {
        let t = now();
        while self
            .attempts
            .front()
            .is_some_and(|v| t.saturating_sub(*v) > 60)
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= 30 {
            return Err("too_many_attempts".into());
        }
        self.attempts.push_back(t);
        Ok(())
    }

    fn keyed(&self, purpose: &[u8], value: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.host_key).expect("HMAC key");
        mac.update(purpose);
        mac.update(&[0]);
        mac.update(value);
        mac.finalize().into_bytes().into()
    }

    fn save_devices(&self) -> Result<(), String> {
        store::write_json_atomic(&self.control_dir.join("devices.json"), &self.devices, 0o600)
    }

    pub fn create_pairing_code(&mut self) -> Result<(String, u64), String> {
        let raw = u32::from_be_bytes(random_bytes::<4>()?) % 100_000_000;
        let code = format!("{raw:08}");
        let expires_at = now() + PAIR_TTL;
        self.pairing = Some(PairCode {
            hash: self.keyed(b"pair", code.as_bytes()),
            expires_at,
        });
        Ok((code, expires_at))
    }

    pub fn pair(&mut self, code: &str, name: &str, public_key: &str) -> Result<String, String> {
        self.rate_limit()?;
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err("invalid_pairing_code".into());
        }
        let pairing = self.pairing.take().ok_or("invalid_pairing_code")?;
        let supplied = self.keyed(b"pair", code.as_bytes());
        if pairing.expires_at < now() || !bool::from(pairing.hash.ct_eq(&supplied)) {
            return Err("invalid_pairing_code".into());
        }
        let clean_name = name.trim().chars().take(64).collect::<String>();
        if clean_name.is_empty() {
            return Err("device_name_required".into());
        }
        let der = Base64UrlUnpadded::decode_vec(public_key).map_err(|_| "invalid_public_key")?;
        PublicKey::from_public_key_der(&der).map_err(|_| "invalid_public_key")?;
        if der.len() > 256 {
            return Err("invalid_public_key".into());
        }
        let id = random_id::<20>()?;
        self.devices.devices.push(Device {
            id: id.clone(),
            name: clean_name,
            public_key: public_key.into(),
            created_at: now(),
            last_seen_at: None,
        });
        self.save_devices()?;
        self.audit("paired", Some(&id));
        Ok(id)
    }

    pub fn challenge(&mut self, device_id: &str) -> Result<(String, String, u64), String> {
        self.rate_limit()?;
        if !self.devices.devices.iter().any(|d| d.id == device_id) {
            return Err("unknown_device".into());
        }
        let nonce = random_id::<24>()?;
        let expires_at = now() + CHALLENGE_TTL;
        let payload = format!(
            "eldrun-mobile-auth-v1\n{}\n{}\n{}\n{}",
            self.origin, device_id, nonce, expires_at
        );
        self.challenges.insert(
            nonce.clone(),
            Challenge {
                device_id: device_id.into(),
                payload: payload.clone(),
                expires_at,
            },
        );
        Ok((nonce, payload, expires_at))
    }

    pub fn login(
        &mut self,
        device_id: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<(String, u64), String> {
        self.rate_limit()?;
        let challenge = self.challenges.remove(nonce).ok_or("invalid_challenge")?;
        if challenge.device_id != device_id || challenge.expires_at < now() {
            return Err("invalid_challenge".into());
        }
        let device = self
            .devices
            .devices
            .iter_mut()
            .find(|d| d.id == device_id)
            .ok_or("unknown_device")?;
        let der =
            Base64UrlUnpadded::decode_vec(&device.public_key).map_err(|_| "invalid_public_key")?;
        let key = PublicKey::from_public_key_der(&der).map_err(|_| "invalid_public_key")?;
        let verifying = VerifyingKey::from(key);
        let sig = Base64UrlUnpadded::decode_vec(signature).map_err(|_| "invalid_signature")?;
        if sig.len() != 64 {
            return Err("invalid_signature".into());
        }
        let sig = Signature::from_slice(&sig).map_err(|_| "invalid_signature")?;
        verifying
            .verify(challenge.payload.as_bytes(), &sig)
            .map_err(|_| "invalid_signature")?;
        device.last_seen_at = Some(now());
        let token = random_id::<32>()?;
        let expires_at = now() + SESSION_TTL;
        self.sessions.insert(
            token.clone(),
            Session {
                device_id: device_id.into(),
                expires_at,
            },
        );
        self.save_devices()?;
        self.audit("login", Some(device_id));
        Ok((token, expires_at))
    }

    pub fn authenticate(&mut self, token: &str) -> Option<String> {
        let session = self.sessions.get(token)?.clone();
        if session.expires_at < now() {
            self.sessions.remove(token);
            return None;
        }
        Some(session.device_id)
    }

    pub fn logout(&mut self, token: &str) {
        self.sessions.remove(token);
    }

    pub fn devices(&self) -> Vec<AdminDevice> {
        self.devices
            .devices
            .iter()
            .map(|d| AdminDevice {
                id: d.id.clone(),
                name: d.name.clone(),
                created_at: d.created_at,
                last_seen_at: d.last_seen_at,
            })
            .collect()
    }

    pub fn revoke(&mut self, device_id: &str) -> Result<(), String> {
        let before = self.devices.devices.len();
        self.devices.devices.retain(|d| d.id != device_id);
        if before == self.devices.devices.len() {
            return Err("unknown device".into());
        }
        self.sessions.retain(|_, s| s.device_id != device_id);
        self.challenges.retain(|_, c| c.device_id != device_id);
        self.save_devices()?;
        self.audit("revoked", Some(device_id));
        Ok(())
    }

    pub fn forget_all(&mut self) -> Result<(), String> {
        self.devices.devices.clear();
        self.sessions.clear();
        self.challenges.clear();
        self.pairing = None;
        self.save_devices()?;
        let next = random_bytes::<32>()?;
        fs::write(self.control_dir.join("host.key"), next).map_err(|e| e.to_string())?;
        self.host_key = next.to_vec();
        self.audit("forgot_all", None);
        Ok(())
    }

    fn audit(&self, event: &str, device_id: Option<&str>) {
        #[derive(Serialize)]
        struct Row<'a> {
            at: u64,
            event: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            device_id: Option<&'a str>,
        }
        let path = self.control_dir.join("audit.jsonl");
        if fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
            let _ = fs::rename(&path, self.control_dir.join("audit.jsonl.1"));
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(path) {
            use std::io::Write;
            if let Ok(row) = serde_json::to_string(&Row {
                at: now(),
                event,
                device_id,
            }) {
                let _ = writeln!(file, "{row}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::{
        ecdsa::{signature::Signer, SigningKey},
        elliptic_curve::rand_core::OsRng,
        pkcs8::EncodePublicKey,
    };

    #[test]
    fn pairing_login_and_revocation_are_key_bound() {
        let dir = tempfile::tempdir().expect("control dir");
        let mut auth =
            AuthStore::open(dir.path(), "https://desk.example.ts.net".into()).expect("auth store");
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        let (nonce, payload, _) = auth.challenge(&device).expect("challenge");
        let signature: Signature = signing.sign(payload.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        let (token, _) = auth.login(&device, &nonce, &signature).expect("login");
        assert_eq!(auth.authenticate(&token).as_deref(), Some(device.as_str()));
        auth.revoke(&device).expect("revoke");
        assert!(auth.authenticate(&token).is_none());
    }
}
