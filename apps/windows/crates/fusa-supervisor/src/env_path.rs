use std::collections::HashSet;
use std::path::PathBuf;

/// 展开 Windows 注册表 `REG_EXPAND_SZ` 中的 `%VAR%` 占位符（大小写无关匹配，未知变量保持原样）。
pub fn expand_windows_env_vars(raw: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '%' {
            if let Some(rel_end) = chars[i + 1..].iter().position(|&c| c == '%') {
                let end = i + 1 + rel_end;
                if end == i + 1 {
                    // `%%` 保留字面 `%%`
                    out.push('%');
                    out.push('%');
                    i = end + 1;
                    continue;
                }
                let key: String = chars[i + 1..end].iter().collect();
                if let Some(val) = lookup(&key) {
                    out.push_str(&val);
                } else {
                    out.push('%');
                    out.push_str(&key);
                    out.push('%');
                }
                i = end + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 合并前置目录、系统/用户注册表最新 `Path` 与当前进程继承的 `PATH`（Windows 按不区分大小写去重保序）。
pub fn merge_path_entries(
    prepend_dirs: &[PathBuf],
    registry_path_lists: &[String],
    fallback_process_path: Option<&str>,
    is_windows: bool,
) -> String {
    let sep = if is_windows { ';' } else { ':' };
    let sep_str = if is_windows { ";" } else { ":" };
    let mut seen = HashSet::new();
    let mut ordered = Vec::new();

    let mut push_entry = |raw_seg: &str| {
        let trimmed = raw_seg.trim().trim_matches('"');
        if trimmed.is_empty() {
            return;
        }
        let key = if is_windows {
            trimmed
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        } else {
            trimmed.to_string()
        };
        if seen.insert(key) {
            ordered.push(trimmed.to_string());
        }
    };

    for dir in prepend_dirs {
        push_entry(&dir.to_string_lossy());
    }
    for list in registry_path_lists {
        for seg in list.split(sep) {
            push_entry(seg);
        }
    }
    if let Some(proc_path) = fallback_process_path {
        for seg in proc_path.split(sep) {
            push_entry(seg);
        }
    }
    ordered.join(sep_str)
}

#[cfg(windows)]
fn read_registry_env_map() -> (Vec<(String, String)>, Vec<String>) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let mut vars: Vec<(String, String)> = Vec::new();
    let mut raw_paths: Vec<String> = Vec::new();

    let read_hive = |hive, subkey: &str, vars_out: &mut Vec<(String, String)>, paths_out: &mut Vec<String>| {
        if let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(subkey, KEY_READ) {
            if let Ok(p) = key.get_value::<String, _>("Path") {
                paths_out.push(p);
            } else if let Ok(p) = key.get_value::<String, _>("PATH") {
                paths_out.push(p);
            }
            for item in key.enum_values().flatten() {
                let (name, reg_val) = item;
                if let Ok(s) = String::from_reg_value(&reg_val) {
                    vars_out.push((name, s));
                }
            }
        }
    };

    // 先系统级再用户级，与 Windows Explorer 广播 WM_SETTINGCHANGE 后合并顺序一致
    read_hive(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        &mut vars,
        &mut raw_paths,
    );
    read_hive(HKEY_CURRENT_USER, "Environment", &mut vars, &mut raw_paths);
    (vars, raw_paths)
}

/// 读取最新注册表（Windows 下 `HKLM` + `HKCU` `Environment\Path` 并展开 `%VAR%`）与当前进程 `PATH` 合成的最新 `PATH`。
pub fn build_refreshed_path_env(prepend_dirs: &[PathBuf]) -> String {
    let current_proc_path = std::env::var("PATH")
        .or_else(|_| std::env::var("Path"))
        .ok();

    #[cfg(windows)]
    {
        let (reg_vars, raw_paths) = read_registry_env_map();
        let lookup = |name: &str| -> Option<String> {
            for (k, v) in reg_vars.iter().rev() {
                if k.eq_ignore_ascii_case(name) && !k.eq_ignore_ascii_case("Path") {
                    return Some(v.clone());
                }
            }
            std::env::vars().find_map(|(k, v)| k.eq_ignore_ascii_case(name).then_some(v))
        };
        let expanded: Vec<String> = raw_paths
            .iter()
            .map(|p| expand_windows_env_vars(p, lookup))
            .collect();
        return merge_path_entries(prepend_dirs, &expanded, current_proc_path.as_deref(), true);
    }

    #[cfg(not(windows))]
    {
        merge_path_entries(prepend_dirs, &[], current_proc_path.as_deref(), false)
    }
}

/// 启动桌面壳时同步刷新当前进程自身的 `PATH`（使壳后续前置检查与子进程继承最新注册表 `PATH`）。
pub fn refresh_current_process_path(prepend_dirs: &[PathBuf]) -> String {
    let merged = build_refreshed_path_env(prepend_dirs);
    if !merged.is_empty() {
        std::env::set_var("PATH", &merged);
    }
    merged
}
