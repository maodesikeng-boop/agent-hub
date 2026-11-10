use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use sha2::{Digest, Sha256};
use crate::command::WslCommand;
use crate::error::ProvisionError;

const SHA256_STREAM_BUF_SIZE: usize = 64 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 外部进程单次执行结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// 可注入的外部命令执行器抽象（Windows 真机用 `StdCommandRunner`，跨平台单测注入假实现）。
pub trait CommandRunner: Send + Sync {
    fn run(&self, cmd: &WslCommand, stdin: Option<&[u8]>) -> Result<CommandOutput, std::io::Error>;
}

/// 默认系统进程执行器（Windows 下自动附加 `CREATE_NO_WINDOW` 避免弹出控制台黑框）。
#[derive(Debug, Default, Clone, Copy)]
pub struct StdCommandRunner;

impl CommandRunner for StdCommandRunner {
    fn run(&self, cmd: &WslCommand, stdin: Option<&[u8]>) -> Result<CommandOutput, std::io::Error> {
        let mut command = Command::new(&cmd.program);
        command.args(&cmd.args);
        // WSLENV 决定哪些 Windows 环境变量会带进发行版；去掉它，宿主环境里的任何变量（含 FUSA_* 测试覆盖项）都进不了 Fusa。
        command.env_remove("WSLENV");
        for (k, v) in &cmd.envs {
            command.env(k, v);
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        if stdin.is_some() {
            command.stdin(Stdio::piped());
        } else {
            command.stdin(Stdio::null());
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()?;
        if let Some(input_bytes) = stdin {
            if let Some(mut child_stdin) = child.stdin.take() {
                child_stdin.write_all(input_bytes)?;
            }
        }

        let output = child.wait_with_output()?;
        Ok(CommandOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

/// 可注入的 Ubuntu WSL rootfs 镜像下载器抽象。
pub trait RootfsDownloader: Send + Sync {
    fn download(&self, url: &str, dest_file: &Path) -> Result<(), ProvisionError>;
}

/// 基于 Windows 11 系统内置 `curl.exe`（或 Unix `curl`）的流式镜像下载器。
/// 第 3 步 Tauri 外壳也可实现 `RootfsDownloader` 以接入细粒度进度事件。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemCurlDownloader;

impl RootfsDownloader for SystemCurlDownloader {
    fn download(&self, url: &str, dest_file: &Path) -> Result<(), ProvisionError> {
        let curl_bin = if cfg!(windows) { "curl.exe" } else { "curl" };
        let mut command = Command::new(curl_bin);
        command
            .arg("--fail")
            .arg("--silent")
            .arg("--show-error")
            .arg("--location")
            .arg("--proto")
            .arg("=https")
            .arg("--proto-redir")
            .arg("=https")
            .arg("--output")
            .arg(dest_file)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let output = command.output().map_err(|err| ProvisionError::DownloadFailed {
            url: url.to_string(),
            reason: err.to_string(),
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(ProvisionError::DownloadFailed {
                url: url.to_string(),
                reason: if stderr.is_empty() {
                    format!("exit code {:?}", output.status.code())
                } else {
                    stderr
                },
            });
        }
        Ok(())
    }
}

/// 以固定 64 KiB 缓冲区流式计算文件的 SHA-256（小写十六进制），内存占用恒定 O(1)。
pub fn compute_file_sha256_hex(path: &Path) -> Result<String, ProvisionError> {
    let mut file = File::open(path).map_err(|source| ProvisionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; SHA256_STREAM_BUF_SIZE];
    loop {
        let read_bytes = file.read(&mut buf).map_err(|source| ProvisionError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if read_bytes == 0 {
            break;
        }
        hasher.update(&buf[..read_bytes]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

/// 校验本地镜像文件 SHA-256 是否与锁定官方校验值一致（不区分大小写）。
pub fn verify_file_sha256(path: &Path, expected_sha256: &str) -> Result<(), ProvisionError> {
    let actual = compute_file_sha256_hex(path)?;
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if actual != expected {
        return Err(ProvisionError::ChecksumMismatch {
            path: path.to_path_buf(),
            expected,
            actual,
        });
    }
    Ok(())
}
