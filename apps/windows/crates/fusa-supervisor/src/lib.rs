pub mod contract;
pub mod env_path;
pub mod error;
pub mod log;
pub mod manifest;
pub mod probe;
pub mod supervisor;

pub use contract::{DesktopContract, EMBEDDED_DESKTOP_CONTRACT_JSON};
pub use env_path::{
    build_refreshed_path_env, expand_windows_env_vars, merge_path_entries,
    refresh_current_process_path,
};
pub use error::SupervisorError;
pub use log::{truncate_chars_clean, RotatingLogWriter, StderrTailCollector};
pub use manifest::{
    admin_named_pipe_path, compute_file_sha256_hex, data_dir_pipe_hash, is_valid_sha256_hex,
    RuntimeManifest,
};
pub use probe::{
    parse_set_cookie_header, parse_status_http_response, DaemonHealthReport, DaemonIdentity,
    HostHttpClient, ProbeFailureKind, ProbeOutcome, SecretUiToken, SessionCookie,
    UreqHostHttpClient,
};
pub use supervisor::{
    resolve_configured_port, Clock, CrashRecord, DaemonOwnership, DaemonRuntime, DaemonSupervisor,
    NativeDaemonRuntime, NativeRuntimeConfig, OwnedProcessHandle, OwnedProcessStatus, OwnedSignal,
    StartupPhase, StopReason, SupervisorFault, SupervisorSnapshot, SupervisorState, SystemClock,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    struct VirtualClock {
        now_ms: AtomicU64,
        on_sleep: Option<Box<dyn Fn(u64, u64) + Send + Sync>>,
    }

    impl VirtualClock {
        fn new(initial_ms: u64) -> Arc<Self> {
            Arc::new(Self {
                now_ms: AtomicU64::new(initial_ms),
                on_sleep: None,
            })
        }

        fn with_hook(
            initial_ms: u64,
            hook: impl Fn(u64, u64) + Send + Sync + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                now_ms: AtomicU64::new(initial_ms),
                on_sleep: Some(Box::new(hook)),
            })
        }

        fn now(&self) -> u64 {
            self.now_ms.load(Ordering::SeqCst)
        }
    }

    impl Clock for Arc<VirtualClock> {
        fn now_epoch_ms(&self) -> u64 {
            self.now_ms.load(Ordering::SeqCst)
        }

        fn sleep(&self, duration: Duration) {
            let delta = duration.as_millis() as u64;
            let prev = self.now_ms.fetch_add(delta, Ordering::SeqCst);
            let next = prev + delta;
            if let Some(cb) = &self.on_sleep {
                cb(prev, next);
            }
        }
    }

    struct NoopProcessHandle {
        cleaned: Arc<AtomicUsize>,
    }

    impl OwnedProcessHandle for NoopProcessHandle {
        fn try_reap(&mut self) -> Option<i32> {
            None
        }
        fn cleanup_owned_resources(&mut self) {
            self.cleaned.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct MockHttpClient {
        status_fn: Arc<dyn Fn(u16, &DesktopContract) -> ProbeOutcome + Send + Sync>,
        cookie_exchanges: Arc<AtomicUsize>,
    }

    impl MockHttpClient {
        fn with_status(
            f: impl Fn(u16, &DesktopContract) -> ProbeOutcome + Send + Sync + 'static,
        ) -> Self {
            Self {
                status_fn: Arc::new(f),
                cookie_exchanges: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn exchange_count(&self) -> usize {
            self.cookie_exchanges.load(Ordering::SeqCst)
        }
    }

    impl HostHttpClient for MockHttpClient {
        fn probe_status(&self, port: u16, contract: &DesktopContract) -> ProbeOutcome {
            (self.status_fn)(port, contract)
        }

        fn exchange_session_cookie(
            &self,
            port: u16,
            _token: &SecretUiToken,
            _timeout: Duration,
        ) -> Result<SessionCookie, SupervisorError> {
            self.cookie_exchanges.fetch_add(1, Ordering::SeqCst);
            Ok(SessionCookie::new(
                format!("agent_hub_ui_{port}"),
                "session-secret-cookie",
                "/",
                true,
                true,
                Some(31_536_000),
            ))
        }
    }

    fn ok_identity(instance_id: &str) -> DaemonIdentity {
        DaemonIdentity {
            product: "fusa".to_string(),
            protocol_version: 1,
            instance_id: instance_id.to_string(),
            status: Some("unauthenticated".to_string()),
        }
    }

    #[test]
    fn contract_json_single_source_of_truth_and_pipe_hash_alignment() {
        let embedded = DesktopContract::embedded().unwrap();
        let repo_contract_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../desktop/contract.json");
        let loaded = DesktopContract::load_from_path(&repo_contract_path).unwrap();
        assert_eq!(embedded, loaded);
        assert_eq!(
            include_str!("../../fusa-desktop/resources/contract.json"),
            EMBEDDED_DESKTOP_CONTRACT_JSON
        );

        assert_eq!(embedded.product, "fusa");
        assert_eq!(embedded.protocol_version, 1);
        assert_eq!(embedded.default_port, 4317);
        assert_eq!(embedded.status_path, "/api/auth/status");
        assert_eq!(embedded.health_path, "/api/health");
        assert_eq!(embedded.shutdown_transport, "admin-endpoint");
        assert_eq!(embedded.shutdown_path, "/admin/shutdown");
        assert_eq!(embedded.daemon_entry_relative_path, "src/daemon/main.ts");
        assert_eq!(embedded.startup_budget_ms, 15_000);
        assert_eq!(embedded.stop_grace_ms, 40_000);
        assert_eq!(embedded.reload_exit_code, 75);
        assert_eq!(embedded.supervised_env, "AGENT_HUB_SUPERVISED");
        assert_eq!(embedded.log_max_bytes, 2_097_152);
        assert_eq!(embedded.log_rotated_files, 1);

        let h1 = data_dir_pipe_hash(r"C:\Users\Alice\.agent-hub\");
        let h2 = data_dir_pipe_hash("c:/users/alice/.agent-hub");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 12);
        assert_eq!(
            admin_named_pipe_path(Path::new(r"C:\Users\Alice\.agent-hub")),
            format!(r"\\.\pipe\fusa-{h1}-admin")
        );
    }

    #[test]
    fn env_path_expands_registry_placeholders_and_deduplicates_case_insensitively() {
        let expanded = expand_windows_env_vars(
            r"%SystemRoot%\System32;%USERPROFILE%\.local\bin;%UNKNOWN_VAR%\bin;%%literal%%",
            |key| match key.to_ascii_lowercase().as_str() {
                "systemroot" => Some(r"C:\Windows".to_string()),
                "userprofile" => Some(r"C:\Users\alice".to_string()),
                _ => None,
            },
        );
        assert_eq!(
            expanded,
            r"C:\Windows\System32;C:\Users\alice\.local\bin;%UNKNOWN_VAR%\bin;%%literal%%"
        );

        let merged = merge_path_entries(
            &[PathBuf::from(r"C:\Fusa\bin"), PathBuf::from(r"C:\Fusa\node")],
            &[
                r"C:\Windows\System32;C:\Program Files\Git\cmd".to_string(),
                r"c:\windows\system32\;C:\Users\alice\.local\bin".to_string(),
            ],
            Some(r"C:\Program Files\Git\cmd;D:\Tools"),
            true,
        );
        assert_eq!(
            merged,
            r"C:\Fusa\bin;C:\Fusa\node;C:\Windows\System32;C:\Program Files\Git\cmd;C:\Users\alice\.local\bin;D:\Tools"
        );
    }

    #[test]
    fn runtime_manifest_verifies_sha256_and_detects_tampering() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        let node_dir = tmp.path().join("node");
        let daemon_src = tmp.path().join("daemon/src/daemon");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&node_dir).unwrap();
        fs::create_dir_all(&daemon_src).unwrap();

        let node_exe = node_dir.join("node.exe");
        let fusa_run = bin_dir.join("fusa-run.exe");
        let hub_exe = bin_dir.join("hub.exe");
        let main_ts = daemon_src.join("main.ts");

        fs::write(&node_exe, b"fake-node-binary").unwrap();
        fs::write(&fusa_run, b"fake-fusa-run").unwrap();
        fs::write(&hub_exe, b"fake-hub").unwrap();
        fs::write(&main_ts, b"console.log('ok');").unwrap();

        let manifest = RuntimeManifest {
            version: "0.1.0".to_string(),
            node_version: "v24.22.3".to_string(),
            node_sha256: compute_file_sha256_hex(&node_exe).unwrap(),
            fusa_run_sha256: compute_file_sha256_hex(&fusa_run).unwrap(),
            hub_sha256: compute_file_sha256_hex(&hub_exe).unwrap(),
        };
        let manifest_path = tmp.path().join("runtime-manifest.json");
        fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();

        let rt = NativeDaemonRuntime::new(NativeRuntimeConfig {
            app_data_dir: tmp.path().join("app-data"),
            hub_home_dir: tmp.path().join("hub-home"),
            node_exe_path: node_exe.clone(),
            daemon_root_dir: tmp.path().join("daemon"),
            win_helpers_dir: bin_dir,
            manifest_path: Some(manifest_path),
            extra_envs: Vec::new(),
        });
        assert!(rt.verify_runtime_integrity().is_ok());
        assert!(rt.verify_runtime_integrity().is_ok());

        fs::write(&node_exe, b"tampered-node-binary-content").unwrap();
        let err = rt.verify_runtime_integrity().unwrap_err();
        assert!(matches!(err, SupervisorError::RuntimeIntegrityFailed(_)));
    }

    #[test]
    fn log_rotates_strictly_at_2mb_and_never_creates_dot2() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("desktop-daemon.log");
        let log = Mutex::new(RotatingLogWriter::open(&path, 1024, 1).unwrap());
        let big = vec![b'a'; 3000];
        supervisor::drain_stdout(&big[..], &log).unwrap();
        assert!(fs::metadata(&path).unwrap().len() <= 1024);
        assert!(log.lock().unwrap().rotated_path(1).exists());
        assert!(!log.lock().unwrap().rotated_path(2).exists());
    }

    #[test]
    fn http_client_blocks_redirects_verifies_auth_and_health_endpoint() {
        let contract = DesktopContract::embedded().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        #[derive(Clone, Copy)]
        enum Mode {
            Redirect307,
            ValidAuthAndHealth,
        }
        let mode = Arc::new(Mutex::new(Mode::Redirect307));
        let stop_srv = Arc::new(AtomicBool::new(false));
        let mode_srv = Arc::clone(&mode);
        let stop_flag = Arc::clone(&stop_srv);

        let srv_handle = thread::spawn(move || {
            while !stop_flag.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else { break };
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut raw_req = vec![0u8; 2048];
                let n = stream.read(&mut raw_req).unwrap_or(0);
                let req_str = String::from_utf8_lossy(&raw_req[..n]);
                let first_line = req_str.lines().next().unwrap_or("");

                match *mode_srv.lock().unwrap() {
                    Mode::Redirect307 => {
                        let resp = format!(
                            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port}/evil\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    }
                    Mode::ValidAuthAndHealth => {
                        if first_line.starts_with("POST /auth ") {
                            let resp = format!(
                                "HTTP/1.1 204 No Content\r\nSet-Cookie: agent_hub_ui_{port}=sess_ok; HttpOnly; SameSite=Strict; Path=/\r\nConnection: close\r\n\r\n"
                            );
                            let _ = stream.write_all(resp.as_bytes());
                        } else if first_line.starts_with("GET /api/health ") {
                            if req_str.contains(&format!("agent_hub_ui_{port}=sess_ok")) {
                                let body = r#"{"ok":true,"product":"fusa","protocolVersion":1,"instanceId":"inst-health-1"}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                let _ = stream.write_all(resp.as_bytes());
                            } else {
                                let body = r#"{"error":{"code":"unauthorized"}}"#;
                                let resp = format!(
                                    "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                let _ = stream.write_all(resp.as_bytes());
                            }
                        } else {
                            let body = r#"{"status":"unauthenticated","product":"fusa","protocolVersion":1,"instanceId":"inst-health-1"}"#;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(resp.as_bytes());
                        }
                    }
                }
            }
        });

        let client = UreqHostHttpClient;
        assert_eq!(
            client.probe_status(port, &contract),
            ProbeOutcome::Failed(ProbeFailureKind::RedirectBlocked { status_code: 307 })
        );

        *mode.lock().unwrap() = Mode::ValidAuthAndHealth;
        assert_eq!(
            client.probe_status(port, &contract),
            ProbeOutcome::Verified(ok_identity("inst-health-1"))
        );

        let (unauth_code, unauth_rep) = client
            .request_health(port, None, &contract, Duration::from_millis(500))
            .unwrap();
        assert_eq!(unauth_code, 401);
        assert!(unauth_rep.is_none());

        let token = SecretUiToken::new("valid-secret-token-123").unwrap();
        let cookie = client
            .exchange_session_cookie(port, &token, Duration::from_millis(500))
            .unwrap();
        let (ok_code, ok_rep) = client
            .request_health(port, Some(&cookie), &contract, Duration::from_millis(500))
            .unwrap();
        assert_eq!(ok_code, 200);
        assert_eq!(
            ok_rep,
            Some(DaemonHealthReport {
                ok: true,
                product: "fusa".to_string(),
                protocol_version: 1,
                instance_id: "inst-health-1".to_string(),
            })
        );

        stop_srv.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(("127.0.0.1", port));
        let _ = srv_handle.join();
    }

    #[test]
    fn external_managed_reuse_reload_exit_75_circuit_breaker_and_40s_graceful_stop() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();
        let signals = Arc::new(Mutex::new(Vec::<OwnedSignal>::new()));
        let cleaned = Arc::new(AtomicUsize::new(0));
        let alive_until_ms = Arc::new(AtomicU64::new(0));
        let clock = VirtualClock::new(1_000);

        struct SimRuntime {
            local_match: bool,
            signals: Arc<Mutex<Vec<OwnedSignal>>>,
            cleaned: Arc<AtomicUsize>,
            alive_until_ms: Arc<AtomicU64>,
            clock: Arc<VirtualClock>,
        }

        impl DaemonRuntime for SimRuntime {
            fn verify_runtime_integrity(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn matches_local_hub_home(&self, _identity: &DaemonIdentity) -> bool {
                self.local_match
            }
            fn spawn_owned_daemon(
                &self,
                _run_id: &str,
                _port: u16,
                _contract: &DesktopContract,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn OwnedProcessHandle>, SupervisorError> {
                Ok(Box::new(NoopProcessHandle {
                    cleaned: Arc::clone(&self.cleaned),
                }))
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedProcessStatus, SupervisorError> {
                let alive = self.clock.now() < self.alive_until_ms.load(Ordering::SeqCst);
                Ok(OwnedProcessStatus {
                    found: true,
                    alive,
                    pid: Some(9001),
                })
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                signal: OwnedSignal,
                _contract: &DesktopContract,
            ) -> Result<bool, SupervisorError> {
                self.signals.lock().unwrap().push(signal);
                if signal == OwnedSignal::Kill {
                    self.alive_until_ms.store(0, Ordering::SeqCst);
                }
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("local-ui-token-123456")
            }
        }

        let ext_http = MockHttpClient::with_status(|_, _| ProbeOutcome::Verified(ok_identity("ext-other")));
        let ext_sup = DaemonSupervisor::new(
            contract.clone(),
            4317,
            tmp.path(),
            SimRuntime {
                local_match: false,
                signals: Arc::clone(&signals),
                cleaned: Arc::clone(&cleaned),
                alive_until_ms: Arc::clone(&alive_until_ms),
                clock: Arc::clone(&clock),
            },
            ext_http.clone(),
            Arc::clone(&clock),
        )
        .unwrap();
        let ext_snap = ext_sup.ensure_running().unwrap();
        assert_eq!(ext_snap.ownership, DaemonOwnership::ExternalManaged);
        assert!(!ext_snap.has_session_cookie);
        assert_eq!(ext_http.exchange_count(), 0);
        assert!(matches!(
            ext_sup.restart_manual().unwrap_err(),
            SupervisorError::ExternalManagedCannotRestart
        ));
        ext_sup.shutdown();
        assert!(signals.lock().unwrap().is_empty());

        let spawned = Arc::new(AtomicBool::new(false));
        let spawned_probe = Arc::clone(&spawned);
        let owned_http = MockHttpClient::with_status(move |_, _| {
            if spawned_probe.load(Ordering::SeqCst) {
                ProbeOutcome::Verified(ok_identity("owned-1"))
            } else {
                ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "starting".to_string(),
                })
            }
        });
        alive_until_ms.store(u64::MAX, Ordering::SeqCst);

        struct SpawnTrackingRuntime {
            inner: SimRuntime,
            spawned: Arc<AtomicBool>,
        }
        impl DaemonRuntime for SpawnTrackingRuntime {
            fn verify_runtime_integrity(&self) -> Result<(), SupervisorError> {
                self.inner.verify_runtime_integrity()
            }
            fn matches_local_hub_home(&self, id: &DaemonIdentity) -> bool {
                self.inner.matches_local_hub_home(id)
            }
            fn spawn_owned_daemon(
                &self,
                run_id: &str,
                port: u16,
                c: &DesktopContract,
                log: Arc<Mutex<RotatingLogWriter>>,
                tail: Arc<Mutex<StderrTailCollector>>,
                on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn OwnedProcessHandle>, SupervisorError> {
                self.spawned.store(true, Ordering::SeqCst);
                self.inner
                    .spawn_owned_daemon(run_id, port, c, log, tail, on_exit)
            }
            fn query_owned_status(&self, run_id: &str) -> Result<OwnedProcessStatus, SupervisorError> {
                self.inner.query_owned_status(run_id)
            }
            fn signal_owned_daemon(
                &self,
                run_id: &str,
                sig: OwnedSignal,
                c: &DesktopContract,
            ) -> Result<bool, SupervisorError> {
                if sig == OwnedSignal::Kill {
                    self.spawned.store(false, Ordering::SeqCst);
                }
                self.inner.signal_owned_daemon(run_id, sig, c)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                self.inner.read_ui_token()
            }
        }

        let owned_sup = DaemonSupervisor::new(
            contract.clone(),
            4317,
            tmp.path(),
            SpawnTrackingRuntime {
                inner: SimRuntime {
                    local_match: true,
                    signals: Arc::clone(&signals),
                    cleaned: Arc::clone(&cleaned),
                    alive_until_ms: Arc::clone(&alive_until_ms),
                    clock: Arc::clone(&clock),
                },
                spawned: Arc::clone(&spawned),
            },
            owned_http,
            Arc::clone(&clock),
        )
        .unwrap();

        let run_snap = owned_sup.ensure_running().unwrap();
        assert_eq!(run_snap.ownership, DaemonOwnership::Owned);
        assert!(run_snap.has_session_cookie);

        for _ in 0..contract.max_crashes_in_window {
            assert!(owned_sup.allow_immediate_reload());
        }
        assert!(!owned_sup.allow_immediate_reload());

        let before_stop = clock.now();
        let stopped_snap = owned_sup.shutdown();
        assert_eq!(stopped_snap.state, SupervisorState::Stopped);
        assert!(clock.now().saturating_sub(before_stop) >= contract.stop_grace_ms);
        assert_eq!(
            *signals.lock().unwrap(),
            vec![OwnedSignal::Term, OwnedSignal::Kill]
        );
        assert!(cleaned.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn slow_graceful_shutdown_within_40s_exits_cleanly_without_kill() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();
        let signals = Arc::new(Mutex::new(Vec::<OwnedSignal>::new()));
        let stop_at_ms = Arc::new(AtomicU64::new(u64::MAX));
        let stop_at_probe = Arc::clone(&stop_at_ms);
        let clock_ref = VirtualClock::with_hook(1_000, |_, _| {});
        let clock_probe = Arc::clone(&clock_ref);
        let spawned = Arc::new(AtomicBool::new(false));
        let spawned_probe = Arc::clone(&spawned);

        struct GracefulRuntime {
            signals: Arc<Mutex<Vec<OwnedSignal>>>,
            stop_at_ms: Arc<AtomicU64>,
            clock: Arc<VirtualClock>,
            spawned: Arc<AtomicBool>,
        }
        impl DaemonRuntime for GracefulRuntime {
            fn verify_runtime_integrity(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn matches_local_hub_home(&self, _: &DaemonIdentity) -> bool {
                true
            }
            fn spawn_owned_daemon(
                &self,
                _: &str,
                _: u16,
                _: &DesktopContract,
                _: Arc<Mutex<RotatingLogWriter>>,
                _: Arc<Mutex<StderrTailCollector>>,
                _: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn OwnedProcessHandle>, SupervisorError> {
                self.spawned.store(true, Ordering::SeqCst);
                Ok(Box::new(NoopProcessHandle {
                    cleaned: Arc::new(AtomicUsize::new(0)),
                }))
            }
            fn query_owned_status(&self, _: &str) -> Result<OwnedProcessStatus, SupervisorError> {
                let alive = self.clock.now() < self.stop_at_ms.load(Ordering::SeqCst);
                Ok(OwnedProcessStatus {
                    found: true,
                    alive,
                    pid: Some(4242),
                })
            }
            fn signal_owned_daemon(
                &self,
                _: &str,
                sig: OwnedSignal,
                _: &DesktopContract,
            ) -> Result<bool, SupervisorError> {
                self.signals.lock().unwrap().push(sig);
                if sig == OwnedSignal::Term {
                    self.stop_at_ms
                        .store(self.clock.now() + 5_000, Ordering::SeqCst);
                }
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("graceful-token-123456")
            }
        }

        let http = MockHttpClient::with_status(move |_, _| {
            if spawned_probe.load(Ordering::SeqCst)
                && clock_probe.now() < stop_at_probe.load(Ordering::SeqCst)
            {
                ProbeOutcome::Verified(ok_identity("graceful-1"))
            } else {
                ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "closed".to_string(),
                })
            }
        });

        let sup = DaemonSupervisor::new(
            contract,
            4317,
            tmp.path(),
            GracefulRuntime {
                signals: Arc::clone(&signals),
                stop_at_ms,
                clock: Arc::clone(&clock_ref),
                spawned,
            },
            http,
            Arc::clone(&clock_ref),
        )
        .unwrap();
        sup.ensure_running().unwrap();
        let snap = sup.shutdown();
        assert_eq!(snap.state, SupervisorState::Stopped);
        assert_eq!(*signals.lock().unwrap(), vec![OwnedSignal::Term]);
    }

    #[test]
    fn native_daemon_runtime_spawns_real_node_handles_exit_75_reload_and_admin_shutdown() {
        let Some(node_bin) = ["node", "node.exe"].into_iter().find_map(|name| {
            Command::new(name)
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|_| {
                    let path_var = std::env::var_os("PATH").unwrap_or_default();
                    std::env::split_paths(&path_var).find_map(|dir| {
                        let cand = dir.join(name);
                        cand.is_file().then_some(cand)
                    })
                })
        }) else {
            return;
        };

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        let daemon_dir = tmp.path().join("daemon");
        let src_daemon = daemon_dir.join("src/daemon");
        let hub_home = tmp.path().join("hub-home");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&src_daemon).unwrap();
        fs::create_dir_all(&hub_home).unwrap();

        fs::write(bin_dir.join("fusa-run.exe"), b"stub").unwrap();
        fs::write(bin_dir.join("hub.exe"), b"stub").unwrap();

        let fake_main = r#"
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const home = process.env.AGENT_HUB_HOME;
const port = Number(process.env.AGENT_HUB_PORT);
const supervised = process.env.AGENT_HUB_SUPERVISED ?? "";
if (!supervised) process.exit(2);

mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "run"), { recursive: true });
const bootFile = join(home, "state", "boot-count.txt");
const bootCount = existsSync(bootFile) ? Number(readFileSync(bootFile, "utf8")) + 1 : 1;
writeFileSync(bootFile, String(bootCount));

