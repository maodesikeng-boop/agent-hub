use serde::Deserialize;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Deserialize)]
struct HubShimConfig {
    node: String,
    main: String,
    #[serde(default)]
    #[cfg_attr(not(windows), allow(dead_code))]
    direct_pipe: bool,
}

fn read_adjacent_config() -> Option<HubShimConfig> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    let json_path: PathBuf = dir.join("hub.json");
    let content = fs::read_to_string(json_path).ok()?;
    serde_json::from_str::<HubShimConfig>(&content).ok()
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum ValidatedWinHubEndpoint {
    LoopbackTcp(u16),
    LocalNamedPipe(String),
    UnsupportedLocalPath,
    ForbiddenRemoteOrUrl,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_loopback_tcp_endpoint(raw: &str) -> Option<u16> {
    let port_str = raw.trim().strip_prefix("tcp://127.0.0.1:")?;
    if port_str.starts_with('0') || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port = port_str.parse::<u16>().ok()?;
    (port > 0).then_some(port)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn classify_win_hub_endpoint(raw: &str) -> ValidatedWinHubEndpoint {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return ValidatedWinHubEndpoint::UnsupportedLocalPath;
    }
    if let Some(port) = parse_loopback_tcp_endpoint(trimmed) {
        return ValidatedWinHubEndpoint::LoopbackTcp(port);
    }
    if let Some(pipe_name) = trimmed.strip_prefix(r"\\.\pipe\") {
        if !pipe_name.is_empty() && !pipe_name.contains('\\') && !pipe_name.contains('/') {
            return ValidatedWinHubEndpoint::LocalNamedPipe(trimmed.to_string());
        }
        return ValidatedWinHubEndpoint::ForbiddenRemoteOrUrl;
    }
    let bytes = trimmed.as_bytes();
    let is_drive_path = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    if !is_drive_path {
        if let Some(colon) = trimmed.find(':') {
            let scheme = &trimmed[..colon];
            if !scheme.is_empty()
                && scheme.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
                && scheme
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
            {
                return ValidatedWinHubEndpoint::ForbiddenRemoteOrUrl;
            }
        }
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return ValidatedWinHubEndpoint::ForbiddenRemoteOrUrl;
    }
    ValidatedWinHubEndpoint::UnsupportedLocalPath
}

#[cfg(windows)]
fn try_direct_pipe(args: &[String]) -> Option<i32> {
    use fusa_win_helper::pipe_http::{
        is_help_invocation, send_hub_cli_over_stream, valid_token_chars, HubCliPipeRequest,
        HubCliPipeResponse, HUB_MAX_STDIN_BYTES,
    };
    use fusa_win_helper::win::pipe::connect_named_pipe;
    use std::io::{self, Read, Write};
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    use std::time::Duration;

    const HUB_CLI_TIMEOUT: Duration = Duration::from_secs(30);

    if is_help_invocation(args) {
        return None;
    }
    let sock = env::var("HUB_SOCK").ok()?;
    if sock.trim().is_empty() {
        return None;
    }
    let endpoint = match classify_win_hub_endpoint(&sock) {
        ValidatedWinHubEndpoint::ForbiddenRemoteOrUrl => {
            let msg = "hub：HUB_SOCK 不是合法的本机守护进程地址（仅允许 \\\\.\\pipe\\<名称> 或 tcp://127.0.0.1:<端口>）\n";
            let _ = io::stderr().write_all(msg.as_bytes());
            let _ = io::stderr().flush();
            return Some(2);
        }
        ValidatedWinHubEndpoint::UnsupportedLocalPath => return None,
        valid => valid,
    };
    let token = env::var("HUB_TOKEN").ok()?;
    if !valid_token_chars(&token) {
        return None;
    }

    let wants_stdin = args.iter().any(|a| a == "--stdin");
    let mut stdin_utf8: Option<String> = None;
    let mut stdin_invalid_utf8 = false;
    if wants_stdin {
        let mut buf = Vec::new();
        // Read up to HUB_MAX_STDIN_BYTES + 1 byte so the daemon enforces the exact HUB_MAX_BODY_BYTES limit.
        let mut handle = io::stdin().take((HUB_MAX_STDIN_BYTES + 1) as u64);
        if handle.read_to_end(&mut buf).is_err() {
            return None;
        }
        match String::from_utf8(buf) {
            Ok(s) => stdin_utf8 = Some(s),
            Err(_) => stdin_invalid_utf8 = true,
        }
    }

    let cwd = env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let msystem = env::var("MSYSTEM").ok();
    let exepath = env::var("EXEPATH").ok();

    let req = HubCliPipeRequest {
        argv: args,
        cwd: &cwd,
        msystem: msystem.as_deref(),
        exepath: exepath.as_deref(),
        stdin_utf8: stdin_utf8.as_deref(),
        stdin_invalid_utf8,
    };

    let io_res = match endpoint {
        ValidatedWinHubEndpoint::LoopbackTcp(port) => {
            let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
            let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).ok()?;
            let _ = stream.set_read_timeout(Some(HUB_CLI_TIMEOUT));
            let _ = stream.set_write_timeout(Some(HUB_CLI_TIMEOUT));
            send_hub_cli_over_stream(stream, &token, &req)
        }
        ValidatedWinHubEndpoint::LocalNamedPipe(ref pipe_path) => {
            let pipe = connect_named_pipe(pipe_path, Duration::from_secs(5), HUB_CLI_TIMEOUT).ok()?;
            send_hub_cli_over_stream(pipe, &token, &req)
        }
        ValidatedWinHubEndpoint::UnsupportedLocalPath
        | ValidatedWinHubEndpoint::ForbiddenRemoteOrUrl => unreachable!(),
    };

    let (status, body) = match io_res {
        Ok(pair) => pair,
        Err(err) if err.kind() == io::ErrorKind::TimedOut => {
            let msg = "请求已经发给 agent-hub，但没等到回应（超时）。请求可能已经执行，请先用 `hub status` 确认，别直接重试\n";
            let _ = io::stderr().write_all(msg.as_bytes());
            let _ = io::stderr().flush();
            return Some(1);
        }
        Err(_) => return None,
    };
    if status == 404 {
        return None;
    }
    if let Ok(parsed) = serde_json::from_slice::<HubCliPipeResponse>(&body) {
        if !parsed.stdout.is_empty() {
            let _ = io::stdout().write_all(parsed.stdout.as_bytes());
            let _ = io::stdout().flush();
        }
        if !parsed.stderr.is_empty() {
            let _ = io::stderr().write_all(parsed.stderr.as_bytes());
            let _ = io::stderr().flush();
        }
        return Some(parsed.exit_code);
    }
    #[derive(Deserialize)]
    struct HubErrBody {
        ok: Option<bool>,
        message: Option<String>,
    }
    if let Ok(err_body) = serde_json::from_slice::<HubErrBody>(&body) {
        if err_body.ok == Some(false) {
            if let Some(msg) = err_body.message {
                let line = if msg.ends_with('\n') { msg } else { format!("{msg}\n") };
                let _ = io::stderr().write_all(line.as_bytes());
                let _ = io::stderr().flush();
                return Some(1);
            }
        }
    }
    None
}

