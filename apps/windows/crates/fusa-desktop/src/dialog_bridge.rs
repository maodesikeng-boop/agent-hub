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
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = generate_bridge_token();
        let expected_auth = format!("bearer {}", token.to_ascii_lowercase());
        let stop_flag = Arc::new(AtomicBool::new(false));
        let busy_flag = Arc::new(AtomicBool::new(false));

        let stop_worker = Arc::clone(&stop_flag);
        let focus_fn = Arc::new(on_focus_window);
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
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if buf.len() + n > 16 * 1024 {
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                            if header_end.is_none() {
                                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                    let end = pos + 4;
                                    header_end = Some(end);
                                    let hdr = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                                    content_len = hdr
                                        .lines()
                                        .find_map(|l| l.strip_prefix("content-length:"))
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                        .unwrap_or(0);
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
                    continue;
                };
                let header_text = String::from_utf8_lossy(&buf[..end]);
                let first_line = header_text.lines().next().unwrap_or("");
                if !first_line.starts_with("POST /pick-folder ") {
                    write_json_response(&mut stream, 404, "Not Found", r#"{"error":"not_found"}"#);
                    continue;
                }

                let authorized = header_text.lines().any(|line| {
                    line.split_once(':')
                        .is_some_and(|(k, v)| {
                            k.trim().eq_ignore_ascii_case("authorization")
                                && v.trim().to_ascii_lowercase() == expected_auth
                        })
                });
                if !authorized {
                    write_json_response(
                        &mut stream,
                        401,
                        "Unauthorized",
                        r#"{"error":"unauthorized"}"#,
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

                let body_slice = &buf[end..buf.len().min(end + content_len)];
                let req_payload: PickFolderReq =
                    serde_json::from_slice(body_slice).unwrap_or_default();

                let app_for_pick = app_handle.clone();
                let busy_for_pick = Arc::clone(&busy_flag);
                let focus_for_pick = Arc::clone(&focus_fn);
                thread::spawn(move || {
                    struct BusyGuard(Arc<AtomicBool>);
                    impl Drop for BusyGuard {
                        fn drop(&mut self) {
                            self.0.store(false, Ordering::SeqCst);
                        }
                    }
                    let _guard = BusyGuard(busy_for_pick);

                    focus_for_pick(&app_for_pick);
                    let mut builder = app_for_pick.dialog().file().set_title("选择主文件夹");
                    if let Some(dir_str) = req_payload.start_dir {
                        let p = PathBuf::from(dir_str.trim());
                        if p.is_dir() {
                            builder = builder.set_directory(p);
                        }
                    }
                    let picked = builder.blocking_pick_folder().and_then(|fp| match fp {
                        FilePath::Path(p) => Some(p.to_string_lossy().into_owned()),
                        FilePath::Url(_) => None,
                    });
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
