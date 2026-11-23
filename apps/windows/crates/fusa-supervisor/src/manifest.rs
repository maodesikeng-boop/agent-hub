use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::SupervisorError;

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
                "runtime-manifest.json has an invalid field ({})",
                path.display()
            )));
        }
        Ok(parsed)
    }
}

pub fn is_valid_sha256_hex(hex_str: &str) -> bool {
    hex_str.len() == 64 && hex_str.bytes().all(|b| b.is_ascii_hexdigit())
}

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

// Must match dataDirPipeHash in src/shared/paths.ts: NFC, backslash to slash, trim trailing slash, lowercase, first 12 hex chars of SHA-256.
pub fn data_dir_pipe_hash(home: &str) -> String {
    let nfc = normalize_nfc(home);
    let normalized = nfc.replace('\\', "/").trim_end_matches('/').to_lowercase();
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

pub fn admin_named_pipe_path(hub_home_dir: &Path) -> String {
    let hash = data_dir_pipe_hash(&hub_home_dir.to_string_lossy());
    format!(r"\\.\pipe\fusa-{hash}-admin")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_accepts_the_git_commit_written_by_the_stage_script() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("runtime-manifest.json");
        let sha = "a".repeat(64);
        let raw = format!(
            r#"{{"version":"0.3.0","nodeVersion":"v24.22.3","nodeSha256":"{sha}","fusaRunSha256":"{sha}","hubSha256":"{sha}","gitCommit":"0123456789abcdef0123456789abcdef01234567"}}"#
        );
        fs::write(&path, raw).unwrap();
        let manifest = RuntimeManifest::load_from_path(&path).unwrap();
        assert_eq!(manifest.version, "0.3.0");
        assert_eq!(manifest.hub_sha256, sha);
    }
}
