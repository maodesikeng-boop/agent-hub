use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use crate::command::{
    build_chmod_daemon_ctl_cmd, build_chmod_guest_script_cmd, build_exec_cmd,
    build_import_distro_cmd, build_install_wsl_no_distro_cmd, build_list_verbose_cmd,
    build_prepare_guest_script_dir_cmd, build_run_guest_script_cmd, build_status_cmd,
    build_terminate_distro_cmd, build_version_cmd, build_write_daemon_ctl_cmd,
    build_write_guest_script_cmd, WslCommand,
};
use crate::constants::{
    DISTRO_INSTALL_SUBDIR, DISTRO_VHDX_FILENAME, EMBEDDED_GUEST_SCRIPT, FUSA_DISTRO_NAME, FUSA_LINUX_USER,
    LXSS_REGISTRY_SUBKEY, PINNED_UBUNTU_2404_ROOTFS, PinnedRootfsImage, ROOTFS_CACHE_SUBDIR,
};
use crate::error::{ProvisionError, SelfTestReport};
use crate::parser::{
    decode_wsl_output, parse_self_test_report, parse_vendor_guides_json, parse_wsl_list_verbose,
    parse_wsl_version_output, VendorGuideEntry, WslDistroEntry, WslVersionInfo,
};
use crate::registry::{
    windows_base_paths_match, DistroRegistryInspector, RegistryLookup, SystemRegistryInspector,
};
use crate::runner::{
    verify_file_sha256, CommandOutput, CommandRunner, RootfsDownloader, StdCommandRunner,
    SystemCurlDownloader,
};
use crate::state::{ProvisionStage, ProvisionState};

/// 宿主 WSL 环境结构化探测结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslHostStatus {
    /// 未安装或未启用 WSL 组件。
    NotInstalled,
    /// 已安装 WSL 组件但内核/虚拟化尚未就绪（例如尚未重启或 BIOS 未开虚拟化）。
    KernelNotReady {
        version: Option<WslVersionInfo>,
        status_exit_code: i32,
    },
    /// WSL2 内核可用，附带当前已安装的发行版列表。
    Available {
        version: Option<WslVersionInfo>,
        distros: Vec<WslDistroEntry>,
    },
}

/// 准备器配置（所有路径与锁定镜像集中配置，支持在测试中覆盖）。
#[derive(Debug, Clone)]
pub struct ProvisionConfig {
    /// 当前用户的本地应用数据目录（不能位于 UNC 网络盘）。
    pub app_data_dir: PathBuf,
    /// 专用 WSL2 发行版名称（默认 `"Fusa"`）。
    pub distro_name: String,
    /// 发行版内日常非特权用户名（默认 `"fusa"`）。
    pub linux_user: String,
    /// 锁定的官方 Ubuntu 24.04 WSL rootfs 镜像元数据。
    pub rootfs: PinnedRootfsImage,
    /// 注入发行版执行的幂等初始化与隔离自检脚本内容。
    pub guest_script: String,
}

impl ProvisionConfig {
    pub fn new(app_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            app_data_dir: app_data_dir.into(),
            distro_name: FUSA_DISTRO_NAME.to_string(),
            linux_user: FUSA_LINUX_USER.to_string(),
            rootfs: PINNED_UBUNTU_2404_ROOTFS,
            guest_script: EMBEDDED_GUEST_SCRIPT.to_string(),
        }
    }

    pub fn distro_install_dir(&self) -> PathBuf {
        self.app_data_dir.join(DISTRO_INSTALL_SUBDIR)
    }

    /// 本应用导入的发行版磁盘文件路径（判断同名实例是不是本应用的依据之一）。
    pub fn distro_vhdx_path(&self) -> PathBuf {
        self.distro_install_dir().join(DISTRO_VHDX_FILENAME)
    }

    pub fn rootfs_cache_dir(&self) -> PathBuf {
        self.app_data_dir.join(ROOTFS_CACHE_SUBDIR)
    }

    pub fn cached_rootfs_path(&self) -> PathBuf {
        self.rootfs_cache_dir().join(self.rootfs.filename)
    }
}

