use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("Invalid desktop contract: {0}")]
    InvalidContract(String),

    #[error("JSON parse or serialize failed: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Failed to read or write supervisor file ({path}): {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Bundled runtime or manifest is invalid: {0}")]
    RuntimeIntegrityFailed(String),

    #[error("Failed to spawn {program}: {source}")]
    SpawnFailed {
        program: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Port {port} conflict: {detail}")]
    PortConflict { port: u16, detail: String },

    #[error("Timed out after {budget_ms} ms waiting for the daemon: {detail}")]
    StartupTimedOut { budget_ms: u64, detail: String },

    #[error("The daemon exited during startup: {detail}")]
    PrematureExit { detail: String },

    #[error("Blocked an HTTP {status_code} redirect (redirects are never followed)")]
    RedirectBlocked { status_code: u16 },

    #[error("Failed to get the WebView session cookie: {0}")]
    AuthExchangeFailed(String),

    #[error("Health check failed: {0}")]
    HealthCheckFailed(String),

    #[error("An external Bellwood daemon owns this port; the shell reuses it and won't restart or stop it")]
    ExternalManagedCannotRestart,

    #[error("Cancelled by a newer restart or a quit request")]
    CancelledByNewerGeneration,
}
