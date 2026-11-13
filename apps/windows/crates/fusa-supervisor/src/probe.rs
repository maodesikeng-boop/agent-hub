use std::fmt;
use std::io::Read;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use crate::contract::DesktopContract;
use crate::error::SupervisorError;

/// 仅驻留于 Rust 内存的 UI 认证令牌封装（严禁打印日志、序列化、拼入 URL 或暴露给前端全局变量）。
#[derive(Clone, PartialEq, Eq)]
pub struct SecretUiToken {
    value: String,
}

impl SecretUiToken {
    pub fn new(raw: impl Into<String>) -> Result<Self, SupervisorError> {
        let trimmed = raw.into().trim().to_string();
        if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c == '\0') {
            return Err(SupervisorError::AuthExchangeFailed(
                "读取到的 ui-token 为空或包含非法控制字符".to_string(),
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

/// 由 `POST /auth` 兑换得到的回环会话 Cookie（仅写入当前 WebView 实例 CookieJar）。
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

/// 经 `/api/auth/status` 核验通过的 Fusa 守护进程身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonIdentity {
    pub product: String,
    pub protocol_version: u32,
    pub instance_id: String,
    #[serde(default)]
    pub status: Option<String>,
}

/// 经 `GET /api/health`（携带已兑换会话 Cookie）核验通过的健康状态响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealthReport {
    pub ok: bool,
    pub product: String,
    pub protocol_version: u32,
    pub instance_id: String,
}

/// 单侧探活失败原因（结构化建模，区分“尚未就绪/不可达”与“端口冲突/非法重定向”）。
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
            Self::Unreachable { reason } => format!("127.0.0.1:{port} 尚未可达（{reason}）"),
            Self::RedirectBlocked { status_code } => format!(
                "端口 {port} 返回了 HTTP {status_code} 重定向，已按安全策略拦截，请关闭占用该端口的其他程序"
            ),
            Self::UnexpectedHttpStatus { status_code } => format!(
                "端口 {port} 已被其他 HTTP 服务占用（返回状态码 {status_code}），请先关闭占用程序"
            ),
            Self::InvalidJson { .. } => format!(
                "端口 {port} 已被非 Fusa 服务占用（响应不是有效的状态 JSON），请先关闭占用程序"
            ),
            Self::ProductMismatch { actual } => format!(
                "端口 {port} 已被其他服务或旧版后台占用（product={actual:?}），请先关闭占用程序"
            ),
            Self::IncompatibleProtocol { actual, expected } => format!(
                "端口 {port} 上的 Fusa 协议版本不兼容（实际: {actual:?}，需要: {expected}），请停止旧进程或更新应用"
            ),
            Self::InvalidInstanceId => {
                format!("端口 {port} 上的服务缺少合法的 Fusa instanceId，拒绝连接")
            }
        }
    }
}

/// 本机回环 HTTP 探活结果。
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

/// 按 `contract.json` 严格校验 `/api/auth/status` 的 HTTP 状态码与响应 JSON。
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

/// 解析 `POST /auth` 返回的 `Set-Cookie` 响应头。
pub fn parse_set_cookie_header(header_val: &str, expected_port: u16) -> Result<SessionCookie, SupervisorError> {
    let mut segments = header_val.split(';').map(str::trim);
    let Some(first) = segments.next() else {
        return Err(SupervisorError::AuthExchangeFailed(
            "Set-Cookie 响应头为空".to_string(),
        ));
    };
    let Some((name, value)) = first.split_once('=') else {
        return Err(SupervisorError::AuthExchangeFailed(
            "Set-Cookie 缺少键值分隔符".to_string(),
        ));
    };
    let name = name.trim();
    let value = value.trim();
    let expected_prefix = format!("agent_hub_ui_{expected_port}");
    if name.is_empty() || value.is_empty() || name != expected_prefix {
        return Err(SupervisorError::AuthExchangeFailed(format!(
            "Set-Cookie 名称与当前端口不符（收到: {name:?}，期望: {expected_prefix:?}）"
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

/// 宿主侧回环 HTTP 客户端抽象（支持注入单测桩，真实实现强制关闭 3xx 重定向与系统代理）。
pub trait HostHttpClient: Send + Sync {
    fn probe_status(&self, port: u16, contract: &DesktopContract) -> ProbeOutcome;

    fn exchange_session_cookie(
        &self,
        port: u16,
        token: &SecretUiToken,
        timeout: Duration,
    ) -> Result<SessionCookie, SupervisorError>;
}

/// 基于 `ureq` 的真实宿主 HTTP 客户端：强制 `max_redirects(0)` 与 `proxy(None)`，绝不自动跟随任何 3xx 重定向。
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

    /// 请求需要鉴权的 `GET /api/health`（可选携带 `SessionCookie`，用于 `--self-test` 同时验证无 Cookie 401 与有 Cookie 200）。
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
        if let Err(err) = resp.into_body().into_reader().take(65_536).read_to_end(&mut body) {
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
                    "请求 POST /auth 失败：{err}"
                )))
            }
        };

        let status_code = resp.status().as_u16();
        if (300..=399).contains(&status_code) {
            return Err(SupervisorError::RedirectBlocked { status_code });
        }
        if status_code != 204 && status_code != 200 {
            return Err(SupervisorError::AuthExchangeFailed(format!(
                "POST /auth 返回非预期状态码 {status_code}"
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
            "POST /auth 未返回有效的会话 Set-Cookie 响应头".to_string(),
        ))
    }
}
