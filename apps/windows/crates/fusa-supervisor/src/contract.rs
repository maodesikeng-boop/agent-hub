use std::fs;
use std::path::Path;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use crate::error::SupervisorError;

/// 编译期内嵌的桌面端统一监管契约（单一事实来源：`apps/desktop/contract.json`）。
pub const EMBEDDED_DESKTOP_CONTRACT_JSON: &str =
    include_str!("../../../../../apps/desktop/contract.json");

/// 桌面外壳与后台守护进程监管契约（所有预算、退避、日志与探活参数均由 `apps/desktop/contract.json` 反序列化，零魔法数字双写）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopContract {
    pub product: String,
    pub protocol_version: u32,
    pub default_port: u16,
    pub status_path: String,
    pub probe_timeout_ms: u64,
    pub poll_interval_ms: u64,
    pub startup_budget_ms: u64,
    pub wsl_cold_start_budget_ms: u64,
    pub stop_grace_ms: u64,
    pub crash_backoff_ms: Vec<u64>,
    pub crash_window_ms: u64,
    pub max_crashes_in_window: usize,
    pub log_relative_path: String,
    pub log_max_bytes: u64,
    pub log_rotated_files: usize,
    pub stderr_tail_max_bytes: usize,
    pub stderr_summary_max_lines: usize,
    pub menu_reason_max_chars: usize,
    pub menu_actions: Vec<String>,
}

impl DesktopContract {
    /// 解析编译期内嵌的 `apps/desktop/contract.json`。
    pub fn embedded() -> Result<Self, SupervisorError> {
        let contract: Self = serde_json::from_str(EMBEDDED_DESKTOP_CONTRACT_JSON)?;
        contract.validate()?;
        Ok(contract)
    }

    /// 从磁盘指定路径运行时加载并校验契约文件。
    pub fn load_from_path(path: &Path) -> Result<Self, SupervisorError> {
        let raw = fs::read_to_string(path).map_err(|source| SupervisorError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let contract: Self = serde_json::from_str(&raw)?;
        contract.validate()?;
        Ok(contract)
    }

    fn validate(&self) -> Result<(), SupervisorError> {
        if self.product.trim().is_empty()
            || !self.status_path.starts_with('/')
            || self.default_port == 0
            || self.probe_timeout_ms == 0
            || self.poll_interval_ms == 0
            || self.startup_budget_ms == 0
            || self.wsl_cold_start_budget_ms == 0
            || self.stop_grace_ms == 0
            || self.crash_backoff_ms.is_empty()
            || self.crash_window_ms == 0
            || self.max_crashes_in_window == 0
            || self.log_max_bytes == 0
            || self.stderr_tail_max_bytes == 0
            || self.stderr_summary_max_lines == 0
            || self.menu_reason_max_chars == 0
        {
            return Err(SupervisorError::InvalidContract(
                "contract.json 存在空字段或 0 值预算".to_string(),
            ));
        }
        Ok(())
    }

    pub fn probe_timeout(&self) -> Duration {
        Duration::from_millis(self.probe_timeout_ms)
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(self.poll_interval_ms)
    }

    pub fn startup_budget(&self, is_cold_start: bool) -> Duration {
        let ms = if is_cold_start {
            self.wsl_cold_start_budget_ms
        } else {
            self.startup_budget_ms
        };
        Duration::from_millis(ms)
    }

    pub fn startup_budget_ms_for(&self, is_cold_start: bool) -> u64 {
        if is_cold_start {
            self.wsl_cold_start_budget_ms
        } else {
            self.startup_budget_ms
        }
    }

    pub fn stop_grace(&self) -> Duration {
        Duration::from_millis(self.stop_grace_ms)
    }

    pub fn crash_window(&self) -> Duration {
        Duration::from_millis(self.crash_window_ms)
    }

    /// 根据当前窗口内第 N 次崩溃（从 1 开始计数）返回对应退避时长。
    pub fn backoff_delay_ms_for_crash_count(&self, crash_count_one_based: usize) -> u64 {
        let idx = crash_count_one_based
            .saturating_sub(1)
            .min(self.crash_backoff_ms.len().saturating_sub(1));
        self.crash_backoff_ms[idx]
    }
}
