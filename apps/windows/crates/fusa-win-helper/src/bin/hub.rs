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
fn parse_loopback_tcp_endpoint(raw: &str) -> Option<u16> {
    let port_str = raw.trim().strip_prefix("tcp://127.0.0.1:")?;
    let port = port_str.parse::<u16>().ok()?;
    (port > 0).then_some(port)
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
    let tcp_port = parse_loopback_tcp_endpoint(&sock);
    if tcp_port.is_none() && !sock.starts_with(r"\\.\pipe\") {
        return None;
    }
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

    let io_res = if let Some(port) = tcp_port {
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).ok()?;
        let _ = stream.set_read_timeout(Some(HUB_CLI_TIMEOUT));
        let _ = stream.set_write_timeout(Some(HUB_CLI_TIMEOUT));
        send_hub_cli_over_stream(stream, &token, &req)
    } else {
        let pipe = connect_named_pipe(&sock, Duration::from_secs(5), HUB_CLI_TIMEOUT).ok()?;
        send_hub_cli_over_stream(pipe, &token, &req)
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
    use super::parse_loopback_tcp_endpoint;

    #[test]
    fn parses_loopback_tcp_endpoint_strictly() {
        assert_eq!(parse_loopback_tcp_endpoint("tcp://127.0.0.1:4317"), Some(4317));
        assert_eq!(parse_loopback_tcp_endpoint("tcp://127.0.0.1:0"), None);
        assert_eq!(parse_loopback_tcp_endpoint("tcp://0.0.0.0:4317"), None);
        assert_eq!(parse_loopback_tcp_endpoint(r"\\.\pipe\fusa-abc-hub"), None);
    }
}