const uiToken = "test_ui_token_0123456789abcdef";
writeFileSync(join(home, "state", "ui-token"), uiToken);
writeFileSync(join(home, "state", "lock"), `${process.pid}\n`);

const instanceId = `inst-boot-${bootCount}-${randomUUID().slice(0, 8)}`;
const authedCookie = `sess_${bootCount}`;

const adminEndpoint = process.platform === "win32"
  ? `\\\\.\\pipe\\fusa-${createHash("sha256").update(home.normalize("NFC").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 12)}-admin`
  : join(home, "run", "admin.sock");
if (process.platform !== "win32" && existsSync(adminEndpoint)) unlinkSync(adminEndpoint);

let uiServer;
const adminServer = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${uiToken}`) {
    res.writeHead(401).end(JSON.stringify({ error: "bad token" }));
    return;
  }
  if (req.method === "POST" && req.url === "/admin/shutdown") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      adminServer.close();
      uiServer.close(() => process.exit(0));
    }, 20);
    return;
  }
  res.writeHead(404).end();
});

uiServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/auth/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "unauthenticated", product: "fusa", protocolVersion: 1, instanceId }));
    return;
  }
  if (req.method === "POST" && req.url === "/auth") {
    res.writeHead(204, { "Set-Cookie": `agent_hub_ui_${port}=${authedCookie}; HttpOnly; SameSite=Strict; Path=/` });
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/trigger-reload") {
    res.writeHead(200).end("reloading");
    setTimeout(() => {
      adminServer.close();
      uiServer.close(() => process.exit(75));
    }, 20);
    return;
  }
  res.writeHead(404).end();
});

adminServer.listen(adminEndpoint, () => {
  uiServer.listen(port, "127.0.0.1");
});
"#;
        fs::write(src_daemon.join("main.ts"), fake_main).unwrap();
        fs::write(
            daemon_dir.join("package.json"),
            r#"{"name":"fake-daemon","type":"module"}"#,
        )
        .unwrap();

        let free_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free_listener.local_addr().unwrap().port();
        drop(free_listener);

        let contract = DesktopContract::embedded().unwrap();
        let rt = NativeDaemonRuntime::new(NativeRuntimeConfig {
            app_data_dir: tmp.path().join("app-data"),
            hub_home_dir: hub_home.clone(),
            node_exe_path: node_bin,
            daemon_root_dir: daemon_dir,
            win_helpers_dir: bin_dir,
            manifest_path: None,
            extra_envs: Vec::new(),
        });
        let sup = DaemonSupervisor::new(
            contract,
            port,
            &tmp.path().join("app-data"),
            rt,
            UreqHostHttpClient,
            SystemClock,
        )
        .unwrap();

        let snap1 = sup.ensure_running().unwrap();
        let first_inst = match snap1.state {
            SupervisorState::Running { identity, .. } => identity.instance_id,
            other => panic!("expected Running, got {other:?}"),
        };
        assert!(first_inst.starts_with("inst-boot-1-"));
        assert!(sup.session_cookie().is_some());

        let _ = ureq::post(&format!("http://127.0.0.1:{port}/trigger-reload")).send_empty();
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut second_inst = None;
        while Instant::now() < deadline {
            if let SupervisorState::Running { identity, .. } = sup.snapshot().state {
                if identity.instance_id.starts_with("inst-boot-2-") {
                    second_inst = Some(identity.instance_id);
                    break;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(second_inst.is_some(), "expected immediate reload to boot-2");
        assert!(sup.snapshot().last_crash.is_none());

        let stop_started = Instant::now();
        let stop_snap = sup.shutdown();
        assert_eq!(stop_snap.state, SupervisorState::Stopped);
        assert!(stop_started.elapsed() < Duration::from_secs(5));
    }
}
