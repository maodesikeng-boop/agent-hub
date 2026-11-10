use std::ffi::{OsStr, OsString};
use std::path::Path;
use crate::constants::{
    DAEMON_CTL_WSL_PATH, FUSA_NODE_WSL_PATH, FUSA_UI_TOKEN_WSL_PATH, GUEST_SCRIPT_WSL_DIR,
    GUEST_SCRIPT_WSL_PATH, WSL_EXE,
};
use crate::error::CommandBuildError;

/// 安全构造的宿主外部进程调用描述（参数全部作为独立数组传递，绝不经 shell 拼接）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub envs: Vec<(OsString, OsString)>,
}

impl WslCommand {
    fn base_wsl(args: Vec<OsString>) -> Result<Self, CommandBuildError> {
        for arg in &args {
            let s = arg.to_string_lossy();
            if s.as_bytes().contains(&0) {
                return Err(CommandBuildError::NullByteInArgument);
            }
            let trimmed = s.trim();
            if trimmed.eq_ignore_ascii_case("--shutdown") {
                return Err(CommandBuildError::ForbiddenWslFlag("--shutdown".to_string()));
            }
            if trimmed.eq_ignore_ascii_case("--unregister") {
                return Err(CommandBuildError::ForbiddenWslFlag("--unregister".to_string()));
            }
        }
        Ok(Self {
            program: OsString::from(WSL_EXE),
            args,
            // 提示新版 wsl.exe 优先输出 UTF-8；旧版或忽略该变量的场景仍由 UTF-16LE 解析器兜底。
            envs: vec![(OsString::from("WSL_UTF8"), OsString::from("1"))],
        })
    }

    /// 供测试和调试查看的字符串参数视图。
    pub fn args_lossy(&self) -> Vec<String> {
        self.args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }
}

fn validate_distro_name(name: &str) -> Result<(), CommandBuildError> {
    if name.is_empty()
        || name.starts_with('-')
        || name
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\0')
    {
        return Err(CommandBuildError::InvalidDistroName(name.to_string()));
    }
    Ok(())
}

fn validate_linux_user(user: &str) -> Result<(), CommandBuildError> {
    let mut chars = user.chars();
    let Some(first) = chars.next() else {
        return Err(CommandBuildError::InvalidLinuxUser(user.to_string()));
    };
    if !(first.is_ascii_lowercase() || first == '_') {
        return Err(CommandBuildError::InvalidLinuxUser(user.to_string()));
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(CommandBuildError::InvalidLinuxUser(user.to_string()));
    }
    Ok(())
}

fn validate_linux_abs_program(program: &str) -> Result<(), CommandBuildError> {
    if !program.starts_with('/')
        || program.len() < 2
        || program.chars().any(|c| c.is_control() || c == '\0')
    {
        return Err(CommandBuildError::ProgramMustBeAbsolutePath(
            program.to_string(),
        ));
    }
    Ok(())
}

fn is_shell_binary(program: &str) -> bool {
    let base = program.rsplit('/').next().unwrap_or(program);
    matches!(base, "sh" | "bash" | "dash" | "zsh" | "env")
}

/// shell 的“执行字符串”开关：`-c` 以及合写的短选项簇（`-lc`、`-ec`、`-xc` 等）。
fn is_shell_eval_flag(arg: &str) -> bool {
    match arg.strip_prefix('-') {
        Some(flags) if !flags.starts_with('-') => {
            !flags.is_empty() && flags.chars().all(|c| c.is_ascii_alphabetic()) && flags.contains('c')
        }
        _ => false,
    }
}

/// `wsl.exe --version`
pub fn build_version_cmd() -> Result<WslCommand, CommandBuildError> {
    WslCommand::base_wsl(vec![OsString::from("--version")])
}

/// `wsl.exe --status`
pub fn build_status_cmd() -> Result<WslCommand, CommandBuildError> {
    WslCommand::base_wsl(vec![OsString::from("--status")])
}

