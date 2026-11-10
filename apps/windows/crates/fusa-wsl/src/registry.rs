use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use crate::constants::LXSS_REGISTRY_SUBKEY;

/// 查询 Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` 的结构化结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryLookup {
    /// 非 Windows 平台默认返回，交由状态标记 + `ext4.vhdx` 校验。
    UnsupportedPlatform,
    /// `Lxss` 注册表下未找到指定发行版名称。
    NotFound,
    /// 找到匹配名称的发行版及其登记的 `BasePath`。
    Found { base_path: PathBuf },
}

/// 可注入的 WSL 注册表归属核查接口（使 macOS 开发机也能 100% 单测注册表 `BasePath` 核对分支）。
pub trait DistroRegistryInspector: Send + Sync {
    fn lookup_distro_base_path(&self, distro_name: &str) -> Result<RegistryLookup, std::io::Error>;
}

/// 真实宿主注册表读取器：Windows 下枚举 `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`，其他平台返回 `UnsupportedPlatform`。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRegistryInspector;

impl DistroRegistryInspector for SystemRegistryInspector {
    #[cfg(target_os = "windows")]
    fn lookup_distro_base_path(&self, distro_name: &str) -> Result<RegistryLookup, std::io::Error> {
        use std::io::ErrorKind;
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let lxss = match hkcu.open_subkey(LXSS_REGISTRY_SUBKEY) {
            Ok(key) => key,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(RegistryLookup::NotFound),
            Err(err) => return Err(err),
        };

        for subkey_res in lxss.enum_keys() {
            let subkey_name = match subkey_res {
                Ok(name) => name,
                Err(_) => continue,
            };
            let Ok(entry) = lxss.open_subkey(&subkey_name) else {
                continue;
            };
            let Ok(registered_name) = entry.get_value::<String, _>("DistributionName") else {
                continue;
            };
            if registered_name.eq_ignore_ascii_case(distro_name) {
                let base_path: String = entry.get_value("BasePath")?;
                return Ok(RegistryLookup::Found {
                    base_path: PathBuf::from(base_path),
                });
            }
        }

        Ok(RegistryLookup::NotFound)
    }

    #[cfg(not(target_os = "windows"))]
    fn lookup_distro_base_path(&self, _distro_name: &str) -> Result<RegistryLookup, std::io::Error> {
        Ok(RegistryLookup::UnsupportedPlatform)
    }
}

/// 规范化 Windows 发行版安装路径以便比对：剥离 `\\?\` 长路径前缀、统一反斜杠、消解 `.`/`..`、去尾斜杠并转小写。
pub fn normalize_windows_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut s = raw.trim().replace('/', r"\");

    let lower_head = s.to_ascii_lowercase();
    if lower_head.starts_with(r"\\?\unc\") {
        s = format!(r"\\{}", &s[8..]);
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        s = stripped.to_string();
    }

    let is_unc = s.starts_with(r"\\");
    let body = if is_unc { &s[2..] } else { s.as_str() };

    let mut parts: Vec<&str> = Vec::new();
    for seg in body.split('\\') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if let Some(last) = parts.last() {
                let is_drive_root = last.len() == 2 && last.as_bytes()[1] == b':';
                if !is_drive_root {
                    parts.pop();
                    continue;
                }
            }
        }
        parts.push(seg);
    }

    let mut normalized = if is_unc {
        format!(r"\\{}", parts.join(r"\"))
    } else if parts.len() == 1 && parts[0].len() == 2 && parts[0].as_bytes()[1] == b':' {
        format!(r"{}\", parts[0])
    } else {
        parts.join(r"\")
    };

    normalized.make_ascii_lowercase();
    normalized.to_lowercase()
}

/// 核对注册表中的 `BasePath` 是否指向本应用专属发行版目录（兼顾真实文件系统软硬链接与纯词法 Windows 路径）。
pub fn windows_base_paths_match(expected_install_dir: &Path, registry_base_path: &Path) -> bool {
    if let (Ok(canon_expected), Ok(canon_actual)) = (
        fs::canonicalize(expected_install_dir),
        fs::canonicalize(registry_base_path),
    ) {
        if normalize_windows_path_key(&canon_expected) == normalize_windows_path_key(&canon_actual) {
            return true;
        }
    }
    normalize_windows_path_key(expected_install_dir) == normalize_windows_path_key(registry_base_path)
}
