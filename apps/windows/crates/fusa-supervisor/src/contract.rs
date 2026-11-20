use std::fs;
use std::path::Path;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use crate::error::SupervisorError;

pub const EMBEDDED_DESKTOP_CONTRACT_JSON: &str =
    include_str!("../../../../../apps/desktop/contract.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopContract {
    pub product: String,
    pub protocol_version: u32,
    pub default_port: u16,
    pub status_path: String,
    pub health_path: String,
    pub shutdown_transport: String,
    pub shutdown_path: String,
    pub daemon_entry_relative_path: String,
    pub probe_timeout_ms: u64,
    pub poll_interval_ms: u64,
    pub startup_budget_ms: u64,
    pub stop_grace_ms: u64,
    pub crash_backoff_ms: Vec<u64>,
    pub crash_window_ms: u64,
    pub max_crashes_in_window: usize,
    pub reload_exit_code: i32,
    pub supervised_env: String,
    pub log_relative_path: String,
    pub log_max_bytes: u64,
    pub log_rotated_files: usize,
    pub stderr_tail_max_bytes: usize,
    pub stderr_summary_max_lines: usize,
    pub menu_reason_max_chars: usize,
    pub menu_actions: Vec<String>,
}

impl DesktopContract {
    pub fn embedded() -> Result<Self, SupervisorError> {
        let contract: Self = serde_json::from_str(EMBEDDED_DESKTOP_CONTRACT_JSON)?;
        contract.validate()?;
        Ok(contract)
    }

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
            || !self.health_path.starts_with('/')
            || self.shutdown_transport.trim().is_empty()
            || !self.shutdown_path.starts_with('/')
            || self.daemon_entry_relative_path.trim().is_empty()
            || self.default_port == 0
            || self.probe_timeout_ms == 0
            || self.poll_interval_ms == 0
            || self.startup_budget_ms == 0
            || self.stop_grace_ms == 0
            || self.crash_backoff_ms.is_empty()
            || self.crash_window_ms == 0
            || self.max_crashes_in_window == 0
            || self.reload_exit_code <= 0
            || self.reload_exit_code > 255
            || self.supervised_env.trim().is_empty()
            || self.log_max_bytes == 0
            || self.stderr_tail_max_bytes == 0
            || self.stderr_summary_max_lines == 0
            || self.menu_reason_max_chars == 0
        {
            return Err(SupervisorError::InvalidContract(
                "contract.json has an empty field or a zero budget".to_string(),
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

    pub fn startup_budget(&self) -> Duration {
        Duration::from_millis(self.startup_budget_ms)
    }

    pub fn stop_grace(&self) -> Duration {
        Duration::from_millis(self.stop_grace_ms)
    }

    pub fn crash_window(&self) -> Duration {
        Duration::from_millis(self.crash_window_ms)
    }

    pub fn backoff_delay_ms_for_crash_count(&self, crash_count_one_based: usize) -> u64 {
        let idx = crash_count_one_based
            .saturating_sub(1)
            .min(self.crash_backoff_ms.len().saturating_sub(1));
        self.crash_backoff_ms[idx]
    }
}
