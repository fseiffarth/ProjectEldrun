use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct MobileHostSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_name")]
    pub display_name: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub serve_origin: Option<String>,
}

fn default_name() -> String {
    "Workstation".into()
}
fn default_port() -> u16 {
    8742
}

impl Default for MobileHostSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            display_name: default_name(),
            port: default_port(),
            serve_origin: None,
        }
    }
}

#[derive(Deserialize, Default)]
struct SettingsFile {
    #[serde(default)]
    eldrun_mobile_host: Option<MobileHostSettings>,
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub state_dir: PathBuf,
    pub control_dir: PathBuf,
    pub host: MobileHostSettings,
    pub origin: String,
}

pub fn validate_origin(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "Mobile origin must be a valid HTTPS origin")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Mobile origin must be one exact HTTPS origin with no path, credentials, query, or fragment".into());
    }
    let mut origin = format!("https://{}", url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

pub fn serve_status_json() -> Result<serde_json::Value, String> {
    let output = crate::paths::command_no_window("tailscale")
        .args(["serve", "status", "--json"])
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Tailscale is not installed".to_string()
            } else {
                error.to_string()
            }
        })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "Tailscale returned invalid Serve status JSON".into())
}

pub fn verify_serve_json(
    status: &serde_json::Value,
    origin: &str,
    port: u16,
) -> Result<(), String> {
    let origin = validate_origin(origin)?;
    let url = url::Url::parse(&origin).map_err(|_| "Invalid Serve origin")?;
    let host = url.host_str().ok_or("Invalid Serve origin")?;
    let public_port = url
        .port_or_known_default()
        .ok_or("Invalid Serve origin port")?;
    let authority = format!("{host}:{public_port}");
    let target = format!("http://127.0.0.1:{port}");

    let https = status
        .pointer(&format!("/TCP/{public_port}/HTTPS"))
        .and_then(serde_json::Value::as_bool);
    if https != Some(true) {
        return Err(format!(
            "Tailscale Serve has no HTTPS listener for {authority}"
        ));
    }
    let proxy = status
        .get("Web")
        .and_then(|web| web.get(&authority))
        .and_then(|server| server.get("Handlers"))
        .and_then(|handlers| handlers.get("/"))
        .and_then(|handler| handler.get("Proxy"))
        .and_then(serde_json::Value::as_str);
    if proxy != Some(target.as_str()) {
        return Err(format!(
            "Tailscale Serve root handler for {authority} must proxy exactly to {target}"
        ));
    }
    if status
        .get("AllowFunnel")
        .and_then(|funnel| funnel.get(&authority))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return Err("The configured origin is exposed through Tailscale Funnel; disable Funnel before enabling Eldrun Mobile".into());
    }
    Ok(())
}

pub fn verify_tailscale_serve(origin: &str, port: u16) -> Result<(), String> {
    verify_serve_json(&serve_status_json()?, origin, port)
}

impl HostConfig {
    pub fn load(state_dir: &Path) -> Result<Self, String> {
        let settings: SettingsFile = fs::read(state_dir.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let host = settings.eldrun_mobile_host.unwrap_or_default();
        if !host.enabled {
            return Err("Eldrun Mobile is disabled".into());
        }
        if !(1024..=65535).contains(&host.port) {
            return Err("Mobile host port must be between 1024 and 65535".into());
        }
        let origin = validate_origin(
            host.serve_origin
                .as_deref()
                .ok_or("A verified Tailscale Serve origin is required")?,
        )?;
        let control_dir = state_dir.join("mobile-control");
        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            control_dir,
            host,
            origin,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_https_origin() {
        assert_eq!(
            validate_origin("https://desk.tail.test").unwrap(),
            "https://desk.tail.test"
        );
        for bad in [
            "http://desk.tail.test",
            "https://u@desk.tail.test",
            "https://desk.tail.test/x",
            "https://desk.tail.test/?q=x",
        ] {
            assert!(validate_origin(bad).is_err(), "accepted {bad}");
        }
    }

    fn serve_status() -> serde_json::Value {
        serde_json::json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": {
                "desk.example.ts.net:443": {
                    "Handlers": { "/": { "Proxy": "http://127.0.0.1:8742" } }
                }
            }
        })
    }

    #[test]
    fn verifies_exact_non_funnel_root_handler() {
        assert!(verify_serve_json(&serve_status(), "https://desk.example.ts.net", 8742).is_ok());
    }

    #[test]
    fn rejects_wrong_target_or_funnel() {
        assert!(verify_serve_json(&serve_status(), "https://desk.example.ts.net", 9999).is_err());
        let mut funnel = serve_status();
        funnel["AllowFunnel"] = serde_json::json!({ "desk.example.ts.net:443": true });
        assert!(verify_serve_json(&funnel, "https://desk.example.ts.net", 8742).is_err());
    }
}