fn main() {
    let cfg = read_adjacent_config();
    let raw_os_args: Vec<_> = env::args_os().skip(1).collect();
    let utf8_args: Option<Vec<String>> = raw_os_args
        .iter()
        .map(|os| os.to_str().map(str::to_string))
        .collect();

    #[cfg(windows)]
    {
        let allow_direct = cfg.as_ref().map(|c| c.direct_pipe).unwrap_or(true);
        if allow_direct {
            if let Some(ref args) = utf8_args {
                if let Some(code) = try_direct_pipe(args) {
                    std::process::exit(code);
                }
            }
        }
    }
    let _ = utf8_args;

    let Some(cfg) = cfg else {
        eprintln!("hub：未找到同目录下的 hub.json 配置文件，且无法直连 HUB_SOCK 管道");
        std::process::exit(3);
    };

    let status = Command::new(&cfg.node)
        .arg(&cfg.main)
        .args(&raw_os_args)
        .status();
    match status {
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(err) => {
            eprintln!("hub：启动 {} 失败：{err}", cfg.node);
            std::process::exit(4);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_win_hub_endpoint, parse_loopback_tcp_endpoint, ValidatedWinHubEndpoint};

    #[test]
    fn parses_loopback_tcp_endpoint_strictly() {
        assert_eq!(parse_loopback_tcp_endpoint("tcp://127.0.0.1:4317"), Some(4317));
        assert_eq!(parse_loopback_tcp_endpoint("tcp://127.0.0.1:0"), None);
        assert_eq!(parse_loopback_tcp_endpoint("tcp://127.0.0.1:04317"), None);
        assert_eq!(parse_loopback_tcp_endpoint("tcp://0.0.0.0:4317"), None);
        assert_eq!(parse_loopback_tcp_endpoint("tcp://localhost:4317"), None);
        assert_eq!(parse_loopback_tcp_endpoint("tcp://evil.example.com:4317"), None);
        assert_eq!(parse_loopback_tcp_endpoint(r"\\.\pipe\fusa-abc-hub"), None);

        assert_eq!(
            classify_win_hub_endpoint("tcp://127.0.0.1:4317"),
            ValidatedWinHubEndpoint::LoopbackTcp(4317)
        );
        assert_eq!(
            classify_win_hub_endpoint(r"\\.\pipe\fusa-abc-hub"),
            ValidatedWinHubEndpoint::LocalNamedPipe(r"\\.\pipe\fusa-abc-hub".to_string())
        );
        for forbidden in [
            "tcp://0.0.0.0:4317",
            "tcp://localhost:4317",
            "tcp://192.168.1.10:4317",
            "http://127.0.0.1:4317",
            r"\\evil-smb\pipe\fusa-hub",
            "//evil-smb/pipe/fusa-hub",
            r"\\?\UNC\evil\share\hub.sock",
            r"\\.\pipe\nested\bad",
        ] {
            assert_eq!(
                classify_win_hub_endpoint(forbidden),
                ValidatedWinHubEndpoint::ForbiddenRemoteOrUrl,
                "expected forbidden for {forbidden}"
            );
        }
    }
}
