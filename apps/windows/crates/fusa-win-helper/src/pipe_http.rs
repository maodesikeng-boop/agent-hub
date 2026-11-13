use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read, Write};

#[derive(Debug, Clone, Serialize)]
pub struct HubCliPipeRequest<'a> {
    pub argv: &'a [String],
    pub cwd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msystem: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exepath: Option<&'a str>,
    #[serde(rename = "stdinUtf8", skip_serializing_if = "Option::is_none")]
    pub stdin_utf8: Option<&'a str>,
    #[serde(rename = "stdinInvalidUtf8", skip_serializing_if = "std::ops::Not::not")]
    pub stdin_invalid_utf8: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubCliPipeResponse {
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn format_http_post(path: &str, token: &str, body: &[u8]) -> Vec<u8> {
    let header = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut buf = Vec::with_capacity(header.len() + body.len());
    buf.extend_from_slice(header.as_bytes());
    buf.extend_from_slice(body);
    buf
}

pub fn read_http_response(stream: impl Read) -> io::Result<(u16, Vec<u8>)> {
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line)? == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "empty HTTP response",
        ));
    }
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP status line"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            let lower = name.trim().to_ascii_lowercase();
            let v = val.trim();
            if lower == "content-length" {
                content_length = v.parse::<usize>().ok();
            } else if lower == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }

    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size_line = String::new();
            if reader.read_line(&mut size_line)? == 0 {
                break;
            }
            let hex = size_line
                .trim()
                .split(';')
                .next()
                .unwrap_or("")
                .trim();
            let n = usize::from_str_radix(hex, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk size"))?;
            if n == 0 {
                break;
            }
            let start = body.len();
            body.resize(start + n, 0);
            reader.read_exact(&mut body[start..])?;
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf)?;
        }
    } else if let Some(len) = content_length {
        body.resize(len, 0);
        reader.read_exact(&mut body)?;
    } else {
        reader.read_to_end(&mut body)?;
    }
    Ok((status, body))
}

pub fn send_hub_cli_over_stream<S: Read + Write>(
    mut stream: S,
    token: &str,
    req: &HubCliPipeRequest<'_>,
) -> io::Result<(u16, Vec<u8>)> {
    let json = serde_json::to_vec(req)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let wire = format_http_post("/hub/cli", token, &json);
    stream.write_all(&wire)?;
    stream.flush()?;
    read_http_response(stream)
}

pub fn is_help_invocation(args: &[String]) -> bool {
    matches!(
        args.first().map(String::as_str),
        None | Some("help") | Some("--help") | Some("-h")
    )
}

pub fn valid_token_chars(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_fixed_and_chunked_http_responses() {
        assert!(is_help_invocation(&[]));
        assert!(is_help_invocation(&["help".to_string()]));
        assert!(!is_help_invocation(&["status".to_string()]));
        assert!(valid_token_chars("abc_DEF-123"));
        assert!(!valid_token_chars(""));
        assert!(!valid_token_chars("bad token"));

        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{\"exitCode\":0,\"stdout\":\"ok\\n\",\"stderr\":\"\"}";
        // Count exact length of body: 41 bytes
        let body_bytes = br#"{"exitCode":0,"stdout":"ok\n","stderr":""}"#;
        let msg = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body_bytes.len()
        );
        let mut wire = msg.into_bytes();
        wire.extend_from_slice(body_bytes);
        let _ = raw;
        let (status, out) = read_http_response(Cursor::new(wire)).expect("fixed");
        assert_eq!(status, 200);
        let parsed: HubCliPipeResponse = serde_json::from_slice(&out).expect("json");
        assert_eq!(
            parsed,
            HubCliPipeResponse {
                exit_code: 0,
                stdout: "ok\n".to_string(),
                stderr: String::new(),
            }
        );

        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let (st2, out2) = read_http_response(Cursor::new(&chunked[..])).expect("chunked");
        assert_eq!(st2, 200);
        assert_eq!(out2, b"hello world");
    }
}