/// `wsl.exe --list --verbose`
pub fn build_list_verbose_cmd() -> Result<WslCommand, CommandBuildError> {
    WslCommand::base_wsl(vec![
        OsString::from("--list"),
        OsString::from("--verbose"),
    ])
}

/// `wsl.exe --install --no-distribution`（缺 WSL 组件时由外壳请求提权执行，不装默认 Ubuntu）。
pub fn build_install_wsl_no_distro_cmd() -> Result<WslCommand, CommandBuildError> {
    WslCommand::base_wsl(vec![
        OsString::from("--install"),
        OsString::from("--no-distribution"),
    ])
}

/// `wsl.exe --import <distro> <install_dir> <rootfs_archive> --version 2`
pub fn build_import_distro_cmd(
    distro_name: &str,
    install_dir: &Path,
    rootfs_archive: &Path,
) -> Result<WslCommand, CommandBuildError> {
    validate_distro_name(distro_name)?;
    WslCommand::base_wsl(vec![
        OsString::from("--import"),
        OsString::from(distro_name),
        install_dir.as_os_str().to_os_string(),
        rootfs_archive.as_os_str().to_os_string(),
        OsString::from("--version"),
        OsString::from("2"),
    ])
}

/// `wsl.exe --terminate <distro>`（仅终止本应用自己的专用实例，严禁全局 `--shutdown`）。
pub fn build_terminate_distro_cmd(distro_name: &str) -> Result<WslCommand, CommandBuildError> {
    validate_distro_name(distro_name)?;
    WslCommand::base_wsl(vec![
        OsString::from("--terminate"),
        OsString::from(distro_name),
    ])
}

/// 构造 `wsl.exe --distribution <distro> --user <user> --exec <program_abs_path> <args...>`。
/// 强制要求 Linux 绝对路径，并禁止 `sh -c` / `bash -c` 动态字符串求值。
pub fn build_exec_cmd<I, S>(
    distro_name: &str,
    linux_user: &str,
    program_abs_path: &str,
    program_args: I,
) -> Result<WslCommand, CommandBuildError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    validate_distro_name(distro_name)?;
    validate_linux_user(linux_user)?;
    validate_linux_abs_program(program_abs_path)?;

    let collected_args: Vec<OsString> = program_args
        .into_iter()
        .map(|s| s.as_ref().to_os_string())
        .collect();

    for arg in &collected_args {
        if arg.to_string_lossy().as_bytes().contains(&0) {
            return Err(CommandBuildError::NullByteInArgument);
        }
    }

    if is_shell_binary(program_abs_path)
        && collected_args
            .iter()
            .any(|a| is_shell_eval_flag(&a.to_string_lossy()))
    {
        return Err(CommandBuildError::ShellEvalForbidden);
    }

    let mut wsl_args = Vec::with_capacity(6 + collected_args.len());
    wsl_args.push(OsString::from("--distribution"));
    wsl_args.push(OsString::from(distro_name));
    wsl_args.push(OsString::from("--user"));
    wsl_args.push(OsString::from(linux_user));
    wsl_args.push(OsString::from("--exec"));
    wsl_args.push(OsString::from(program_abs_path));
    wsl_args.extend(collected_args);

    WslCommand::base_wsl(wsl_args)
}

/// 在专用发行版内准备脚本安装目录：`mkdir -p /usr/local/libexec/fusa`
pub fn build_prepare_guest_script_dir_cmd(
    distro_name: &str,
) -> Result<WslCommand, CommandBuildError> {
    build_exec_cmd(
        distro_name,
        "root",
        "/bin/mkdir",
        ["-p", GUEST_SCRIPT_WSL_DIR],
    )
}

/// 通过 stdin 将脚本内容写入 `/usr/local/libexec/fusa/wsl-provision-guest.sh`
pub fn build_write_guest_script_cmd(distro_name: &str) -> Result<WslCommand, CommandBuildError> {
    build_exec_cmd(
        distro_name,
        "root",
        "/usr/bin/tee",
        [GUEST_SCRIPT_WSL_PATH],
    )
}

