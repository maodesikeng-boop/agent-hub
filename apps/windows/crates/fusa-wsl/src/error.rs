use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 命令数组构造阶段的安全校验错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CommandBuildError {
    #[error("WSL 发行版名称非法（不能为空或包含空白与控制字符）：{0:?}")]
    InvalidDistroName(String),

    #[error("Linux 用户名非法（仅允许小写字母、数字、下划线与连字符）：{0:?}")]
    InvalidLinuxUser(String),

    #[error("WSL --exec 目标程序必须是 Linux 绝对路径（以 / 开头且不含控制字符）：{0:?}")]
    ProgramMustBeAbsolutePath(String),

    #[error("命令参数包含非法的 NUL 字节")]
    NullByteInArgument,

    #[error("禁止通过 sh/bash -c 动态拼接命令字符串，请直接传递可执行文件绝对路径与独立参数数组")]
    ShellEvalForbidden,

    #[error("禁止构造破坏性或影响全局其他发行版的 WSL 参数：{0}")]
    ForbiddenWslFlag(String),
}

/// 发行版内 `--self-test` 隔离门禁返回的结构化检查明细。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfTestChecks {
    pub non_root: bool,
    pub no_passwordless_sudo: bool,
    pub interop_disabled: bool,
    pub windows_path_clean: bool,
    pub bwrap_probe: bool,
    pub bwrap_write_guard: bool,
}

/// 发行版内 `--self-test` 单条失败原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfTestFailureItem {
    pub code: String,
    pub detail: String,
}

/// 发行版内 `--self-test` 返回的完整门禁报告。
/// 任一检查未通过时 `ok` 与 `worker_sandbox_ready` 均为 `false`，外壳据此禁用派 Worker 并提示原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfTestReport {
    pub ok: bool,
    pub worker_sandbox_ready: bool,
    pub error_code: Option<String>,
    pub message: String,
    pub checks: SelfTestChecks,
    pub failures: Vec<SelfTestFailureItem>,
}

/// WSL2 专用发行版准备与监管错误（完全基于退出码与结构化状态建模，不匹配英文报错句子）。
#[derive(Debug, Error)]
pub enum ProvisionError {
    #[error("本地应用数据目录不能位于网络共享盘（UNC 路径）：{0}")]
    NetworkPathNotSupported(PathBuf),

    #[error("读写准备器状态或本地文件失败（{path}）：{source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("序列化或解析状态 JSON 失败：{0}")]
    Json(#[from] serde_json::Error),

    #[error("构造安全的 WSL 命令失败：{0}")]
    CommandBuild(#[from] CommandBuildError),

    #[error("启动宿主命令 `{program}` 失败：{source}")]
    SpawnFailed {
        program: String,
        #[source]
        source: std::io::Error,
    },

    #[error("系统尚未安装或启用 WSL2 组件，请先同意安装 WSL 并按提示重启系统")]
    WslNotInstalled,

    #[error("WSL2 安装已完成但需要重启 Windows 后才能生效")]
    RebootRequired,

    #[error("WSL2 内核或虚拟化组件尚未就绪（退出码 {exit_code}），请确认已在 BIOS 启用虚拟化并完成系统重启")]
    KernelOrVirtualizationNotReady { exit_code: i32 },

    #[error("检测到同名 WSL 发行版 `{distro_name}`，但未发现 Fusa 安装标记；为保护已有数据已停止导入，请先处理名称冲突")]
    DistroNameConflict { distro_name: String },

    #[error("检测到同名 WSL 发行版 `{distro_name}` 的 Windows 注册表 BasePath 与本应用专属目录不符（期望: {expected}，实际: {actual}）；拒绝触碰非本应用创建的发行版")]
    DistroBasePathMismatch {
        distro_name: String,
        expected: PathBuf,
        actual: String,
    },

    #[error("已登记的发行版 `{distro_name}` 当前 WSL 版本为 {version}（要求 WSL 2）")]
    UnsupportedWslVersion { distro_name: String, version: u8 },

    #[error("发行版安装目录 `{distro_dir}` 中已存在磁盘文件但状态标记未登记导入，拒绝自动覆盖已有数据")]
    ExistingDistroDataFound { distro_dir: PathBuf },

    #[error("下载 Ubuntu 24.04 官方 WSL 镜像失败（URL: {url}）：{reason}")]
    DownloadFailed { url: String, reason: String },

    #[error("镜像文件 SHA256 校验失败（路径: {path}，期望: {expected}，实际: {actual}）")]
    ChecksumMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },

    #[error("阶段 `{stage}` 执行失败（退出码 {exit_code}）：{stderr}")]
    CommandFailed {
        stage: &'static str,
        exit_code: i32,
        stderr: String,
    },

    #[error("WSL2 沙箱与互操作隔离自检未通过（错误码: {code}）：{message}")]
    SelfTestFailed {
        code: String,
        message: String,
        report: Box<SelfTestReport>,
    },

    #[error("无法解析发行版内返回的自检报告（退出码 {exit_code}）：{raw_output}")]
    InvalidSelfTestOutput { exit_code: i32, raw_output: String },
}
