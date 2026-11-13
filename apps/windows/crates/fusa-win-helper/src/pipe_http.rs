use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read, Write};

pub const HUB_MAX_STDIN_BYTES: usize = 256 * 1024;
pub const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_HTTP_HEADER_LINES: usize = 128;
pub const MAX_HTTP_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;

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

pub fn valid_request_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 1024
        && path.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub fn format_http_post(path: &str, token: &str, body: &[u8]) -> io::Result<Vec<u8>> {
    if !valid_request_path(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid HTTP request path",
        ));
    }
    if !valid_token_chars(token) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid HUB_TOKEN characters",
        ));
    }
    let header = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut buf = Vec::with_capacity(header.len() + body.len());
    buf.extend_from_slice(header.as_bytes());
    buf.extend_from_slice(body);
    Ok(buf)
}

fn read_bounded_line(reader: &mut impl BufRead, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(out);
        }
        if let Some(nl_idx) = available.iter().position(|&b| b == b'\n') {
            let take_len = nl_idx + 1;
            if out.len().saturating_add(take_len) > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HTTP header line exceeds maximum length",
                ));
            }
            out.extend_from_slice(&available[..take_len]);
            reader.consume(take_len);
            return Ok(out);
        }
        let take_len = available.len();
        if out.len().saturating_add(take_len) > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP header line exceeds maximum length",
            ));
        }
        out.extend_from_slice(available);
        reader.consume(take_len);
    }
}

pub fn read_http_response(stream: impl Read) -> io::Result<(u16, Vec<u8>)> {
    let mut reader = BufReader::new(stream);
    let mut total_header_bytes = 0usize;
    let status_raw = read_bounded_line(&mut reader, MAX_HTTP_HEADER_BYTES)?;
    if status_raw.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "empty HTTP response",
        ));
    }
    total_header_bytes += status_raw.len();
    let status_line = std::str::from_utf8(&status_raw)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF8 HTTP status line"))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP status line"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    let mut header_lines = 0usize;
    loop {
        let remaining_header = MAX_HTTP_HEADER_BYTES.saturating_sub(total_header_bytes);
        if remaining_header == 0 || header_lines >= MAX_HTTP_HEADER_LINES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP response headers exceed limit",
            ));
        }
        let raw_line = read_bounded_line(&mut reader, remaining_header)?;
        if raw_line.is_empty() {
            break;
        }
        total_header_bytes += raw_line.len();
        header_lines += 1;
        let line = std::str::from_utf8(&raw_line)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF8 HTTP header"))?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            let lower = name.trim().to_ascii_lowercase();
            let v = val.trim();
            if lower == "content-length" {
                let parsed_len = v.parse::<usize>().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid Content-Length")
                })?;
                if parsed_len > MAX_HTTP_RESPONSE_BODY_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "HTTP response Content-Length exceeds limit",
                    ));
                }
                content_length = Some(parsed_len);
            } else if lower == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }

    let mut body = Vec::new();
    if chunked {
        loop {
            let size_raw = read_bounded_line(&mut reader, 1024)?;
            if size_raw.is_empty() {
                break;
            }
            let size_line = std::str::from_utf8(&size_raw)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk header"))?;
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
            let new_len = body.len().checked_add(n).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "chunked body size overflow")
            })?;
            if new_len > MAX_HTTP_RESPONSE_BODY_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HTTP chunked response body exceeds limit",
                ));
            }
            let start = body.len();
            body.resize(new_len, 0);
            reader.read_exact(&mut body[start..])?;
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf)?;
        }
    } else if let Some(len) = content_length {
        body.resize(len, 0);
        reader.read_exact(&mut body)?;
    } else {
        reader
            .take((MAX_HTTP_RESPONSE_BODY_BYTES + 1) as u64)
            .read_to_end(&mut body)?;
        if body.len() > MAX_HTTP_RESPONSE_BODY_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP response body exceeds limit",
            ));
        }
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
    let wire = format_http_post("/hub/cli", token, &json)?;
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

    #[test]
    fn rejects_header_injection_and_oversized_responses() {
        assert!(format_http_post("/hub/cli", "good-token_1", b"{}").is_ok());
        assert!(format_http_post("/hub/cli", "bad\r\nX-Injected: 1", b"{}").is_err());
        assert!(format_http_post("/hub/cli\r\n", "good-token", b"{}").is_err());
        assert!(format_http_post("hub/cli", "good-token", b"{}").is_err());

        let huge_cl = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_HTTP_RESPONSE_BODY_BYTES + 1
        );
        assert!(read_http_response(Cursor::new(huge_cl.into_bytes())).is_err());

        let huge_chunk = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            MAX_HTTP_RESPONSE_BODY_BYTES + 1
        );
        assert!(read_http_response(Cursor::new(huge_chunk.into_bytes())).is_err());
    }
}