/// 将发行版内准备脚本权限设为 `0755`（root 只写、普通用户只读可执行）。
pub fn build_chmod_guest_script_cmd(distro_name: &str) -> Result<WslCommand, CommandBuildError> {
    build_exec_cmd(
        distro_name,
        "root",
        "/bin/chmod",
        ["0755", GUEST_SCRIPT_WSL_PATH],
    )
}

/// 执行发行版内准备脚本指定参数（如 `["--phase", "root"]`、`["--phase", "user"]`、`["--self-test"]`）。
pub fn build_run_guest_script_cmd<I, S>(
    distro_name: &str,
    linux_user: &str,
    script_args: I,
) -> Result<WslCommand, CommandBuildError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    build_exec_cmd(distro_name, linux_user, GUEST_SCRIPT_WSL_PATH, script_args)
}

/// 构造启动 Linux 守护进程的命令（供第 3 步 Tauri 外壳直接调用）。
pub fn build_daemon_launch_cmd<I, S>(
    distro_name: &str,
    linux_user: &str,
    daemon_entry_abs_path: &str,
    extra_args: I,
) -> Result<WslCommand, CommandBuildError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    validate_linux_abs_program(daemon_entry_abs_path)?;
    let mut args = vec![OsString::from(daemon_entry_abs_path)];
    for item in extra_args {
        args.push(item.as_ref().to_os_string());
    }
    build_exec_cmd(distro_name, linux_user, FUSA_NODE_WSL_PATH, args)
}

/// 构造读取 Linux `state/ui-token` 到内存的命令（令牌走 stdout 内存管道，不进 URL 或参数）。
pub fn build_read_ui_token_cmd(
    distro_name: &str,
    linux_user: &str,
) -> Result<WslCommand, CommandBuildError> {
    build_exec_cmd(distro_name, linux_user, "/bin/cat", [FUSA_UI_TOKEN_WSL_PATH])
}

/// 通过 stdin 将受控起停脚本写入 `/usr/local/libexec/fusa/wsl-daemon-ctl.sh`。
pub fn build_write_daemon_ctl_cmd(distro_name: &str) -> Result<WslCommand, CommandBuildError> {
    build_exec_cmd(
        distro_name,
        "root",
        "/usr/bin/tee",
        [DAEMON_CTL_WSL_PATH],
    )
}

/// 将受控起停脚本权限设为 `0755`（root 只写、普通用户只读可执行）。
pub fn build_chmod_daemon_ctl_cmd(distro_name: &str) -> Result<WslCommand, CommandBuildError> {
    build_exec_cmd(
        distro_name,
        "root",
        "/bin/chmod",
        ["0755", DAEMON_CTL_WSL_PATH],
    )
}

/// 执行发行版内受控起停脚本子命令（如 `["probe", ...]`、`["run", ...]`、`["status", ...]`、`["signal", ...]`）。
pub fn build_run_daemon_ctl_cmd<I, S>(
    distro_name: &str,
    linux_user: &str,
    ctl_args: I,
) -> Result<WslCommand, CommandBuildError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    build_exec_cmd(distro_name, linux_user, DAEMON_CTL_WSL_PATH, ctl_args)
}

/// 构造为用户拉起专用发行版交互式终端的命令：`wsl.exe --distribution <distro> --user <user> --cd ~`。
/// 供用户在首次运行引导页自行执行厂商 CLI 登录，零 `sh -c` 拼接。
pub fn build_interactive_login_cmd(
    distro_name: &str,
    linux_user: &str,
) -> Result<WslCommand, CommandBuildError> {
    validate_distro_name(distro_name)?;
    validate_linux_user(linux_user)?;
    WslCommand::base_wsl(vec![
        OsString::from("--distribution"),
        OsString::from(distro_name),
        OsString::from("--user"),
        OsString::from(linux_user),
        OsString::from("--cd"),
        OsString::from("~"),
    ])
}
