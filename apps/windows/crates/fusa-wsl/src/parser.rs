use serde::{Deserialize, Serialize};
use crate::error::{ProvisionError, SelfTestReport};

/// `wsl.exe --version` 提取出的版本号信息（不依赖英文或中文标签名）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WslVersionInfo {
    pub wsl_version: String,
    pub raw_text: String,
}

/// `wsl.exe --list --verbose` 单条发行版运行状态（兼容多语言系统输出）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WslDistroState {
    Running,
    Stopped,
    Installing,
    /// 其他系统语言下的状态词（如法语、德语、日语），保留原文不报错。
    Other(String),
}

/// `wsl.exe --list --verbose` 结构化解析出的发行版条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WslDistroEntry {
    pub name: String,
    pub state: WslDistroState,
    pub wsl_version: u8,
    pub is_default: bool,
}

/// 从 `scripts/print-vendors.ts` / `--vendors-json` 动态读取的单家厂商安装与登录引导元数据。
/// 结构完全通用，不含任何具体厂商分支。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VendorGuideEntry {
    pub id: String,
    pub command: String,
    pub install_command: String,
    pub login_command: String,
    pub installed: bool,
    pub binary_path: Option<String>,
}

/// 解码 `wsl.exe` 的标准输出或标准错误字节流。
/// 同时兼容：
/// 1. UTF-16LE（带 `FF FE` BOM）
/// 2. UTF-16LE（无 BOM，Windows 中文/英文系统下 `wsl.exe --list --verbose` / `--status` 的常见编码）
/// 3. UTF-8（带 `EF BB BF` BOM 或无 BOM，如开启 `WSL_UTF8=1` 或 Linux 内部进程输出）
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    let decoded = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        decode_utf16le_slice(rest)
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else if looks_like_utf16le_without_bom(bytes) {
        decode_utf16le_slice(bytes)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) if bytes.len() >= 2 && bytes.len() % 2 == 0 => decode_utf16le_slice(bytes),
            Err(_) => String::from_utf8_lossy(bytes).into_owned(),
        }
    };

    normalize_decoded_text(&decoded)
}

fn decode_utf16le_slice(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn looks_like_utf16le_without_bom(bytes: &[u8]) -> bool {
    if bytes.len() < 2 {
        return false;
    }
    let mut even_zeros = 0usize;
    let mut odd_zeros = 0usize;
    for (idx, &b) in bytes.iter().enumerate() {
        if b == 0 {
            if idx % 2 == 0 {
                even_zeros += 1;
            } else {
                odd_zeros += 1;
            }
        }
    }
    if even_zeros == 0 && odd_zeros == 0 {
        return false;
    }
    // UTF-16LE 中的 ASCII 字符（空格、冒号、数字、换行、拉丁字母）高字节均在奇数下标且为 0x00。
    if odd_zeros > even_zeros {
        return true;
    }
    // 若偶数位出现 0x00（如宽字符 NUL 或特定 CJK 码位如 U+4E00 `00 4E`），只要总长度是偶数且非单字节尾部 C NUL，也按 UTF-16LE 处理。
    let only_trailing_nul =
        even_zeros + odd_zeros == 1 && bytes.last().copied() == Some(0) && std::str::from_utf8(&bytes[..bytes.len() - 1]).is_ok();
    !only_trailing_nul && bytes.len() % 2 == 0
}

fn normalize_decoded_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    if chars.peek() == Some(&'\u{feff}') {
        chars.next();
    }
    while let Some(ch) = chars.next() {
        if ch == '\0' {
            continue;
        }
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

/// 解析 `wsl.exe --version` 输出（仅当退出码为 0 时有效，提取首个形如 `a.b.c` 的版本号，不匹配语言相关标签）。
pub fn parse_wsl_version_output(exit_code: i32, raw_stdout: &[u8]) -> Option<WslVersionInfo> {
    if exit_code != 0 {
        return None;
    }
    let text = decode_wsl_output(raw_stdout);
    let version = text.lines().find_map(extract_dotted_version)?;
    Some(WslVersionInfo {
        wsl_version: version,
        raw_text: text,
    })
}

fn extract_dotted_version(line: &str) -> Option<String> {
    for token in line.split(|c: char| c.is_whitespace() || c == ':' || c == '：') {
        let candidate = token.trim();
        if candidate.is_empty() {
            continue;
        }
        let parts: Vec<&str> = candidate.split('.').collect();
        if parts.len() >= 3
            && parts.len() <= 5
            && parts
                .iter()
                .all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()))
        {
            return Some(candidate.to_string());
        }
    }
    None
}

