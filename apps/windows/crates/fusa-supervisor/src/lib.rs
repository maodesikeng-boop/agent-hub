pub mod contract;
pub mod error;
pub mod log;
pub mod probe;
pub mod supervisor;

pub use contract::{DesktopContract, EMBEDDED_DESKTOP_CONTRACT_JSON};
pub use error::SupervisorError;
pub use log::{truncate_chars_clean, RotatingLogWriter, StderrTailCollector};
pub use probe::{
    diagnose_dual_probe, parse_set_cookie_header, parse_status_http_response,
    parse_wsl_ctl_probe_output, DaemonIdentity, DualProbeDiagnosis, HostHttpClient,
    ProbeFailureKind, ProbeOutcome, ProbeSide, SecretUiToken, SessionCookie, UreqHostHttpClient,
};
pub use supervisor::{
    resolve_configured_port, ChildProxyHandle, Clock, CrashRecord, DaemonOwnership,
    DaemonRuntime, DaemonSupervisor, OwnedLinuxStatus, OwnedSignal, StartupPhase, StopReason,
    SupervisorFault, SupervisorSnapshot, SupervisorState, SystemClock, WslDaemonRuntime,
    WslRuntimeConfig,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    /// 虚拟推进时钟：单测无需真实阻塞等待 40s / 60s 即可精确校验所有时间预算边界。
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

    struct NoopProxyHandle;
    impl ChildProxyHandle for NoopProxyHandle {
        fn try_reap(&mut self) -> Option<i32> {
            None
        }
        fn cleanup_after_linux_exit(&mut self) {}
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
    fn contract_json_single_source_of_truth_locks_all_fields() {
        let embedded = DesktopContract::embedded().unwrap();
        let repo_contract_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../desktop/contract.json");
        let loaded = DesktopContract::load_from_path(&repo_contract_path).unwrap();
        assert_eq!(embedded, loaded);

        assert_eq!(embedded.product, "fusa");
        assert_eq!(embedded.protocol_version, 1);
        assert_eq!(embedded.default_port, 4317);
        assert_eq!(embedded.status_path, "/api/auth/status");
        assert_eq!(embedded.probe_timeout_ms, 500);
        assert_eq!(embedded.poll_interval_ms, 150);
        assert_eq!(embedded.startup_budget_ms, 15_000);
        assert_eq!(embedded.wsl_cold_start_budget_ms, 60_000);
        assert_eq!(embedded.stop_grace_ms, 40_000);
        assert_eq!(
            embedded.crash_backoff_ms,
            vec![1000, 2000, 4000, 8000, 16000, 30000]
        );
        assert_eq!(embedded.crash_window_ms, 60_000);
        assert_eq!(embedded.max_crashes_in_window, 5);
        assert_eq!(embedded.reload_exit_code, 75);
        assert_eq!(embedded.supervised_env, "AGENT_HUB_SUPERVISED");
        assert_eq!(embedded.log_relative_path, "state/logs/desktop-daemon.log");
        assert_eq!(embedded.log_max_bytes, 2_097_152);
        assert_eq!(embedded.log_rotated_files, 1);
        assert_eq!(embedded.stderr_tail_max_bytes, 4096);
        assert_eq!(embedded.stderr_summary_max_lines, 8);
        assert_eq!(embedded.menu_reason_max_chars, 60);
        assert_eq!(
            embedded.menu_actions,
            vec![
                "open_main_window",
                "restart_daemon",
                "open_logs",
                "toggle_autostart",
                "quit_app",
            ]
        );

        assert_eq!(embedded.backoff_delay_ms_for_crash_count(1), 1000);
        assert_eq!(embedded.backoff_delay_ms_for_crash_count(4), 8000);
        assert_eq!(embedded.backoff_delay_ms_for_crash_count(6), 30000);
        assert_eq!(embedded.backoff_delay_ms_for_crash_count(99), 30000);
    }

    #[test]
    fn real_http_client_blocks_3xx_redirects_and_rejects_port_conflict_without_sending_token() {
        let contract = DesktopContract::embedded().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        #[derive(Clone, Copy)]
        enum ServerMode {
            Redirect307,
            NonFusaHtml,
            WrongProtocol,
            ValidFusaAndAuth,
            AuthRedirect302,
        }

        let mode = Arc::new(Mutex::new(ServerMode::Redirect307));
        let followed_redirect = Arc::new(AtomicBool::new(false));
        let stop_srv = Arc::new(AtomicBool::new(false));

        let mode_srv = Arc::clone(&mode);
        let redir_srv = Arc::clone(&followed_redirect);
        let stop_flag = Arc::clone(&stop_srv);

        let srv_handle = thread::spawn(move || {
            while !stop_flag.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut raw_req = Vec::with_capacity(1024);
                let mut tmp_buf = [0u8; 1024];
                loop {
                    match stream.read(&mut tmp_buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            raw_req.extend_from_slice(&tmp_buf[..n]);
                            if let Some(hdr_end) = raw_req
                                .windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|p| p + 4)
                            {
                                let hdr_str =
                                    String::from_utf8_lossy(&raw_req[..hdr_end]).to_ascii_lowercase();
                                let content_len = hdr_str
                                    .lines()
                                    .find_map(|l| l.strip_prefix("content-length:"))
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                                    .unwrap_or(0);
                                if raw_req.len() >= hdr_end + content_len {
                                    break;
                                }
                            }
                        }
                    }
                }
                let req_str = String::from_utf8_lossy(&raw_req);
                let first_line = req_str.lines().next().unwrap_or("");

                if first_line.contains("/evil-target") {
                    redir_srv.store(true, Ordering::SeqCst);
                    let body = r#"{"product":"fusa","protocolVersion":1,"instanceId":"spoof"}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    continue;
                }

                let cur_mode = *mode_srv.lock().unwrap();
                match cur_mode {
                    ServerMode::Redirect307 => {
                        let resp = format!(
                            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port}/evil-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    }
                    ServerMode::NonFusaHtml => {
                        let body = "<html><body>Some Other App</body></html>";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    }
                    ServerMode::WrongProtocol => {
                        let body = r#"{"product":"fusa","protocolVersion":99,"instanceId":"v99-id"}"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    }
                    ServerMode::ValidFusaAndAuth => {
                        if first_line.starts_with("POST /auth ") {
                            assert!(req_str
                                .to_ascii_lowercase()
                                .contains(&format!("origin: http://127.0.0.1:{port}")));
                            assert!(req_str.contains(r#"{"token":"top-secret-ui-token"}"#));
                            let resp = format!(
                                "HTTP/1.1 204 No Content\r\nSet-Cookie: agent_hub_ui_{port}=sess_abc123; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000\r\nConnection: close\r\n\r\n"
                            );
                            let _ = stream.write_all(resp.as_bytes());
                        } else {
                            let body = r#"{"status":"unauthenticated","product":"fusa","protocolVersion":1,"instanceId":"real-inst-01"}"#;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(resp.as_bytes());
                        }
                    }
                    ServerMode::AuthRedirect302 => {
                        let resp = format!(
                            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/evil-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    }
                }
            }
        });

        let client = UreqHostHttpClient;

        // 1) 307 重定向被严格拦截，绝不跟随请求 /evil-target
        let out_redir = client.probe_status(port, &contract);
        assert_eq!(
            out_redir,
            ProbeOutcome::Failed(ProbeFailureKind::RedirectBlocked { status_code: 307 })
        );
        assert!(!followed_redirect.load(Ordering::SeqCst));

        // 2) 非 Fusa 服务占用端口（返回 HTML）与协议不兼容时进入 PortConflict，绝不读 ui-token、绝不杀外部进程
        struct FailIfTouchedRuntime {
            token_reads: Arc<AtomicUsize>,
            signals: Arc<AtomicUsize>,
        }
        impl DaemonRuntime for FailIfTouchedRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                panic!("端口冲突时严禁准备或拉起自有后台");
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "unused".to_string(),
                })
            }
            fn spawn_owned_daemon(
                &self,
                _run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                panic!("端口冲突时严禁拉起新进程");
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                Ok(OwnedLinuxStatus::dead())
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                _signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                self.signals.fetch_add(1, Ordering::SeqCst);
                Ok(false)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                self.token_reads.fetch_add(1, Ordering::SeqCst);
                SecretUiToken::new("should-never-be-read")
            }
        }

        *mode.lock().unwrap() = ServerMode::NonFusaHtml;
        let tmp = TempDir::new().unwrap();
        let token_reads = Arc::new(AtomicUsize::new(0));
        let signals = Arc::new(AtomicUsize::new(0));
        let sup = DaemonSupervisor::new(
            contract.clone(),
            port,
            tmp.path(),
            FailIfTouchedRuntime {
                token_reads: Arc::clone(&token_reads),
                signals: Arc::clone(&signals),
            },
            client,
            SystemClock,
        )
        .unwrap();

        let conflict_err = sup.ensure_running().unwrap_err();
        assert!(matches!(conflict_err, SupervisorError::PortConflict { .. }));
        assert!(matches!(
            sup.snapshot().state,
            SupervisorState::Faulted {
                fault: SupervisorFault::PortConflict { .. },
                ..
            }
        ));
        assert_eq!(token_reads.load(Ordering::SeqCst), 0);
        assert_eq!(signals.load(Ordering::SeqCst), 0);

        *mode.lock().unwrap() = ServerMode::WrongProtocol;
        assert!(matches!(
            client.probe_status(port, &contract),
            ProbeOutcome::Failed(ProbeFailureKind::IncompatibleProtocol {
                actual: Some(99),
                expected: 1
            })
        ));

        // 3) 合法 Fusa 身份探活与 POST /auth Cookie 兑换（含脱敏 Debug 守卫）
        *mode.lock().unwrap() = ServerMode::ValidFusaAndAuth;
        let verified = client.probe_status(port, &contract);
        assert_eq!(verified, ProbeOutcome::Verified(ok_identity("real-inst-01")));

        let token = SecretUiToken::new("top-secret-ui-token").unwrap();
        assert!(!format!("{token:?}").contains("top-secret-ui-token"));
        let cookie = client
            .exchange_session_cookie(port, &token, Duration::from_millis(500))
            .unwrap();
        assert_eq!(cookie.name, format!("agent_hub_ui_{port}"));
        assert_eq!(cookie.value(), "sess_abc123");
        assert!(cookie.http_only);
        assert!(cookie.same_site_strict);
        assert!(!format!("{cookie:?}").contains("sess_abc123"));

        // 4) POST /auth 返回 302 重定向时同样被拦截，绝不跟随
        *mode.lock().unwrap() = ServerMode::AuthRedirect302;
        assert!(matches!(
            client.exchange_session_cookie(port, &token, Duration::from_millis(500)),
            Err(SupervisorError::RedirectBlocked { status_code: 302 })
        ));
        assert!(!followed_redirect.load(Ordering::SeqCst));

        stop_srv.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(("127.0.0.1", port));
        let _ = srv_handle.join();
    }

    #[test]
    fn external_compatible_fusa_is_reused_as_external_managed_and_never_signaled() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();
        let signals = Arc::new(AtomicUsize::new(0));
        let token_reads = Arc::new(AtomicUsize::new(0));

        struct ExternalCheckRuntime {
            guest_outcome: ProbeOutcome,
            signals: Arc<AtomicUsize>,
            token_reads: Arc<AtomicUsize>,
        }
        impl DaemonRuntime for ExternalCheckRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                panic!("外部兼容实例仅复用，不应部署或拉起新实例");
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                self.guest_outcome.clone()
            }
            fn spawn_owned_daemon(
                &self,
                _run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                panic!("外部兼容实例仅复用，不应 spawn");
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                Ok(OwnedLinuxStatus::dead())
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                _signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                self.signals.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                self.token_reads.fetch_add(1, Ordering::SeqCst);
                SecretUiToken::new("wsl-secret-token")
            }
        }

        // 场景 A：宿主与 WSL 内为同一个外部已启动实例 -> 标记 ExternalManaged 并兑换 Cookie，重启与退出绝不发信号
        let http_a = MockHttpClient::with_status(|_, _| {
            ProbeOutcome::Verified(ok_identity("ext-same-instance"))
        });
        let sup_a = DaemonSupervisor::new(
            contract.clone(),
            4317,
            tmp.path(),
            ExternalCheckRuntime {
                guest_outcome: ProbeOutcome::Verified(ok_identity("ext-same-instance")),
                signals: Arc::clone(&signals),
                token_reads: Arc::clone(&token_reads),
            },
            http_a.clone(),
            VirtualClock::new(1_000),
        )
        .unwrap();

        let snap = sup_a.ensure_running().unwrap();
        assert_eq!(snap.ownership, DaemonOwnership::ExternalManaged);
        assert!(snap.has_session_cookie);
        assert_eq!(http_a.exchange_count(), 1);

        assert!(matches!(
            sup_a.restart_manual().unwrap_err(),
            SupervisorError::ExternalManagedCannotRestart
        ));
        let shut_snap = sup_a.shutdown();
        assert_eq!(shut_snap.state, SupervisorState::Stopped);
        assert_eq!(signals.load(Ordering::SeqCst), 0);

        // 场景 B：宿主上是另一个非本 WSL 的外部 Fusa（guest 不可达或 instanceId 不同）-> 同样复用为 ExternalManaged，且绝不泄露 WSL ui-token！
        let token_reads_b = Arc::new(AtomicUsize::new(0));
        let http_b = MockHttpClient::with_status(|_, _| {
            ProbeOutcome::Verified(ok_identity("windows-external-fusa"))
        });
        let sup_b = DaemonSupervisor::new(
            contract,
            4317,
            tmp.path(),
            ExternalCheckRuntime {
                guest_outcome: ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "stopped".to_string(),
                }),
                signals: Arc::new(AtomicUsize::new(0)),
                token_reads: Arc::clone(&token_reads_b),
            },
            http_b.clone(),
            VirtualClock::new(2_000),
        )
        .unwrap();
        let snap_b = sup_b.ensure_running().unwrap();
        assert_eq!(snap_b.ownership, DaemonOwnership::ExternalManaged);
        assert!(!snap_b.has_session_cookie);
        assert_eq!(token_reads_b.load(Ordering::SeqCst), 0);
        assert_eq!(http_b.exchange_count(), 0);
    }

    #[test]
    fn cold_start_60s_budget_stage_progression_and_localhost_forwarding_diagnosis() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();

        // 1) WSL 冷启动（is_distro_cold = true）：耗时 25s（超过热启动 15s，但在冷启动 60s 预算内）顺利就绪，且就绪后零轮询
        let clock_now = Arc::new(AtomicU64::new(10_000));
        let clock_now_probe = Arc::clone(&clock_now);
        let clock = VirtualClock::with_hook(10_000, move |_, next| {
            clock_now_probe.store(next, Ordering::SeqCst);
        });

        let guest_probes = Arc::new(AtomicUsize::new(0));
        let guest_probes_rt = Arc::clone(&guest_probes);
        let ready_after_ms = 10_000 + 25_000; // 25s 后就绪
        let clock_for_guest = Arc::clone(&clock);
        let clock_for_host = Arc::clone(&clock);
        let spawned_flag = Arc::new(AtomicBool::new(false));
        let spawned_for_guest = Arc::clone(&spawned_flag);
        let spawned_for_host = Arc::clone(&spawned_flag);

        struct ColdStartRuntime {
            clock: Arc<VirtualClock>,
            ready_at: u64,
            spawned: Arc<AtomicBool>,
            guest_probes: Arc<AtomicUsize>,
        }
        impl DaemonRuntime for ColdStartRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(true)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                Ok(true)
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                self.guest_probes.fetch_add(1, Ordering::SeqCst);
                if self.spawned.load(Ordering::SeqCst) && self.clock.now() >= self.ready_at {
                    ProbeOutcome::Verified(ok_identity("cold-inst-1"))
                } else {
                    ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "booting".to_string(),
                    })
                }
            }
            fn spawn_owned_daemon(
                &self,
                _run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                self.spawned.store(true, Ordering::SeqCst);
                Ok(Box::new(NoopProxyHandle))
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                Ok(OwnedLinuxStatus {
                    found: true,
                    leader_alive: true,
                    group_alive: true,
                    pid: Some(501),
                    pgid: Some(501),
                })
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                _signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("cold-ui-token")
            }
        }

        let http = MockHttpClient::with_status(move |_, _| {
            if spawned_for_host.load(Ordering::SeqCst) && clock_for_host.now() >= ready_after_ms {
                ProbeOutcome::Verified(ok_identity("cold-inst-1"))
            } else {
                ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "booting".to_string(),
                })
            }
        });

        let observed_phases = Arc::new(Mutex::new(Vec::<StartupPhase>::new()));
        let obs_clone = Arc::clone(&observed_phases);

        let sup = DaemonSupervisor::new(
            contract.clone(),
            4317,
            tmp.path(),
            ColdStartRuntime {
                clock: clock_for_guest,
                ready_at: ready_after_ms,
                spawned: spawned_for_guest,
                guest_probes: guest_probes_rt,
            },
            http,
            Arc::clone(&clock),
        )
        .unwrap();

        sup.set_observer(Arc::new(move |snap| {
            if let SupervisorState::Starting { phase, is_cold_start, .. } = snap.state {
                if is_cold_start {
                    obs_clone.lock().unwrap().push(phase);
                }
            }
        }));

        let ready_snap = sup.ensure_running().unwrap();
        assert!(matches!(
            ready_snap.state,
            SupervisorState::Running {
                ownership: DaemonOwnership::Owned,
                linux_pid: Some(501),
                ..
            }
        ));

        let phases = observed_phases.lock().unwrap().clone();
        assert!(phases.contains(&StartupPhase::ColdStartingWsl));
        assert!(phases.contains(&StartupPhase::SyncingReleaseBundle));
        assert!(phases.contains(&StartupPhase::LaunchingDaemon));
        assert!(phases.iter().any(|p| matches!(
            p,
            StartupPhase::WaitingForReady { budget_ms: 60_000, .. }
        )));
        assert!(phases.contains(&StartupPhase::ExchangingSession));

        // 稳定态零轮询验证
        let probes_at_ready = guest_probes.load(Ordering::SeqCst);
        thread::sleep(Duration::from_millis(30));
        assert_eq!(guest_probes.load(Ordering::SeqCst), probes_at_ready);

        // 2) 双重探活精准诊断：WSL 内部已就绪（guest Verified），但宿主 127.0.0.1 不通（localhostForwarding 异常）
        struct ForwardingBrokenRuntime {
            alive: Arc<AtomicBool>,
        }
        impl DaemonRuntime for ForwardingBrokenRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                if self.alive.load(Ordering::SeqCst) {
                    ProbeOutcome::Verified(ok_identity("wsl-guest-ok"))
                } else {
                    ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "not_started".to_string(),
                    })
                }
            }
            fn spawn_owned_daemon(
                &self,
                _run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                self.alive.store(true, Ordering::SeqCst);
                Ok(Box::new(NoopProxyHandle))
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                let on = self.alive.load(Ordering::SeqCst);
                Ok(OwnedLinuxStatus {
                    found: on,
                    leader_alive: on,
                    group_alive: on,
                    pid: if on { Some(777) } else { None },
                    pgid: if on { Some(777) } else { None },
                })
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                _signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                self.alive.store(false, Ordering::SeqCst);
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("tok")
            }
        }

        let sup_fwd = DaemonSupervisor::new(
            contract,
            4317,
            tmp.path(),
            ForwardingBrokenRuntime {
                alive: Arc::new(AtomicBool::new(false)),
            },
            MockHttpClient::with_status(|_, _| {
                ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "connection refused on Windows loopback".to_string(),
                })
            }),
            VirtualClock::new(50_000),
        )
        .unwrap();

        let fwd_err = sup_fwd.ensure_running().unwrap_err();
        assert!(matches!(
            fwd_err,
            SupervisorError::LocalhostForwardingBroken {
                ref guest_instance_id,
                ..
            } if guest_instance_id == "wsl-guest-ok"
        ));
        assert!(matches!(
            sup_fwd.snapshot().state,
            SupervisorState::Faulted {
                fault: SupervisorFault::LocalhostForwardingBroken { .. },
                ..
            }
        ));
    }

    #[test]
    fn crash_backoff_5_limit_in_60s_window_and_manual_restart_resets_counter() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();

        // 控制每次拉起后的存活与 stderr 输出
        let linux_alive = Arc::new(AtomicBool::new(false));
        let auto_recover = Arc::new(AtomicBool::new(false));
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let last_run_id = Arc::new(Mutex::new(String::new()));

        struct CrashTestRuntime {
            linux_alive: Arc<AtomicBool>,
            auto_recover: Arc<AtomicBool>,
            spawn_count: Arc<AtomicUsize>,
            last_run_id: Arc<Mutex<String>>,
        }
        impl DaemonRuntime for CrashTestRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                if self.linux_alive.load(Ordering::SeqCst) {
                    ProbeOutcome::Verified(ok_identity("crash-test-inst"))
                } else {
                    ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "down".to_string(),
                    })
                }
            }
            fn spawn_owned_daemon(
                &self,
                run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                let n = self.spawn_count.fetch_add(1, Ordering::SeqCst) + 1;
                *self.last_run_id.lock().unwrap() = run_id.to_string();
                tail.lock().unwrap().append(
                    format!(
                        "Error: fatal uncaught exception on attempt #{n} — SQLite disk full details that exceed sixty characters easily for truncation check\n"
                    )
                    .as_bytes(),
                );
                let alive = n == 1 || self.auto_recover.load(Ordering::SeqCst);
                self.linux_alive.store(alive, Ordering::SeqCst);
                Ok(Box::new(NoopProxyHandle))
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                let alive = self.linux_alive.load(Ordering::SeqCst);
                Ok(OwnedLinuxStatus {
                    found: true,
                    leader_alive: alive,
                    group_alive: alive,
                    pid: if alive { Some(900) } else { None },
                    pgid: if alive { Some(900) } else { None },
                })
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                _signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                self.linux_alive.store(false, Ordering::SeqCst);
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("crash-tok")
            }
        }

        let alive_for_http = Arc::clone(&linux_alive);
        let http = MockHttpClient::with_status(move |_, _| {
            if alive_for_http.load(Ordering::SeqCst) {
                ProbeOutcome::Verified(ok_identity("crash-test-inst"))
            } else {
                ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "down".to_string(),
                })
            }
        });

        let recorded_backoffs = Arc::new(Mutex::new(Vec::<(usize, u64)>::new()));
        let rec_obs = Arc::clone(&recorded_backoffs);

        let clock = VirtualClock::new(100_000);
        let sup = DaemonSupervisor::new(
            contract,
            4317,
            tmp.path(),
            CrashTestRuntime {
                linux_alive: Arc::clone(&linux_alive),
                auto_recover: Arc::clone(&auto_recover),
                spawn_count: Arc::clone(&spawn_count),
                last_run_id: Arc::clone(&last_run_id),
            },
            http,
            Arc::clone(&clock),
        )
        .unwrap();

        sup.set_observer(Arc::new(move |snap| {
            if let SupervisorState::BackingOff {
                attempt, delay_ms, ..
            } = snap.state
            {
                rec_obs.lock().unwrap().push((attempt, delay_ms));
            }
        }));

        // 初次启动成功
        let initial = sup.ensure_running().unwrap();
        let SupervisorState::Running { generation: gen1, .. } = initial.state else {
            panic!("应处于 Running");
        };
        let run1 = last_run_id.lock().unwrap().clone();

        // 保护验证：仅宿主 wsl.exe 代理退出、但 Linux 主进程仍存活时，绝不误判为崩溃！
        sup.on_owned_proxy_exited(gen1, &run1, Some(0));
        assert!(matches!(sup.snapshot().state, SupervisorState::Running { .. }));

        // 现在模拟 Linux 主进程真崩溃：第 1 次崩溃触发后台退避链，连续拉起又立即退出共累计 5 次崩溃后熔断停止重试！
        linux_alive.store(false, Ordering::SeqCst);
        sup.on_owned_proxy_exited(gen1, &run1, Some(1));

        // 等待后台退避线程推进至第 5 次崩溃熔断（VirtualClock 秒级完成，无真实 sleep）
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if matches!(
                sup.snapshot().state,
                SupervisorState::Faulted {
                    fault: SupervisorFault::CrashLimitExceeded {
                        crashes_in_window: 5,
                        ..
                    },
                    ..
                }
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "等待第 5 次崩溃熔断超时，当前状态：{:?}",
                sup.snapshot().state
            );
            thread::sleep(Duration::from_millis(5));
        }

        // 前 4 次退避严格按契约 [1000, 2000, 4000, 8000]ms 递增，第 5 次直接熔断不再退避
        assert_eq!(
            *recorded_backoffs.lock().unwrap(),
            vec![(1, 1000), (2, 2000), (3, 4000), (4, 8000)]
        );
        let fault_snap = sup.snapshot();
        let crash_info = fault_snap.last_crash.as_ref().unwrap();
        assert!(crash_info.menu_reason.chars().count() <= 60);

        // 用户手动点“重启后台服务”：清零崩溃计数窗口并成功恢复 Running，同时保留上次崩溃摘要供排查
        auto_recover.store(true, Ordering::SeqCst);
        let recovered = sup.restart_manual().unwrap();
        assert!(matches!(
            recovered.state,
            SupervisorState::Running {
                ownership: DaemonOwnership::Owned,
                ..
            }
        ));
        assert!(recovered.last_crash.is_some());
    }

    #[test]
    fn slow_graceful_shutdown_3s_within_40s_budget_and_40s_timeout_sigkill_fallback() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();

        struct StopBehaviorRuntime {
            clock: Arc<VirtualClock>,
            started: AtomicBool,
            term_at_ms: Mutex<Option<u64>>,
            graceful_exit_delay_ms: Option<u64>, // None 表示死锁忽略 SIGTERM
            killed: AtomicBool,
            signals: Mutex<Vec<OwnedSignal>>,
        }

        impl DaemonRuntime for StopBehaviorRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                if self.is_alive() {
                    ProbeOutcome::Verified(ok_identity("stop-inst"))
                } else {
                    ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "stopped".to_string(),
                    })
                }
            }
            fn spawn_owned_daemon(
                &self,
                _run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                self.started.store(true, Ordering::SeqCst);
                *self.term_at_ms.lock().unwrap() = None;
                self.killed.store(false, Ordering::SeqCst);
                Ok(Box::new(NoopProxyHandle))
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                let alive = self.is_alive();
                Ok(OwnedLinuxStatus {
                    found: alive,
                    leader_alive: alive,
                    group_alive: alive,
                    pid: if alive { Some(1234) } else { None },
                    pgid: if alive { Some(1234) } else { None },
                })
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                self.signals.lock().unwrap().push(signal);
                match signal {
                    OwnedSignal::Term => {
                        *self.term_at_ms.lock().unwrap() = Some(self.clock.now());
                    }
                    OwnedSignal::Kill => {
                        self.killed.store(true, Ordering::SeqCst);
                    }
                }
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("stop-tok")
            }
        }

        impl StopBehaviorRuntime {
            fn is_alive(&self) -> bool {
                if !self.started.load(Ordering::SeqCst) || self.killed.load(Ordering::SeqCst) {
                    return false;
                }
                match (*self.term_at_ms.lock().unwrap(), self.graceful_exit_delay_ms) {
                    (Some(t0), Some(delay)) => self.clock.now() < t0 + delay,
                    _ => true,
                }
            }
        }

        // 1) 慢关闭（3 秒退出）：在 40s stopGraceMs 预算内优雅完成，绝不发送 SIGKILL！
        let clock1 = VirtualClock::new(1_000);
        let rt1 = Arc::new(StopBehaviorRuntime {
            clock: Arc::clone(&clock1),
            started: AtomicBool::new(false),
            term_at_ms: Mutex::new(None),
            graceful_exit_delay_ms: Some(3_000),
            killed: AtomicBool::new(false),
            signals: Mutex::new(Vec::new()),
        });

        struct ArcRt(Arc<StopBehaviorRuntime>);
        impl DaemonRuntime for ArcRt {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                self.0.verify_distro_ownership()
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                self.0.is_distro_cold()
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                self.0.prepare_runtime_assets()
            }
            fn probe_guest_status(&self, p: u16, c: &DesktopContract) -> ProbeOutcome {
                self.0.probe_guest_status(p, c)
            }
            fn spawn_owned_daemon(
                &self,
                r: &str,
                p: u16,
                l: Arc<Mutex<RotatingLogWriter>>,
                t: Arc<Mutex<StderrTailCollector>>,
                cb: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                self.0.spawn_owned_daemon(r, p, l, t, cb)
            }
            fn query_owned_status(&self, r: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                self.0.query_owned_status(r)
            }
            fn signal_owned_daemon(&self, r: &str, s: OwnedSignal) -> Result<bool, SupervisorError> {
                self.0.signal_owned_daemon(r, s)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                self.0.read_ui_token()
            }
        }

        let spawned1 = Arc::new(AtomicBool::new(false));
        let sp1_http = Arc::clone(&spawned1);
        let rt1_http = Arc::clone(&rt1);
        let sup1 = DaemonSupervisor::new(
            contract.clone(),
            4317,
            tmp.path(),
            ArcRt(Arc::clone(&rt1)),
            MockHttpClient::with_status(move |_, _| {
                if sp1_http.load(Ordering::SeqCst) && rt1_http.is_alive() {
                    ProbeOutcome::Verified(ok_identity("stop-inst"))
                } else {
                    ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "init".to_string(),
                    })
                }
            }),
            Arc::clone(&clock1),
        )
        .unwrap();
        sup1.set_observer(Arc::new(move |snap| {
            if matches!(
                snap.state,
                SupervisorState::Starting {
                    phase: StartupPhase::LaunchingDaemon,
                    ..
                }
            ) {
                spawned1.store(true, Ordering::SeqCst);
            }
        }));

        sup1.ensure_running().unwrap();
        let before_stop = clock1.now();
        let shut1 = sup1.shutdown();
        let stop_elapsed = clock1.now() - before_stop;
        assert_eq!(shut1.state, SupervisorState::Stopped);
        assert!(stop_elapsed >= 3_000 && stop_elapsed < 4_000);
        assert_eq!(*rt1.signals.lock().unwrap(), vec![OwnedSignal::Term]);

        // 2) 僵死进程忽略 SIGTERM：等足 40_000ms（stopGraceMs）后才对自有进程树发 SIGKILL
        let clock2 = VirtualClock::new(10_000);
        let rt2 = Arc::new(StopBehaviorRuntime {
            clock: Arc::clone(&clock2),
            started: AtomicBool::new(false),
            term_at_ms: Mutex::new(None),
            graceful_exit_delay_ms: None,
            killed: AtomicBool::new(false),
            signals: Mutex::new(Vec::new()),
        });
        let spawned2 = Arc::new(AtomicBool::new(false));
        let sp2_http = Arc::clone(&spawned2);
        let rt2_http = Arc::clone(&rt2);
        let sup2 = DaemonSupervisor::new(
            contract,
            4317,
            tmp.path(),
            ArcRt(Arc::clone(&rt2)),
            MockHttpClient::with_status(move |_, _| {
                if sp2_http.load(Ordering::SeqCst) && rt2_http.is_alive() {
                    ProbeOutcome::Verified(ok_identity("stop-inst"))
                } else {
                    ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "init".to_string(),
                    })
                }
            }),
            Arc::clone(&clock2),
        )
        .unwrap();
        sup2.set_observer(Arc::new(move |snap| {
            if matches!(
                snap.state,
                SupervisorState::Starting {
                    phase: StartupPhase::LaunchingDaemon,
                    ..
                }
            ) {
                spawned2.store(true, Ordering::SeqCst);
            }
        }));

        sup2.ensure_running().unwrap();
        let t_start_kill = clock2.now();
        let shut2 = sup2.shutdown();
        let kill_elapsed = clock2.now() - t_start_kill;
        assert_eq!(shut2.state, SupervisorState::Stopped);
        assert!(kill_elapsed >= 40_000);
        assert_eq!(
            *rt2.signals.lock().unwrap(),
            vec![OwnedSignal::Term, OwnedSignal::Kill]
        );
    }

    #[test]
    fn double_click_manual_restart_has_zero_dual_instance_race() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();

        let live_instances = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));
        let total_spawns = Arc::new(AtomicUsize::new(0));
        let current_inst_id = Arc::new(Mutex::new(None::<String>));

        struct RaceGuardRuntime {
            live_instances: Arc<AtomicUsize>,
            max_concurrent: Arc<AtomicUsize>,
            total_spawns: Arc<AtomicUsize>,
            current_inst_id: Arc<Mutex<Option<String>>>,
        }

        impl DaemonRuntime for RaceGuardRuntime {
            fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
                Ok(())
            }
            fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
                Ok(false)
            }
            fn probe_guest_status(&self, _port: u16, _contract: &DesktopContract) -> ProbeOutcome {
                match self.current_inst_id.lock().unwrap().clone() {
                    Some(id) => ProbeOutcome::Verified(ok_identity(&id)),
                    None => ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                        reason: "none".to_string(),
                    }),
                }
            }
            fn spawn_owned_daemon(
                &self,
                run_id: &str,
                _port: u16,
                _log: Arc<Mutex<RotatingLogWriter>>,
                _tail: Arc<Mutex<StderrTailCollector>>,
                _on_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
            ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
                let n = self.total_spawns.fetch_add(1, Ordering::SeqCst) + 1;
                let cur = self.live_instances.fetch_add(1, Ordering::SeqCst) + 1;
                self.max_concurrent.fetch_max(cur, Ordering::SeqCst);
                *self.current_inst_id.lock().unwrap() = Some(format!("inst-{n}-{run_id}"));
                Ok(Box::new(NoopProxyHandle))
            }
            fn query_owned_status(&self, _run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
                let alive = self.live_instances.load(Ordering::SeqCst) > 0;
                Ok(OwnedLinuxStatus {
                    found: alive,
                    leader_alive: alive,
                    group_alive: alive,
                    pid: if alive { Some(333) } else { None },
                    pgid: if alive { Some(333) } else { None },
                })
            }
            fn signal_owned_daemon(
                &self,
                _run_id: &str,
                _signal: OwnedSignal,
            ) -> Result<bool, SupervisorError> {
                // 模拟真实旧实例需要 80ms 落盘优雅退出：期间第 2 次点击并发打入
                thread::sleep(Duration::from_millis(80));
                if self.current_inst_id.lock().unwrap().take().is_some() {
                    self.live_instances.fetch_sub(1, Ordering::SeqCst);
                }
                Ok(true)
            }
            fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
                SecretUiToken::new("race-tok")
            }
        }

        let inst_for_http = Arc::clone(&current_inst_id);
        let sup = DaemonSupervisor::new(
            contract,
            4317,
            tmp.path(),
            RaceGuardRuntime {
                live_instances: Arc::clone(&live_instances),
                max_concurrent: Arc::clone(&max_concurrent),
                total_spawns: Arc::clone(&total_spawns),
                current_inst_id: Arc::clone(&current_inst_id),
            },
            MockHttpClient::with_status(move |_, _| match inst_for_http.lock().unwrap().clone() {
                Some(id) => ProbeOutcome::Verified(ok_identity(&id)),
                None => ProbeOutcome::Failed(ProbeFailureKind::Unreachable {
                    reason: "none".to_string(),
                }),
            }),
            SystemClock,
        )
        .unwrap();

        sup.ensure_running().unwrap();
        assert_eq!(total_spawns.load(Ordering::SeqCst), 1);

        // 用户在 15ms 内连点两次“重启后台服务”
        let s1 = Arc::clone(&sup);
        let t1 = thread::spawn(move || s1.restart_manual());
        thread::sleep(Duration::from_millis(15));
        let s2 = Arc::clone(&sup);
        let t2 = thread::spawn(move || s2.restart_manual());

        let r1 = t1.join().unwrap();
        let r2 = t2.join().unwrap();

        // 任何时刻并发存活实例数严格 == 1，且前一次连点让位于最新一次，总共仅拉起 1 个新实例（初始 1 + 重启 1 = 2）
        assert_eq!(max_concurrent.load(Ordering::SeqCst), 1);
        assert_eq!(live_instances.load(Ordering::SeqCst), 1);
        assert_eq!(total_spawns.load(Ordering::SeqCst), 2);
        assert!(
            matches!(r1, Err(SupervisorError::CancelledByNewerGeneration)) && r2.is_ok()
                || matches!(r2, Err(SupervisorError::CancelledByNewerGeneration)) && r1.is_ok()
        );
        assert!(matches!(sup.snapshot().state, SupervisorState::Running { .. }));
    }

    #[test]
    fn rotating_log_strictly_caps_2mib_plus_1_backup_and_stderr_tail_caps_4kib_8_lines_60_chars() {
        let contract = DesktopContract::embedded().unwrap();
        let tmp = TempDir::new().unwrap();
        let log_path = tmp.path().join(&contract.log_relative_path);

        let mut writer = RotatingLogWriter::open(
            &log_path,
            contract.log_max_bytes,
            contract.log_rotated_files,
        )
        .unwrap();

        // 连续写入约 5.5 MiB 日志（含单次 2.6 MiB 超大块），验证任何时刻 .log 与 .log.1 均 <= 2 MiB 且绝无 .log.2
        let medium_chunk = vec![b'A'; 600 * 1024];
        for _ in 0..5 {
            writer.write_chunk(&medium_chunk).unwrap();
        }
        let huge_chunk = vec![b'B'; 2_600_000];
        writer.write_chunk(&huge_chunk).unwrap();

        let main_len = fs::metadata(&log_path).unwrap().len();
        let rot1_path = writer.rotated_path(1);
        let rot2_path = writer.rotated_path(2);
        let rot1_len = fs::metadata(&rot1_path).unwrap().len();

        assert!(main_len <= contract.log_max_bytes);
        assert_eq!(rot1_len, contract.log_max_bytes);
        assert!(!rot2_path.exists(), "logRotatedFiles=1 时严禁残留 .log.2");

        // stderr 4 KiB 尾缓冲、最多 8 行摘要与 60 字托盘原因截断（含中文多字节边界）
        let mut collector = StderrTailCollector::from_contract(&contract);
        for idx in 1..=120 {
            let line = format!(
                "第{idx:03}行错误：数据库连接重试失败，详细上下文诊断信息用于验证中文 UTF-8 截断安全性与四千字节上限控制以及托盘菜单严格的六十个字符最大显示长度约束边界检查\n"
            );
            collector.append(line.as_bytes());
        }
        assert_eq!(collector.byte_len(), contract.stderr_tail_max_bytes);
        let tail_text = collector.tail_text();
        assert!(!tail_text.contains('\u{FFFD}'), "前端截断不应产生乱码替代符");

        let lines = collector.summary_lines();
        assert_eq!(lines.len(), contract.stderr_summary_max_lines);
        assert!(lines.last().unwrap().starts_with("第120行错误："));

        let reason = collector.format_menu_crash_reason("退出码 1");
        assert!(reason.chars().count() <= contract.menu_reason_max_chars);
        assert!(reason.ends_with('…'));
    }

    #[test]
    fn wsl_daemon_runtime_enforces_safe_commands_and_lxss_ownership() {
        use fusa_wsl::{
            CommandOutput, DistroRegistryInspector, ProvisionConfig, ProvisionStage,
            ProvisionState, RegistryLookup, WslCommand,
        };

        struct RecordingWslRunner {
            outputs: Mutex<VecDeque<CommandOutput>>,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl fusa_wsl::CommandRunner for RecordingWslRunner {
            fn run(
                &self,
                cmd: &WslCommand,
                _stdin: Option<&[u8]>,
            ) -> Result<CommandOutput, std::io::Error> {
                let args = cmd.args_lossy();
                for forbidden in ["--shutdown", "--terminate", "--unregister", "pkill", "-c"] {
                    assert!(
                        !args.iter().any(|a| a.eq_ignore_ascii_case(forbidden)),
                        "严禁在受控运行期调用危险参数 {forbidden}: {args:?}"
                    );
                }
                self.calls.lock().unwrap().push(args);
                Ok(self.outputs.lock().unwrap().pop_front().unwrap())
            }
        }
        struct DummyDl;
        impl fusa_wsl::RootfsDownloader for DummyDl {
            fn download(&self, _u: &str, _d: &Path) -> Result<(), fusa_wsl::ProvisionError> {
                Ok(())
            }
        }
        struct FixedReg(RegistryLookup);
        impl DistroRegistryInspector for FixedReg {
            fn lookup_distro_base_path(&self, _n: &str) -> Result<RegistryLookup, std::io::Error> {
                Ok(self.0.clone())
            }
        }

        let tmp = TempDir::new().unwrap();
        let p_cfg = ProvisionConfig::new(tmp.path());
        let mut st = ProvisionState::new("Fusa");
        st.imported_by_fusa = true;
        st.self_test_passed = true;
        st.stage = ProvisionStage::Ready;
        st.save_atomic(tmp.path()).unwrap();
        fs::create_dir_all(p_cfg.distro_install_dir()).unwrap();
        fs::write(p_cfg.distro_vhdx_path(), b"vhdx").unwrap();

        let runner = RecordingWslRunner {
            outputs: Mutex::new(VecDeque::from(vec![
                // prepare_runtime_assets: mkdir, tee, chmod
                CommandOutput { exit_code: 0, stdout: Vec::new(), stderr: Vec::new() },
                CommandOutput { exit_code: 0, stdout: Vec::new(), stderr: Vec::new() },
                CommandOutput { exit_code: 0, stdout: Vec::new(), stderr: Vec::new() },
                // probe_guest_status
                CommandOutput {
                    exit_code: 0,
                    stdout: b"{\"product\":\"fusa\",\"protocolVersion\":1,\"instanceId\":\"wsl-01\"}\n__FUSA_HTTP_STATUS__:200\n".to_vec(),
                    stderr: Vec::new(),
                },
                // query_owned_status
                CommandOutput {
                    exit_code: 0,
                    stdout: b"{\"found\":true,\"leader_alive\":true,\"group_alive\":true,\"pid\":2048,\"pgid\":2048}\n".to_vec(),
                    stderr: Vec::new(),
                },
                // signal_owned_daemon TERM
                CommandOutput {
                    exit_code: 0,
                    stdout: b"{\"signaled\":true,\"reason\":\"sigterm_sent_to_leader\",\"pid\":2048}\n".to_vec(),
                    stderr: Vec::new(),
                },
                // read_ui_token
                CommandOutput {
                    exit_code: 0,
                    stdout: b"mem-only-token-xyz\n".to_vec(),
                    stderr: Vec::new(),
                },
            ])),
            calls: Mutex::new(Vec::new()),
        };

        let expected_dir = p_cfg.distro_install_dir();
        let prov = fusa_wsl::Provisioner::with_registry_inspector(
            p_cfg.clone(),
            runner,
            DummyDl,
            FixedReg(RegistryLookup::Found {
                base_path: expected_dir,
            }),
        );
        let rt = WslDaemonRuntime::new(WslRuntimeConfig::new(tmp.path()), prov);
        let contract = DesktopContract::embedded().unwrap();

        rt.verify_distro_ownership().unwrap();
        assert!(!rt.prepare_runtime_assets().unwrap());
        assert_eq!(
            rt.probe_guest_status(4317, &contract),
            ProbeOutcome::Verified(DaemonIdentity {
                product: "fusa".to_string(),
                protocol_version: 1,
                instance_id: "wsl-01".to_string(),
                status: None,
            })
        );
        let owned_st = rt.query_owned_status("run-abc").unwrap();
        assert_eq!(owned_st.pid, Some(2048));
        assert!(rt.signal_owned_daemon("run-abc", OwnedSignal::Term).unwrap());
        let tok = rt.read_ui_token().unwrap();
        assert_eq!(tok.expose_secret(), "mem-only-token-xyz");
    }
}
