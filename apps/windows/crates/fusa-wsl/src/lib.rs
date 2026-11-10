pub mod command;
pub mod constants;
pub mod error;
pub mod parser;
pub mod provisioner;
pub mod runner;
pub mod state;

pub use command::{
    build_chmod_guest_script_cmd, build_daemon_launch_cmd, build_exec_cmd, build_import_distro_cmd,
    build_install_wsl_no_distro_cmd, build_list_verbose_cmd, build_prepare_guest_script_dir_cmd,
    build_read_ui_token_cmd, build_run_guest_script_cmd, build_status_cmd,
    build_terminate_distro_cmd, build_version_cmd, build_write_guest_script_cmd, WslCommand,
};
pub use constants::{
    DISTRO_INSTALL_SUBDIR, DISTRO_VHDX_FILENAME, EMBEDDED_GUEST_SCRIPT, FUSA_DISTRO_NAME, FUSA_LINUX_USER,
    FUSA_NODE_WSL_PATH, FUSA_PNPM_WSL_PATH, FUSA_PROJECTS_WSL_DIR, FUSA_RELEASES_WSL_DIR,
    FUSA_ROOT_USER, FUSA_UI_TOKEN_WSL_PATH, GUEST_SCRIPT_WSL_DIR, GUEST_SCRIPT_WSL_PATH,
    PINNED_UBUNTU_2404_ROOTFS, PinnedRootfsImage, PROVISION_STATE_FILENAME, ROOTFS_CACHE_SUBDIR,
    WSL_EXE,
};
pub use error::{CommandBuildError, ProvisionError, SelfTestChecks, SelfTestFailureItem, SelfTestReport};
pub use parser::{
    decode_wsl_output, parse_self_test_report, parse_vendor_guides_json, parse_vendor_guides_tsv,
    parse_wsl_list_verbose, parse_wsl_version_output, VendorGuideEntry, WslDistroEntry,
    WslDistroState, WslVersionInfo,
};
pub use provisioner::{validate_local_app_data_dir, ProvisionConfig, Provisioner, WslHostStatus};
pub use runner::{
    compute_file_sha256_hex, verify_file_sha256, CommandOutput, CommandRunner, RootfsDownloader,
    StdCommandRunner, SystemCurlDownloader,
};
pub use state::{ProvisionStage, ProvisionState, STATE_SCHEMA_VERSION};

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    fn encode_utf16le(text: &str, with_bom: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        if with_bom {
            bytes.extend_from_slice(&[0xFF, 0xFE]);
        }
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn sha256_hex_bytes(data: &[u8]) -> String {
        let digest = Sha256::digest(data);
        let mut s = String::with_capacity(64);
        for b in digest {
            use std::fmt::Write as _;
            let _ = write!(&mut s, "{b:02x}");
        }
        s
    }

    #[derive(Debug, Clone)]
    struct RecordedCall {
        args: Vec<String>,
        stdin: Option<Vec<u8>>,
    }

    struct ScriptedRunner {
        responses: Mutex<VecDeque<Result<CommandOutput, std::io::Error>>>,
        recorded: Mutex<Vec<RecordedCall>>,
    }

    impl ScriptedRunner {
        fn new(responses: Vec<Result<CommandOutput, std::io::Error>>) -> Self {
            Self {
                responses: Mutex::new(VecDeque::from(responses)),
                recorded: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<RecordedCall> {
            self.recorded.lock().unwrap().clone()
        }
    }

    impl CommandRunner for ScriptedRunner {
        fn run(
            &self,
            cmd: &WslCommand,
            stdin: Option<&[u8]>,
        ) -> Result<CommandOutput, std::io::Error> {
            let args = cmd.args_lossy();
            // 全局红线守卫：任何测试路径中都不允许发出 --shutdown 或 --unregister
            assert!(
                !args.iter().any(|a| a.eq_ignore_ascii_case("--shutdown")),
                "严禁调用全局 wsl --shutdown: {args:?}"
            );
            assert!(
                !args.iter().any(|a| a.eq_ignore_ascii_case("--unregister")),
                "严禁调用 wsl --unregister: {args:?}"
            );
            self.recorded.lock().unwrap().push(RecordedCall {
                args: args.clone(),
                stdin: stdin.map(|b| b.to_vec()),
            });
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("测试桩未预期到的命令调用: {args:?}"))
        }
    }

    struct FakeDownloader {
        payload: Vec<u8>,
        calls: Mutex<usize>,
        fail_message: Option<String>,
    }

    impl FakeDownloader {
        fn ok(payload: Vec<u8>) -> Self {
            Self {
                payload,
                calls: Mutex::new(0),
                fail_message: None,
            }
        }

        fn call_count(&self) -> usize {
            *self.calls.lock().unwrap()
        }
    }

    impl RootfsDownloader for FakeDownloader {
        fn download(&self, url: &str, dest_file: &Path) -> Result<(), ProvisionError> {
            *self.calls.lock().unwrap() += 1;
            if let Some(msg) = &self.fail_message {
                return Err(ProvisionError::DownloadFailed {
                    url: url.to_string(),
                    reason: msg.clone(),
                });
            }
            fs::write(dest_file, &self.payload).map_err(|source| ProvisionError::Io {
                path: dest_file.to_path_buf(),
                source,
            })
        }
    }

    fn ok_out(stdout: Vec<u8>) -> Result<CommandOutput, std::io::Error> {
        Ok(CommandOutput {
            exit_code: 0,
            stdout,
            stderr: Vec::new(),
        })
    }

    fn err_out(exit_code: i32, stderr: Vec<u8>) -> Result<CommandOutput, std::io::Error> {
        Ok(CommandOutput {
            exit_code,
            stdout: Vec::new(),
            stderr,
        })
    }

    /// 模拟 `wsl --import` 在本应用安装目录里生成的 ext4.vhdx（测试桩的 --import 不落盘）。
    fn simulate_imported_vhdx(cfg: &ProvisionConfig) {
        fs::create_dir_all(cfg.distro_install_dir()).unwrap();
        fs::write(cfg.distro_vhdx_path(), b"fusa-vhdx").unwrap();
    }

    fn sample_ok_self_test_json() -> Vec<u8> {
        r#"{"ok":true,"worker_sandbox_ready":true,"error_code":null,"message":"WSL2 隔离与 bubblewrap 沙箱自检通过","checks":{"non_root":true,"no_passwordless_sudo":true,"interop_disabled":true,"windows_path_clean":true,"bwrap_probe":true,"bwrap_write_guard":true},"failures":[]}"#
            .as_bytes()
            .to_vec()
    }

    #[test]
    fn embedded_guest_script_is_present_and_valid_shebang() {
        assert!(EMBEDDED_GUEST_SCRIPT.starts_with("#!/usr/bin/env bash\n"));
        assert_eq!(PINNED_UBUNTU_2404_ROOTFS.version, "24.04.5");
        assert_eq!(PINNED_UBUNTU_2404_ROOTFS.sha256.len(), 64);
    }

    #[test]
    fn decode_and_parse_utf16le_chinese_and_english_wsl_outputs() {
        // 1) 简体中文无 BOM UTF-16LE `wsl --list --verbose`
        let zh_list = "  名称                   状态            版本\r\n* Ubuntu-24.04           正在运行        2\r\n  Fusa                   已停止          2\r\n  LegacyDistro           正在安装        1\r\n";
        let entries_no_bom = parse_wsl_list_verbose(&encode_utf16le(zh_list, false));
        assert_eq!(
            entries_no_bom,
            vec![
                WslDistroEntry {
                    name: "Ubuntu-24.04".to_string(),
                    state: WslDistroState::Running,
                    wsl_version: 2,
                    is_default: true,
                },
                WslDistroEntry {
                    name: "Fusa".to_string(),
                    state: WslDistroState::Stopped,
                    wsl_version: 2,
                    is_default: false,
                },
                WslDistroEntry {
                    name: "LegacyDistro".to_string(),
                    state: WslDistroState::Installing,
                    wsl_version: 1,
                    is_default: false,
                },
            ]
        );

        // 2) 英文带 BOM UTF-16LE + 法语多词状态行
        let mixed_list = "  NAME            STATE                    VERSION\r\n* Ubuntu          Running                  2\r\n  CustomBox       En cours d'exécution     2\r\n";
        let entries_with_bom = parse_wsl_list_verbose(&encode_utf16le(mixed_list, true));
        assert_eq!(entries_with_bom.len(), 2);
        assert_eq!(
            entries_with_bom[1],
            WslDistroEntry {
                name: "CustomBox".to_string(),
                state: WslDistroState::Other("En cours d'exécution".to_string()),
                wsl_version: 2,
                is_default: false,
            }
        );

        // 3) 尚未安装任何发行版时的中文与英文提示（不匹配任何提示词，自然返回空列表）
        let zh_empty = "适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n使用 'wsl.exe --list --online' 列出可用的分发版。\r\n";
        let en_empty = "Windows Subsystem for Linux has no installed distributions.\r\nUse 'wsl.exe --list --online' to list available distributions.\r\n";
        assert!(parse_wsl_list_verbose(&encode_utf16le(zh_empty, false)).is_empty());
        assert!(parse_wsl_list_verbose(&encode_utf16le(en_empty, true)).is_empty());

        // 4) 纯中文无 ASCII 无 BOM UTF-16LE 解码与 `wsl --version` 多语言版本提取
        assert_eq!(
            decode_wsl_output(&encode_utf16le("未安装子系统", false)),
            "未安装子系统"
        );
        let zh_ver = "WSL 版本： 2.3.26.0\r\n内核版本： 5.15.167.4-1\r\nWSLg 版本： 1.0.65\r\n";
        let ver_info = parse_wsl_version_output(0, &encode_utf16le(zh_ver, false)).unwrap();
        assert_eq!(ver_info.wsl_version, "2.3.26.0");
        assert!(parse_wsl_version_output(1, &encode_utf16le(zh_ver, false)).is_none());
    }

    #[test]
    fn command_builder_prevents_shell_injection_and_forbidden_flags() {
        let safe = build_exec_cmd(
            "Fusa",
            "fusa",
            FUSA_NODE_WSL_PATH,
            [
                "/home/fusa/projects/中文 空格; $(whoami)/main.ts",
                "--port",
                "4317",
            ],
        )
        .unwrap();
        assert_eq!(
            safe.args_lossy(),
            vec![
                "--distribution",
                "Fusa",
                "--user",
                "fusa",
                "--exec",
                "/home/fusa/.local/share/fusa/node/bin/node",
                "/home/fusa/projects/中文 空格; $(whoami)/main.ts",
                "--port",
                "4317",
            ]
        );

        // 严禁 sh -c / bash -c / env -c 动态拼接
        assert_eq!(
            build_exec_cmd("Fusa", "fusa", "/bin/sh", ["-c", "echo pwned"]),
            Err(CommandBuildError::ShellEvalForbidden)
        );
        assert_eq!(
            build_exec_cmd("Fusa", "fusa", "/usr/bin/bash", ["-lc", "id"]),
            Err(CommandBuildError::ShellEvalForbidden)
        );
        // 合写短选项簇同样拦住（-ec、-xc、-euc），env 转跳到 sh -c 也拦
        for flags in ["-ec", "-xc", "-euc", "-ce"] {
            assert_eq!(
                build_exec_cmd("Fusa", "fusa", "/bin/bash", [flags, "id"]),
                Err(CommandBuildError::ShellEvalForbidden),
                "{flags}"
            );
        }
        assert_eq!(
            build_exec_cmd("Fusa", "fusa", "/usr/bin/env", ["sh", "-c", "id"]),
            Err(CommandBuildError::ShellEvalForbidden)
        );
        // 普通脚本参数（如 --self-test、--phase）不受影响
        assert!(build_exec_cmd("Fusa", "fusa", "/bin/bash", ["/usr/local/libexec/fusa/x.sh", "--self-test"]).is_ok());
        // 严禁非绝对路径、非法用户名与危险 WSL 标志
        assert!(matches!(
            build_exec_cmd("Fusa", "fusa", "node", ["-v"]),
            Err(CommandBuildError::ProgramMustBeAbsolutePath(_))
        ));
        assert!(matches!(
            build_exec_cmd("Fusa", "RootUser!", "/bin/true", [""; 0]),
            Err(CommandBuildError::InvalidLinuxUser(_))
        ));
        assert_eq!(
            build_exec_cmd("Fusa", "fusa", "/bin/echo", ["--shutdown"]),
            Err(CommandBuildError::ForbiddenWslFlag("--shutdown".to_string()))
        );
        assert_eq!(
            build_exec_cmd("Fusa", "fusa", "/bin/echo", ["--unregister"]),
            Err(CommandBuildError::ForbiddenWslFlag("--unregister".to_string()))
        );
    }

    #[test]
    fn network_unc_paths_are_rejected_while_local_paths_pass() {
        assert!(matches!(
            validate_local_app_data_dir(Path::new(r"\\fileserver\share\Fusa")),
            Err(ProvisionError::NetworkPathNotSupported(_))
        ));
        assert!(matches!(
            validate_local_app_data_dir(Path::new(r"\\?\UNC\fileserver\share\Fusa")),
            Err(ProvisionError::NetworkPathNotSupported(_))
        ));
        assert!(matches!(
            validate_local_app_data_dir(Path::new("//nas/share/Fusa")),
            Err(ProvisionError::NetworkPathNotSupported(_))
        ));
        assert!(validate_local_app_data_dir(Path::new(r"C:\Users\Alice\AppData\Local\Fusa")).is_ok());
        assert!(validate_local_app_data_dir(Path::new(r"\\?\C:\Users\Alice\AppData\Local\Fusa")).is_ok());
    }

    #[test]
    fn name_conflict_guard_protects_existing_user_distro_without_marker() {
        let tmp = TempDir::new().unwrap();
        let cfg = ProvisionConfig::new(tmp.path());

        let zh_list_with_user_fusa =
            "  名称      状态        版本\r\n* Ubuntu    正在运行    2\r\n  fusa      已停止      2\r\n";
        let runner = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)), // --version
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),        // --status
            ok_out(encode_utf16le(zh_list_with_user_fusa, false)),   // --list --verbose
        ]);
        let downloader = FakeDownloader::ok(b"unused".to_vec());
        let provisioner = Provisioner::new(cfg, runner, downloader);

        let err = provisioner.provision_until_ready().unwrap_err();
        assert!(matches!(
            err,
            ProvisionError::DistroNameConflict { ref distro_name } if distro_name == "fusa"
        ));
        // 只执行了 3 条只读探测命令，绝未触碰用户已有发行版，也未下载镜像
        assert_eq!(provisioner.runner().calls().len(), 3);
        assert_eq!(provisioner.downloader().call_count(), 0);
    }

    #[test]
    fn full_lifecycle_from_missing_wsl_to_reboot_and_ready() {
        let tmp = TempDir::new().unwrap();
        let fake_rootfs = b"fake-ubuntu-24.04-wsl-rootfs-bytes".to_vec();
        let fake_sha = sha256_hex_bytes(&fake_rootfs);

        let mut cfg = ProvisionConfig::new(tmp.path());
        cfg.rootfs = PinnedRootfsImage {
            version: "24.04.5",
            filename: "ubuntu-test.wsl",
            // 静态生命周期测试辅助：此处直接复用常量 url，覆盖校验和即可
            url: PINNED_UBUNTU_2404_ROOTFS.url,
            sha256: Box::leak(fake_sha.into_boxed_str()),
            license: PINNED_UBUNTU_2404_ROOTFS.license,
        };
        cfg.guest_script = "#!/usr/bin/env bash\r\necho ok\r\n".to_string();

        // 1) 裸机未装 WSL -> 报 WslNotInstalled -> 触发安装保存 InstallWslPendingReboot -> 重启前报 RebootRequired
        let runner_before_reboot = ScriptedRunner::new(vec![
            err_out(-1, encode_utf16le("尚未安装", false)), // probe: --version
            err_out(-1, encode_utf16le("尚未安装", false)), // probe: --status
            ok_out(encode_utf16le("操作成功", false)),      // install_wsl_without_distro
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)), // 重启前 --version 虽有但 --status 失败
            err_out(-1, encode_utf16le("需要重启", false)),
        ]);
        let p1 = Provisioner::new(cfg.clone(), runner_before_reboot, FakeDownloader::ok(fake_rootfs.clone()));

        assert!(matches!(
            p1.provision_until_ready().unwrap_err(),
            ProvisionError::WslNotInstalled
        ));

        let st_pending = p1.install_wsl_without_distro().unwrap();
        assert_eq!(st_pending.stage, ProvisionStage::InstallWslPendingReboot);

        assert!(matches!(
            p1.provision_until_ready().unwrap_err(),
            ProvisionError::RebootRequired
        ));
        assert_eq!(
            p1.load_state().unwrap().stage,
            ProvisionStage::InstallWslPendingReboot
        );

        // 2) 用户重启 Windows 后再次打开：自动从 DownloadRootfs 完整推进到 Ready
        let runner_after_reboot = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)), // --version
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),        // --status
            ok_out(encode_utf16le(
                "适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n",
                false,
            )), // --list --verbose (空列表)
            ok_out(Vec::new()), // wsl --import Fusa ... --version 2
            ok_out(Vec::new()), // mkdir -p /usr/local/libexec/fusa
            ok_out(Vec::new()), // tee /usr/local/libexec/fusa/wsl-provision-guest.sh
            ok_out(Vec::new()), // chmod 0755 ...
            ok_out(Vec::new()), // wsl-provision-guest.sh --phase root
            ok_out(Vec::new()), // wsl --terminate Fusa
            ok_out(Vec::new()), // wsl-provision-guest.sh --phase user
            ok_out(sample_ok_self_test_json()), // wsl-provision-guest.sh --self-test
        ]);
        let p2 = Provisioner::new(cfg, runner_after_reboot, FakeDownloader::ok(fake_rootfs));
        let (final_state, report) = p2.provision_until_ready().unwrap();

        assert_eq!(final_state.stage, ProvisionStage::Ready);
        assert!(final_state.imported_by_fusa);
        assert!(final_state.self_test_passed);
        assert!(report.ok);
        assert!(report.worker_sandbox_ready);
        assert_eq!(p2.downloader().call_count(), 1);

        let calls = p2.runner().calls();
        // 验证通过 tee 写入的脚本已自动将 CRLF 规范化为 LF
        let tee_call = calls
            .iter()
            .find(|c| c.args.contains(&"/usr/bin/tee".to_string()))
            .expect("应通过 tee 写入 guest 脚本");
        assert_eq!(
            std::str::from_utf8(tee_call.stdin.as_deref().unwrap()).unwrap(),
            "#!/usr/bin/env bash\necho ok\n"
        );
        // 验证只单实例重启了 Fusa
        assert!(calls
            .iter()
            .any(|c| c.args == vec!["--terminate", "Fusa"]));
    }

    #[test]
    fn checksum_mismatch_rejects_corrupted_rootfs_and_cleans_up() {
        let tmp = TempDir::new().unwrap();
        let cfg = ProvisionConfig::new(tmp.path());
        let runner = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le(
                "适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n",
                false,
            )),
        ]);
        let corrupted = FakeDownloader::ok(b"corrupted-archive-data".to_vec());
        let provisioner = Provisioner::new(cfg.clone(), runner, corrupted);

        let err = provisioner.provision_until_ready().unwrap_err();
        assert!(matches!(err, ProvisionError::ChecksumMismatch { .. }));
        assert!(!cfg.cached_rootfs_path().exists());
        assert!(!provisioner.load_state().unwrap().imported_by_fusa);
    }

    #[test]
    fn resume_after_midway_failure_skips_reimport_and_enforces_self_test_gate() {
        let tmp = TempDir::new().unwrap();
        let fake_rootfs = b"verified-ubuntu-rootfs".to_vec();
        let fake_sha = sha256_hex_bytes(&fake_rootfs);

        let mut cfg = ProvisionConfig::new(tmp.path());
        cfg.rootfs = PinnedRootfsImage {
            version: "24.04.5",
            filename: "ubuntu-resume.wsl",
            url: PINNED_UBUNTU_2404_ROOTFS.url,
            sha256: Box::leak(fake_sha.into_boxed_str()),
            license: PINNED_UBUNTU_2404_ROOTFS.license,
        };

        // 第 1 轮：成功导入，但在 InitRoot 阶段 apt 网络波动失败（退出码 100）
        let runner_fail_init_root = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le("没有已安装的分发版\r\n", false)),
            ok_out(Vec::new()), // --import 成功！
            ok_out(Vec::new()), // mkdir
            ok_out(Vec::new()), // tee
            ok_out(Vec::new()), // chmod
            err_out(100, b"apt-get network timeout".to_vec()), // --phase root 失败
        ]);
        let p1 = Provisioner::new(
            cfg.clone(),
            runner_fail_init_root,
            FakeDownloader::ok(fake_rootfs.clone()),
        );
        let err1 = p1.provision_until_ready().unwrap_err();
        assert!(matches!(
            err1,
            ProvisionError::CommandFailed {
                stage: "init_root",
                exit_code: 100,
                ..
            }
        ));
        let st_after_fail = p1.load_state().unwrap();
        assert!(st_after_fail.imported_by_fusa);
        assert_eq!(st_after_fail.stage, ProvisionStage::InitRoot);
        simulate_imported_vhdx(&cfg);

        // 第 2 轮：断点续跑！列表中已有 Fusa -> 识别为本应用导入（不报冲突、不重跑 --import、不重新下载），
        // 但在 --self-test 阶段检测到 interop 未关 -> 拒绝进入 Ready！
        let failed_self_test = r#"{"ok":false,"worker_sandbox_ready":false,"error_code":"interop_binfmt_enabled","message":"WSL interop 仍处于开启状态","checks":{"non_root":true,"no_passwordless_sudo":true,"interop_disabled":false,"windows_path_clean":true,"bwrap_probe":true,"bwrap_write_guard":true},"failures":[{"code":"interop_binfmt_enabled","detail":"WSLInterop enabled"}]}"#
            .as_bytes()
            .to_vec();

        let runner_fail_gate = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le(
                "  名称    状态      版本\r\n  Fusa    已停止    2\r\n",
                false,
            )),
            ok_out(Vec::new()), // mkdir
            ok_out(Vec::new()), // tee
            ok_out(Vec::new()), // chmod
            ok_out(Vec::new()), // --phase root 成功
            ok_out(Vec::new()), // --terminate Fusa
            ok_out(Vec::new()), // --phase user 成功
            Ok(CommandOutput {
                exit_code: 1,
                stdout: failed_self_test,
                stderr: Vec::new(),
            }),
        ]);
        let p2 = Provisioner::new(
            cfg.clone(),
            runner_fail_gate,
            FakeDownloader::ok(fake_rootfs.clone()),
        );
        let err2 = p2.provision_until_ready().unwrap_err();
        assert!(matches!(
            err2,
            ProvisionError::SelfTestFailed { ref code, .. } if code == "interop_binfmt_enabled"
        ));
        assert_eq!(p2.downloader().call_count(), 0);
        assert!(!p2
            .runner()
            .calls()
            .iter()
            .any(|c| c.args.contains(&"--import".to_string())));

        let st_gate_blocked = p2.load_state().unwrap();
        assert_eq!(st_gate_blocked.stage, ProvisionStage::InitUserAndSelfTest);
        assert!(!st_gate_blocked.self_test_passed);

        // 第 3 轮：修复后再次续跑，直接从 InitUserAndSelfTest 通过并进入 Ready！
        let runner_pass = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le(
                "  名称    状态        版本\r\n  Fusa    正在运行    2\r\n",
                false,
            )),
            ok_out(Vec::new()),                 // --phase user
            ok_out(sample_ok_self_test_json()), // --self-test 通过
        ]);
        let p3 = Provisioner::new(cfg, runner_pass, FakeDownloader::ok(fake_rootfs));
        let (st_ready, _) = p3.provision_until_ready().unwrap();
        assert_eq!(st_ready.stage, ProvisionStage::Ready);
        assert!(st_ready.self_test_passed);
    }

    #[test]
    fn vendor_guides_are_parsed_generically_without_hardcoded_vendor_names() {
        let tmp = TempDir::new().unwrap();
        let cfg = ProvisionConfig::new(tmp.path());
        let json_payload = br#"[{"id":"alpha","command":"alpha-cli","install_command":"curl -fsSL https://example.com/install.sh | bash","login_command":"alpha-cli auth","installed":true,"binary_path":"/home/fusa/.local/bin/alpha-cli"},{"id":"beta","command":"beta-cli","install_command":"","login_command":"beta-cli login --device","installed":false,"binary_path":null}]"#.to_vec();

        let runner = ScriptedRunner::new(vec![ok_out(json_payload)]);
        let provisioner = Provisioner::new(cfg, runner, FakeDownloader::ok(Vec::new()));
        let guides = provisioner
            .query_vendor_guides("/home/fusa/.local/share/fusa/releases/current")
            .unwrap();

        assert_eq!(guides.len(), 2);
        assert_eq!(guides[0].id, "alpha");
        assert!(guides[0].installed);
        assert_eq!(
            guides[0].binary_path.as_deref(),
            Some("/home/fusa/.local/bin/alpha-cli")
        );
        assert_eq!(guides[1].id, "beta");
        assert!(!guides[1].installed);

        let tsv = "gamma\tgamma-bin\tnpm i -g gamma\tgamma-bin login\n";
        let from_tsv = parse_vendor_guides_tsv(tsv);
        assert_eq!(from_tsv.len(), 1);
        assert_eq!(from_tsv[0].command, "gamma-bin");
    }

    #[test]
    fn cached_rootfs_is_reused_when_valid_and_redownloaded_when_corrupted() {
        let tmp = TempDir::new().unwrap();
        let valid_bytes = b"valid-cached-rootfs".to_vec();
        let valid_sha = sha256_hex_bytes(&valid_bytes);

        let mut cfg = ProvisionConfig::new(tmp.path());
        cfg.rootfs = PinnedRootfsImage {
            version: "24.04.5",
            filename: "cached.wsl",
            url: PINNED_UBUNTU_2404_ROOTFS.url,
            sha256: Box::leak(valid_sha.into_boxed_str()),
            license: PINNED_UBUNTU_2404_ROOTFS.license,
        };

        // 预先放入校验正确的缓存镜像，验证 0 次网络下载直接完成导入与准备
        fs::create_dir_all(cfg.rootfs_cache_dir()).unwrap();
        fs::write(cfg.cached_rootfs_path(), &valid_bytes).unwrap();

        let runner = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le("没有已安装的分发版\r\n", false)),
            ok_out(Vec::new()), // --import
            ok_out(Vec::new()), // mkdir
            ok_out(Vec::new()), // tee
            ok_out(Vec::new()), // chmod
            ok_out(Vec::new()), // --phase root
            ok_out(Vec::new()), // --terminate Fusa
            ok_out(Vec::new()), // --phase user
            ok_out(sample_ok_self_test_json()),
        ]);
        let provisioner = Provisioner::new(cfg, runner, FakeDownloader::ok(valid_bytes));
        let (state, _) = provisioner.provision_until_ready().unwrap();
        assert_eq!(state.stage, ProvisionStage::Ready);
        assert_eq!(provisioner.downloader().call_count(), 0);
    }

    #[test]
    fn protects_residual_vhdx_and_downgraded_wsl1_and_ready_regression() {
        // 1) 未登记导入但 distro 目录存在残留 ext4.vhdx 时拒绝覆盖
        let tmp1 = TempDir::new().unwrap();
        let cfg1 = ProvisionConfig::new(tmp1.path());
        fs::create_dir_all(cfg1.distro_install_dir()).unwrap();
        fs::write(cfg1.distro_install_dir().join("ext4.vhdx"), b"user-data").unwrap();
        let r1 = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le("没有已安装的分发版\r\n", false)),
        ]);
        let p1 = Provisioner::new(cfg1, r1, FakeDownloader::ok(Vec::new()));
        assert!(matches!(
            p1.provision_until_ready().unwrap_err(),
            ProvisionError::ExistingDistroDataFound { .. }
        ));

        // 2) 已登记实例若处于 WSL 1 则拒绝运行；已处于 Ready 的实例若后续自检失败则回退到 InitUserAndSelfTest
        let tmp2 = TempDir::new().unwrap();
        let cfg2 = ProvisionConfig::new(tmp2.path());
        let mut ready_state = ProvisionState::new("Fusa");
        ready_state.imported_by_fusa = true;
        ready_state.self_test_passed = true;
        ready_state.stage = ProvisionStage::Ready;
        ready_state.save_atomic(tmp2.path()).unwrap();
        simulate_imported_vhdx(&cfg2);

        let r_wsl1 = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le("  Fusa    Stopped    1\r\n", false)),
        ]);
        let p_wsl1 = Provisioner::new(cfg2.clone(), r_wsl1, FakeDownloader::ok(Vec::new()));
        assert!(matches!(
            p_wsl1.provision_until_ready().unwrap_err(),
            ProvisionError::UnsupportedWslVersion { version: 1, .. }
        ));

        let broken_gate = r#"{"ok":false,"worker_sandbox_ready":false,"error_code":"bwrap_unavailable","message":"bwrap 不可用","checks":{"non_root":true,"no_passwordless_sudo":true,"interop_disabled":true,"windows_path_clean":true,"bwrap_probe":false,"bwrap_write_guard":false},"failures":[{"code":"bwrap_unavailable","detail":"missing"}]}"#
            .as_bytes()
            .to_vec();
        let r_regressed = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le("  Fusa    Running    2\r\n", false)),
            Ok(CommandOutput {
                exit_code: 1,
                stdout: broken_gate,
                stderr: Vec::new(),
            }),
        ]);
        let p_regressed = Provisioner::new(cfg2, r_regressed, FakeDownloader::ok(Vec::new()));
        assert!(matches!(
            p_regressed.provision_until_ready().unwrap_err(),
            ProvisionError::SelfTestFailed { ref code, .. } if code == "bwrap_unavailable"
        ));
        let rolled_back = p_regressed.load_state().unwrap();
        assert_eq!(rolled_back.stage, ProvisionStage::InitUserAndSelfTest);
        assert!(!rolled_back.self_test_passed);
    }

    #[test]
    fn residual_state_marker_without_our_vhdx_never_touches_user_owned_same_name_distro() {
        // 之前装过 Fusa（状态标记 imported_by_fusa=true 且已 Ready），后来用户 `wsl --unregister` 掉（vhdx 随之删除），
        // 又自己建了个同名 Fusa：只剩半截状态标记，必须报冲突，不跑任何会改写或终止它的命令。
        for stage in [
            ProvisionStage::InitRoot,
            ProvisionStage::RestartDistro,
            ProvisionStage::InitUserAndSelfTest,
            ProvisionStage::Ready,
        ] {
            let tmp = TempDir::new().unwrap();
            let cfg = ProvisionConfig::new(tmp.path());
            let mut residual = ProvisionState::new("Fusa");
            residual.imported_by_fusa = true;
            residual.self_test_passed = stage == ProvisionStage::Ready;
            residual.stage = stage;
            residual.save_atomic(tmp.path()).unwrap();
            fs::create_dir_all(cfg.distro_install_dir()).unwrap(); // 目录还在，但没有 ext4.vhdx

            let runner = ScriptedRunner::new(vec![
                ok_out(encode_utf16le("WSL バージョン: 2.3.26.0\r\n", false)),
                ok_out(encode_utf16le("既定のバージョン: 2\r\n", false)),
                ok_out(encode_utf16le(
                    "  名前      状態      バージョン\r\n* Fusa      実行中    2\r\n",
                    false,
                )),
            ]);
            let p = Provisioner::new(cfg, runner, FakeDownloader::ok(Vec::new()));
            assert!(
                matches!(
                    p.provision_until_ready().unwrap_err(),
                    ProvisionError::DistroNameConflict { ref distro_name } if distro_name == "Fusa"
                ),
                "{stage:?}"
            );
            // 只有 3 条只读探测，没有 tee / --phase root / --terminate / --self-test
            assert_eq!(p.runner().calls().len(), 3, "{stage:?}");
            assert_eq!(p.downloader().call_count(), 0);
            // 状态标记原样保留（不被改写成别的阶段）
            assert_eq!(p.load_state().unwrap(), residual);
        }
    }

    #[test]
    fn list_parser_never_panics_on_truncated_odd_utf16_crlf_lf_and_japanese_output() {
        let ja_list = "  名前            状態            バージョン\r\n* Ubuntu          実行中          2\r\n  Fusa            停止            2\r\n";
        let full = encode_utf16le(ja_list, false);
        let entries = parse_wsl_list_verbose(&full);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].state, WslDistroState::Running);
        assert!(entries[0].is_default);
        assert_eq!(entries[1].name, "Fusa");
        assert_eq!(entries[1].state, WslDistroState::Stopped);

        // 任意位置截断（含奇数字节、切在多字节字符中间）与只用 LF 换行都不 panic
        for cut in 0..=full.len() {
            let _ = parse_wsl_list_verbose(&full[..cut]);
            let _ = decode_wsl_output(&full[..cut]);
        }
        let utf8 = ja_list.replace("\r\n", "\n");
        for cut in 0..=utf8.len() {
            let _ = parse_wsl_list_verbose(&utf8.as_bytes()[..cut]);
        }
        assert_eq!(parse_wsl_list_verbose(utf8.as_bytes()), entries);
        // 只有 * 号、只有一列、全是空白等畸形行直接跳过
        assert!(parse_wsl_list_verbose(&encode_utf16le("*\r\n  2\r\n Fusa\r\n   \r\n* 2\n", true)).is_empty());
    }

    #[test]
    fn stale_partial_download_is_replaced_not_accumulated() {
        let tmp = TempDir::new().unwrap();
        let payload = b"rootfs-after-crash".to_vec();
        let mut cfg = ProvisionConfig::new(tmp.path());
        cfg.rootfs = PinnedRootfsImage {
            version: "24.04.5",
            filename: "ubuntu-part.wsl",
            url: PINNED_UBUNTU_2404_ROOTFS.url,
            sha256: Box::leak(sha256_hex_bytes(&payload).into_boxed_str()),
            license: PINNED_UBUNTU_2404_ROOTFS.license,
        };
        fs::create_dir_all(cfg.rootfs_cache_dir()).unwrap();
        fs::write(cfg.rootfs_cache_dir().join("ubuntu-part.wsl.part"), b"half-downloaded").unwrap();

        let runner = ScriptedRunner::new(vec![
            ok_out(encode_utf16le("WSL 版本: 2.3.26.0\r\n", false)),
            ok_out(encode_utf16le("默认版本: 2\r\n", false)),
            ok_out(encode_utf16le("没有已安装的分发版\r\n", false)),
            err_out(1, b"import failed".to_vec()),
        ]);
        let p = Provisioner::new(cfg.clone(), runner, FakeDownloader::ok(payload.clone()));
        assert!(p.provision_until_ready().is_err());
        let names: Vec<String> = fs::read_dir(cfg.rootfs_cache_dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["ubuntu-part.wsl".to_string()]);
        assert_eq!(fs::read(cfg.cached_rootfs_path()).unwrap(), payload);
    }
}