/// 结构化解析 `wsl.exe --list --verbose` 输出。
/// 规则：
/// - 不匹配任何英文报错或表头词（如 `NAME`、`Windows Subsystem for Linux has no installed distributions`）；
/// - 依据表格列结构识别：可选 `*` 默认标记 + `<发行版名>` + `<多语言状态>` + 末尾独立版本号列 `1` 或 `2`；
/// - 当系统尚未安装任何发行版时（输出中文或英文提示语），自然返回空列表 `vec![]`。
pub fn parse_wsl_list_verbose(raw_stdout: &[u8]) -> Vec<WslDistroEntry> {
    let text = decode_wsl_output(raw_stdout);
    let mut entries = Vec::new();

    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let (is_default, after_star) = match trimmed.strip_prefix('*') {
            Some(rest) => (true, rest.trim_start()),
            None => (false, trimmed),
        };
        if after_star.is_empty() {
            continue;
        }

        // 最后一列必须是独立的 WSL 版本号 1 或 2
        let Some((before_version, version_token)) = split_last_token(after_star) else {
            continue;
        };
        let wsl_version: u8 = match version_token {
            "1" => 1,
            "2" => 2,
            _ => continue,
        };

        // 第一列是发行版名称（WSL 发行版名不含空格），中间部分是本地化状态文本（可能含空格）
        let Some((distro_name, state_raw)) = split_first_token(before_version.trim()) else {
            continue;
        };
        let state_trimmed = state_raw.trim();
        if distro_name.is_empty() || state_trimmed.is_empty() {
            continue;
        }

        entries.push(WslDistroEntry {
            name: distro_name.to_string(),
            state: classify_distro_state(state_trimmed),
            wsl_version,
            is_default,
        });
    }

    entries
}

fn split_last_token(s: &str) -> Option<(&str, &str)> {
    let trimmed = s.trim_end();
    let idx = trimmed.rfind(char::is_whitespace)?;
    let head = trimmed[..idx].trim_end();
    let tail = &trimmed[idx..].trim_start();
    if head.is_empty() || tail.is_empty() {
        return None;
    }
    Some((head, tail))
}

fn split_first_token(s: &str) -> Option<(&str, &str)> {
    let trimmed = s.trim_start();
    let idx = trimmed.find(char::is_whitespace)?;
    let first = &trimmed[..idx];
    let rest = trimmed[idx..].trim_start();
    if first.is_empty() || rest.is_empty() {
        return None;
    }
    Some((first, rest))
}

fn classify_distro_state(raw: &str) -> WslDistroState {
    if raw.eq_ignore_ascii_case("running") || raw == "正在运行" || raw == "執行中" || raw == "実行中" {
        WslDistroState::Running
    } else if raw.eq_ignore_ascii_case("stopped") || raw == "已停止" || raw == "停止" {
        WslDistroState::Stopped
    } else if raw.eq_ignore_ascii_case("installing")
        || raw == "正在安装"
        || raw == "正在安裝"
        || raw == "インストール中"
    {
        WslDistroState::Installing
    } else {
        WslDistroState::Other(raw.to_string())
    }
}

/// 解析发行版内 `wsl-provision-guest.sh --self-test` 返回的 JSON 报告。
pub fn parse_self_test_report(
    exit_code: i32,
    raw_stdout: &[u8],
    raw_stderr: &[u8],
) -> Result<SelfTestReport, ProvisionError> {
    let stdout_text = decode_wsl_output(raw_stdout);
    let trimmed = stdout_text.trim();
    if let Ok(report) = serde_json::from_str::<SelfTestReport>(trimmed) {
        return Ok(report);
    }
    // 若 stdout 混入了前置空行，取最后一行非空 JSON 尝试解析
    if let Some(last_line) = trimmed.lines().rev().find(|l| l.trim().starts_with('{')) {
        if let Ok(report) = serde_json::from_str::<SelfTestReport>(last_line.trim()) {
            return Ok(report);
        }
    }
    let stderr_text = decode_wsl_output(raw_stderr);
    let combined = if trimmed.is_empty() {
        stderr_text.trim().to_string()
    } else if stderr_text.trim().is_empty() {
        trimmed.to_string()
    } else {
        format!("stdout={trimmed}; stderr={}", stderr_text.trim())
    };
    Err(ProvisionError::InvalidSelfTestOutput {
        exit_code,
        raw_output: combined,
    })
}

/// 解析发行版内 `wsl-provision-guest.sh --vendors-json` 返回的动态厂商引导 JSON。
pub fn parse_vendor_guides_json(raw_stdout: &[u8]) -> Result<Vec<VendorGuideEntry>, ProvisionError> {
    let text = decode_wsl_output(raw_stdout);
    let guides: Vec<VendorGuideEntry> = serde_json::from_str(text.trim())?;
    Ok(guides)
}

/// 直接解析 `scripts/print-vendors.ts` 原始制表符分隔输出（无具体厂商硬编码）。
pub fn parse_vendor_guides_tsv(tsv_text: &str) -> Vec<VendorGuideEntry> {
    let mut out = Vec::new();
    for line in tsv_text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        let Some(&id) = cols.first() else { continue };
        let Some(&command) = cols.get(1) else { continue };
        if id.is_empty() || command.is_empty() {
            continue;
        }
        let install_command = cols.get(2).copied().unwrap_or_default().to_string();
        let login_command = cols.get(3).copied().unwrap_or_default().to_string();
        out.push(VendorGuideEntry {
            id: id.to_string(),
            command: command.to_string(),
            install_command,
            login_command,
            installed: false,
            binary_path: None,
        });
    }
    out
}
