use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::SupervisorError;

/// 随包内置运行时完整性校验清单（`runtime-manifest.json`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub version: String,
    pub node_version: String,
    pub node_sha256: String,
    pub fusa_run_sha256: String,
    pub hub_sha256: String,
}

impl RuntimeManifest {
    pub fn load_from_path(path: &Path) -> Result<Self, SupervisorError> {
        let raw = fs::read_to_string(path).map_err(|source| SupervisorError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let parsed: Self = serde_json::from_str(&raw)?;
        if parsed.version.trim().is_empty()
            || parsed.node_version.trim().is_empty()
            || !is_valid_sha256_hex(&parsed.node_sha256)
            || !is_valid_sha256_hex(&parsed.fusa_run_sha256)
            || !is_valid_sha256_hex(&parsed.hub_sha256)
        {
            return Err(SupervisorError::RuntimeIntegrityFailed(format!(
                "runtime-manifest.json 字段格式非法（{}）",
                path.display()
            )));
        }
        Ok(parsed)
    }
}

pub fn is_valid_sha256_hex(hex_str: &str) -> bool {
    hex_str.len() == 64 && hex_str.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 流式计算文件 SHA-256（固定 64 KiB 栈缓冲，校验 80 MiB `node.exe` 时峰值内存零增长）。
pub fn compute_file_sha256_hex(path: &Path) -> Result<String, SupervisorError> {
    let mut file = File::open(path).map_err(|source| SupervisorError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|source| SupervisorError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    Ok(out)
}

#[cfg(windows)]
fn normalize_nfc(input: &str) -> String {
    use windows_sys::Win32::Globalization::{NormalizationC, NormalizeString};
    if input.is_ascii() {
        return input.to_string();
    }
    let wide: Vec<u16> = input.encode_utf16().collect();
    let est = unsafe {
        NormalizeString(
            NormalizationC,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if est <= 0 {
        return input.to_string();
    }
    let mut out_wide = vec![0u16; est as usize];
    let actual = unsafe {
        NormalizeString(
            NormalizationC,
            wide.as_ptr(),
            wide.len() as i32,
            out_wide.as_mut_ptr(),
            out_wide.len() as i32,
        )
    };
    if actual <= 0 {
        return input.to_string();
    }
    out_wide.truncate(actual as usize);
    String::from_utf16(&out_wide).unwrap_or_else(|_| input.to_string())
}

#[cfg(not(windows))]
fn normalize_nfc(input: &str) -> String {
    input.to_string()
}

/// 与 TypeScript `src/shared/paths.ts` 的 `dataDirPipeHash(home)` 逐字符对齐：
/// `NFC -> '\\' 转 '/' -> 去除末尾 '/' -> 小写 -> SHA-256 前 12 位十六进制`。
pub fn data_dir_pipe_hash(home: &str) -> String {
    let nfc = normalize_nfc(home);
    let normalized = nfc
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(12);
    for byte in &digest[..6] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// 计算指定守护进程数据目录对应的 Windows 管理命名管道路径（`\\.\pipe\fusa-<hash12>-admin`）。
pub fn admin_named_pipe_path(hub_home_dir: &Path) -> String {
    let hash = data_dir_pipe_hash(&hub_home_dir.to_string_lossy());
    format!(r"\\.\pipe\fusa-{hash}-admin")
}