/// 校验安装目录不是 Windows UNC / 网络盘路径（设计文档 2.1 第 3 条要求）。
/// 允许本地盘符路径（`C:\...`）、本地长路径（`\\?\C:\...`）及非 Windows 本地路径（`/Users/...`）。
pub fn validate_local_app_data_dir(path: &Path) -> Result<(), ProvisionError> {
    let raw = path.to_string_lossy();
    let lower = raw.to_ascii_lowercase();

    if lower.starts_with(r"\\?\unc\") || lower.starts_with("//?/unc/") {
        return Err(ProvisionError::NetworkPathNotSupported(path.to_path_buf()));
    }

    if let Some(after_verbatim) = raw.strip_prefix(r"\\?\") {
        let bytes = after_verbatim.as_bytes();
        let is_local_drive = bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':';
        if !is_local_drive {
            return Err(ProvisionError::NetworkPathNotSupported(path.to_path_buf()));
        }
        return Ok(());
    }

    if raw.starts_with(r"\\") || raw.starts_with("//") {
        return Err(ProvisionError::NetworkPathNotSupported(path.to_path_buf()));
    }

    Ok(())
}

/// WSL2 专用发行版准备与隔离验证编排器。
pub struct Provisioner<
    R = StdCommandRunner,
    D = SystemCurlDownloader,
    G = SystemRegistryInspector,
> {
    config: ProvisionConfig,
    runner: R,
    downloader: D,
    registry: G,
}

impl Provisioner<StdCommandRunner, SystemCurlDownloader, SystemRegistryInspector> {
    pub fn with_defaults(config: ProvisionConfig) -> Self {
        Self {
            config,
            runner: StdCommandRunner,
            downloader: SystemCurlDownloader,
            registry: SystemRegistryInspector,
        }
    }
}

impl<R, D> Provisioner<R, D, SystemRegistryInspector>
where
    R: CommandRunner,
    D: RootfsDownloader,
{
    pub fn new(config: ProvisionConfig, runner: R, downloader: D) -> Self {
        Self {
            config,
            runner,
            downloader,
            registry: SystemRegistryInspector,
        }
    }
}

