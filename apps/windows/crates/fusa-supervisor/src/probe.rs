use crate::contract::DesktopContract;
use crate::error::SupervisorError;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Read;
use std::time::Duration;

// Never log, serialize, put in a URL or expose to the frontend.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretUiToken {
    value: String,
}

impl SecretUiToken {
    pub fn new(raw: impl Into<String>) -> Result<Self, SupervisorError> {
        let trimmed = raw.into().trim().to_string();
        if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c == '\0') {
            return Err(SupervisorError::AuthExchangeFailed(
                "ui-token is empty or contains control characters".to_string(),
            ));
        }
        Ok(Self { value: trimmed })
    }

    pub(crate) fn expose_secret(&self) -> &str {
        &self.value
    }
}

impl fmt::Debug for SecretUiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretUiToken([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SessionCookie {
    pub name: String,
    value: String,
    pub path: String,
    pub http_only: bool,
    pub same_site_strict: bool,
    pub max_age_secs: Option<u64>,
}

impl SessionCookie {
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
        path: impl Into<String>,
        http_only: bool,
        same_site_strict: bool,
        max_age_secs: Option<u64>,
    ) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
            path: path.into(),
            http_only,
            same_site_strict,
            max_age_secs,
        }
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

impl fmt::Debug for SessionCookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionCookie")
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .field("path", &self.path)
            .field("http_only", &self.http_only)
            .field("same_site_strict", &self.same_site_strict)
            .field("max_age_secs", &self.max_age_secs)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonIdentity {
    pub product: String,
    pub protocol_version: u32,
    pub instance_id: String,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealthReport {
    pub ok: bool,
    pub product: String,
    pub protocol_version: u32,
    pub instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProbeFailureKind {
    Unreachable { reason: String },
    RedirectBlocked { status_code: u16 },
    UnexpectedHttpStatus { status_code: u16 },
    InvalidJson { reason: String },
    ProductMismatch { actual: Option<String> },
    IncompatibleProtocol { actual: Option<i64>, expected: u32 },
    InvalidInstanceId,
}

impl ProbeFailureKind {
    pub fn is_port_conflict(&self) -> bool {
        !matches!(self, Self::Unreachable { .. })
    }

    pub fn describe_for_port(&self, port: u16) -> String {
        match self {
            Self::Unreachable { reason } => format!("127.0.0.1:{port} is not reachable yet ({reason})"),
            Self::RedirectBlocked { status_code } => format!(
                "Port {port} returned an HTTP {status_code} redirect, which is blocked. Close the program using this port"
            ),
            Self::UnexpectedHttpStatus { status_code } => format!(
                "Port {port} is used by another HTTP service (status {status_code}). Close that program first"
            ),
            Self::InvalidJson { .. } => format!(
                "Port {port} is used by a non-Bellwood service (no valid status JSON). Close that program first"
            ),
            Self::ProductMismatch { actual } => format!(
                "Port {port} is used by another service or an older daemon (product={actual:?}). Close that program first"
            ),
            Self::IncompatibleProtocol { actual, expected } => format!(
                "The Bellwood daemon on port {port} speaks an incompatible protocol (got {actual:?}, need {expected}). Stop the old process or update the app"
            ),
            Self::InvalidInstanceId => {
                format!("The service on port {port} has no valid Bellwood instanceId. Connection refused")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    Verified(DaemonIdentity),
    Failed(ProbeFailureKind),
}

impl ProbeOutcome {
    pub fn is_port_conflict(&self) -> bool {
        matches!(self, Self::Failed(kind) if kind.is_port_conflict())
    }
}

fn is_valid_instance_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn parse_status_http_response(
    status_code: u16,
    body: &[u8],
    contract: &DesktopContract,
) -> ProbeOutcome {
    if status_code == 0 {
        return ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
            reason: "connection_failed".to_string(),
        });
    }
    if (300..=399).contains(&status_code) {
        return ProbeOutcome::Failed(ProbeFailureKind::RedirectBlocked { status_code });
    }
    if status_code != 200 {
        return ProbeOutcome::Failed(ProbeFailureKind::UnexpectedHttpStatus { status_code });
    }

    let val: serde_json::Value = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(v) if v.is_object() => v,
        Ok(_) => {
            return ProbeOutcome::Failed(ProbeFailureKind::InvalidJson {
                reason: "not_json_object".to_string(),
            })
        }
        Err(err) => {
            return ProbeOutcome::Failed(ProbeFailureKind::InvalidJson {
                reason: err.to_string(),
            })
        }
    };

    let product = val.get("product").and_then(|v| v.as_str());
    if product != Some(contract.product.as_str()) {
        return ProbeOutcome::Failed(ProbeFailureKind::ProductMismatch {
            actual: product.map(ToOwned::to_owned),
        });
    }

    let proto_val = val.get("protocolVersion");
    let proto_i64 = match proto_val {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        _ => None,
    };
    if proto_i64 != Some(i64::from(contract.protocol_version)) {
        return ProbeOutcome::Failed(ProbeFailureKind::IncompatibleProtocol {
            actual: proto_i64,
            expected: contract.protocol_version,
        });
    }

    let Some(raw_id) = val.get("instanceId").and_then(|v| v.as_str()) else {
        return ProbeOutcome::Failed(ProbeFailureKind::InvalidInstanceId);
    };
    let trimmed_id = raw_id.trim();
    if !is_valid_instance_id(trimmed_id) {
        return ProbeOutcome::Failed(ProbeFailureKind::InvalidInstanceId);
    }

    let auth_status = val
        .get("status")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);

    ProbeOutcome::Verified(DaemonIdentity {
        product: contract.product.clone(),
        protocol_version: contract.protocol_version,
        instance_id: trimmed_id.to_string(),
        status: auth_status,
    })
}

pub fn parse_set_cookie_header(
    header_val: &str,
    expected_port: u16,
) -> Result<SessionCookie, SupervisorError> {
    let mut segments = header_val.split(';').map(str::trim);
    let Some(first) = segments.next() else {
        return Err(SupervisorError::AuthExchangeFailed(
            "Set-Cookie header is empty".to_string(),
        ));
    };
    let Some((name, value)) = first.split_once('=') else {
        return Err(SupervisorError::AuthExchangeFailed(
            "Set-Cookie has no name=value separator".to_string(),
        ));
    };
    let name = name.trim();
    let value = value.trim();
    let expected_prefix = format!("agent_hub_ui_{expected_port}");
    if name.is_empty() || value.is_empty() || name != expected_prefix {
        return Err(SupervisorError::AuthExchangeFailed(format!(
            "Set-Cookie name does not match this port (got {name:?}, expected {expected_prefix:?})"
        )));
    }

    let mut path = "/".to_string();
    let mut http_only = false;
    let mut same_site_strict = false;
    let mut max_age_secs = None;

    for attr in segments {
        if attr.eq_ignore_ascii_case("HttpOnly") {
            http_only = true;
        } else if let Some((k, v)) = attr.split_once('=') {
            let k = k.trim();
            let v = v.trim();
            if k.eq_ignore_ascii_case("Path") && !v.is_empty() {
                path = v.to_string();
            } else if k.eq_ignore_ascii_case("SameSite") && v.eq_ignore_ascii_case("Strict") {
                same_site_strict = true;
            } else if k.eq_ignore_ascii_case("Max-Age") {
                max_age_secs = v.parse::<u64>().ok();
            }
        }
    }

    Ok(SessionCookie::new(
        name,
        value,
        path,
        http_only,
        same_site_strict,
        max_age_secs,
    ))
}

pub trait HostHttpClient: Send + Sync {
    fn probe_status(&self, port: u16, contract: &DesktopContract) -> ProbeOutcome;

    fn exchange_session_cookie(
        &self,
        port: u16,
        token: &SecretUiToken,
        timeout: Duration,
    ) -> Result<SessionCookie, SupervisorError>;
}

// Redirects and system proxies stay disabled so a 3xx is never followed.
#[derive(Debug, Default, Clone, Copy)]
pub struct UreqHostHttpClient;

impl UreqHostHttpClient {
    fn build_agent(timeout: Duration) -> ureq::Agent {
        let cfg = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .no_delay(true)
            .proxy(None)
            .timeout_global(Some(timeout))
            .build();
        cfg.into()
    }

    pub fn request_health(
        &self,
        port: u16,
        cookie: Option<&SessionCookie>,
        contract: &DesktopContract,
        timeout: Duration,
    ) -> Result<(u16, Option<DaemonHealthReport>), SupervisorError> {
        let agent = Self::build_agent(timeout);
        let url = format!("http://127.0.0.1:{port}{}", contract.health_path);
        let host_header = format!("127.0.0.1:{port}");
        let mut req = agent.get(&url).header("Host", &host_header);
        if let Some(sc) = cookie {
            req = req.header("Cookie", &format!("{}={}", sc.name, sc.value()));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::TooManyRedirects) => {
                return Err(SupervisorError::RedirectBlocked { status_code: 302 })
            }
            Err(err) => return Err(SupervisorError::HealthCheckFailed(err.to_string())),
        };
        let status_code = resp.status().as_u16();
        if (300..=399).contains(&status_code) {
            return Err(SupervisorError::RedirectBlocked { status_code });
        }
        let mut body = Vec::with_capacity(512);
        resp.into_body()
            .into_reader()
            .take(65_536)
            .read_to_end(&mut body)
            .map_err(|e| SupervisorError::HealthCheckFailed(e.to_string()))?;
        let report = if status_code == 200 {
            Some(serde_json::from_slice::<DaemonHealthReport>(&body)?)
        } else {
            None
        };
        Ok((status_code, report))
    }
}

impl HostHttpClient for UreqHostHttpClient {
    fn probe_status(&self, port: u16, contract: &DesktopContract) -> ProbeOutcome {
        let agent = Self::build_agent(contract.probe_timeout());
        let url = format!("http://127.0.0.1:{port}{}", contract.status_path);
        let host_header = format!("127.0.0.1:{port}");

        let resp = match agent.get(&url).header("Host", &host_header).call() {
            Ok(r) => r,
            Err(ureq::Error::TooManyRedirects) => {
                return ProbeOutcome::Failed(ProbeFailureKind::RedirectBlocked { status_code: 302 })
            }
            Err(err) => {
                return ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: err.to_string(),
                })
            }
        };

        let status_code = resp.status().as_u16();
        if (300..=399).contains(&status_code) {
            return ProbeOutcome::Failed(ProbeFailureKind::RedirectBlocked { status_code });
        }

        let mut body = Vec::with_capacity(512);
        if let Err(err) = resp
            .into_body()
            .into_reader()
            .take(65_536)
            .read_to_end(&mut body)
        {
            return ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                reason: err.to_string(),
            });
        }
        parse_status_http_response(status_code, &body, contract)
    }

    fn exchange_session_cookie(
        &self,
        port: u16,
        token: &SecretUiToken,
        timeout: Duration,
    ) -> Result<SessionCookie, SupervisorError> {
        let agent = Self::build_agent(timeout);
        let url = format!("http://127.0.0.1:{port}/auth");
        let host_header = format!("127.0.0.1:{port}");
        let origin_header = format!("http://127.0.0.1:{port}");
        let payload = serde_json::json!({ "token": token.expose_secret() }).to_string();

        let resp = match agent
            .post(&url)
            .header("Host", &host_header)
            .header("Origin", &origin_header)
            .header("Content-Type", "application/json")
            .send(payload.as_bytes())
        {
            Ok(r) => r,
            Err(ureq::Error::TooManyRedirects) => {
                return Err(SupervisorError::RedirectBlocked { status_code: 302 })
            }
            Err(err) => {
                return Err(SupervisorError::AuthExchangeFailed(format!(
                    "POST /auth failed: {err}"
                )))
            }
        };

        let status_code = resp.status().as_u16();
        if (300..=399).contains(&status_code) {
            return Err(SupervisorError::RedirectBlocked { status_code });
        }
        if status_code != 204 && status_code != 200 {
            return Err(SupervisorError::AuthExchangeFailed(format!(
                "POST /auth returned unexpected status {status_code}"
            )));
        }

        for val in resp.headers().get_all("set-cookie") {
            if let Ok(header_str) = val.to_str() {
                if let Ok(cookie) = parse_set_cookie_header(header_str, port) {
                    return Ok(cookie);
                }
            }
        }

        Err(SupervisorError::AuthExchangeFailed(
            "POST /auth returned no valid session Set-Cookie header".to_string(),
        ))
    }
}
