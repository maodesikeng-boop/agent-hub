use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::constants::{FUSA_DISTRO_NAME, PROVISION_STATE_FILENAME};
use crate::error::ProvisionError;

pub const STATE_SCHEMA_VERSION: u32 = 1;

/// Windows 宿主侧 WSL2 专用发行版准备阶段状态机。
/// 按固定顺序推进并持久化，失败可从当前阶段幂等重试且绝不覆盖用户已有项目与凭据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionStage {
    /// 1. 检查 WSL2 可用性与现有发行版列表（识别同名冲突）。
    CheckWsl,
    /// 2. 已触发 `wsl --install --no-distribution`，等待用户重启 Windows。
    InstallWslPendingReboot,
    /// 3. 下载并按官方 SHA-256 校验 Ubuntu 24.04 WSL rootfs 镜像。
    DownloadRootfs,
    /// 4. 执行 `wsl --import Fusa <distro_dir> <rootfs> --version 2`。
    ImportDistro,
    /// 5. 在发行版内以 root 初始化 `/etc/wsl.conf`、普通用户 `fusa` 及系统依赖与 AppArmor 规则。
    InitRoot,
    /// 6. 执行 `wsl --terminate Fusa` 重启单实例使 `/etc/wsl.conf` 隔离配置生效。
    RestartDistro,
    /// 7. 以普通用户 `fusa` 安装锁定版 Node 24 / pnpm 并运行 `bwrap` 与 interop 关闭自检门禁。
    InitUserAndSelfTest,
    /// 8. 全部准备与隔离门禁验证通过，可安全启动后台与派发 Worker。
    Ready,
}

impl ProvisionStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CheckWsl => "check_wsl",
            Self::InstallWslPendingReboot => "install_wsl_pending_reboot",
            Self::DownloadRootfs => "download_rootfs",
            Self::ImportDistro => "import_distro",
            Self::InitRoot => "init_root",
            Self::RestartDistro => "restart_distro",
            Self::InitUserAndSelfTest => "init_user_and_self_test",
            Self::Ready => "ready",
        }
    }
}

/// 持久化在本地应用数据目录下的准备状态标记。
/// `imported_by_fusa` 用于区分“本应用自己导入的 Fusa 实例（允许断点续跑）”与“用户自己原有的同名实例（必须报冲突保护）”。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvisionState {
    pub schema_version: u32,
    pub distro_name: String,
    pub stage: ProvisionStage,
    pub imported_by_fusa: bool,
    pub rootfs_version: Option<String>,
    pub rootfs_sha256: Option<String>,
    pub self_test_passed: bool,
    pub last_error: Option<String>,
}

impl ProvisionState {
    pub fn new(distro_name: impl Into<String>) -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            distro_name: distro_name.into(),
            stage: ProvisionStage::CheckWsl,
            imported_by_fusa: false,
            rootfs_version: None,
            rootfs_sha256: None,
            self_test_passed: false,
            last_error: None,
        }
    }

    pub fn state_file_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(PROVISION_STATE_FILENAME)
    }

    pub fn load_or_default(app_data_dir: &Path, distro_name: &str) -> Result<Self, ProvisionError> {
        let path = Self::state_file_path(app_data_dir);
        if !path.exists() {
            return Ok(Self::new(distro_name));
        }
        let bytes = fs::read(&path).map_err(|source| ProvisionError::Io {
            path: path.clone(),
            source,
        })?;
        let state: Self = serde_json::from_slice(&bytes)?;
        Ok(state)
    }

    /// 原子写入状态文件（先写同目录临时文件再 rename），防止进程异常中断留下半截 JSON。
    pub fn save_atomic(&self, app_data_dir: &Path) -> Result<(), ProvisionError> {
        fs::create_dir_all(app_data_dir).map_err(|source| ProvisionError::Io {
            path: app_data_dir.to_path_buf(),
            source,
        })?;
        let target = Self::state_file_path(app_data_dir);
        let tmp = app_data_dir.join(format!("{}.tmp.{}", PROVISION_STATE_FILENAME, std::process::id()));
        let payload = serde_json::to_vec_pretty(self)?;
        fs::write(&tmp, payload).map_err(|source| ProvisionError::Io {
            path: tmp.clone(),
            source,
        })?;
        fs::rename(&tmp, &target).map_err(|source| ProvisionError::Io {
            path: target,
            source,
        })?;
        Ok(())
    }
}

impl Default for ProvisionState {
    fn default() -> Self {
        Self::new(FUSA_DISTRO_NAME)
    }
}