impl<R, D, G> Provisioner<R, D, G>
where
    R: CommandRunner,
    D: RootfsDownloader,
    G: DistroRegistryInspector,
{
    pub fn with_registry_inspector(
        config: ProvisionConfig,
        runner: R,
        downloader: D,
        registry: G,
    ) -> Self {
        Self {
            config,
            runner,
            downloader,
            registry,
        }
    }

    pub fn config(&self) -> &ProvisionConfig {
        &self.config
    }

    pub fn runner(&self) -> &R {
        &self.runner
    }

    pub fn downloader(&self) -> &D {
        &self.downloader
    }

    pub fn registry(&self) -> &G {
        &self.registry
    }

    pub fn load_state(&self) -> Result<ProvisionState, ProvisionError> {
        validate_local_app_data_dir(&self.config.app_data_dir)?;
        ProvisionState::load_or_default(&self.config.app_data_dir, &self.config.distro_name)
    }

    /// 核对 Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` 下的 `BasePath` 是否指向本应用专属目录。
    pub fn verify_registry_base_path(&self, distro_name: &str) -> Result<(), ProvisionError> {
        let lookup = self
            .registry
            .lookup_distro_base_path(distro_name)
            .map_err(|source| ProvisionError::Io {
                path: PathBuf::from(LXSS_REGISTRY_SUBKEY),
                source,
            })?;
        let expected = self.config.distro_install_dir();
        match lookup {
            RegistryLookup::UnsupportedPlatform => Ok(()),
            RegistryLookup::NotFound => Err(ProvisionError::DistroBasePathMismatch {
                distro_name: distro_name.to_string(),
                expected,
                actual: "<HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss 未找到同名项>"
                    .to_string(),
            }),
            RegistryLookup::Found { base_path } => {
                if windows_base_paths_match(&expected, &base_path) {
                    Ok(())
                } else {
                    Err(ProvisionError::DistroBasePathMismatch {
                        distro_name: distro_name.to_string(),
                        expected,
                        actual: base_path.display().to_string(),
                    })
                }
            }
        }
    }

    /// 供运行期监管器（`fusa-supervisor`）在每次起停或读取敏感文件前复核三重归属（状态标记 + `ext4.vhdx` + `Lxss` 注册表 `BasePath`）。
    pub fn verify_distro_ownership(&self) -> Result<(), ProvisionError> {
        let state = self.load_state()?;
        if !state.imported_by_fusa || !self.config.distro_vhdx_path().is_file() {
            return Err(ProvisionError::DistroNameConflict {
                distro_name: self.config.distro_name.clone(),
            });
        }
        self.verify_registry_base_path(&self.config.distro_name)
    }

    fn run_wsl(
        &self,
        cmd: &WslCommand,
        stdin: Option<&[u8]>,
    ) -> Result<CommandOutput, ProvisionError> {
        self.runner
            .run(cmd, stdin)
            .map_err(|source| ProvisionError::SpawnFailed {
                program: cmd.program.to_string_lossy().into_owned(),
                source,
            })
    }

    /// 按退出码与结构化列探测宿主 WSL2 状态，绝不匹配英文报错文本。
    pub fn probe_wsl_host(&self) -> Result<WslHostStatus, ProvisionError> {
        let ver_cmd = build_version_cmd()?;
        let version_res = match self.runner.run(&ver_cmd, None) {
            Ok(out) => out,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(WslHostStatus::NotInstalled),
            Err(source) => {
                return Err(ProvisionError::SpawnFailed {
                    program: ver_cmd.program.to_string_lossy().into_owned(),
                    source,
                });
            }
        };
        let version_info = parse_wsl_version_output(version_res.exit_code, &version_res.stdout);

        let status_cmd = build_status_cmd()?;
        let status_res = self.run_wsl(&status_cmd, None)?;

        if status_res.exit_code != 0 {
            if version_res.exit_code != 0 {
                return Ok(WslHostStatus::NotInstalled);
            }
            return Ok(WslHostStatus::KernelNotReady {
                version: version_info,
                status_exit_code: status_res.exit_code,
            });
        }

        let list_cmd = build_list_verbose_cmd()?;
        let list_res = self.run_wsl(&list_cmd, None)?;
        if list_res.exit_code == 0 {
            let distros = parse_wsl_list_verbose(&list_res.stdout);
            return Ok(WslHostStatus::Available {
                version: version_info,
                distros,
            });
        }

        // 部分版本 WSL 在尚未安装任何发行版时 `--list --verbose` 返回非 0 退出码。
        // 为防误判漏掉同名实例，按退出码探测目标发行版是否可响应 `/bin/true`。
        let probe_target = build_exec_cmd(&self.config.distro_name, "root", "/bin/true", [""; 0])?;
        let target_res = self.run_wsl(&probe_target, None)?;
        if target_res.exit_code == 0 {
            return Err(ProvisionError::CommandFailed {
                stage: "list_distros",
                exit_code: list_res.exit_code,
                stderr: decode_wsl_output(&list_res.stderr),
            });
        }

        Ok(WslHostStatus::Available {
            version: version_info,
            distros: Vec::new(),
        })
    }

    /// 在确认缺少 WSL 组件后触发 `wsl.exe --install --no-distribution` 并保存 `InstallWslPendingReboot` 状态标记。
    pub fn install_wsl_without_distro(&self) -> Result<ProvisionState, ProvisionError> {
        validate_local_app_data_dir(&self.config.app_data_dir)?;
        let mut state = self.load_state()?;
        let install_cmd = build_install_wsl_no_distro_cmd()?;
        let out = self.run_wsl(&install_cmd, None)?;
        if out.exit_code != 0 {
            let err_msg = non_empty_error_text(&out);
            state.last_error = Some(err_msg.clone());
            state.save_atomic(&self.config.app_data_dir)?;
            return Err(ProvisionError::CommandFailed {
                stage: ProvisionStage::InstallWslPendingReboot.as_str(),
                exit_code: out.exit_code,
                stderr: err_msg,
            });
        }
        state.stage = ProvisionStage::InstallWslPendingReboot;
        state.last_error = None;
        state.save_atomic(&self.config.app_data_dir)?;
        Ok(state)
    }

    /// 推进完整准备状态机直至 `ProvisionStage::Ready`（支持断点续跑、同名冲突保护、SHA256 校验与自检门禁）。
    pub fn provision_until_ready(&self) -> Result<(ProvisionState, SelfTestReport), ProvisionError> {
        validate_local_app_data_dir(&self.config.app_data_dir)?;
        let mut state = self.load_state()?;

        // 阶段 1 & 2：检查 WSL 可用性与同名发行版冲突保护
        let distros = match self.probe_wsl_host()? {
            WslHostStatus::NotInstalled => {
                if state.stage == ProvisionStage::InstallWslPendingReboot {
                    return Err(ProvisionError::RebootRequired);
                }
                state.stage = ProvisionStage::CheckWsl;
                state.save_atomic(&self.config.app_data_dir)?;
                return Err(ProvisionError::WslNotInstalled);
            }
            WslHostStatus::KernelNotReady {
                status_exit_code, ..
            } => {
                if state.stage == ProvisionStage::InstallWslPendingReboot {
                    return Err(ProvisionError::RebootRequired);
                }
                return Err(ProvisionError::KernelOrVirtualizationNotReady {
                    exit_code: status_exit_code,
                });
            }
            WslHostStatus::Available { distros, .. } => distros,
        };

        let existing_distro = distros
            .iter()
            .find(|d| d.name.eq_ignore_ascii_case(&self.config.distro_name));

        if let Some(found) = existing_distro {
            // 同名实例要同时满足两条才认作本应用的：状态标记登记过导入，且本应用安装目录里确有 `wsl --import` 生成的 ext4.vhdx。
            // 用户 `wsl --unregister` 掉我们的实例会连 vhdx 一起删，之后再自建同名 Fusa 时只剩半截状态标记：
            // 这时必须报冲突停止，不跑 root 初始化、不改它的 /etc/wsl.conf、不 --terminate 它。
            if !state.imported_by_fusa || !self.config.distro_vhdx_path().is_file() {
                return Err(ProvisionError::DistroNameConflict {
                    distro_name: found.name.clone(),
                });
            }
            self.verify_registry_base_path(&found.name)?;
            if found.wsl_version != 2 {
                return Err(ProvisionError::UnsupportedWslVersion {
                    distro_name: found.name.clone(),
                    version: found.wsl_version,
                });
            }
            // 本应用之前已成功导入，从当前阶段继续（若阶段早于 InitRoot 则推进到 InitRoot）
            if state.stage < ProvisionStage::InitRoot {
                state.stage = ProvisionStage::InitRoot;
                state.save_atomic(&self.config.app_data_dir)?;
            }
        } else {
            // WSL 列表中没有 Fusa：检查安装目录是否已有未登记的磁盘数据（绝不自动删除或覆盖）
            let distro_dir = self.config.distro_install_dir();
            if directory_has_files(&distro_dir)? {
                return Err(ProvisionError::ExistingDistroDataFound { distro_dir });
            }
            // 若之前曾登记导入但用户外部手动注销且目录为空，安全回退到下载/导入阶段
            state.imported_by_fusa = false;
            state.self_test_passed = false;
            state.stage = ProvisionStage::DownloadRootfs;
            state.save_atomic(&self.config.app_data_dir)?;
        }

        // 阶段 3：下载并 SHA256 校验官方 Ubuntu 24.04 rootfs 镜像
        if state.stage <= ProvisionStage::DownloadRootfs {
            self.step_download_and_verify_rootfs(&mut state)?;
        }

        // 阶段 4：`wsl --import Fusa <distro_dir> <rootfs> --version 2`
        if state.stage == ProvisionStage::ImportDistro {
            self.step_import_distro(&mut state)?;
        }

        // 阶段 5：发行版内 root 初始化普通用户 fusa、/etc/wsl.conf、依赖与 AppArmor
        if state.stage == ProvisionStage::InitRoot {
            self.step_init_root(&mut state)?;
        }

        // 阶段 6：单实例 `wsl --terminate Fusa` 使 `/etc/wsl.conf` 生效（严禁全局 `wsl --shutdown`）
        if state.stage == ProvisionStage::RestartDistro {
            self.step_restart_single_distro(&mut state)?;
        }

        // 阶段 7 & 8：普通用户 fusa 初始化与隔离自检门禁 -> Ready
        let report = if state.stage == ProvisionStage::InitUserAndSelfTest {
            self.step_init_user_and_self_test(&mut state)?
        } else {
            // 已处于 Ready 时执行一次自检门禁确认隔离未被外部手改破坏
            match self.run_self_test_gate() {
                Ok(report) => report,
                Err(err) => {
                    state.self_test_passed = false;
                    state.stage = ProvisionStage::InitUserAndSelfTest;
                    state.last_error = Some(err.to_string());
                    state.save_atomic(&self.config.app_data_dir)?;
                    return Err(err);
                }
            }
        };

        Ok((state, report))
    }

    fn step_download_and_verify_rootfs(
        &self,
        state: &mut ProvisionState,
    ) -> Result<(), ProvisionError> {
        let cache_dir = self.config.rootfs_cache_dir();
        fs::create_dir_all(&cache_dir).map_err(|source| ProvisionError::Io {
            path: cache_dir.clone(),
            source,
        })?;
        let target_path = self.config.cached_rootfs_path();

        let reuse_existing = if target_path.exists() {
            match verify_file_sha256(&target_path, self.config.rootfs.sha256) {
                Ok(()) => true,
                Err(_) => {
                    let _ = fs::remove_file(&target_path);
                    false
                }
            }
        } else {
            false
        };

        if !reuse_existing {
            // 固定临时文件名：上次下载中途崩溃留下的几百 MB 半截文件在这里先删掉，不会按进程号越积越多
            let part_path = cache_dir.join(format!("{}.part", self.config.rootfs.filename));
            let _ = fs::remove_file(&part_path);
            if let Err(err) = self.downloader.download(self.config.rootfs.url, &part_path) {
                let _ = fs::remove_file(&part_path);
                state.last_error = Some(err.to_string());
                state.save_atomic(&self.config.app_data_dir)?;
                return Err(err);
            }

            if let Err(err) = verify_file_sha256(&part_path, self.config.rootfs.sha256) {
                let _ = fs::remove_file(&part_path);
                state.last_error = Some(err.to_string());
                state.save_atomic(&self.config.app_data_dir)?;
                return Err(err);
            }

            if let Err(source) = fs::rename(&part_path, &target_path) {
                let _ = fs::remove_file(&part_path);
                return Err(ProvisionError::Io {
                    path: target_path.clone(),
                    source,
                });
            }
        }

        state.rootfs_version = Some(self.config.rootfs.version.to_string());
        state.rootfs_sha256 = Some(self.config.rootfs.sha256.to_string());
        state.stage = ProvisionStage::ImportDistro;
        state.last_error = None;
        state.save_atomic(&self.config.app_data_dir)?;
        Ok(())
    }

    fn step_import_distro(&self, state: &mut ProvisionState) -> Result<(), ProvisionError> {
        let distro_dir = self.config.distro_install_dir();
        fs::create_dir_all(&distro_dir).map_err(|source| ProvisionError::Io {
            path: distro_dir.clone(),
            source,
        })?;
        let rootfs_path = self.config.cached_rootfs_path();
        // 导入前再次核验 SHA256，防止缓存文件在断点期间被损坏或替换
        verify_file_sha256(&rootfs_path, self.config.rootfs.sha256)?;

        let import_cmd =
            build_import_distro_cmd(&self.config.distro_name, &distro_dir, &rootfs_path)?;
        let out = self.run_wsl(&import_cmd, None)?;
        if out.exit_code != 0 {
            let err_msg = non_empty_error_text(&out);
            state.last_error = Some(err_msg.clone());
            state.save_atomic(&self.config.app_data_dir)?;
            return Err(ProvisionError::CommandFailed {
                stage: ProvisionStage::ImportDistro.as_str(),
                exit_code: out.exit_code,
                stderr: err_msg,
            });
        }

        state.imported_by_fusa = true;
        state.stage = ProvisionStage::InitRoot;
        state.last_error = None;
        state.save_atomic(&self.config.app_data_dir)?;
        Ok(())
    }

    fn step_init_root(&self, state: &mut ProvisionState) -> Result<(), ProvisionError> {
        // 统一转为 LF 换行再通过 stdin 写入 Linux 路径，避免 CRLF 破坏 bash shebang 且不依赖 /mnt/c
        let lf_script = self.config.guest_script.replace("\r\n", "\n");

        let mkdir_cmd = build_prepare_guest_script_dir_cmd(&self.config.distro_name)?;
        self.run_checked_stage(&mkdir_cmd, None, ProvisionStage::InitRoot, state)?;

        let write_cmd = build_write_guest_script_cmd(&self.config.distro_name)?;
        self.run_checked_stage(
            &write_cmd,
            Some(lf_script.as_bytes()),
            ProvisionStage::InitRoot,
            state,
        )?;

        let chmod_cmd = build_chmod_guest_script_cmd(&self.config.distro_name)?;
        self.run_checked_stage(&chmod_cmd, None, ProvisionStage::InitRoot, state)?;

        let phase_root_cmd =
            build_run_guest_script_cmd(&self.config.distro_name, "root", ["--phase", "root"])?;
        self.run_checked_stage(&phase_root_cmd, None, ProvisionStage::InitRoot, state)?;

        state.stage = ProvisionStage::RestartDistro;
        state.last_error = None;
        state.save_atomic(&self.config.app_data_dir)?;
        Ok(())
    }

    fn step_restart_single_distro(&self, state: &mut ProvisionState) -> Result<(), ProvisionError> {
        let term_cmd = build_terminate_distro_cmd(&self.config.distro_name)?;
        self.run_checked_stage(&term_cmd, None, ProvisionStage::RestartDistro, state)?;

        state.stage = ProvisionStage::InitUserAndSelfTest;
        state.last_error = None;
        state.save_atomic(&self.config.app_data_dir)?;
        Ok(())
    }

    fn step_init_user_and_self_test(
        &self,
        state: &mut ProvisionState,
    ) -> Result<SelfTestReport, ProvisionError> {
        let phase_user_cmd = build_run_guest_script_cmd(
            &self.config.distro_name,
            &self.config.linux_user,
            ["--phase", "user"],
        )?;
        self.run_checked_stage(
            &phase_user_cmd,
            None,
            ProvisionStage::InitUserAndSelfTest,
            state,
        )?;

        let report = match self.run_self_test_gate() {
            Ok(report) => report,
            Err(err) => {
                state.self_test_passed = false;
                state.last_error = Some(err.to_string());
                state.save_atomic(&self.config.app_data_dir)?;
                return Err(err);
            }
        };

        state.self_test_passed = true;
        state.stage = ProvisionStage::Ready;
        state.last_error = None;
        state.save_atomic(&self.config.app_data_dir)?;
        Ok(report)
    }

    fn run_checked_stage(
        &self,
        cmd: &WslCommand,
        stdin: Option<&[u8]>,
        stage: ProvisionStage,
        state: &mut ProvisionState,
    ) -> Result<CommandOutput, ProvisionError> {
        let out = self.run_wsl(cmd, stdin)?;
        if out.exit_code != 0 {
            let err_msg = non_empty_error_text(&out);
            state.last_error = Some(err_msg.clone());
            state.save_atomic(&self.config.app_data_dir)?;
            return Err(ProvisionError::CommandFailed {
                stage: stage.as_str(),
                exit_code: out.exit_code,
                stderr: err_msg,
            });
        }
        Ok(out)
    }

    /// 运行发行版内 `--self-test` 隔离门禁：任一检查失败立即返回 `ProvisionError::SelfTestFailed`，绝不降级运行。
    pub fn run_self_test_gate(&self) -> Result<SelfTestReport, ProvisionError> {
        let cmd = build_run_guest_script_cmd(
            &self.config.distro_name,
            &self.config.linux_user,
            ["--self-test"],
        )?;
        let out = self.run_wsl(&cmd, None)?;
        let report = parse_self_test_report(out.exit_code, &out.stdout, &out.stderr)?;

        if out.exit_code != 0 || !report.ok || !report.worker_sandbox_ready {
            let code = report
                .error_code
                .clone()
                .unwrap_or_else(|| "self_test_failed".to_string());
            let message = report.message.clone();
            return Err(ProvisionError::SelfTestFailed {
                code,
                message,
                report: Box::new(report),
            });
        }

        Ok(report)
    }

    /// 按注册表动态查询各厂商在专用发行版内的安装与登录引导信息（不在宿主或脚本写死厂商名单）。
    pub fn query_vendor_guides(
        &self,
        app_dir_in_wsl: &str,
    ) -> Result<Vec<VendorGuideEntry>, ProvisionError> {
        let cmd = build_run_guest_script_cmd(
            &self.config.distro_name,
            &self.config.linux_user,
            ["--vendors-json", "--app-dir", app_dir_in_wsl],
        )?;
        let out = self.run_wsl(&cmd, None)?;
        if out.exit_code != 0 {
            return Err(ProvisionError::CommandFailed {
                stage: "query_vendor_guides",
                exit_code: out.exit_code,
                stderr: non_empty_error_text(&out),
            });
        }
        parse_vendor_guides_json(&out.stdout)
    }
}

