use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fusa_supervisor::compute_file_sha256_hex;
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

const MAX_DIALOG_HEADER_BYTES: usize = 8 * 1024;
const MAX_DIALOG_BODY_BYTES: usize = 8 * 1024;
const MAX_DIALOG_WIRE_BYTES: usize = MAX_DIALOG_HEADER_BYTES + MAX_DIALOG_BODY_BYTES;

/// 守护进程 `POST /api/pick-folder` 与桌面外壳 `tauri-plugin-dialog` 之间的本机回环窄桥接句柄。
pub struct DesktopDialogBridge {
    pub url: String,
    pub token: String,
    stop_flag: Arc<AtomicBool>,
    port: u16,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PickFolderReq {
    start_dir: Option<String>,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn extract_bearer_token(header_text: &str) -> Option<&str> {
    for line in header_text.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("authorization") {
            continue;
        }
        let trimmed = value.trim();
        if trimmed.len() > 7 && trimmed[..7].eq_ignore_ascii_case("bearer ") {
            return Some(trimmed[7..].trim());
        }
    }
    None
}

fn generate_bridge_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let exe_hash = std::env::current_exe()
        .ok()
        .and_then(|p| compute_file_sha256_hex(&p).ok())
        .unwrap_or_else(|| "fusa".to_string());
    let stack_anchor = &nanos as *const u128 as usize;
    use fusa_supervisor::data_dir_pipe_hash;
    let part1 = data_dir_pipe_hash(&format!("{nanos}-{pid}-{stack_anchor}"));
    let part2 = data_dir_pipe_hash(&format!("{exe_hash}-{stack_anchor}-{nanos}"));
    format!("dlg_{part1}{part2}")
}

fn write_json_response(stream: &mut impl Write, status: u16, status_text: &str, body: &str) {
    let wire = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(wire.as_bytes());
    let _ = stream.flush();
}

impl DesktopDialogBridge {
    pub fn start<R: tauri::Runtime>(
        app_handle: AppHandle<R>,
        on_focus_window: impl Fn(&AppHandle<R>) + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        let focus_fn = Arc::new(on_focus_window);
        Self::start_with_handler(move |start_dir| {
            focus_fn(&app_handle);
            let mut builder = app_handle.dialog().file().set_title("选择主文件夹");
            if let Some(dir_str) = start_dir {
                let p = PathBuf::from(dir_str.trim());
                if p.is_dir() {
                    builder = builder.set_directory(p);
                }
            }
            builder.blocking_pick_folder().and_then(|fp| match fp {
                FilePath::Path(p) => Some(p.to_string_lossy().into_owned()),
                FilePath::Url(_) => None,
            })
        })
    }

    pub fn start_with_handler(
        pick_handler: impl Fn(Option<String>) -> Option<String> + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = generate_bridge_token();
        let expected_token_bytes = token.as_bytes().to_vec();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let busy_flag = Arc::new(AtomicBool::new(false));

        let stop_worker = Arc::clone(&stop_flag);
        let handler = Arc::new(pick_handler);
        thread::spawn(move || {
            while !stop_worker.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                if stop_worker.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

                let mut buf = Vec::with_capacity(1024);
                let mut chunk = [0u8; 1024];
                let mut header_end = None;
                let mut content_len = 0usize;
                let mut payload_too_large = false;
                let mut invalid_content_length = false;
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if buf.len() + n > MAX_DIALOG_WIRE_BYTES {
                                payload_too_large = true;
                                let remain = MAX_DIALOG_WIRE_BYTES.saturating_sub(buf.len());
                                buf.extend_from_slice(&chunk[..remain]);
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                            if header_end.is_none() {
                                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                    let end = pos + 4;
                                    if end > MAX_DIALOG_HEADER_BYTES {
                                        payload_too_large = true;
                                        break;
                                    }
                                    header_end = Some(end);
                                    let hdr = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                                    if let Some(raw_cl) = hdr.lines().find_map(|l| l.strip_prefix("content-length:")) {
                                        match raw_cl.trim().parse::<usize>() {
                                            Ok(len) if len <= MAX_DIALOG_BODY_BYTES => {
                                                content_len = len;
                                            }
                                            Ok(_) => {
                                                payload_too_large = true;
                                                break;
                                            }
                                            Err(_) => {
                                                invalid_content_length = true;
                                                break;
                                            }
                                        }
                                    }
                                } else if buf.len() >= MAX_DIALOG_HEADER_BYTES {
                                    payload_too_large = true;
                                    break;
                                }
                            }
                            if let Some(end) = header_end {
                                if buf.len() >= end + content_len {
                                    break;
                                }
                            }
                        }
                    }
                }

                let Some(end) = header_end else {
                    if payload_too_large {
                        write_json_response(
                            &mut stream,
                            413,
                            "Payload Too Large",
                            r#"{"error":"payload_too_large"}"#,
                        );
                    }
                    continue;
                };
                let header_text = String::from_utf8_lossy(&buf[..end]);
                let first_line = header_text.lines().next().unwrap_or("");
                if !first_line.starts_with("POST /pick-folder ") {
                    write_json_response(&mut stream, 404, "Not Found", r#"{"error":"not_found"}"#);
                    continue;
                }

                let authorized = extract_bearer_token(&header_text)
                    .is_some_and(|tok| constant_time_eq(tok.as_bytes(), &expected_token_bytes));
                if !authorized {
                    write_json_response(
                        &mut stream,
                        401,
                        "Unauthorized",
                        r#"{"error":"unauthorized"}"#,
                    );
                    continue;
                }

                if payload_too_large {
                    write_json_response(
                        &mut stream,
                        413,
                        "Payload Too Large",
                        r#"{"error":"payload_too_large"}"#,
                    );
                    continue;
                }
                if invalid_content_length || buf.len() < end + content_len {
                    write_json_response(
                        &mut stream,
                        400,
                        "Bad Request",
                        r#"{"error":"bad_request"}"#,
                    );
                    continue;
                }

                if busy_flag
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    write_json_response(&mut stream, 409, "Conflict", r#"{"error":"busy"}"#);
                    continue;
                }

                let body_slice = &buf[end..end + content_len];
                let req_payload: PickFolderReq = if body_slice.is_empty() {
                    PickFolderReq::default()
                } else {
                    match serde_json::from_slice(body_slice) {
                        Ok(p) => p,
                        Err(_) => {
                            busy_flag.store(false, Ordering::SeqCst);
                            write_json_response(
                                &mut stream,
                                400,
                                "Bad Request",
                                r#"{"error":"invalid_json"}"#,
                            );
                            continue;
                        }
                    }
                };

                let busy_for_pick = Arc::clone(&busy_flag);
                let handler_for_pick = Arc::clone(&handler);
                thread::spawn(move || {
                    struct BusyGuard(Arc<AtomicBool>);
                    impl Drop for BusyGuard {
                        fn drop(&mut self) {
                            self.0.store(false, Ordering::SeqCst);
                        }
                    }
                    let _guard = BusyGuard(busy_for_pick);

                    let picked = handler_for_pick(req_payload.start_dir);
                    let body = serde_json::json!({ "path": picked }).to_string();
                    write_json_response(&mut stream, 200, "OK", &body);
                });
            }
        });

        Ok(Self {
            url: format!("http://127.0.0.1:{port}/pick-folder"),
            token,
            stop_flag,
            port,
        })
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
    }
}
