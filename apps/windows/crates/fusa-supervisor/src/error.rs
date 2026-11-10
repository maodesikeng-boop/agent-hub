use std::path::PathBuf;
use thiserror::Error;

/// 后台监管、探活、认证兑换与优雅停机错误。
#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("桌面契约配置非法：{0}")]
    InvalidContract(String),

    #[error("解析或序列化 JSON 失败：{0}")]
    Json(#[from] serde_json::Error),

    #[error("读写本地监管文件失败（{path}）：{source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("WSL 发行版归属或命令执行错误：{0}")]
    Wsl(#[from] fusa_wsl::ProvisionError),

    #[error("构造 WSL 命令失败：{0}")]
    CommandBuild(#[from] fusa_wsl::CommandBuildError),

    #[error("端口 {port} 冲突：{detail}")]
    PortConflict { port: u16, detail: String },

    #[error("WSL 内部后台已就绪（实例 {guest_instance_id}），但宿主 Windows 无法访问 127.0.0.1:{port}：{detail}")]
    LocalhostForwardingBroken {
        port: u16,
        guest_instance_id: String,
        detail: String,
    },

    #[error("等待后台守护进程就绪超时（预算 {budget_ms} ms）：{detail}")]
    StartupTimedOut { budget_ms: u64, detail: String },

    #[error("守护进程在启动阶段提前退出：{detail}")]
    PrematureExit { detail: String },

    #[error("拦截到非法的 HTTP {status_code} 重定向响应（严禁跟随重定向）")]
    RedirectBlocked { status_code: u16 },

    #[error("兑换本地 WebView 会话 Cookie 失败：{0}")]
    AuthExchangeFailed(String),

    #[error("当前端口由外部兼容 Fusa 实例管理，外壳只复用连接，拒绝重启或停止外部实例")]
    ExternalManagedCannotRestart,

    #[error("监管操作已被更新的重启世代或退出请求取消")]
    CancelledByNewerGeneration,
}