/// 将受控后台起停与探活脚本幂等安装到专用发行版 `/usr/local/libexec/fusa/wsl-daemon-ctl.sh`（root 0755，LF 换行）。
pub fn install_daemon_ctl_script<R: CommandRunner>(
    runner: &R,
    distro_name: &str,
    script_content: &str,
) -> Result<(), ProvisionError> {
    let lf_script = script_content.replace("\r\n", "\n");
    let steps: [(WslCommand, Option<&[u8]>); 3] = [
        (build_prepare_guest_script_dir_cmd(distro_name)?, None),
        (
            build_write_daemon_ctl_cmd(distro_name)?,
            Some(lf_script.as_bytes()),
        ),
        (build_chmod_daemon_ctl_cmd(distro_name)?, None),
    ];
    for (cmd, stdin) in steps {
        let out = runner
            .run(&cmd, stdin)
            .map_err(|source| ProvisionError::SpawnFailed {
                program: cmd.program.to_string_lossy().into_owned(),
                source,
            })?;
        if out.exit_code != 0 {
            return Err(ProvisionError::CommandFailed {
                stage: "install_daemon_ctl_script",
                exit_code: out.exit_code,
                stderr: non_empty_error_text(&out),
            });
        }
    }
    Ok(())
}

fn directory_has_files(dir: &Path) -> Result<bool, ProvisionError> {
    if !dir.exists() {
        return Ok(false);
    }
    let mut iter = fs::read_dir(dir).map_err(|source| ProvisionError::Io {
        path: dir.to_path_buf(),
        source,
    })?;
    Ok(iter.next().transpose().map_err(|source| ProvisionError::Io {
        path: dir.to_path_buf(),
        source,
    })?.is_some())
}

fn non_empty_error_text(out: &CommandOutput) -> String {
    let stderr = decode_wsl_output(&out.stderr);
    if !stderr.trim().is_empty() {
        return stderr.trim().to_string();
    }
    let stdout = decode_wsl_output(&out.stdout);
    if !stdout.trim().is_empty() {
        return stdout.trim().to_string();
    }
    format!("exit code {}", out.exit_code)
}
